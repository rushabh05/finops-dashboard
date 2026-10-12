const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export const int = (v) => (v === null || v === undefined ? '—' : nf0.format(Math.round(v)));

/** micro-USD -> "$1,234" / "$12.34" / "$0.0083" */
export function usd(micro, { precise = false } = {}) {
  if (micro === null || micro === undefined || Number.isNaN(micro)) return '—';
  const v = micro / 1e6;
  const a = Math.abs(v);
  if (precise) return '$' + v.toFixed(a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
  if (a >= 1000) return '$' + nf0.format(v);
  if (a >= 100) return '$' + v.toFixed(0);
  if (a >= 1) return '$' + v.toFixed(2);
  if (a >= 0.01) return '$' + v.toFixed(3);
  if (a === 0) return '$0';
  return '$' + v.toFixed(4);
}

export function usdCompact(micro) {
  const v = micro / 1e6;
  if (v >= 1e6) return '$' + nf1.format(v / 1e6) + 'M';
  if (v >= 1e3) return '$' + nf1.format(v / 1e3) + 'K';
  if (v >= 10) return '$' + nf0.format(v);
  if (v >= 1) return '$' + v.toFixed(1).replace(/\.0$/, '');
  return v === 0 ? '$0' : '$' + v.toFixed(2);
}

export const pct = (r, d = 1) => (r === null || r === undefined ? '—' : (r * 100).toFixed(d) + '%');
export const compact = (v) => (v === null || v === undefined ? '—' : v >= 1e9 ? nf1.format(v / 1e9) + 'B' : v >= 1e6 ? nf1.format(v / 1e6) + 'M' : v >= 1e3 ? nf1.format(v / 1e3) + 'K' : nf0.format(v));
export const ms = (v) => (v === null || v === undefined ? '—' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms');

export function bytes(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
}

const pad = (n) => String(n).padStart(2, '0');
export const utcDate = (ts) => { const d = new Date(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const utcHour = (ts) => { const d = new Date(ts); return `${pad(d.getUTCHours())}:00`; };
export const utcTime = (ts) => { const d = new Date(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
export const utcStamp = (ts) => `${utcDate(ts)} ${utcTime(ts)} UTC`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const utcDow = (ts) => DOW[new Date(ts).getUTCDay()];

/** "3h ago" style, relative to the DATA clock (simulated data runs ahead of the wall clock). */
export function ago(ts, now) {
  const d = Math.max(0, now - ts);
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function signedPct(cur, prev) {
  if (prev === null || prev === undefined || prev === 0 || cur === null || cur === undefined) return null;
  return (cur - prev) / prev;
}

export const KIND_LABEL = {
  cost_spike: 'Cost spike', volume_spike: 'Traffic spike', retry_storm: 'Retry storm',
  tokens_per_request: 'Tokens per request jump', cost_per_request: 'Cost per request jump',
};
export const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium' };
export const SEV_ICON = { critical: '▲▲', high: '▲', medium: '◆' }; // shape + label: never colour alone
