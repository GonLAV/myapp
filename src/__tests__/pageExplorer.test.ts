/**
 * Tests for PageExplorer — resilience to collector failures.
 * Uses fakes only; no real browser is launched.
 */
import type { BrowserContext } from 'playwright';
import { PageExplorer } from '../browser/PageExplorer';
import type { ScreenshotManager } from '../browser/ScreenshotManager';

const URL_UNDER_TEST = 'https://demo.example.com/';
const FINAL_URL = 'https://demo.example.com/redirected';

// Collector call order inside PageExplorer.explore():
// buttons, links, inputs, forms, headings.
const COLLECTOR_RESULTS: unknown[] = [
  [{ tag: 'button', text: 'Go', selector: '#go' }],
  [{ tag: 'a', text: 'Home', href: 'https://demo.example.com/', selector: '#home' }],
  [{ tag: 'input', type: 'text', selector: '#q' }],
  [{ inputs: [] }],
  ['Welcome'],
];

interface FakeSetup {
  context: BrowserContext;
  screenshots: ScreenshotManager;
  close: jest.Mock;
}

function buildFakes(failingIndexes: number[]): FakeSetup {
  let call = 0;
  const evaluate = jest.fn(async () => {
    const index = call++;
    if (failingIndexes.includes(index)) {
      throw new Error('Execution context was destroyed');
    }
    return COLLECTOR_RESULTS[index];
  });
  const close = jest.fn(async () => undefined);
  const page = {
    on: jest.fn(),
    goto: jest.fn(async () => null),
    title: jest.fn(async () => 'Demo'),
    evaluate,
    close,
    url: jest.fn(() => FINAL_URL),
  };
  const context = {
    newPage: jest.fn(async () => page),
  } as unknown as BrowserContext;
  const screenshots = {
    capture: jest.fn(async () => '/tmp/explore.png'),
  } as unknown as ScreenshotManager;
  return { context, screenshots, close };
}

describe('PageExplorer.explore', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns empty collections instead of throwing when every collector fails', async () => {
    const { context, screenshots, close } = buildFakes([0, 1, 2, 3, 4]);
    const explorer = new PageExplorer(screenshots);

    const snapshot = await explorer.explore(context, URL_UNDER_TEST);

    expect(snapshot.buttons).toEqual([]);
    expect(snapshot.links).toEqual([]);
    expect(snapshot.inputs).toEqual([]);
    expect(snapshot.forms).toEqual([]);
    expect(snapshot.headings).toEqual([]);
    expect(snapshot.url).toBe(URL_UNDER_TEST);
    expect(snapshot.finalUrl).toBe(FINAL_URL);
    expect(snapshot.title).toBe('Demo');
    expect(snapshot.screenshotPath).toBe('/tmp/explore.png');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the data of the other collectors when only one fails', async () => {
    const { context, screenshots, close } = buildFakes([1]); // links collector rejects
    const explorer = new PageExplorer(screenshots);

    const snapshot = await explorer.explore(context, URL_UNDER_TEST);

    expect(snapshot.links).toEqual([]);
    expect(snapshot.buttons).toEqual(COLLECTOR_RESULTS[0]);
    expect(snapshot.inputs).toEqual(COLLECTOR_RESULTS[2]);
    expect(snapshot.forms).toEqual(COLLECTOR_RESULTS[3]);
    expect(snapshot.headings).toEqual(COLLECTOR_RESULTS[4]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('warns with the collection name and the URL when a collector fails', async () => {
    const { context, screenshots } = buildFakes([4]); // headings collector rejects
    const explorer = new PageExplorer(screenshots);

    await explorer.explore(context, URL_UNDER_TEST);

    const warned = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(warned).toContain('headings');
    expect(warned).toContain(URL_UNDER_TEST);
  });
});
