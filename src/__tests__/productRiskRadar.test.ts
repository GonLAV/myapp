import { ProductRiskRadar } from '../agents/ProductRiskRadar';
import type { PageSnapshot } from '../types';

function snapshot(overrides: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: 'https://app.example.test/',
    title: 'Fake app',
    forms: [],
    inputs: [],
    buttons: [{ tag: 'button', text: 'Go', selector: '#go' }],
    links: [],
    consoleErrors: [],
    networkErrors: [],
    ...overrides,
  };
}

describe('ProductRiskRadar.analyzeSnapshot - technical_reliability evidence', () => {
  const radar = new ProductRiskRadar();

  test('reports every unique network error, without a cap of five', () => {
    const networkErrors = [
      'HTTP 500 https://app.example.test/api/a',
      'HTTP 500 https://app.example.test/api/b',
      'HTTP 404 https://app.example.test/api/c',
      'HTTP 404 https://app.example.test/api/b',
      'HTTP 500 https://app.example.test/api/a',
      'HTTP 403 https://app.example.test/api/d',
      'HTTP 502 https://app.example.test/api/e',
    ];
    const unique = Array.from(new Set(networkErrors));
    expect(unique).toHaveLength(6);

    const signals = radar.analyzeSnapshot('run-1', snapshot({ networkErrors }));
    const reliability = signals.find((s) => s.type === 'technical_reliability');

    expect(reliability).toBeDefined();
    expect(reliability?.evidence).toEqual(unique.map((e) => `Network: ${e}`));
  });

  test('keeps the Console prefix, reports all unique console errors and drops duplicates', () => {
    const consoleErrors = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a'];

    const signals = radar.analyzeSnapshot('run-1', snapshot({ consoleErrors }));
    const reliability = signals.find((s) => s.type === 'technical_reliability');

    expect(reliability?.evidence).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((e) => `Console: ${e}`));
  });
});
