import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * Money is stored as integer micro-dollars (1 USD = 1_000_000).
 *
 * rollups_hourly grain: (hour, tenant_id, endpoint, model).
 *   model = ''  -> the "infra row": carries `requests` and the infra cost of those requests.
 *   model = 'x' -> an LLM row: carries llm_calls, tokens and the LLM cost of calls to model x.
 * So SUM(requests) over any slice is the request count, SUM(cost_micro_usd) is total cost
 * (infra + LLM), and LLM cost is SUM(cost) WHERE model <> ''.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  infra_cost_micro_usd INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_pair_ts ON requests(tenant_id, endpoint, ts);

CREATE TABLE IF NOT EXISTS llm_calls(
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  ts INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL DEFAULT 'price_list'
);
CREATE INDEX IF NOT EXISTS llm_calls_request ON llm_calls(request_id);
CREATE INDEX IF NOT EXISTS llm_calls_ts ON llm_calls(ts);

-- prices are micro-USD per million tokens (so $3.00 / Mtok = 3000000)
-- cached_per_mtok is the cache READ price; the two cache_write columns are the 5-minute / 1-hour TTL write prices
CREATE TABLE IF NOT EXISTS model_prices(
  model TEXT NOT NULL,
  input_per_mtok INTEGER NOT NULL,
  output_per_mtok INTEGER NOT NULL,
  cached_per_mtok INTEGER NOT NULL,
  effective_from INTEGER NOT NULL,
  cache_write_per_mtok INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_per_mtok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(model, effective_from)
);

CREATE TABLE IF NOT EXISTS rollups_hourly(
  hour INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(hour, tenant_id, endpoint, model)
);

-- tenant_id / endpoint are NULL for alerts that span all tenants / all endpoints.
-- hour + detail (JSON) are additions to the spec'd columns: the evaluated hour and the evidence.
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tenant_id TEXT,
  endpoint TEXT,
  observed REAL NOT NULL,
  baseline REAL NOT NULL,
  score REAL NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','ack','resolved')),
  hour INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS alerts_dedupe ON alerts(kind, tenant_id, endpoint, ts);
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS changes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  "table" TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  op TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS rollups_ai AFTER INSERT ON rollups_hourly BEGIN
  INSERT INTO changes("table", row_id, op) VALUES('rollups_hourly', NEW.rowid, 'insert');
END;
CREATE TRIGGER IF NOT EXISTS rollups_au AFTER UPDATE ON rollups_hourly BEGIN
  INSERT INTO changes("table", row_id, op) VALUES('rollups_hourly', NEW.rowid, 'update');
END;
CREATE TRIGGER IF NOT EXISTS alerts_ai AFTER INSERT ON alerts BEGIN
  INSERT INTO changes("table", row_id, op) VALUES('alerts', NEW.id, 'insert');
END;
CREATE TRIGGER IF NOT EXISTS alerts_au AFTER UPDATE ON alerts BEGIN
  INSERT INTO changes("table", row_id, op) VALUES('alerts', NEW.id, 'update');
END;
`;

/** Columns added after the first release: databases created before them get them via ALTER TABLE (cheap, metadata only). */
const ADDED_COLUMNS = [
  ['llm_calls', 'cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['llm_calls', 'cache_write_1h_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['llm_calls', 'cost_source', "TEXT NOT NULL DEFAULT 'price_list'"], // 'price_list': computed from model_prices; 'supplied': the sender's own figure
  ['model_prices', 'cache_write_per_mtok', 'INTEGER NOT NULL DEFAULT 0'],
  ['model_prices', 'cache_write_1h_per_mtok', 'INTEGER NOT NULL DEFAULT 0'],
];

export function migrate(db) {
  for (const [table, column, def] of ADDED_COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const txDepth = new WeakMap(); // db -> nesting depth (node:sqlite's isTransaction only exists on newer Node 22 builds)

/** Run fn inside BEGIN IMMEDIATE ... COMMIT. Re-entrant: a nested call just runs fn inside the outer transaction. */
export function transaction(db, fn) {
  if (txDepth.get(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
    throw e;
  } finally {
    txDepth.set(db, 0);
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

/** The change log the live feed follows. seq is AUTOINCREMENT so it is never reused after pruning. */
export class ChangeLog {
  constructor(db) {
    this.db = db;
    this.stHead = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'");
    this.stSince = db.prepare('SELECT seq, "table" AS tbl, row_id, op FROM changes WHERE seq > ? ORDER BY seq LIMIT ?');
  }
  /** Highest seq ever assigned (survives pruning). */
  head() {
    const r = this.stHead.get();
    return r ? r.seq : 0;
  }
  /** Highest seq that has been deleted from the log: resume ids below this need a snapshot. */
  prunedTo() {
    return Number(getMeta(this.db, 'changes_pruned_to', 0));
  }
  since(seq, limit = 5000) {
    return this.stSince.all(seq, limit);
  }
  /** Keep only the newest `keep` entries. */
  prune(keep) {
    const cut = this.head() - keep;
    if (cut <= this.prunedTo()) return 0;
    const { changes } = this.db.prepare('DELETE FROM changes WHERE seq <= ?').run(cut);
    setMeta(this.db, 'changes_pruned_to', cut);
    return changes;
  }
  /** Forget everything so far (used after bulk seeding): every older resume id now needs a snapshot. */
  reset() {
    this.db.exec('DELETE FROM changes');
    setMeta(this.db, 'changes_pruned_to', this.head());
  }
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM changes').get().n;
  }
}
