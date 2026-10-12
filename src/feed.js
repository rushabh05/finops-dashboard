import { EventEmitter } from 'node:events';
import { HOUR } from './util.js';
import { ChangeLog } from './db.js';
import { shapeAlert } from './alerts.js';

export const ROLLUP_COLS = ['id', 'hour', 'tenant_id', 'endpoint', 'model', 'requests', 'llm_calls', 'tokens_in', 'tokens_out', 'cost_micro_usd'];
const ROLLUP_SELECT = `SELECT rowid AS id, hour, tenant_id, endpoint, model, requests, llm_calls, tokens_in, tokens_out, cost_micro_usd FROM rollups_hourly`;

export const entityKey = (table, id) => (table === 'rollups_hourly' ? `r:${id}` : `a:${id}`);

/**
 * Follows the `changes` table (filled by triggers) and turns it into per-entity row entries for the Channels.
 * An entry carries the CURRENT row value, so a burst of changes to one row collapses to one entry (latest wins).
 * The live window is the last `windowHours` of rollups (relative to the newest hour in the data) plus recent alerts.
 */
export class ChangeFeed extends EventEmitter {
  constructor(db, { windowHours = 6, minGapMs = 30, batchRows = 5000, maxAlerts = 200 } = {}) {
    super();
    this.db = db;
    this.log = new ChangeLog(db);
    this.windowHours = windowHours;
    this.minGapMs = minGapMs;
    this.batchRows = batchRows;
    this.maxAlerts = maxAlerts;
    this.head = this.log.head();
    this.timer = null;
    this.lastPoll = 0;
    this.subscribers = new Set();
    this.stRollups = db.prepare(`${ROLLUP_SELECT} WHERE rowid IN (SELECT value FROM json_each(?))`);
    this.stAlerts = db.prepare('SELECT * FROM alerts WHERE id IN (SELECT value FROM json_each(?))');
    this.stLatest = db.prepare('SELECT MAX(hour) AS h FROM rollups_hourly');
    this.stSnapRollups = db.prepare(`${ROLLUP_SELECT} WHERE hour >= ?`);
    this.stSnapAlerts = db.prepare('SELECT * FROM alerts ORDER BY ts DESC, id DESC LIMIT ?');
    this._snap = null;
    this.stats = { polls: 0, entries: 0, changes_read: 0 };
  }

  subscribe(fn) { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }

  latestHour() { return this.stLatest.get().h ?? 0; }
  windowFrom() { return this.latestHour() - (this.windowHours - 1) * HOUR; }

  /** Ask for a poll soon (coalesced and rate limited). Cheap to call after every write. */
  notify() {
    if (this.timer) return;
    const wait = Math.max(0, this.lastPoll + this.minGapMs - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.poll(); }, wait);
    this.timer.unref?.();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  /** Read everything after `head`, dispatch to subscribers. Returns the number of entries dispatched. */
  poll() {
    this.lastPoll = Date.now();
    let total = 0;
    for (;;) {
      const rows = this.log.since(this.head, this.batchRows);
      if (!rows.length) break;
      const head = rows[rows.length - 1].seq;
      const entries = this.resolve(rows);
      this.head = head;
      this.stats.polls++;
      this.stats.changes_read += rows.length;
      this.stats.entries += entries.length;
      total += entries.length;
      for (const fn of this.subscribers) fn(entries, head);
      if (rows.length < this.batchRows) break;
    }
    return total;
  }

  /** Collapse change rows to one entry per entity (its newest seq) carrying the current row; ascending by seq. */
  resolve(rows) {
    const last = new Map(); // key -> {seq, table, row_id, op}
    for (const r of rows) {
      const key = entityKey(r.tbl, r.row_id);
      last.delete(key);
      last.set(key, { key, seq: r.seq, table: r.tbl, row_id: r.row_id, op: r.op });
    }
    const rollupIds = [], alertIds = [];
    for (const e of last.values()) (e.table === 'rollups_hourly' ? rollupIds : alertIds).push(e.row_id);
    const rollups = new Map();
    if (rollupIds.length) for (const r of this.stRollups.all(JSON.stringify(rollupIds))) rollups.set(r.id, { ...r });
    const alerts = new Map();
    if (alertIds.length) for (const a of this.stAlerts.all(JSON.stringify(alertIds))) alerts.set(a.id, shapeAlert(a, { detail: false }));
    const from = this.windowFrom();
    const out = [];
    for (const e of last.values()) {
      if (e.table === 'rollups_hourly') {
        const row = rollups.get(e.row_id);
        if (!row || row.hour < from) continue; // outside the live window: clients do not hold it
        out.push({ ...e, row });
      } else {
        const row = alerts.get(e.row_id);
        if (row) out.push({ ...e, row });
      }
    }
    return out;
  }

  /**
   * Entries for a client resuming after `lastId`. Returns null when it cannot be done incrementally
   * (id is not a valid cursor, the log was pruned past it, or too many entities changed) -> caller sends a snapshot.
   */
  since(lastId, maxEntities) {
    if (!Number.isSafeInteger(lastId) || lastId < 0) return null;
    const head = this.log.head();
    if (lastId > head || lastId < this.log.prunedTo()) return null;
    const rows = this.log.since(lastId, this.batchRows);
    if (rows.length >= this.batchRows) return null;
    const entries = this.resolve(rows);
    if (entries.length > maxEntities) return null;
    return { entries, head };
  }

  /** Full state of the live window. `id` is the log head it reflects (read in the same synchronous turn). */
  snapshot() {
    const id = this.log.head();
    const now = Date.now();
    if (this._snap && this._snap.id === id && now - this._snap.t < 1000) return this._snap.value;
    const from = this.windowFrom();
    const rollups = this.stSnapRollups.all(from).map((r) => ROLLUP_COLS.map((c) => r[c]));
    const alerts = this.stSnapAlerts.all(this.maxAlerts).map((a) => shapeAlert(a, { detail: false }));
    const value = { id, data: { window: { from, to: this.latestHour() + HOUR }, rollups: { cols: ROLLUP_COLS, rows: rollups }, alerts } };
    this._snap = { id, t: now, value };
    return value;
  }
}
