import { EventEmitter } from 'node:events';
import { HOUR, hourOf } from './util.js';
import { transaction } from './db.js';

/* ------------------------------------------------------------------ seeded randomness */

export class Rng {
  constructor(seed) { this.s = seed >>> 0; }
  next() { // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  normal() {
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  lognormal(sigma) { return Math.exp(sigma * this.normal() - (sigma * sigma) / 2); } // mean 1
  poisson(l) {
    if (l <= 0) return 0;
    if (l < 30) {
      const L = Math.exp(-l);
      let k = 0, p = 1;
      do { k++; p *= this.next(); } while (p > L);
      return k - 1;
    }
    return Math.max(0, Math.round(l + Math.sqrt(l) * this.normal()));
  }
}

function hash3(seed, a, b) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ a, 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/* ------------------------------------------------------------------ the world */

export const TENANTS = [
  { id: 'acme', w: 1.0, phase: 0 },
  { id: 'globex', w: 0.8, phase: 2 },
  { id: 'initech', w: 0.6, phase: -1 },
  { id: 'umbrella', w: 0.45, phase: 3 },
  { id: 'hooli', w: 0.3, phase: 5 },
  { id: 'stark', w: 0.2, phase: -3 },
  { id: 'wayne', w: 0.12, phase: 1 },
  { id: 'wonka', w: 0.08, phase: 8 },
];

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

// plan: LLM stages per request. in/out are mean tokens; cache = probability the prompt prefix is cached.
export const ENDPOINTS = [
  { path: '/v1/chat', method: 'POST', w: 1.0, infra: 900, plan: [{ model: SONNET, in: 1800, out: 350, cache: 0.6 }] },
  { path: '/v1/chat/stream', method: 'POST', w: 0.7, infra: 1400, plan: [{ model: SONNET, in: 1500, out: 500, cache: 0.6 }] },
  { path: '/v1/summarize', method: 'POST', w: 0.6, infra: 700, plan: [{ model: HAIKU, in: 3500, out: 300, cache: 0.2 }] },
  { path: '/v1/classify', method: 'POST', w: 0.8, infra: 300, plan: [{ model: HAIKU, in: 400, out: 20, cache: 0.7 }] },
  { path: '/v1/tag', method: 'POST', w: 0.5, infra: 300, plan: [{ model: HAIKU, in: 300, out: 60, cache: 0.7 }] },
  { path: '/v1/rag/answer', method: 'POST', w: 0.5, infra: 1800, plan: [{ model: SONNET, in: 6000, out: 400, cache: 0.8 }] },
  { path: '/v1/agents/run', method: 'POST', w: 0.25, infra: 2500,
    plan: [{ model: OPUS, in: 4000, out: 800, cache: 0.5 }, { model: HAIKU, in: 800, out: 100, cache: 0.5, n: [1, 3] }] },
  { path: '/v1/extract', method: 'POST', w: 0.4, infra: 600, plan: [{ model: HAIKU, in: 2500, out: 250, cache: 0.3 }] },
  { path: '/v1/translate', method: 'POST', w: 0.3, infra: 500, plan: [{ model: HAIKU, in: 700, out: 700, cache: 0.1 }] },
  { path: '/v1/code/review', method: 'POST', w: 0.15, infra: 1500, plan: [{ model: OPUS, in: 8000, out: 1200, cache: 0.5 }] },
  { path: '/v1/moderate', method: 'POST', w: 0.7, infra: 200, plan: [{ model: HAIKU, in: 250, out: 10, cache: 0.8 }] },
  { path: '/v1/search/rerank', method: 'GET', w: 0.35, infra: 800, plan: [{ model: HAIKU, in: 1200, out: 30, cache: 0.5, p: 0.4 }] },
];

// tokens-per-second by model, for synthetic latency
const SPEED = { [HAIKU]: 160, [SONNET]: 80, [OPUS]: 50 };

export const ANOMALY_KINDS = ['tenant_cost_spike', 'token_bloat', 'retry_storm'];

/** Default injected anomalies (tenant/endpoint chosen so they never overlap). */
export const ANOMALY_DEFAULTS = {
  tenant_cost_spike: { tenant: 'globex' },
  token_bloat: { endpoint: '/v1/chat' },
  retry_storm: { tenant: 'acme', endpoint: '/v1/classify' },
};

/** The effect an injection has on one (tenant, endpoint) pair, or null if it does not apply. */
function effectOf(inj, tenant, endpoint) {
  switch (inj.kind) {
    case 'tenant_cost_spike': // runaway batch job: more requests with bigger prompts and outputs
      return inj.tenant === tenant ? { vol: 1.8, tin: 2.5, tout: 2.5 } : null;
    case 'token_bloat': // prompt bloat: tokens per request triple, traffic flat
      return inj.endpoint === endpoint ? { vol: 1, tin: 3, tout: 3 } : null;
    case 'retry_storm': // a client hammering one endpoint: 8x requests, mostly failing, failed attempts still hit the model
      return inj.tenant === tenant && inj.endpoint === endpoint ? { vol: 8, fail: 0.8, failCallP: 0.5 } : null;
    default: return null;
  }
}

export class TrafficGenerator {
  constructor({ seed = 42, volumeScale = 1, injections = [], idPrefix } = {}) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed ^ 0xa5a5a5a5);
    this.volumeScale = volumeScale;
    this.injections = [...injections];
    this.counter = 0;
    this.idPrefix = idPrefix ?? `s${this.seed.toString(36)}`;
    const BASE = 40 * volumeScale; // requests/hour of the biggest tenant x endpoint pair at average season
    this.pairs = [];
    TENANTS.forEach((t, ti) => {
      ENDPOINTS.forEach((e, ei) => {
        const h = hash3(this.seed, ti + 1, ei + 101) / 4294967296;
        const affinity = h < 0.12 ? 0 : 0.4 + 0.9 * ((h - 0.12) / 0.88); // 12% of pairs unused
        const base = BASE * t.w * e.w * affinity;
        if (base > 0) this.pairs.push({ tenant: t, ep: e, ti, base });
      });
    });
  }

  addInjection(inj) { this.injections.push(inj); }

  /** Daily seasonality, mean 1, per-tenant phase shift (hours). */
  static season(ts, phaseHours) {
    const hod = (ts % (24 * HOUR)) / HOUR;
    return 1 + 0.5 * Math.sin((2 * Math.PI * (hod + phaseHours - 8)) / 24);
  }

  _fx(tenant, endpoint, ts) {
    let vol = 1, tin = 1, tout = 1, fail = 0, failCallP = 1;
    for (const inj of this.injections) {
      if (ts < inj.startTs || ts >= inj.endTs) continue;
      const e = effectOf(inj, tenant, endpoint);
      if (!e) continue;
      vol *= e.vol ?? 1; tin *= e.tin ?? 1; tout *= e.tout ?? 1;
      if (e.fail) { fail = Math.max(fail, e.fail); failCallP = e.failCallP ?? 1; }
    }
    return { vol, tin, tout, fail, failCallP };
  }

  /** Expected requests per millisecond across all pairs at `ts`, ignoring injections (drives the simulated clock). */
  expectedPerMs(ts) {
    let sum = 0;
    for (const p of this.pairs) sum += p.base * TrafficGenerator.season(ts, p.tenant.phase);
    return sum / HOUR;
  }

  /** Generate requests (ingest format, no LLM cost - that is computed at ingest) for ts in [t0, t1). */
  generate(t0, t1) {
    const out = [];
    const mid = (t0 + t1) / 2;
    const hourIdx = Math.floor(mid / HOUR);
    const hours = (t1 - t0) / HOUR;
    for (const p of this.pairs) {
      const shock = Math.exp(0.05 * gaussFromHash(this.seed, p.ti + 7, hourIdx) - 0.00125);
      const fx = this._fx(p.tenant.id, p.ep.path, mid);
      const lambda = p.base * TrafficGenerator.season(mid, p.tenant.phase) * shock * fx.vol * hours;
      const n = this.rng.poisson(lambda);
      for (let i = 0; i < n; i++) out.push(this._request(p, t0 + Math.floor(this.rng.next() * (t1 - t0)), fx));
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  _request(p, ts, fx) {
    const r = this.rng;
    const id = `r${this.idPrefix}${ts.toString(36)}${(this.counter++).toString(36)}`;
    const failed = fx.fail > 0 && r.next() < fx.fail;
    let status = 200;
    if (failed) status = [503, 503, 429, 500][r.int(4)];
    else {
      const u = r.next();
      if (u < 0.015) status = 400; else if (u < 0.02) status = 429; else if (u < 0.026) status = 500; else if (u < 0.03) status = 503;
    }
    const calls = [];
    let latency = 0;
    if (!failed || r.next() < fx.failCallP) {
      for (const stage of p.ep.plan) {
        if (stage.p !== undefined && r.next() >= stage.p) continue;
        const n = stage.n ? stage.n[0] + r.int(stage.n[1] - stage.n[0] + 1) : 1;
        for (let k = 0; k < n; k++) {
          const input = Math.max(1, Math.round(stage.in * fx.tin * r.lognormal(0.5)));
          let output = Math.max(1, Math.round(stage.out * fx.tout * r.lognormal(0.5) * (failed ? 0.15 : 1)));
          const cached = r.next() < stage.cache ? Math.min(input, Math.round(input * (0.5 + 0.4 * r.next()))) : 0;
          const lat = Math.round(180 + (output / SPEED[stage.model]) * 1000 * r.lognormal(0.25));
          latency += lat;
          calls.push({ model: stage.model, input_tokens: input, output_tokens: output, cached_tokens: cached, latency_ms: lat });
        }
      }
    }
    return {
      id, ts, tenant_id: p.tenant.id, endpoint: p.ep.path, method: p.ep.method, status,
      duration_ms: latency + 15 + r.int(60),
      infra_cost_micro_usd: Math.round(p.ep.infra * r.lognormal(0.2)),
      llm_calls: calls,
    };
  }
}

function gaussFromHash(seed, a, b) {
  const r = new Rng(hash3(seed, a, b));
  return r.normal();
}

/* ------------------------------------------------------------------ history seeding */

/** Fill [endTs - days, endTs) hour by hour through the real ingest path. Returns counts. */
export function seedHistory(ingestor, { seed = 42, days = 30, endTs, volumeScale = 1, injections = [], chunk = 1000, idPrefix } = {}) {
  const gen = new TrafficGenerator({ seed, volumeScale, injections, idPrefix });
  const start = endTs - days * 24 * HOUR;
  let requests = 0, calls = 0;
  for (let day = start; day < endTs; day += 24 * HOUR) { // one commit per simulated day keeps the WAL small
    transaction(ingestor.db, () => {
      for (let h = day; h < Math.min(day + 24 * HOUR, endTs); h += HOUR) {
        const batch = gen.generate(h, h + HOUR);
        for (let i = 0; i < batch.length; i += chunk) {
          const r = ingestor.write(ingestor.validate({ requests: batch.slice(i, i + chunk) }));
          requests += r.accepted;
          calls += r.llm_calls;
        }
      }
    });
  }
  return { requests, llm_calls: calls, start, end: endTs };
}

/* ------------------------------------------------------------------ live simulator */

/** Schedule of anomalies relative to the live start, in simulated hours. */
export const AUTO_SCHEDULE = [
  { kind: 'tenant_cost_spike', offsetHours: 1.5, durationHours: 2 },
  { kind: 'token_bloat', offsetHours: 5, durationHours: 2 },
  { kind: 'retry_storm', offsetHours: 8.5, durationHours: 2 },
];

/**
 * Drives the generator in (simulated) time. `rate` is requests written per REAL second; the simulated clock
 * advances by however much simulated time that many requests represent (so a higher rate also means a faster clock).
 */
export class Simulator extends EventEmitter {
  constructor({ ingestor, seed = 42, volumeScale = 1, rate = 40, tickMs = 200, startTs, autoAnomalies = true, maxBatch = 1000 }) {
    super();
    this.ingestor = ingestor;
    this.maxBatch = maxBatch;
    this.rate = rate;
    this.tickMs = tickMs;
    this.simNow = startTs;
    this.startTs = startTs;
    this.budget = 0;
    this.timer = null;
    this.running = false;
    this.written = 0;
    this.errors = 0;
    this.gen = new TrafficGenerator({ seed: seed + 1, volumeScale, idPrefix: `L${Date.now().toString(36)}` });
    this.injected = [];
    if (autoAnomalies) {
      for (const s of AUTO_SCHEDULE) this.inject(s.kind, { startTs: startTs + s.offsetHours * HOUR, hours: s.durationHours, auto: true });
    }
  }

  inject(kind, { hours = 2, startTs, tenant, endpoint, auto = false } = {}) {
    if (!ANOMALY_KINDS.includes(kind)) throw new RangeError(`unknown anomaly kind ${kind}`);
    const s = startTs ?? this.simNow;
    const inj = { kind, ...ANOMALY_DEFAULTS[kind], startTs: s, endTs: s + hours * HOUR, auto };
    if (tenant) inj.tenant = tenant;
    if (endpoint) inj.endpoint = endpoint;
    this.gen.addInjection(inj);
    this.injected.push(inj);
    return inj;
  }

  setRate(r) { this.rate = r; }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = Date.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = Date.now();
    const elapsed = Math.min(1000, now - this.last);
    this.last = now;
    this.budget += (this.rate * elapsed) / 1000;
    const n = Math.floor(this.budget);
    if (n < 1) return;
    this.budget -= n;
    const dt = Math.max(1, Math.round(n / this.gen.expectedPerMs(this.simNow)));
    const t0 = this.simNow;
    const batch = this.gen.generate(t0, t0 + dt);
    this.simNow = t0 + dt;
    if (!batch.length) return;
    try {
      for (let i = 0; i < batch.length; i += this.maxBatch) {
        const res = this.ingestor.write(this.ingestor.validate({ requests: batch.slice(i, i + this.maxBatch) }));
        this.written += res.accepted;
      }
      this.emit('write', { count: batch.length, simNow: this.simNow });
    } catch (e) {
      this.errors++;
      this.emit('error', e);
    }
  }

  status() {
    return {
      running: this.running, rate: this.rate, sim_now: this.simNow, written: this.written, errors: this.errors,
      anomalies: this.injected.map((i) => ({ kind: i.kind, tenant: i.tenant ?? null, endpoint: i.endpoint ?? null, start_ts: i.startTs, end_ts: i.endTs, active: this.simNow >= i.startTs && this.simNow < i.endTs, auto: i.auto })),
    };
  }
}

export { hourOf };
