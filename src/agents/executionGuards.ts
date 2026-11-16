const URL_PATTERN = /https?:\/\/\S+/gi;
const DEFAULT_WAIT_MS = 1000;

/**
 * True when the value parses as an absolute URL with an http: or https: protocol.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse the value of a `wait` step into a bounded delay in milliseconds.
 * Missing, non-numeric and negative values fall back to one second; everything is capped at maxMs.
 */
export function parseWaitMs(value: string | undefined, maxMs: number): number {
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return Math.min(DEFAULT_WAIT_MS, maxMs);
  return Math.min(parsed, maxMs);
}

/**
 * Strip the query string and fragment from every http(s) URL inside an error text, so the same
 * failure compares equal across cache-busters and session tokens.
 */
export function normalizeErrorText(entry: string): string {
  return entry.replace(URL_PATTERN, (url) => url.replace(/[?#].*$/, ''));
}

/**
 * The original entries of `all` that are not known noise.
 * Known noise is whatever the page exploration observed; entries are compared after normalizeErrorText.
 */
export function unexplainedErrors(all: string[], knownNoise: ReadonlySet<string>): string[] {
  const normalizedNoise = new Set([...knownNoise].map(normalizeErrorText));
  return all.filter((entry) => !normalizedNoise.has(normalizeErrorText(entry)));
}
