/**
 * Integration tests for QAAgent.runSync against a fake Playwright (no real browser, no network).
 *
 * Proves, inside the real execute() flow, the fixes:
 *  - F2: a browser per run (parallel runs do not close each other's browser; launch() is shared per manager)
 *  - F5: navigate blocks non-http(s) URLs and resolves relative URLs against the base URL
 *  - F7: wait steps are capped at stepTimeoutMs, non-numeric values fall back to 1000ms
 *  - F8: errors observed while exploring do not fail a scenario (favicon included), other errors do
 *  - V1: late load noise and sub-page noise seen while exploring do not fail a scenario
 *  - W1: errors never seen while exploring fail a scenario, even on its first load; cache-busters are ignored
 *  - V3: runSync/startRun reject non-http(s) URLs before creating a run
 *  - V4: BrowserManager.close() waits for a launch that is still in flight
 */

// Use an in-memory database for tests (must be set before the DB layer is imported)
process.env.DATABASE_PATH = ':memory:';

import { chromium } from 'playwright';
import { closeDatabase } from '../database/Database';
import { getAllRuns, getBugsByRun, getRiskSignalsByRun } from '../database/Repository';
import { getConfig } from '../config/Config';
import { QAAgent } from '../agents/QAAgent';
import { BrowserManager } from '../browser/BrowserManager';
import type { Dashboard, PageSnapshot, TestScenario, TestStep } from '../types';

// ─── Fake Playwright ─────────────────────────────────────────────────────────

type FakeEvent =
  | { kind: 'console'; type: string; text: string }
  | { kind: 'response'; status: number; url: string };

type Handler = (arg: unknown) => void;

const BASE_URL = 'https://app.example.test';
const FAVICON_URL = 'https://app.example.test/favicon.ico';
const FAVICON_ERROR = `HTTP 404 ${FAVICON_URL}`;

/** Scripts the fake page: which events fire on goto (per URL) and on click (per selector). */
interface PageScript {
  onGoto: (url: string) => FakeEvent[];
  onClick: Record<string, FakeEvent[]>;
  /**
   * Events that arrive after goto() resolved (async tracker, broken image, fetch on load).
   * They surface on the next page interaction, e.g. waitForLoadState('networkidle').
   */
  onLate?: (url: string) => FakeEvent[];
}

class FakePage {
  public readonly gotoCalls: string[] = [];
  public readonly waitCalls: number[] = [];
  public readonly clickCalls: string[] = [];
  public readonly loadStateCalls: Array<{ state?: string; timeout?: number }> = [];
  public closed = false;
  private currentUrl = '';
  private pendingLate: FakeEvent[] = [];
  private readonly handlers = new Map<string, Handler[]>();

  constructor(private readonly script: PageScript) {}

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  private fire(events: FakeEvent[]): void {
    for (const event of events) {
      if (event.kind === 'console') {
        const msg = { type: () => event.type, text: () => event.text };
        (this.handlers.get('console') ?? []).forEach((h) => h(msg));
      } else {
        const res = { status: () => event.status, url: () => event.url };
        (this.handlers.get('response') ?? []).forEach((h) => h(res));
      }
    }
  }

  /** Deliver events that arrived after goto() resolved. */
  private flushLate(): void {
    const events = this.pendingLate;
    this.pendingLate = [];
    this.fire(events);
  }

  async goto(url: string): Promise<null> {
    this.gotoCalls.push(url);
    await tick();
    this.currentUrl = url;
    this.fire(this.script.onGoto(url));
    this.pendingLate.push(...(this.script.onLate?.(url) ?? []));
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  async click(selector: string): Promise<void> {
    this.clickCalls.push(selector);
    await tick();
    this.flushLate();
    this.fire(this.script.onClick[selector] ?? []);
  }

  async fill(): Promise<void> {
    await tick();
    this.flushLate();
  }

  async waitForSelector(): Promise<null> {
    await tick();
    this.flushLate();
    return null;
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.waitCalls.push(ms);
    await tick();
    this.flushLate();
  }

  async waitForLoadState(state?: string, options?: { timeout?: number }): Promise<void> {
    this.loadStateCalls.push({ state, timeout: options?.timeout });
    await tick();
    this.flushLate();
  }

  async textContent(): Promise<string> {
    this.flushLate();
    return 'text';
  }

  locator(): { innerText: () => Promise<string> } {
    return {
      innerText: async () => {
        this.flushLate();
        return 'body text';
      },
    };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from('');
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeContext {
  constructor(
    private readonly browser: FakeBrowser,
    private readonly makePage: () => FakePage,
  ) {}

  async newPage(): Promise<FakePage> {
    if (this.browser.closed) throw new Error('Target closed');
    return this.makePage();
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

class FakeBrowser {
  public closed = false;
  public closeCount = 0;
  public newContextCalls = 0;
  /** newContext calls that arrived after close() - must stay at zero. */
  public newContextAfterClose = 0;

  constructor(private readonly makePage: () => FakePage) {}

  async newContext(): Promise<FakeContext> {
    this.newContextCalls++;
    if (this.closed) {
      this.newContextAfterClose++;
      throw new Error('Target closed');
    }
    return new FakeContext(this, this.makePage);
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.closed = true;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fakeState: {
  browsers: FakeBrowser[];
  pages: FakePage[];
  script: PageScript;
} = { browsers: [], pages: [], script: defaultScript() };

function defaultScript(): PageScript {
  return { onGoto: () => [], onClick: {} };
}

function createFakeBrowser(): FakeBrowser {
  const browser = new FakeBrowser(() => {
    const page = new FakePage(fakeState.script);
    fakeState.pages.push(page);
    return page;
  });
  fakeState.browsers.push(browser);
  return browser;
}

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn(async () => {
      await tick();
      return createFakeBrowser();
    }),
  },
}));

// ─── Other collaborators ─────────────────────────────────────────────────────

const mockGenerateScenarios = jest.fn();
const mockClassifyBug = jest.fn();

jest.mock('../agents/LLMClient', () => ({
  LLMClient: jest.fn().mockImplementation(() => ({
    generateTestScenarios: (...args: unknown[]) => mockGenerateScenarios(...args),
    classifyBug: (...args: unknown[]) => mockClassifyBug(...args),
  })),
}));

/** Per-URL overrides for the snapshot the fake PageExplorer returns. */
const mockExploreOverrides: Record<string, Partial<PageSnapshot>> = {};

jest.mock('../browser/PageExplorer', () => ({
  PageExplorer: jest.fn().mockImplementation(() => ({
    explore: jest.fn(async (_context: unknown, url: string) => ({
      url,
      finalUrl: url,
      title: 'Fake app',
      forms: [],
      inputs: [],
      buttons: [],
      links: [],
      headings: [],
      consoleErrors: [],
      networkErrors: [],
      ...mockExploreOverrides[url],
    })),
  })),
}));

jest.mock('../browser/ScreenshotManager', () => ({
  ScreenshotManager: jest.fn().mockImplementation(() => ({
    capture: jest.fn(async (_page: unknown, name: string) => `/fake/screenshots/${name}.png`),
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RawScenario = Omit<TestScenario, 'id' | 'runId' | 'status'>;

function scenario(title: string, steps: TestStep[]): RawScenario {
  return { title, description: `${title} description`, priority: 'medium', steps };
}

function setScenarios(...batches: RawScenario[][]): void {
  mockGenerateScenarios.mockReset();
  for (const batch of batches) {
    mockGenerateScenarios.mockResolvedValueOnce(batch);
  }
  mockGenerateScenarios.mockResolvedValue([]);
}

function allGotoCalls(): string[] {
  return fakeState.pages.flatMap((p) => p.gotoCalls);
}

function allWaitCalls(): number[] {
  return fakeState.pages.flatMap((p) => p.waitCalls);
}

const launchMock = (): jest.Mock => chromium.launch as unknown as jest.Mock;

let logSpies: jest.SpyInstance[] = [];

beforeAll(() => {
  logSpies = [
    jest.spyOn(console, 'log').mockImplementation(() => undefined),
    jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    jest.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterAll(() => {
  logSpies.forEach((s) => s.mockRestore());
  closeDatabase();
});

beforeEach(() => {
  fakeState.browsers = [];
  fakeState.pages = [];
  fakeState.script = defaultScript();
  for (const key of Object.keys(mockExploreOverrides)) delete mockExploreOverrides[key];
  launchMock().mockClear();
  mockGenerateScenarios.mockReset();
  mockClassifyBug.mockReset();
  mockClassifyBug.mockImplementation(
    async (
      _runId: string,
      _scenarioId: string,
      url: string,
      errorDescription: string,
      reproductionSteps: string[],
      consoleErrors: string[],
      networkErrors: string[],
      errorStack?: string,
    ) => ({
      title: 'Deterministic bug',
      severity: 'high',
      description: errorDescription,
      reproductionSteps,
      expectedBehavior: 'works',
      actualBehavior: 'broken',
      url,
      consoleErrors,
      networkErrors,
      errorStack,
    }),
  );
});

// ─── F2: browser per run ─────────────────────────────────────────────────────

describe('F2 - a browser per run', () => {
  test('two parallel runs on the same agent each get their own browser and close it exactly once', async () => {
    // Run A finishes quickly (1 scenario), run B keeps going for 4 scenarios, so A's close()
    // lands while B still needs newContext(). With a shared browser, B would hit 'Target closed'.
    const quick = [scenario('quick', [{ action: 'wait', value: '1', description: 'wait' }])];
    const slow = [1, 2, 3, 4].map((i) =>
      scenario(`slow ${i}`, [{ action: 'wait', value: '1', description: 'wait' }]),
    );
    setScenarios(quick, slow);

    const agent = new QAAgent();
    const [a, b] = await Promise.all([agent.runSync(BASE_URL), agent.runSync(BASE_URL)]);

    expect(launchMock()).toHaveBeenCalledTimes(2);
    expect(fakeState.browsers).toHaveLength(2);
    for (const browser of fakeState.browsers) {
      expect(browser.closeCount).toBe(1);
      expect(browser.newContextAfterClose).toBe(0);
    }

    const dashboards: Dashboard[] = [a, b];
    expect(dashboards.map((d) => d.totalScenarios).sort()).toEqual([1, 4]);
    for (const d of dashboards) {
      expect(d.status).toBe('completed');
      expect(d.failedScenarios).toBe(0);
      expect(d.passedScenarios).toBe(d.totalScenarios);
      expect(d.bugsFound).toBe(0);
    }
    expect(a.runId).not.toBe(b.runId);
  });

  test('a single BrowserManager shares one launch between concurrent launch() calls', async () => {
    const manager = new BrowserManager();
    await Promise.all([manager.launch(), manager.launch()]);

    expect(launchMock()).toHaveBeenCalledTimes(1);

    const context = await manager.newContext();
    expect(context).toBeDefined();
    await manager.close();
    expect(fakeState.browsers).toHaveLength(1);
    expect(fakeState.browsers[0].closeCount).toBe(1);
  });
});

// ─── F5: navigate guard ──────────────────────────────────────────────────────

describe('F5 - navigate blocking and URL resolution', () => {
  test('navigate to a javascript: URL fails the scenario and never reaches page.goto', async () => {
    setScenarios([
      scenario('js navigate', [
        { action: 'navigate', value: 'javascript:alert(1)', description: 'Go to javascript url' },
      ]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.failedScenarios).toBe(1);
    expect(dashboard.passedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(1);
    expect(dashboard.bugs[0].description).toContain('navigate blocked');
    expect(mockClassifyBug).toHaveBeenCalledTimes(1);
    expect(mockClassifyBug.mock.calls[0][3]).toContain('navigate blocked');

    const gotos = allGotoCalls();
    expect(gotos.length).toBeGreaterThan(0);
    for (const url of gotos) {
      expect(url).toMatch(/^https?:\/\//);
    }
    expect(gotos).not.toContain('javascript:alert(1)');
  });

  test.each(['data:text/html,<script>1</script>', 'file:///etc/passwd'])(
    'navigate to %s is blocked as well',
    async (value) => {
      setScenarios([scenario('non http navigate', [{ action: 'navigate', value, description: 'bad nav' }])]);

      const dashboard = await new QAAgent().runSync(BASE_URL);

      expect(dashboard.failedScenarios).toBe(1);
      expect(dashboard.bugs[0].description).toContain('navigate blocked');
      expect(allGotoCalls().every((u) => /^https?:\/\//.test(u))).toBe(true);
    },
  );

  test('a relative navigate value is resolved against the base URL', async () => {
    setScenarios([
      scenario('relative navigate', [{ action: 'navigate', value: '/signup', description: 'Go to signup' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.failedScenarios).toBe(0);
    expect(allGotoCalls()).toContain('https://app.example.test/signup');
  });
});

// ─── F7: wait cap ────────────────────────────────────────────────────────────

describe('F7 - wait step ceiling', () => {
  test("wait '600000' is capped at stepTimeoutMs", async () => {
    setScenarios([scenario('long wait', [{ action: 'wait', value: '600000', description: 'long wait' }])]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    const { stepTimeoutMs } = getConfig();
    const waits = allWaitCalls();
    expect(dashboard.passedScenarios).toBe(1);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(stepTimeoutMs);
    expect(waits[0]).toBe(stepTimeoutMs);
  });

  test("a non-numeric wait value ('abc') becomes 1000", async () => {
    setScenarios([scenario('bad wait', [{ action: 'wait', value: 'abc', description: 'bad wait' }])]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.passedScenarios).toBe(1);
    expect(allWaitCalls()).toEqual([1000]);
  });
});

// ─── F8: noise filtering ─────────────────────────────────────────────────────

describe('F8 - baseline noise and favicon failures', () => {
  const baselineNoise = (): void => {
    // Seen while exploring, so scenarios may ignore it.
    mockExploreOverrides[BASE_URL] = { consoleErrors: ['baseline noise'], networkErrors: [FAVICON_ERROR] };
    fakeState.script = {
      onGoto: (url) =>
        url === BASE_URL
          ? [
              { kind: 'console', type: 'error', text: 'baseline noise' },
              { kind: 'response', status: 404, url: FAVICON_URL },
            ]
          : [],
      onClick: {},
    };
  };

  test('errors present on the initial load do not fail an innocent scenario', async () => {
    baselineNoise();
    setScenarios([
      scenario('innocent', [
        { action: 'assert_url', value: 'app.example.test', description: 'still on app' },
        { action: 'wait', value: '5', description: 'wait' },
      ]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.scenarios).toHaveLength(1);
    expect(dashboard.scenarios[0].status).toBe('passed');
    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.failedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(0);
    expect(getBugsByRun(dashboard.runId)).toHaveLength(0);
    expect(mockClassifyBug).not.toHaveBeenCalled();
  });

  test('a favicon 404 that the exploration observed does not fail the scenario and is reported as a risk', async () => {
    mockExploreOverrides[BASE_URL] = { networkErrors: [FAVICON_ERROR] };
    fakeState.script = {
      onGoto: () => [],
      onClick: { '#favicon-trigger': [{ kind: 'response', status: 404, url: FAVICON_URL }] },
    };
    setScenarios([
      scenario('favicon after click', [{ action: 'click', selector: '#favicon-trigger', description: 'click' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.bugs).toHaveLength(0);

    const reliability = getRiskSignalsByRun(dashboard.runId).filter((s) => s.type === 'technical_reliability');
    expect(reliability.flatMap((s) => s.evidence)).toContain(`Network: ${FAVICON_ERROR}`);
  });

  test('a favicon failure that the exploration did not observe fails the scenario', async () => {
    fakeState.script = {
      onGoto: () => [],
      onClick: { '#favicon-trigger': [{ kind: 'response', status: 404, url: FAVICON_URL }] },
    };
    setScenarios([
      scenario('favicon after click', [{ action: 'click', selector: '#favicon-trigger', description: 'click' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.failedScenarios).toBe(1);
    expect(dashboard.passedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(1);
    expect(dashboard.bugs[0].networkErrors).toContain(FAVICON_ERROR);
  });

  test('guard: every error observed while exploring, on any explored page, stays in the risk evidence', async () => {
    // Pins the coupling between the filter and the report: whatever a scenario may ignore must
    // appear in a technical_reliability signal. The base page carries six distinct errors (one more
    // than the old evidence cap of 5) and an explored sub-page carries another, so this fails if the
    // analyzeSnapshot call is removed, if it only runs on the first snapshot, or if the evidence is
    // capped again.
    const subUrl = `${BASE_URL}/sub`;
    const baseErrors = [1, 2, 3, 4, 5, 6].map((n) => `HTTP 404 ${BASE_URL}/img${n}.png`);
    mockExploreOverrides[BASE_URL] = {
      networkErrors: baseErrors,
      links: [{ tag: 'a', text: 'Sub', href: subUrl, selector: 'a[href="/sub"]' }],
    };
    mockExploreOverrides[subUrl] = { consoleErrors: ['subpage noise'] };
    fakeState.script = {
      onGoto: (url) => (url === subUrl ? [{ kind: 'console', type: 'error', text: 'subpage noise' }] : []),
      onClick: { '#img': [{ kind: 'response', status: 404, url: `${BASE_URL}/img6.png` }] },
    };
    setScenarios([
      scenario('image click then sub page', [
        { action: 'click', selector: '#img', description: 'click' },
        { action: 'navigate', value: '/sub', description: 'Go to sub page' },
      ]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.bugs).toHaveLength(0);

    const evidence = getRiskSignalsByRun(dashboard.runId)
      .filter((s) => s.type === 'technical_reliability')
      .flatMap((s) => s.evidence);
    for (const error of baseErrors) {
      expect(evidence).toContain(`Network: ${error}`);
    }
    expect(evidence).toContain('Console: subpage noise');
  });

  test('a new console error after a click fails the scenario and only that error is reported', async () => {
    baselineNoise();
    fakeState.script.onClick = {
      '#boom': [{ kind: 'console', type: 'error', text: 'boom after click' }],
    };
    setScenarios([
      scenario('click causes error', [{ action: 'click', selector: '#boom', description: 'click boom' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.failedScenarios).toBe(1);
    expect(dashboard.passedScenarios).toBe(0);
    expect(dashboard.scenarios[0].status).toBe('failed');
    expect(dashboard.bugs).toHaveLength(1);

    const stored = getBugsByRun(dashboard.runId);
    expect(stored).toHaveLength(1);
    const bug = dashboard.bugs[0];
    expect(bug.consoleErrors).toContain('boom after click');
    expect(bug.consoleErrors).not.toContain('baseline noise');
    expect(bug.networkErrors ?? []).toHaveLength(0);
    expect(stored[0].consoleErrors).toContain('boom after click');
  });
});

// ─── V1: noise that arrives after DOMContentLoaded or on explored sub-pages ──

describe('V1 - late load noise and sub-page noise', () => {
  const SUB_URL = `${BASE_URL}/sub`;

  test('late console noise that the exploration also saw does not fail an innocent scenario', async () => {
    mockExploreOverrides[BASE_URL] = { consoleErrors: ['late load noise'] };
    fakeState.script = {
      onGoto: () => [],
      onClick: {},
      onLate: (url) => (url === BASE_URL ? [{ kind: 'console', type: 'error', text: 'late load noise' }] : []),
    };
    setScenarios([
      scenario('innocent', [{ action: 'assert_url', value: 'app.example.test', description: 'still on app' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.failedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(0);
    expect(mockClassifyBug).not.toHaveBeenCalled();

    // No networkidle wait and no baseline after the initial load.
    expect(fakeState.pages.flatMap((p) => p.loadStateCalls)).toHaveLength(0);
  });

  test('an error that appears only on the scenario initial load fails the scenario (W1)', async () => {
    fakeState.script = {
      onGoto: (url) =>
        url === BASE_URL ? [{ kind: 'response', status: 500, url: `${BASE_URL}/api/session` }] : [],
      onClick: {},
    };
    setScenarios([scenario('flaky load', [{ action: 'wait', value: '1', description: 'wait' }])]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.failedScenarios).toBe(1);
    expect(dashboard.passedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(1);
    expect(dashboard.bugs[0].networkErrors).toContain('HTTP 500 https://app.example.test/api/session');
    expect(mockClassifyBug).toHaveBeenCalledTimes(1);
  });

  test('a scanned error that returns with a different cache-buster does not fail the scenario', async () => {
    mockExploreOverrides[BASE_URL] = { networkErrors: ['HTTP 404 https://app.example.test/img.png?cb=1'] };
    fakeState.script = {
      onGoto: () => [],
      onClick: { '#img': [{ kind: 'response', status: 404, url: `${BASE_URL}/img.png?cb=2` }] },
    };
    setScenarios([scenario('cache buster', [{ action: 'click', selector: '#img', description: 'click' }])]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.failedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(0);
    expect(mockClassifyBug).not.toHaveBeenCalled();
  });

  test('noise from an explored sub-page does not fail a scenario that navigates there', async () => {
    mockExploreOverrides[BASE_URL] = {
      links: [{ tag: 'a', text: 'Sub', href: SUB_URL, selector: 'a[href="/sub"]' }],
    };
    mockExploreOverrides[SUB_URL] = { consoleErrors: ['subpage noise'] };
    fakeState.script = {
      onGoto: (url) => (url === SUB_URL ? [{ kind: 'console', type: 'error', text: 'subpage noise' }] : []),
      onClick: {},
    };
    setScenarios([
      scenario('visit sub page', [{ action: 'navigate', value: '/sub', description: 'Go to sub page' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(allGotoCalls()).toContain(SUB_URL);
    expect(dashboard.passedScenarios).toBe(1);
    expect(dashboard.failedScenarios).toBe(0);
    expect(dashboard.bugs).toHaveLength(0);
    expect(mockClassifyBug).not.toHaveBeenCalled();
  });

  test('an error caused by interaction still fails the scenario even with load noise around', async () => {
    mockExploreOverrides[BASE_URL] = { consoleErrors: ['late load noise'] };
    fakeState.script = {
      onGoto: () => [],
      onClick: { '#boom': [{ kind: 'console', type: 'error', text: 'boom after click' }] },
      onLate: (url) => (url === BASE_URL ? [{ kind: 'console', type: 'error', text: 'late load noise' }] : []),
    };
    setScenarios([
      scenario('click causes error', [{ action: 'click', selector: '#boom', description: 'click boom' }]),
    ]);

    const dashboard = await new QAAgent().runSync(BASE_URL);

    expect(dashboard.failedScenarios).toBe(1);
    expect(dashboard.bugs).toHaveLength(1);
    expect(dashboard.bugs[0].consoleErrors).toEqual(['boom after click']);
  });
});

// ─── V3: non-http(s) entry URL ───────────────────────────────────────────────

describe('V3 - entry URL must be http(s)', () => {
  test("runSync('file:///etc/passwd') is rejected before any browser or run record exists", async () => {
    const runsBefore = getAllRuns().length;

    await expect(new QAAgent().runSync('file:///etc/passwd')).rejects.toThrow('URL must use http or https');

    expect(launchMock()).not.toHaveBeenCalled();
    expect(getAllRuns()).toHaveLength(runsBefore);
  });

  test("startRun('javascript:alert(1)') is rejected before any browser or run record exists", async () => {
    const runsBefore = getAllRuns().length;

    await expect(new QAAgent().startRun('javascript:alert(1)')).rejects.toThrow('URL must use http or https');

    expect(launchMock()).not.toHaveBeenCalled();
    expect(getAllRuns()).toHaveLength(runsBefore);
  });
});

// ─── V4: close() during launch() ─────────────────────────────────────────────

describe('V4 - BrowserManager.close() while launch() is in flight', () => {
  test('the browser that comes up is closed exactly once', async () => {
    const manager = new BrowserManager();

    const launching = manager.launch();
    await manager.close();
    await launching;

    expect(fakeState.browsers).toHaveLength(1);
    expect(fakeState.browsers[0].closeCount).toBe(1);
  });
});
