import { severityOf } from './alerts.js';

/*
 * Alert notifications: when the detector raises a NEW alert, post it to a webhook (Slack, Discord, or anything that takes JSON).
 *
 *   ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...   ALERT_WEBHOOK_FORMAT=auto|slack|discord|json
 *
 * Design rules:
 *  - The URL is a secret (a Slack webhook URL is a password). It is never logged - only its host - and a plain-http URL is refused unless it
 *    points at this machine.
 *  - Delivery never blocks or breaks detection: notify() returns at once, a worker sends one message at a time, a failure is logged and counted.
 *  - Redirects are not followed (a webhook endpoint has no reason to redirect, and following one would send the alert somewhere nobody configured).
 *  - Only what the dashboard already shows is sent: kind, severity, tenant, endpoint, numbers and the explanation. Never request ids or rows.
 */
const KIND_LABEL = {
  cost_spike: 'Cost spike', volume_spike: 'Traffic spike', retry_storm: 'Retry storm',
  tokens_per_request: 'Tokens per request jump', cost_per_request: 'Cost per request jump',
};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const FORMATS = ['auto', 'slack', 'discord', 'json'];

/** Validate the configured URL and pick a payload format. Errors never contain the URL itself. */
export function parseWebhookUrl(raw, format = 'auto') {
  if (!FORMATS.includes(format)) throw new Error(`ALERT_WEBHOOK_FORMAT must be one of ${FORMATS.join(', ')}`);
  let u;
  try { u = new URL(raw); } catch { throw new Error('ALERT_WEBHOOK_URL is not a valid URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error('ALERT_WEBHOOK_URL must be https (plain http is only accepted for localhost): the URL is a secret and the alert text is business data');
  }
  const host = u.hostname.toLowerCase();
  let fmt = format;
  if (fmt === 'auto') fmt = host === 'hooks.slack.com' || host.endsWith('.slack.com') ? 'slack' : /(^|\.)discord(app)?\.com$/.test(host) && u.pathname.startsWith('/api/webhooks/') ? 'discord' : 'json';
  return { url: u.toString(), host, format: fmt };
}

const usd = (micro) => `$${(micro / 1e6).toFixed(micro >= 1e8 ? 0 : 2)}`;
function figures(a) {
  const ratio = a.baseline > 0 ? `${(a.observed / a.baseline).toFixed(1)}x` : 'new';
  if (a.kind === 'cost_spike' || a.kind === 'cost_per_request') return `${usd(a.observed)} vs typical ${usd(a.baseline)} (${ratio})`;
  if (a.kind === 'tokens_per_request') return `${Math.round(a.observed).toLocaleString('en-US')} vs typical ${Math.round(a.baseline).toLocaleString('en-US')} tokens per request (${ratio})`;
  return `${Math.round(a.observed).toLocaleString('en-US')} vs typical ${Math.round(a.baseline).toLocaleString('en-US')} requests (${ratio})`;
}

/** The human-readable message, shared by every format. */
export function describeAlert(alert, source) {
  const severity = severityOf(alert);
  const where = `${alert.tenant_id ? `tenant ${alert.tenant_id}` : 'all tenants'} · ${alert.endpoint || 'all endpoints'}`;
  const title = `${severity.toUpperCase()}: ${KIND_LABEL[alert.kind] ?? alert.kind}, ${where}`;
  return { severity, title, figures: figures(alert), explanation: alert.explanation || '', source };
}

export function buildPayload(format, alert, source) {
  const d = describeAlert(alert, source);
  const lines = [d.title, d.figures, d.explanation, `source: ${source}`].filter(Boolean);
  if (format === 'slack') return { text: `*${d.title}*\n${[d.figures, d.explanation].filter(Boolean).join('\n')}\n_source: ${source}_` };
  if (format === 'discord') return { content: `**${d.title}**\n${[d.figures, d.explanation].filter(Boolean).join('\n')}\n*source: ${source}*`.slice(0, 2000) };
  return {
    event: 'finops.alert', source, text: lines.join('\n'),
    alert: {
      id: alert.id, kind: alert.kind, severity: d.severity, tenant: alert.tenant_id ?? null, endpoint: alert.endpoint ?? null,
      observed: alert.observed, baseline: alert.baseline, score: alert.score, hour: alert.hour, explanation: alert.explanation || '',
    },
  };
}

export class Notifier {
  constructor({ url, format = 'auto', source = 'finops', fetchImpl = globalThis.fetch, log = () => {}, timeoutMs = 5000, retryDelayMs = 1000, maxQueue = 100 }) {
    const p = parseWebhookUrl(url, format);
    this.target = p.url; this.host = p.host; this.format = p.format;
    this.source = source; this.fetch = fetchImpl; this.log = log;
    this.timeoutMs = timeoutMs; this.retryDelayMs = retryDelayMs; this.maxQueue = maxQueue;
    this.queue = []; this.working = null; this.reported = 0;
    this.stats = { sent: 0, failed: 0, dropped: 0 };
  }

  /** Queue new alerts; returns immediately. */
  notify(alerts) {
    for (const a of alerts) {
      if (this.queue.length >= this.maxQueue) { this.queue.shift(); this.stats.dropped++; }
      this.queue.push(buildPayload(this.format, a, this.source));
    }
    if (!this.working && this.queue.length) this.working = this.#drain();
  }

  async #drain() {
    try {
      while (this.queue.length) {
        const r = await this.deliver(this.queue.shift());
        if (r.ok) this.stats.sent++;
        else { this.stats.failed++; this.log(`alert webhook (${this.host}) failed: ${r.error || `HTTP ${r.status}`}`); }
      }
      const missed = this.stats.dropped - this.reported; // a flood overflowed the queue: say so once, instead of silently losing alerts
      if (missed > 0) {
        this.reported = this.stats.dropped;
        const r = await this.deliver(this.#plain(`${missed} more alert${missed === 1 ? '' : 's'} were not sent because too many arrived at once. Open the dashboard for the full list. (source: ${this.source})`));
        if (!r.ok) this.log(`alert webhook (${this.host}) failed: ${r.error || `HTTP ${r.status}`}`);
      }
    } finally { this.working = null; }
  }

  #plain(text, event = 'finops.notice') {
    return this.format === 'slack' ? { text } : this.format === 'discord' ? { content: text } : { event, source: this.source, text };
  }

  /** One POST with one retry (network error, 429, 5xx). Resolves to { ok, status?, error? }; never throws. */
  async deliver(body) {
    let last = { ok: false, error: 'not attempted' };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      try {
        const res = await this.fetch(this.target, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
        });
        await res.body?.cancel?.().catch(() => {});
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
        last = { ok: false, status: res.status, error: res.status >= 300 && res.status < 400 ? `HTTP ${res.status} (redirects are not followed)` : `HTTP ${res.status}` };
        if (res.status !== 429 && res.status < 500) return last;
      } catch (e) {
        last = { ok: false, error: e?.name === 'TimeoutError' ? `no answer within ${this.timeoutMs} ms` : String(e?.cause?.code || e?.message || e).replace(this.target, '<url>') };
      }
    }
    return last;
  }

  /** A clearly labelled message, to check the configuration (`finops check-webhook`). */
  sendTest() {
    const text = `Test message from the FinOps dashboard (source: ${this.source}). If you can read this, alert notifications are configured correctly.`;
    return this.deliver(this.#plain(text, 'finops.test'));
  }

  /** Resolves when the queue is empty (tests, shutdown); gives up after `timeoutMs`. */
  async idle(timeoutMs = 5000) {
    const t0 = Date.now();
    while (this.working && Date.now() - t0 < timeoutMs) await Promise.race([this.working, new Promise((r) => setTimeout(r, 25))]);
  }
}
