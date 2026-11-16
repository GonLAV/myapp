import { resetConfigForTests } from '../config/Config';
import { LLMClient, parseBugDraft, parseScenarioDrafts } from '../agents/LLMClient';
import type { PageSnapshot } from '../types';

const mockCreate = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const snapshot: PageSnapshot = {
  url: 'https://example.com/',
  title: 'Example',
  forms: [],
  inputs: [],
  buttons: [{ tag: 'button', text: 'Save', selector: '#save' }],
  links: [],
  consoleErrors: [],
  networkErrors: [],
};

function reply(payload: unknown): void {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
  });
}

function classify(client: LLMClient) {
  return client.classifyBug('run-1', 'scn-1', 'https://example.com/', 'boom', ['open page'], [], []);
}

describe('LLMClient', () => {
  let client: LLMClient;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCreate.mockReset();
    process.env.OPENAI_API_KEY = 'sk-unit';
    resetConfigForTests();
    client = new LLMClient();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
    resetConfigForTests();
  });

  describe('classifyBug', () => {
    test('keeps title and severity when the reply also contains a reproductionSteps array (F1)', async () => {
      reply({
        title: 'Checkout button is dead',
        severity: 'critical',
        description: 'Clicking does nothing',
        reproductionSteps: ['open cart', 'click checkout'],
        expectedBehavior: 'Navigates to payment',
        actualBehavior: 'Nothing happens',
      });

      const bug = await classify(client);

      expect(bug.title).toBe('Checkout button is dead');
      expect(bug.severity).toBe('critical');
      expect(bug.description).toBe('Clicking does nothing');
      expect(bug.reproductionSteps).toEqual(['open cart', 'click checkout']);
    });

    test('does not throw when the LLM call rejects and returns defaults (F3)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('429 rate limited'));

      const bug = await classify(client);

      expect(bug.title).toBe('Unknown issue');
      expect(bug.severity).toBe('medium');
      expect(bug.description).toBe('boom');
      expect(bug.reproductionSteps).toEqual(['open page']);
      expect(warnSpy).toHaveBeenCalled();
    });

    test('turns an invalid severity into medium (F13)', async () => {
      reply({ title: 'Odd severity', severity: 'catastrophic' });

      const bug = await classify(client);

      expect(bug.title).toBe('Odd severity');
      expect(bug.severity).toBe('medium');
    });

    test('normalizes the case and whitespace of severity (W2)', async () => {
      reply({ title: 'Cased', severity: 'Critical' });
      expect((await classify(client)).severity).toBe('critical');

      reply({ title: 'Shouting', severity: 'HIGH' });
      expect((await classify(client)).severity).toBe('high');

      reply({ title: 'Padded', severity: '  Low ' });
      expect((await classify(client)).severity).toBe('low');
    });
  });

  describe('generateTestScenarios', () => {
    test('normalizes the case of priority and step action instead of dropping the scenario (W2)', async () => {
      reply({
        scenarios: [
          {
            title: 'Cased scenario',
            priority: 'High',
            steps: [
              { action: 'Click', selector: '#save', description: 'click' },
              { action: ' NAVIGATE ', value: 'https://example.com/', description: 'open' },
            ],
          },
        ],
      });

      const scenarios = await client.generateTestScenarios(snapshot);

      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].title).toBe('Cased scenario');
      expect(scenarios[0].priority).toBe('high');
      expect(scenarios[0].steps.map((s) => s.action)).toEqual(['click', 'navigate']);
    });

    test('drops scenarios with an invalid action or no steps and repairs invalid priority (F9)', async () => {
      reply({
        scenarios: [
          {
            title: 'Valid scenario',
            description: 'ok',
            priority: 'urgent',
            steps: [
              { action: 'navigate', value: 'https://example.com/', description: 'open' },
              { action: 'click', selector: '#save', description: 'click' },
              { action: 'wait', value: 500, description: 'wait' },
            ],
          },
          {
            title: 'Bad action',
            priority: 'high',
            steps: [{ action: 'teleport', description: 'nope' }],
          },
          { title: 'No steps', priority: 'high' },
          { title: 'Empty steps', priority: 'high', steps: [] },
        ],
      });

      const scenarios = await client.generateTestScenarios(snapshot);

      expect(scenarios).toHaveLength(1);
      expect(scenarios[0].title).toBe('Valid scenario');
      expect(scenarios[0].priority).toBe('medium');
      expect(scenarios[0].description).toBe('ok');
      expect(scenarios[0].steps).toHaveLength(3);
      expect(scenarios[0].steps[0].selector).toBeUndefined();
      expect(scenarios[0].steps[2].value).toBe('500');
    });

    test('falls back to heuristics when no scenario is valid (F9)', async () => {
      reply({ scenarios: [{ title: 'Bad', priority: 'high', steps: [{ action: 'teleport' }] }, { title: 'No steps' }] });

      const scenarios = await client.generateTestScenarios(snapshot);

      expect(scenarios.length).toBeGreaterThan(0);
      expect(scenarios[0].title).toContain('Verify button interaction');
    });
  });

  describe('parseScenarioDrafts', () => {
    test('accepts a top-level array and an object with a scenarios array', () => {
      expect(parseScenarioDrafts('[{"a":1}]')).toEqual([{ a: 1 }]);
      expect(parseScenarioDrafts('{"scenarios":[{"a":1},{"b":2}]}')).toEqual([{ a: 1 }, { b: 2 }]);
    });

    test('returns [] for other shapes and for invalid JSON', () => {
      expect(parseScenarioDrafts('{"other":[1,2]}')).toEqual([]);
      expect(parseScenarioDrafts('{"scenarios":"nope"}')).toEqual([]);
      expect(parseScenarioDrafts('"text"')).toEqual([]);
      expect(parseScenarioDrafts('null')).toEqual([]);
      expect(parseScenarioDrafts('not json')).toEqual([]);
    });
  });

  describe('parseBugDraft', () => {
    test('returns a plain object as-is without extracting nested arrays', () => {
      const draft = parseBugDraft('{"title":"T","reproductionSteps":["a","b"]}');
      expect(draft).toEqual({ title: 'T', reproductionSteps: ['a', 'b'] });
    });

    test('returns {} for arrays, non-objects and invalid JSON', () => {
      expect(parseBugDraft('[{"title":"T"}]')).toEqual({});
      expect(parseBugDraft('null')).toEqual({});
      expect(parseBugDraft('"text"')).toEqual({});
      expect(parseBugDraft('not json')).toEqual({});
    });
  });
});
