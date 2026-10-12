import { HOUR, DAY, sleep } from './util.js';
import { hourLabel } from './alerts.js';

/*
 * LLM explanation of an alert. The model only ever sees AGGREGATED numbers and entity names (tenant ids, endpoint
 * paths, model names) taken from rollups and the alert row - never request ids, payloads or per-request rows.
 */

const money = (micro) => `$${(micro / 1e6).toFixed(micro >= 1e8 ? 0 : 2)}`;

export function buildExplainContext(db, alert) {
  const t = alert.tenant_id;
  const e = alert.endpoint;
  const H = alert.hour ?? Math.floor(alert.ts / HOUR) * HOUR;
  const where = [];
  const params = [];
  if (t) { where.push('tenant_id = ?'); params.push(t); }
  if (e) { where.push('endpoint = ?'); params.push(e); }
  const scope = where.length ? ' AND ' + where.join(' AND ') : '';

  const series = db
    .prepare(`SELECT hour, SUM(requests) AS requests, SUM(cost_micro_usd) AS cost, SUM(tokens_in + tokens_out) AS tokens FROM rollups_hourly WHERE hour BETWEEN ? AND ?${scope} GROUP BY hour ORDER BY hour`)
    .all(H - 11 * HOUR, H, ...params)
    .map((r) => ({ hour: hourLabel(r.hour).slice(11, 16), requests: r.requests, cost_usd: +(r.cost / 1e6).toFixed(3), tokens_per_request: r.requests ? Math.round(r.tokens / r.requests) : null }));

  // same hour on previous days, for the typical level
  const dayAgo = db
    .prepare(`SELECT SUM(requests) AS requests, SUM(cost_micro_usd) AS cost, SUM(tokens_in + tokens_out) AS tokens FROM rollups_hourly WHERE hour IN (?,?,?)${scope}`)
    .get(H - DAY, H - 2 * DAY, H - 3 * DAY, ...params);

  const breakdownBy = e && !t ? 'tenant_id' : t && !e ? 'endpoint' : 'model';
  const breakdown = db
    .prepare(`SELECT ${breakdownBy} AS name, SUM(cost_micro_usd) AS cost, SUM(requests) AS requests, SUM(llm_calls) AS calls, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout FROM rollups_hourly WHERE hour = ?${scope} GROUP BY 1 ORDER BY cost DESC LIMIT 5`)
    .all(H, ...params)
    .map((r) => ({ name: r.name === '' ? '(infra only)' : r.name, cost_usd: +(r.cost / 1e6).toFixed(3), requests: r.requests, llm_calls: r.calls, avg_input_tokens_per_call: r.calls ? Math.round(r.tin / r.calls) : null, avg_output_tokens_per_call: r.calls ? Math.round(r.tout / r.calls) : null }));

  const models = db
    .prepare(`SELECT model AS name, SUM(cost_micro_usd) AS cost, SUM(llm_calls) AS calls FROM rollups_hourly WHERE hour = ? AND model <> ''${scope} GROUP BY model ORDER BY cost DESC`)
    .all(H, ...params)
    .map((r) => ({ model: r.name, cost_usd: +(r.cost / 1e6).toFixed(3), calls: r.calls }));

  const d = alert.detail || {};
  return {
    alert: {
      kind: alert.kind, tenant: t ?? 'all tenants', endpoint: e ?? 'all endpoints', hour_utc: hourLabel(H),
      observed: alert.observed, baseline: alert.baseline, robust_z: +alert.score.toFixed(1), summary: alert.explanation,
      severity: alert.severity,
    },
    metrics: d.metrics ? Object.fromEntries(Object.entries(d.metrics).map(([k, v]) => [k, { observed: +v.observed.toFixed(2), typical: +v.baseline.toFixed(2), ratio: Number.isFinite(v.ratio) ? +v.ratio.toFixed(2) : null }])) : null,
    failed_request_share: d.error_share ?? null,
    failed_request_share_prior_day: d.error_share_prior_day ?? null,
    top_contributor: d.top_contributor ? { tenant: d.top_contributor.tenant, endpoint: d.top_contributor.endpoint } : null,
    last_12_hours: series,
    same_hour_previous_3_days_avg: { requests: dayAgo.requests ? Math.round(dayAgo.requests / 3) : 0, cost_usd: +((dayAgo.cost ?? 0) / 3e6).toFixed(3) },
    breakdown_by: breakdownBy === 'tenant_id' ? 'tenant' : breakdownBy,
    breakdown_in_alert_hour: breakdown,
    model_mix_in_alert_hour: models,
  };
}

export const SYSTEM_PROMPT = [
  'You are a FinOps analyst for an LLM platform. You get aggregated cost numbers and entity names for one anomaly.',
  'You never see raw requests or customer content, so do not speculate about payloads.',
  'Explain in plain English why this anomaly likely happened, grounded in the numbers given, then list the 3 most useful things to check next.',
  'Be concrete and brief: under 170 words, plain text, no markdown tables or headings, short lines starting with "- " for the checks.',
].join(' ');

export function buildPrompt(ctx) {
  return {
    system: SYSTEM_PROMPT,
    user: `Anomaly data (aggregated, JSON):\n${JSON.stringify(ctx, null, 1)}\n\nWhy did this spike, and what should I check?`,
  };
}

/* ------------------------------------------------------------------ deterministic mock model */

const KIND_TEXT = {
  cost_spike: {
    why: (c) => `Spend is ${ratio(c)} the typical level for this hour, and the move is split between more requests and more expensive requests rather than one single cause. That pattern usually means a runaway job or batch process, or a change that made each call heavier at the same time as traffic grew.`,
    checks: ['Compare the top endpoints in the breakdown with their normal share: the endpoint that grew most is where to start.', 'Look for a new client, scheduled job or backfill that started around this hour.', 'Check whether prompts, max output length or the model for this tenant changed recently.'],
  },
  volume_spike: {
    why: (c) => `Request volume is ${ratio(c)} the typical level while per-request cost is roughly unchanged, so this is more traffic, not heavier traffic. Only ${pct(c.failed_request_share)} of the requests failed, which points to a new or misbehaving client rather than a retry loop.`,
    checks: ['Identify the caller: a new integration, a load test or a scraper hitting the endpoint.', 'Check rate limits and quotas for this tenant; a cap would bound the spend.', 'Confirm the traffic is expected (a launch or campaign) before treating it as an incident.'],
  },
  retry_storm: {
    why: (c) => `Requests are ${ratio(c)} the typical level and ${pct(c.failed_request_share)} of them failed with 429 or 5xx (normally about ${pct(c.failed_request_share_prior_day)}). Failed attempts are being retried aggressively, and some of those retries still reach the model and bill tokens.`,
    checks: ['Look at the client retry policy: exponential backoff with jitter and a retry budget.', 'Find the upstream failure that started it (errors on the endpoint, a provider outage or rate limiting).', 'Consider a circuit breaker or a temporary rate limit for this tenant while it is fixed.'],
  },
  tokens_per_request: {
    why: (c) => `Tokens per request are ${ratio(c)} the typical level while traffic is flat, so each call is carrying far more context. That is the signature of prompt bloat: a longer system prompt, more retrieved documents, or conversation history that is no longer being trimmed.`,
    checks: ['Diff the most recent prompt template or retrieval settings against the last known good one.', 'Check whether conversation history truncation or summarisation stopped working.', 'Check prompt-cache hit rate; cached tokens are far cheaper, so a cache break makes the same prompt cost more.'],
  },
  cost_per_request: {
    why: (c) => `Cost per request is ${ratio(c)} the typical level with flat traffic. Token counts alone do not explain all of it, so look at the model mix and caching: a switch to a pricier model or a drop in cached input would produce this.`,
    checks: ['Check the model mix in the alert hour against the previous days.', 'Check cached-token share for this entity; a prompt change can invalidate the cache prefix.', 'Check for longer outputs (a changed max_tokens or a more verbose instruction).'],
  },
};

function ratio(c) {
  const a = c.alert;
  const r = a.baseline > 0 ? a.observed / a.baseline : null;
  return r ? `${r.toFixed(1)}x` : 'well above';
}
function pct(v) { return v == null ? 'a few percent' : `${Math.round(v * 100)}%`; }

export function mockExplanationText(ctx) {
  const a = ctx.alert;
  const k = KIND_TEXT[a.kind] || KIND_TEXT.cost_spike;
  const who = a.tenant !== 'all tenants' && a.endpoint !== 'all endpoints' ? `${a.tenant} on ${a.endpoint}` : a.tenant !== 'all tenants' ? `tenant ${a.tenant}` : `endpoint ${a.endpoint}`;
  const top = ctx.breakdown_in_alert_hour[0];
  const lines = [
    `Why: ${who} in the hour starting ${a.hour_utc}. ${k.why(ctx)}`,
    top ? `The largest line in that hour is ${top.name} at ${money(top.cost_usd * 1e6)} over ${top.requests || top.llm_calls} ${top.requests ? 'requests' : 'calls'}.` : '',
    '',
    'What to check:',
    ...k.checks.map((x) => `- ${x}`),
    '',
    'This explanation was generated by the deterministic mock model from aggregated numbers only.',
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

/**
 * Deterministic mock "model": same alert => same text. Yields word-sized chunks at ~tokensPerSec after a short
 * simulated time-to-first-token. Abortable via `signal`.
 */
export async function* mockSource(ctx, { tokensPerSec = 40, startupMs = 150, signal, repeat = 1 } = {}) {
  const once = mockExplanationText(ctx);
  // `repeat` > 1 is a stress option for the backpressure lab: the same text again and again, numbered
  const text = repeat > 1 ? Array.from({ length: repeat }, (_, i) => `[pass ${i + 1} of ${repeat}]\n${once}`).join('\n\n') : once;
  const chunks = text.match(/\S+\s*|\s+/g) || [];
  const abortableSleep = (ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  if (startupMs) await abortableSleep(startupMs);
  const perTick = Math.max(1, Math.ceil(tokensPerSec / 100)); // up to 100 timer ticks a second
  const tickMs = (perTick / tokensPerSec) * 1000;
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw abortError();
    yield chunks[i];
    if ((i + 1) % perTick === 0) await abortableSleep(tickMs);
  }
}

function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

/* ------------------------------------------------------------------ Anthropic streaming source (raw HTTP, no SDK) */

/** Incremental SSE parser over an async iterable of Buffers/Uint8Arrays. Yields { event, data } (data parsed as JSON when possible). */
export async function* parseSse(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const ev = parseSseBlock(raw);
      if (ev) yield ev;
    }
  }
  buf += dec.decode();
  if (buf.trim()) { const ev = parseSseBlock(buf); if (ev) yield ev; }
}

function parseSseBlock(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  const text = data.join('\n');
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  return { event, data: parsed };
}

/**
 * Streams text deltas from POST {baseUrl}/v1/messages (Messages API, stream: true).
 * Pausing = not pulling from this generator: the HTTP body is then not read, so TCP flow control pushes back upstream.
 */
export async function* anthropicSource({ apiKey, model, baseUrl = 'https://api.anthropic.com', system, user, maxTokens = 1500, effort = 'low', signal, fetchImpl = fetch }) {
  const body = { model, max_tokens: maxTokens, stream: true, system, messages: [{ role: 'user', content: user }] };
  if (effort) body.output_config = { effort }; // short answer: keep thinking light so the first token comes fast
  const res = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Anthropic API ${res.status}${detail ? `: ${detail.replace(apiKey, '***')}` : ''}`);
  }
  // Newer models think by default and thinking tokens count against max_tokens, so a small budget can be spent entirely on
  // thinking: that must surface as an error, not as a silently empty explanation.
  let yielded = 0, stopReason = null;
  const nothing = () => new Error(stopReason === 'max_tokens'
    ? `the model used its whole token budget (max_tokens=${maxTokens}) before writing any text - raise ANTHROPIC_MAX_TOKENS or lower ANTHROPIC_EFFORT`
    : 'the model returned no text');
  for await (const ev of parseSse(res.body)) {
    const d = ev.data;
    if (ev.event === 'content_block_delta' && d?.delta?.type === 'text_delta' && typeof d.delta.text === 'string') { yielded += d.delta.text.length; yield d.delta.text; }
    else if (ev.event === 'error') throw new Error(`Anthropic stream error: ${d?.error?.type || 'unknown'}${d?.error?.message ? ` - ${d.error.message}` : ''}`);
    else if (ev.event === 'message_delta' && d?.delta?.stop_reason === 'refusal') throw new Error('the model declined to answer');
    else if (ev.event === 'message_delta' && d?.delta?.stop_reason) stopReason = d.delta.stop_reason;
    else if (ev.event === 'message_stop') break;
  }
  if (!yielded) throw nothing();
}

export { sleep };
