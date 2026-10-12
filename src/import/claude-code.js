import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/*
 * Claude Code history -> dashboard data.
 *
 * Claude Code appends every message to ~/.claude/projects/<project>/<session>.jsonl (and sub-agent runs to
 * <session>/subagents/agent-*.jsonl). Only the usage metadata is read here: message TEXT is never kept (it is parsed
 * because a JSONL line has to be, but nothing except scalar fields is copied out of it).
 *
 * Mapping (see README "Importing real data"):
 *   tenant    = the project folder (git worktrees fold into their parent project)
 *   request   = one user prompt (the main agent's whole turn) or one sub-agent run
 *   endpoint  = /main/<cli|vscode|desktop|...>  or  /agent/<general-purpose|explore|workflow-subagent|...>
 *   llm call  = one API response (a "message")
 *   cost      = tokens x model_prices, i.e. API-EQUIVALENT list-price cost - a subscription is billed flat
 *
 * Gotchas this handles (all measured on real history):
 *   - one API response is written as several JSONL lines (one per content block), repeating the usage; the early lines
 *     hold a partial output_tokens count. A message counts once, with the line that has the final output_tokens.
 *   - the same message can appear in several files (forked / resumed sessions): it counts once, in the oldest file.
 *   - "<synthetic>" entries are client-generated API errors (rate limit, server error): no tokens, no cost; they set the
 *     status of the request they belong to.
 */

export const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');

const MAX_REQUEST_MS = 3_600_000;
const int = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const idPart = (s, n = 12) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, n);

export function findTranscripts(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** "/a/b/.claude/worktrees/x/src" -> "/a/b": a worktree is the same project as the repository it was cut from. */
export function projectRootOf(cwd) {
  const i = cwd.indexOf('/.claude/worktrees/');
  return i >= 0 ? cwd.slice(0, i) : cwd;
}

/**
 * Readable, unique tenant labels for a set of project roots: the folder name when it is unique; when two different
 * roots share a folder name, the folder name plus the first ancestor folder at which their paths differ
 * ("shop-Users" vs "shop-Old-Laptop"). Result: Map(root -> label), each matching the tenant regex.
 */
export function labelRoots(roots) {
  const clean = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'project';
  const fit = (s) => (s.length <= 64 ? s : `${s.slice(0, 57)}-${createHash('sha1').update(s).digest('hex').slice(0, 6)}`);
  const parts = new Map();
  for (const r of new Set(roots)) parts.set(r, r.includes('/Library/Application Support/Claude/') ? ['claude-desktop-scratch'] : r.split('/').filter(Boolean));
  const base = (root) => { const p = parts.get(root); return clean(p[p.length - 1] ?? ''); };
  const byBase = new Map();
  for (const root of parts.keys()) {
    const b = base(root);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(root);
  }
  const out = new Map();
  const used = new Set();
  const take = (root, label) => {
    let l = fit(label);
    for (let n = 2; used.has(l); n++) l = fit(`${label}-${n}`);
    used.add(l);
    out.set(root, l);
  };
  for (const [b, group] of [...byBase.entries()].sort()) {
    if (group.length === 1) { take(group[0], b); continue; }
    for (const root of group.sort()) {
      const p = parts.get(root);
      // shortest suffix depth at which this root differs from every other root sharing the folder name
      let k = 2;
      const suffix = (r, n) => parts.get(r).slice(-n).join('/');
      while (k <= p.length && group.some((o) => o !== root && suffix(o, k) === suffix(root, k))) k++;
      take(root, k <= p.length ? `${b}-${clean(p[p.length - k])}` : b);
    }
  }
  return out;
}

/** Scan every transcript under `root`. Returns the raw material for buildRequests(). */
export async function scanTranscripts({ root = DEFAULT_ROOT, files = findTranscripts(root), onProgress } = {}) {
  const messages = new Map(); // message id -> canonical instance
  const errors = []; // API errors: { reqKey, status }
  const costStates = new Map(); // sessionId -> Claude Code's own cost record (used only to cross-check)
  const cwdCounts = new Map(); // project dir -> Map(root -> n)
  const stats = { files: files.length, lines: 0, badLines: 0, assistantLines: 0, duplicateLines: 0, crossFileDuplicates: 0, syntheticErrors: 0, fastMode: 0, webSearch: 0, noTimestamp: 0 };

  for (let fi = 0; fi < files.length; fi++) {
    const path = files[fi];
    const projectDir = relative(root, path).split(sep)[0];
    const uuidTs = new Map(); // uuid -> timestamp, for latency (parent = the prompt / tool result the response answers)
    let fileStart = null;
    let turn = null; // the main agent's current turn
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      stats.lines++;
      let d;
      try { d = JSON.parse(line); } catch { stats.badLines++; continue; }
      const type = d.type;

      if (type === 'cost-state') {
        const sid = d.sessionId;
        const prev = costStates.get(sid);
        if (sid && d.modelUsage && typeof d.modelUsage === 'object' && (!prev || (d.totalCostUSD ?? 0) >= prev.totalCostUSD)) costStates.set(sid, { totalCostUSD: d.totalCostUSD ?? 0, modelUsage: d.modelUsage });
        continue;
      }
      if (type !== 'user' && type !== 'assistant') continue;
      const ts = Date.parse(d.timestamp);
      if (!Number.isFinite(ts)) { stats.noTimestamp++; continue; }
      if (fileStart === null) fileStart = ts;
      if (d.uuid) uuidTs.set(d.uuid, ts);
      if (typeof d.cwd === 'string' && d.cwd) {
        let m = cwdCounts.get(projectDir);
        if (!m) cwdCounts.set(projectDir, (m = new Map()));
        const r = projectRootOf(d.cwd);
        m.set(r, (m.get(r) || 0) + 1);
      }

      if (type === 'user') {
        const c = d.message?.content;
        const toolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
        if (!d.isSidechain && !d.agentId && !d.isMeta && !d.isCompactSummary && !toolResult) turn = { key: `turn:${idPart(d.uuid)}`, ts };
        continue;
      }

      // ---- assistant
      stats.assistantLines++;
      const m = d.message;
      if (!m || !m.id) continue;
      const agent = d.agentId || (d.isSidechain ? `side-${idPart(d.sessionId, 8)}` : null);
      const reqKey = () => {
        if (agent) return `agent:${idPart(agent, 40)}`;
        if (!turn) turn = { key: `turn:m${idPart(m.id)}`, ts };
        return turn.key;
      };

      if (m.model === '<synthetic>' || d.isApiErrorMessage) {
        stats.syntheticErrors++;
        if (d.isApiErrorMessage) {
          const s = Number(d.apiErrorStatus);
          const e = String(d.error ?? '');
          errors.push({ reqKey: reqKey(), status: Number.isInteger(s) && s >= 400 && s <= 599 ? s : /rate_limit/.test(e) ? 429 : /overloaded/.test(e) ? 529 : 500 });
        }
        continue;
      }
      const u = m.usage;
      if (!u || typeof u !== 'object') continue;

      const prev = messages.get(m.id);
      if (prev && prev.path !== path) {
        stats.crossFileDuplicates++;
        // keep the instance from the oldest file (the original session, not a fork or resume that replayed it)
        if (!(fileStart < prev.fileStart || (fileStart === prev.fileStart && path < prev.path))) continue;
      } else if (prev) {
        stats.duplicateLines++;
        if (int(u.output_tokens) >= prev.output) { // later line of the same response: final output count wins
          Object.assign(prev, usageFields(u), { ts });
        }
        continue;
      }
      if (u.speed === 'fast') stats.fastMode++;
      if (u.server_tool_use && (u.server_tool_use.web_search_requests || u.server_tool_use.web_fetch_requests)) stats.webSearch++;
      const parentTs = d.parentUuid ? uuidTs.get(d.parentUuid) : undefined;
      messages.set(m.id, {
        id: m.id, path, fileStart, projectDir, model: m.model, ts, firstTs: ts, parentTs,
        sessionId: d.sessionId ?? '', agent: !!agent, agentType: agent ? (d.attributionAgent || 'unknown') : null,
        surface: String(d.entrypoint || 'unknown').replace(/^claude-/, ''), reqKey: reqKey(), turnTs: agent ? null : turn?.ts ?? null,
        ...usageFields(u),
      });
    }
    onProgress?.(fi + 1, files.length);
  }
  return { messages, errors, costStates, cwdCounts, stats };
}

export function usageFields(u) {
  const cc = u.cache_creation || {};
  let w5 = int(cc.ephemeral_5m_input_tokens);
  const w1 = int(cc.ephemeral_1h_input_tokens);
  w5 += Math.max(0, int(u.cache_creation_input_tokens) - w5 - w1); // no breakdown (older clients): all 5-minute writes
  return { input: int(u.input_tokens), read: int(u.cache_read_input_tokens), w5, w1, output: int(u.output_tokens) };
}

/**
 * Turn the scan into dashboard requests (ordered by time) and a cross-check against Claude Code's own cost record.
 * `priceBook` prices every call; a model without a price is counted in `unpriced` and skipped (add one with --price).
 */
export function buildRequests(scan, { priceBook, sinceTs = 0 }) {
  const roots = new Map(); // project dir -> its most common project root
  for (const [dir, counts] of scan.cwdCounts) roots.set(dir, [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]);
  const fallback = (dir) => `/${dir.replace(/^-/, '').split(/-{1,2}/).slice(-2).join('/')}`;
  for (const dir of new Set([...scan.messages.values()].map((r) => r.projectDir))) if (!roots.has(dir)) roots.set(dir, fallback(dir));
  const rootLabels = labelRoots([...roots.values()]);
  const tenantOf = (dir) => rootLabels.get(roots.get(dir));

  const groups = new Map(); // reqKey -> { calls: [], project, ... }
  const unpriced = new Map();
  const perSession = new Map(); // for the cross-check
  let skippedBefore = 0;
  for (const r of scan.messages.values()) {
    if (r.ts < sinceTs) { skippedBefore++; continue; }
    const price = priceBook.priceAt(r.model, r.ts);
    if (!price) { unpriced.set(r.model, (unpriced.get(r.model) || 0) + 1); continue; }
    let g = groups.get(r.reqKey);
    if (!g) {
      groups.set(r.reqKey, (g = { key: r.reqKey, calls: [], dir: r.projectDir, agent: r.agent, agentType: r.agentType, surface: r.surface, turnTs: r.turnTs, start: Infinity }));
    }
    const start = Math.min(r.parentTs ?? r.firstTs, r.firstTs);
    g.start = Math.min(g.start, start);
    if (r.turnTs != null) g.turnTs = r.turnTs;
    const call = {
      id: `c:${idPart(String(r.id).replace(/^msg_/, ''), 90)}`, ts: r.ts, model: r.model,
      input_tokens: r.input + r.read + r.w5 + r.w1, output_tokens: r.output, cached_tokens: r.read,
      cache_write_tokens: r.w5, cache_write_1h_tokens: r.w1, latency_ms: Math.max(0, Math.min(MAX_REQUEST_MS, Math.round(r.ts - start))),
    };
    g.calls.push(call);
    // cross-check bookkeeping (cost computed the same way the ingest will)
    const cost = priceBook.cost(call, r.ts);
    let s = perSession.get(r.sessionId);
    if (!s) perSession.set(r.sessionId, (s = new Map()));
    const a = s.get(r.model) || { input: 0, output: 0, read: 0, write: 0, cost: 0 };
    a.input += r.input; a.output += r.output; a.read += r.read; a.write += r.w5 + r.w1; a.cost += cost;
    s.set(r.model, a);
  }

  const errorStatus = new Map();
  for (const e of scan.errors) if (!errorStatus.has(e.reqKey)) errorStatus.set(e.reqKey, e.status);
  for (const [key, status] of errorStatus) { // an error with no priced call in its request still happened: keep it as a failed request
    if (!groups.has(key)) continue;
    groups.get(key).status = status;
  }

  const requests = [];
  const usedIds = new Set();
  for (const g of groups.values()) {
    g.calls.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const ts = Math.min(g.start, g.turnTs ?? Infinity);
    const last = g.calls[g.calls.length - 1].ts;
    let id = g.key;
    for (let n = 2; usedIds.has(id); n++) id = `${g.key}.${n}`;
    usedIds.add(id);
    requests.push({
      id, ts, tenant_id: tenantOf(g.dir),
      endpoint: g.agent ? `/agent/${slug(g.agentType) || 'unknown'}` : `/main/${slug(g.surface) || 'unknown'}`,
      method: 'POST', status: g.status ?? 200, duration_ms: Math.max(0, Math.min(MAX_REQUEST_MS, Math.round(last - ts))),
      infra_cost_micro_usd: 0, llm_calls: g.calls,
    });
  }
  requests.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  return { requests, tenants: new Map([...roots].map(([dir, root]) => [dir, rootLabels.get(root)])), unpriced, skippedBefore, crossCheck: crossCheck(scan.costStates, perSession) };
}

/**
 * Compare what we compute per session and model with what Claude Code itself recorded (its `cost-state` entries carry
 * token totals and a costUSD per model).
 *
 * Claude Code's counter is per process lifetime: a resumed session, a fork, or sub-agent / workflow usage that was not
 * persisted leaves it with only PART of what the transcript files hold, so totals are not comparable in general. The
 * pairs whose four token totals match exactly ARE comparable, and for those the dollar figures validate the price table
 * (rates, and the 5-minute vs 1-hour cache-write split).
 */
export function crossCheck(costStates, perSession) {
  const rows = [];
  for (const [sid, st] of costStates) {
    const mine = perSession.get(sid);
    if (!mine) continue;
    for (const [model, u] of Object.entries(st.modelUsage)) {
      const a = mine.get(model);
      if (!a) continue;
      const exact = a.input === (u.inputTokens ?? 0) && a.output === (u.outputTokens ?? 0) && a.read === (u.cacheReadInputTokens ?? 0) && a.write === (u.cacheCreationInputTokens ?? 0);
      rows.push({ session: sid.slice(0, 8), model, reported: u.costUSD ?? 0, computed: a.cost / 1e6, exact });
    }
  }
  const exact = rows.filter((r) => r.exact);
  const sum = (list, f) => list.reduce((n, r) => n + r[f], 0);
  const byModel = {};
  for (const r of exact) {
    const m = (byModel[r.model] ||= { pairs: 0, reported: 0, computed: 0 });
    m.pairs++; m.reported += r.reported; m.computed += r.computed;
  }
  const rel = (r) => (r.reported > 0 ? Math.abs(r.computed - r.reported) / r.reported : r.computed > 0 ? 1 : 0);
  return {
    sessions: new Set(rows.map((r) => r.session)).size, compared: rows.length, tokenExact: exact.length,
    reportedUsd: sum(exact, 'reported'), computedUsd: sum(exact, 'computed'), ratio: sum(exact, 'reported') > 0 ? sum(exact, 'computed') / sum(exact, 'reported') : null,
    maxRelError: exact.reduce((n, r) => Math.max(n, rel(r)), 0), byModel, rows,
  };
}
