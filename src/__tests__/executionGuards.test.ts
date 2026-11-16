/**
 * Tests for the pure execution guards used by the QA agent.
 */
import {
  isHttpUrl,
  parseWaitMs,
  normalizeErrorText,
  unexplainedErrors,
} from '../agents/executionGuards';

describe('isHttpUrl', () => {
  test('accepts http and https URLs', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://example.com/path?q=1')).toBe(true);
  });

  test('rejects file, javascript and data URLs', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<h1>x</h1>')).toBe(false);
  });

  test('rejects unparseable values', () => {
    expect(isHttpUrl('not-a-url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('parseWaitMs', () => {
  test('returns the default 1000 for NaN, negative and undefined', () => {
    expect(parseWaitMs('abc', 10_000)).toBe(1000);
    expect(parseWaitMs('-5', 10_000)).toBe(1000);
    expect(parseWaitMs(undefined, 10_000)).toBe(1000);
  });

  test('caps the default at maxMs', () => {
    expect(parseWaitMs(undefined, 500)).toBe(500);
  });

  test('returns the parsed value when within the cap', () => {
    expect(parseWaitMs('250', 10_000)).toBe(250);
  });

  test('caps large values at maxMs', () => {
    expect(parseWaitMs('999999', 10_000)).toBe(10_000);
  });
});

describe('normalizeErrorText', () => {
  test('strips the query string and fragment from http(s) URLs inside the text', () => {
    expect(normalizeErrorText('HTTP 404 https://a.test/img.png?cb=1')).toBe('HTTP 404 https://a.test/img.png');
    expect(normalizeErrorText('HTTP 404 http://a.test/img.png#top')).toBe('HTTP 404 http://a.test/img.png');
    expect(normalizeErrorText('GET https://a.test/x?y=1#z \u2014 net::ERR_FAILED')).toBe(
      'GET https://a.test/x \u2014 net::ERR_FAILED',
    );
  });

  test('leaves text without URLs, and non-http URLs, unchanged', () => {
    expect(normalizeErrorText('TypeError: x is undefined')).toBe('TypeError: x is undefined');
    expect(normalizeErrorText('blocked data:text/html,a?b')).toBe('blocked data:text/html,a?b');
  });
});

describe('unexplainedErrors', () => {
  test('drops entries that match known noise after normalization, whatever the cache-buster', () => {
    const noise = new Set(['HTTP 404 https://a.test/img.png?cb=1']);
    const all = ['HTTP 404 https://a.test/img.png?cb=2', 'HTTP 404 https://a.test/img.png'];
    expect(unexplainedErrors(all, noise)).toEqual([]);
  });

  test('keeps a favicon error that is not in known noise', () => {
    const all = ['HTTP 404 https://x/favicon.ico?v=2'];
    expect(unexplainedErrors(all, new Set())).toEqual(all);
    expect(unexplainedErrors(all, new Set(['HTTP 404 https://x/other.png']))).toEqual(all);
  });

  test('drops a favicon error that is in known noise, whatever its ?v= value', () => {
    const noise = new Set(['HTTP 404 https://x/favicon.ico?v=1']);
    const all = ['HTTP 404 https://x/favicon.ico?v=2', 'HTTP 404 https://x/favicon.ico'];
    expect(unexplainedErrors(all, noise)).toEqual([]);
  });

  test('keeps unrelated errors and returns the original, non-normalized text', () => {
    const noise = new Set(['HTTP 404 https://a.test/img.png?cb=1']);
    const all = ['HTTP 500 https://a.test/api/session?id=7', 'TypeError: x is undefined'];
    expect(unexplainedErrors(all, noise)).toEqual(all);
  });
});
