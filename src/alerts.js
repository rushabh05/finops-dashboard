import { HOUR } from './util.js';

export const ALERT_KINDS = ['cost_spike', 'volume_spike', 'retry_storm', 'tokens_per_request', 'cost_per_request'];
export const ALERT_STATUSES = ['open', 'ack', 'resolved'];

/** Severity is derived (not stored): driven by the robust z-score and the observed/baseline ratio. */
export function severityOf(alert) {
  const ratio = alert.baseline > 0 ? alert.observed / alert.baseline : Infinity;
  if (alert.score >= 15 || ratio >= 5) return 'critical';
  if (alert.score >= 8 || ratio >= 3) return 'high';
  return 'medium';
}

export function shapeAlert(row, { detail: withDetail = true } = {}) {
  if (!row) return null;
  const out = {
    id: row.id, ts: row.ts, kind: row.kind, tenant_id: row.tenant_id, endpoint: row.endpoint,
    observed: row.observed, baseline: row.baseline, score: row.score, explanation: row.explanation,
    status: row.status, hour: row.hour, severity: severityOf(row),
  };
  if (withDetail) {
    out.detail = null;
    if (row.detail) { try { out.detail = JSON.parse(row.detail); } catch { /* keep null */ } }
  }
  return out;
}

export function getAlert(db, id) {
  return shapeAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id));
}

/**
 * filters: { status: 'active'|'open'|'ack'|'resolved'|'all', tenant, endpoint, limit }
 * Alerts whose tenant/endpoint is NULL span everything, so they match any tenant/endpoint filter.
 */
export function listAlerts(db, { status = 'all', tenant = null, endpoint = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status === 'active') where.push("status <> 'resolved'");
  else if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (tenant) { where.push('(tenant_id IS NULL OR tenant_id = ?)'); params.push(tenant); }
  if (endpoint) { where.push('(endpoint IS NULL OR endpoint = ?)'); params.push(endpoint); }
  const sql = `SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, limit).map(shapeAlert);
}

export function countActive(db, { tenant = null, endpoint = null } = {}) {
  const where = ["status <> 'resolved'"];
  const params = [];
  if (tenant) { where.push('(tenant_id IS NULL OR tenant_id = ?)'); params.push(tenant); }
  if (endpoint) { where.push('(endpoint IS NULL OR endpoint = ?)'); params.push(endpoint); }
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(status = 'open') AS open FROM alerts WHERE ${where.join(' AND ')}`).get();
  return { active: r.n, open: r.open ?? 0, acked: r.n - (r.open ?? 0) };
}

export class AlertStateError extends Error {
  constructor(msg) { super(msg); this.status = 409; }
}

/** open -> ack -> resolved (resolve is allowed straight from open). Idempotent for repeats of the same target state. */
export function setAlertStatus(db, id, target) {
  const row = db.prepare('SELECT status FROM alerts WHERE id = ?').get(id);
  if (!row) return null;
  if (row.status === target) return getAlert(db, id);
  if (row.status === 'resolved') throw new AlertStateError(`alert ${id} is already resolved`);
  if (target === 'ack' && row.status !== 'open') throw new AlertStateError(`alert ${id} is ${row.status}`);
  db.prepare('UPDATE alerts SET status = ? WHERE id = ?').run(target, id);
  return getAlert(db, id);
}

export const hourLabel = (ts) => new Date(ts).toISOString().slice(0, 13).replace('T', ' ') + ':00 UTC';
export { HOUR };
