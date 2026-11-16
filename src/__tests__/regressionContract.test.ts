import ts from 'typescript';
import { RegressionContractBuilder } from '../contracts/RegressionContractBuilder';
import { getConfig } from '../config/Config';
import type { BugReport, ProductRiskSignal, TestRun, TestScenario } from '../types';

const run: TestRun = {
  id: 'run-123',
  url: 'https://example.com',
  status: 'completed',
  startedAt: '2026-04-30T00:00:00.000Z',
  completedAt: '2026-04-30T00:00:10.000Z',
  totalScenarios: 1,
  passedScenarios: 0,
  failedScenarios: 1,
  bugsFound: 1,
};

const scenario: TestScenario = {
  id: 'scenario-1',
  runId: run.id,
  title: 'Submit signup form',
  description: 'Exercises signup form',
  priority: 'high',
  status: 'failed',
  steps: [
    { action: 'navigate', value: 'https://example.com/signup', description: 'Open signup' },
    { action: 'fill', selector: '#email', value: 'qa@example.com', description: 'Fill email' },
    { action: 'click', selector: 'button:has-text("Sign up")', description: 'Submit signup' },
    { action: 'assert_url', value: '/dashboard', description: 'Expect dashboard' },
  ],
};

const bug: BugReport = {
  id: 'bug-1',
  runId: run.id,
  scenarioId: scenario.id,
  title: 'Signup does not redirect',
  severity: 'high',
  description: 'Signup submission stays on the same page.',
  reproductionSteps: ['Open signup', 'Fill email', 'Submit signup'],
  expectedBehavior: 'User lands on dashboard.',
  actualBehavior: 'User remains on signup.',
  url: 'https://example.com/signup',
  detectedAt: '2026-04-30T00:00:05.000Z',
};

const risk: ProductRiskSignal = {
  id: 'risk-1',
  runId: run.id,
  scenarioId: scenario.id,
  type: 'dead_interaction',
  title: 'Primary signup CTA has no visible effect',
  severity: 'high',
  evidence: ['URL did not change', 'DOM did not change'],
  recommendation: 'Add visible feedback or fix the handler.',
  url: 'https://example.com/signup',
  detectedAt: '2026-04-30T00:00:06.000Z',
};

describe('RegressionContractBuilder', () => {
  test('generates Playwright specs from bugs and risk signals', () => {
    const contract = new RegressionContractBuilder().build(run, [scenario], [bug], [risk]);

    expect(contract.framework).toBe('playwright');
    expect(contract.testCount).toBe(2);
    expect(contract.sourceIssueCount).toBe(1);
    expect(contract.sourceRiskCount).toBe(1);
    expect(contract.specFilename).toBe('qa-copilot-run-123.spec.ts');
    expect(contract.spec).toContain("import { test, expect } from '@playwright/test'");
    expect(contract.spec).toContain('Signup does not redirect');
    expect(contract.spec).toContain('Primary signup CTA has no visible effect');
    expect(contract.spec).toContain('await page.locator("#email").fill("qa@example.com");');
    expect(contract.spec).toContain('await expect(page).toHaveURL(new RegExp("/dashboard"));');
  });

  test('generates a baseline smoke contract when there are no findings', () => {
    const contract = new RegressionContractBuilder().build(run, [], [], []);

    expect(contract.testCount).toBe(1);
    expect(contract.spec).toContain('baseline page remains reachable');
    expect(contract.spec).toContain('await expect(page.locator(\'body\')).toBeVisible();');
  });

  test('describe title survives a quote and a backslash in run.url (F11)', () => {
    const hostile: TestRun = { ...run, url: "https://example.com/it's\\path?q='x'" };
    const contract = new RegressionContractBuilder().build(hostile, [], [], []);
    const { diagnostics } = ts.transpileModule(contract.spec, { reportDiagnostics: true });

    const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));

    expect(messages).toEqual([]);
    expect(contract.spec).toContain(JSON.stringify(`QA Copilot regression contract: ${hostile.url}`));
  });

  test.each([
    ['an invalid severity', 'catastrophic'],
    ['an undefined severity', undefined],
  ])('does not crash on %s in a stored bug and renders MEDIUM (F13)', (_label, severity) => {
    const weird = { ...bug, severity } as unknown as BugReport;
    const contract = new RegressionContractBuilder().build(run, [scenario], [weird], []);

    expect(contract.spec).toContain('1. MEDIUM - Signup does not redirect');
  });

  test.each([
    ['a lone CR', '\r'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
    ['CRLF', '\r\n'],
    ['LF', '\n'],
  ])('%s inside a note cannot turn the rest of the text into code (V2)', (_label, terminator) => {
    const hostile = { ...bug, actualBehavior: `x${terminator}globalThis.PWNED=1;//` };
    const contract = new RegressionContractBuilder().build(run, [scenario], [hostile], []);
    const { diagnostics, outputText } = ts.transpileModule(contract.spec, {
      compilerOptions: { removeComments: true },
      reportDiagnostics: true,
    });

    const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));

    expect(messages).toEqual([]);
    expect(outputText).not.toContain('globalThis.PWNED');
  });

  test.each(['abc', '-5', ''])("a wait step with value '%s' renders waitForTimeout(1000) (V6)", (value) => {
    const waiting: TestScenario = {
      ...scenario,
      steps: [{ action: 'wait', value, description: 'wait' }],
    };
    const contract = new RegressionContractBuilder().build(run, [waiting], [bug], []);

    expect(contract.spec).toContain('await page.waitForTimeout(1000);');
    expect(contract.spec).not.toContain('NaN');
  });

  test("a wait step with value '250' keeps its value (V6)", () => {
    const waiting: TestScenario = {
      ...scenario,
      steps: [{ action: 'wait', value: '250', description: 'wait' }],
    };
    const contract = new RegressionContractBuilder().build(run, [waiting], [bug], []);

    expect(contract.spec).toContain('await page.waitForTimeout(250);');
  });

  test('a long wait step is capped like the agent caps it (STEP_TIMEOUT_MS)', () => {
    const waiting: TestScenario = {
      ...scenario,
      steps: [{ action: 'wait', value: '600000', description: 'wait' }],
    };
    // Derived from the live config so a STEP_TIMEOUT_MS set in the shell does not break the test.
    const expectedCap = Math.min(600000, getConfig().stepTimeoutMs);

    expect(new RegressionContractBuilder().build(run, [waiting], [bug], []).spec)
      .toContain(`await page.waitForTimeout(${expectedCap});`);
    expect(new RegressionContractBuilder(2000).build(run, [waiting], [bug], []).spec)
      .toContain('await page.waitForTimeout(2000);');
  });
});
