export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isInt = (v, min = -Infinity, max = Infinity) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(values, med = median(values)) {
  if (!values.length) return NaN;
  return median(values.map((v) => Math.abs(v - med)));
}

export const usd = (micro) => micro / 1e6;
