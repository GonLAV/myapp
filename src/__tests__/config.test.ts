/**
 * Tests for environment-driven configuration parsing.
 */
import { getConfig, resetConfigForTests } from '../config/Config';

describe('getConfig headless', () => {
  const originalHeadless = process.env.HEADLESS;

  beforeEach(() => {
    resetConfigForTests();
  });

  afterAll(() => {
    if (originalHeadless === undefined) {
      delete process.env.HEADLESS;
    } else {
      process.env.HEADLESS = originalHeadless;
    }
    resetConfigForTests();
  });

  test('HEADLESS=false parses to false', () => {
    process.env.HEADLESS = 'false';
    expect(getConfig().headless).toBe(false);
  });

  test('HEADLESS=0 parses to false', () => {
    process.env.HEADLESS = '0';
    expect(getConfig().headless).toBe(false);
  });

  test('unset HEADLESS defaults to true', () => {
    delete process.env.HEADLESS;
    expect(getConfig().headless).toBe(true);
  });

  test('HEADLESS=true parses to true', () => {
    process.env.HEADLESS = 'true';
    expect(getConfig().headless).toBe(true);
  });
});
