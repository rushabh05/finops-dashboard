import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb, getMeta, setMeta, ChangeLog } from '../db.js';
import { PriceBook } from '../pricing.js';
import { Ingestor, ValidationError } from '../ingest.js';
import { Detector } from '../detector.js';
import { DAY, HOUR, hourOf } from '../util.js';
import { installPrices } from './prices.js';

/*
 * Shared plumbing for the importers. Imports go through the REAL ingest path (Ingestor: validation, cost from
 * model_prices, raw rows + rollups in one transaction per batch), straight into a SQLite file - no HTTP, so the body
 * and batch caps of POST /api/ingest do not apply, but every other rule does.
 *
 * An imported database is tagged with meta `source` (+ `source_note`). The server reads the tag: it shows the note in
 * the UI and refuses to start the simulator on that file, so real data can never be mixed with simulated rows.
 */

export const IMPORT_SOURCE_PREFIX = 'import:';

function importerOwned(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'source'").get();
    if (row && String(row.value).startsWith(IMPORT_SOURCE_PREFIX)) return true;
    const n = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
    return n === 0; // an empty database is safe to replace
  } catch {
    return false; // unreadable / not one of ours: do not touch it
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Create (or, with replace, recreate) the database an importer writes into.
 * Refuses to overwrite a database that has data and was not created by an importer (e.g. the simulator's data/finops.db).
 */
export function createImportDb({ path, replace = false, source, note, priceOverrides = [], maxCallsPerRequest = 5000 }) {
  if (path !== ':memory:') {
    const files = [path, `${path}-wal`, `${path}-shm`];
    if (files.some((f) => existsSync(f))) {
      if (!replace) throw new Error(`${path} already exists - pass --replace to rebuild it, or choose another --db`);
      if (existsSync(path) && !importerOwned(path)) throw new Error(`${path} holds data that was not created by an importer (simulator or live ingest): refusing to overwrite it`);
      for (const f of files) rmSync(f, { force: true });
    }
  }
  const db = openDb(path);
  const priceCount = installPrices(db, priceOverrides);
  setMeta(db, 'source', source);
  setMeta(db, 'source_note', note);
  const priceBook = new PriceBook(db);
  const ingestor = new Ingestor(db, priceBook, { maxBatch: 1000, maxCallsPerRequest });
  const changeLog = new ChangeLog(db);
  return { db, priceBook, ingestor, changeLog, priceCount };
}

/** Collects requests and writes them in batches; a bad record is skipped and counted, it never sinks its batch. */
export class BatchWriter {
  constructor(ingestor, { batchSize = 1000 } = {}) {
    this.ingestor = ingestor;
    this.batchSize = Math.min(batchSize, ingestor.maxBatch);
    this.buf = [];
    this.accepted = 0;
    this.duplicates = 0;
    this.rejected = 0;
    this.llmCalls = 0;
    this.costMicro = 0;
    this.rejectSamples = [];
  }
  add(request) {
    this.buf.push(request);
    if (this.buf.length >= this.batchSize) this.flush();
  }
  _tally(r) {
    this.accepted += r.accepted;
    this.duplicates += r.duplicates;
    this.llmCalls += r.llm_calls;
    this.costMicro += r.cost_micro_usd;
  }
  flush() {
    if (!this.buf.length) return;
    const batch = this.buf;
    this.buf = [];
    try {
      this._tally(this.ingestor.ingest({ requests: batch }));
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      for (const r of batch) {
        try {
          this._tally(this.ingestor.ingest({ requests: [r] }));
        } catch (e2) {
          if (!(e2 instanceof ValidationError)) throw e2;
          this.rejected++;
          if (this.rejectSamples.length < 5) this.rejectSamples.push(`${r.id}: ${e2.errors[0]}`);
        }
      }
    }
  }
}

/**
 * Run the detector over the last `days` of the data's own clock, one hour at a time, so the alerts panel is populated.
 * (The server only runs the detector when new data arrives; imported history never would.)
 */
export function backfillDetection(db, { days, params = {} }) {
  const det = new Detector(db, params);
  const last = det.dataNow();
  const out = { evaluated: 0, inserted: 0, byKind: {}, skipped: null };
  if (last == null || days <= 0) return out;
  const lastHour = hourOf(last);
  for (let b = lastHour - days * DAY + HOUR; b <= lastHour; b += HOUR) {
    const r = det.run(b); // as of an hour boundary: judges the hour that just completed
    out.evaluated += r.evaluated;
    out.inserted += r.inserted.length;
    for (const a of r.inserted) out.byKind[a.kind] = (out.byKind[a.kind] || 0) + 1;
    if (r.skipped) out.skipped = r.skipped;
  }
  const r = det.run(last); // and the (possibly partial) newest hour
  out.evaluated += r.evaluated;
  out.inserted += r.inserted.length;
  for (const a of r.inserted) out.byKind[a.kind] = (out.byKind[a.kind] || 0) + 1;
  return out;
}

/** After a bulk import: forget the change log it produced (every older resume id then needs a snapshot) and shrink the WAL. */
export function finishImport({ db, changeLog }) {
  changeLog.reset();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
export const fmtUsd = (micro) => {
  const v = micro / 1e6;
  return '$' + (Math.abs(v) >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2));
};

/** Headline numbers of an imported database, for the CLI report. */
export function describeDb(db) {
  const one = (sql) => db.prepare(sql).get();
  const t = one('SELECT COUNT(*) AS requests, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM requests');
  const c = one('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_micro_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS tin, COALESCE(SUM(output_tokens),0) AS tout FROM llm_calls');
  const infra = one('SELECT COALESCE(SUM(infra_cost_micro_usd),0) AS cost FROM requests');
  const top = (col, n = 5) => db.prepare(`SELECT ${col} AS key, SUM(cost_micro_usd) AS cost, SUM(requests) AS requests FROM rollups_hourly GROUP BY ${col} ORDER BY cost DESC LIMIT ?`).all(n).map((r) => ({ ...r }));
  return {
    requests: t.requests, calls: c.calls, llm_cost_micro: c.cost, infra_cost_micro: infra.cost, tokens_in: c.tin, tokens_out: c.tout,
    from: t.min_ts, to: t.max_ts, tenants: top('tenant_id', 8), endpoints: top('endpoint', 8), models: top("CASE WHEN model = '' THEN '(infra)' ELSE model END", 8),
    alerts: one('SELECT COUNT(*) AS n FROM alerts').n,
    source: getMeta(db, 'source'),
  };
}

export { HOUR, DAY };
