import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

/** All runtime configuration. Every value can be overridden by passing `overrides` (tests do). */
export function loadConfig(env = process.env, overrides = {}) {
  const cfg = {
    root: ROOT,
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 8787),
    dbPath: env.DB_PATH || resolve(ROOT, 'data/finops.db'),
    dataDir: env.DATA_DIR || resolve(ROOT, 'data'), // multi-database mode (no DB_PATH): every dashboard database in here gets an entry in the source switcher
    defaultSource: env.DEFAULT_SOURCE || '', //       which one `/` opens (default: the sample data)
    sourcesTtlMs: 5000, //                              how long the discovered list of databases is cached
    publicDir: resolve(ROOT, 'public'),

    // extra origins / hosts allowed in addition to the loopback ones derived from host:port
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    allowedHosts: list(env.ALLOWED_HOSTS),
    strictOrigin: env.STRICT_ORIGIN === '1', // reject POST/WS with no Origin header at all
    authToken: env.AUTH_TOKEN || '', //   shared secret (>= 16 chars): Bearer header or session cookie (/?token=...)
    allowInsecure: env.ALLOW_INSECURE === '1', // allow a non-loopback HOST without AUTH_TOKEN (e.g. behind an authenticating proxy)
    cookieSecure: env.COOKIE_SECURE === '1', //   add the Secure flag to the session cookie (serve over HTTPS)

    alertWebhookUrl: env.ALERT_WEBHOOK_URL || '', //    post each NEW alert here (Slack, Discord or any JSON endpoint); the URL is a secret
    alertWebhookFormat: env.ALERT_WEBHOOK_FORMAT || 'auto', // auto | slack | discord | json
    alertWebhookSimulated: env.ALERT_WEBHOOK_SIMULATED === '1', // simulated data never notifies, unless you are trying the setup out

    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    anthropicEffort: env.ANTHROPIC_EFFORT === undefined ? 'low' : env.ANTHROPIC_EFFORT, // '' omits output_config.effort
    anthropicMaxTokens: num(env.ANTHROPIC_MAX_TOKENS, 1500), // includes thinking tokens on models that think by default
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),

    seed: num(env.SIM_SEED, 42),
    seedDays: num(env.SEED_DAYS, 30),
    volumeScale: num(env.SEED_VOLUME, 1),
    simAutoStart: env.SIM_AUTOSTART !== '0',
    simRate: num(env.SIM_RATE, 40), // requests / real second
    simAnomalies: env.SIM_ANOMALIES !== '0',
    simPauseWhenIdle: env.SIM_PAUSE_WHEN_IDLE === '1', // stop writing simulated rows while nobody is watching (multi-database mode turns this on)
    simIdleMs: num(env.SIM_IDLE_MS, 30_000),
    simIdleCheckMs: 2000,

    limits: {
      ingestBodyBytes: 1_000_000,
      jsonBodyBytes: 8_192,
      maxBatch: 1000,
      maxCallsPerRequest: 20,
      maxChannels: 64,
      maxGenerations: 4,
      maxSimRate: 5000,
    },

    detector: {}, // overrides merged into DETECTOR_DEFAULTS
    detectEveryMs: 1000,

    // live window the row lane keeps in sync (hours of rollups behind the newest hour)
    liveWindowHours: num(env.LIVE_WINDOW_HOURS, 6),
    changeLogKeep: num(env.CHANGE_LOG_KEEP, 50_000),

    channel: {
      bufferLimit: 32 * 1024, // stop writing when the transport holds this many unflushed bytes
      drainMark: 8 * 1024, //    ...and resume once it falls below this
      maxPending: 600, //        pending row entities before we drop them and send a snapshot
      maxRowsPerFrame: 100,
      highWater: 16 * 1024, //   queued token bytes that pause the model source
      lowWater: 4 * 1024, //     ...resumed once the queue is below this
      maxTokenFrame: 2048, //    max bytes of text merged into one token frame
      rowShare: 1 / 3, //        rows may use ~this share of bytes while a token backlog exists
      heartbeatMs: 15_000,
      stallMs: 120_000, //       a consumer that has not drained for this long is evicted
    },
  };
  return deepMerge(cfg, overrides);
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}
