import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTranscripts, buildRequests, labelRoots, projectRootOf, crossCheck } from '../src/import/claude-code.js';
import { createImportDb, BatchWriter } from '../src/import/common.js';
import { verifyRollups } from '../src/ingest.js';

/*
 * Fixture = a miniature ~/.claude/projects with the quirks measured in real history:
 *   - one API response written as several lines (partial output_tokens on the early ones)
 *   - a forked session that replays an earlier response
 *   - a sub-agent file, a git worktree, a second project, an API error entry, a Claude Code cost-state record
 * Every user/assistant text carries the canary "SECRET" so we can prove no message text reaches the database.
 */
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);
const iso = (ms) => new Date(T0 + ms).toISOString();
const S = 1000;

const base = (o) => ({ isSidechain: false, userType: 'external', entrypoint: 'claude-vscode', cwd: '/Users/me/work/alpha', sessionId: 'sess-9999', version: '9.9.9', ...o });
const prompt = (uuid, at, o = {}) => base({ type: 'user', uuid, parentUuid: null, timestamp: iso(at), message: { role: 'user', content: 'SECRET prompt text' }, ...o });
const toolResult = (uuid, parent, at, o = {}) => base({ type: 'user', uuid, parentUuid: parent, timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', content: 'SECRET tool output' }] }, ...o });
const usage = (input, read, out, w5 = 0, w1 = 0) => ({ input_tokens: input, cache_creation_input_tokens: w5 + w1, cache_read_input_tokens: read, output_tokens: out, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 } });
const assistant = (uuid, parent, at, id, model, u, o = {}) => base({ type: 'assistant', uuid, parentUuid: parent, timestamp: iso(at), requestId: `req_${id}`, message: { id: `msg_${id}`, model, role: 'assistant', content: [{ type: 'text', text: 'SECRET answer' }], usage: u }, ...o });

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'finops-cc-'));
  const w = (rel, lines) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'); };
  const A = '-Users-me-work-alpha';

  // the original session: turn 1 = prompt u1 -> response msg_AAA (3 lines) -> tool result -> response msg_BBB; turn 2 = prompt u3 -> msg_CCC -> API error 429
  w(`${A}/sess-9999.jsonl`, [
    prompt('u1', 0),
    assistant('a1', 'u1', 2 * S, 'AAA', 'claude-sonnet-5-5', usage(10, 5000, 10, 400, 600)),
    assistant('a2', 'a1', 3 * S, 'AAA', 'claude-sonnet-5-5', usage(10, 5000, 10, 400, 600)),
    assistant('a3', 'a2', 4 * S, 'AAA', 'claude-sonnet-5-5', usage(10, 5000, 200, 400, 600)), // final line: 200 output tokens
    toolResult('u2', 'a3', 6 * S),
    assistant('a4', 'u2', 9 * S, 'BBB', 'claude-opus-5-5', usage(20, 6000, 300)),
    prompt('u3', 60 * S),
    assistant('a5', 'u3', 63 * S, 'CCC', 'claude-sonnet-5-5', usage(5, 100, 50)),
    assistant('a6', 'a5', 70 * S, 'syn1', '<synthetic>', usage(0, 0, 0), { isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit' }),
    { type: 'cost-state', sessionId: 'sess-9999', totalCostUSD: 0.01423, modelUsage: {
      'claude-sonnet-5-5': { inputTokens: 15, outputTokens: 250, cacheReadInputTokens: 5100, cacheCreationInputTokens: 1000, costUSD: 0.00695 },
      'claude-opus-5-5': { inputTokens: 20, outputTokens: 300, cacheReadInputTokens: 6000, cacheCreationInputTokens: 0, costUSD: 0.00728 },
      'claude-haiku-4-5-20251001': { inputTokens: 999, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 5 }, // a partial counter: tokens differ
    } },
    '{ this line is not json',
  ]);
  // a sub-agent run of that session: its own file, sidechain entries, one priced and one unpriced model
  w(`${A}/sess-9999/subagents/agent-xyz.jsonl`, [
    base({ type: 'user', uuid: 'su1', parentUuid: null, timestamp: iso(10 * S), isSidechain: true, agentId: 'xyz', message: { role: 'user', content: 'SECRET subagent prompt' } }),
    assistant('sa1', 'su1', 12 * S, 'SSS', 'claude-haiku-4-5-20251001', usage(100, 0, 20), { isSidechain: true, agentId: 'xyz', attributionAgent: 'Explore' }),
    assistant('sa2', 'sa1', 14 * S, 'TTT', 'claude-unknown-9', usage(50, 0, 5), { isSidechain: true, agentId: 'xyz', attributionAgent: 'Explore' }),
  ]);
  // a fork of the session (sorts BEFORE the original): resumes later, replays the original prompt and response, then adds a new turn
  w(`${A}/sess-2222.jsonl`, [
    prompt('u0', 30 * 60 * S, { sessionId: 'sess-2222' }),
    prompt('u1', 0, { sessionId: 'sess-2222' }),
    assistant('a3', 'u1', 4 * S, 'AAA', 'claude-sonnet-5-5', usage(10, 5000, 200, 400, 600), { sessionId: 'sess-2222' }),
    prompt('u9', 31 * 60 * S, { sessionId: 'sess-2222' }),
    assistant('f1', 'u9', 31 * 60 * S + 4 * S, 'DDD', 'claude-sonnet-5-5', usage(7, 70, 7), { sessionId: 'sess-2222' }),
  ]);
  // a git worktree of the same project
  w(`${A}--claude-worktrees-feat/sess-3333.jsonl`, [
    prompt('w1', 2 * 60 * 60 * S, { sessionId: 'sess-3333', cwd: '/Users/me/work/alpha/.claude/worktrees/feat' }),
    assistant('w2', 'w1', 2 * 60 * 60 * S + 3 * S, 'EEE', 'claude-sonnet-5-5', usage(3, 30, 3), { sessionId: 'sess-3333', cwd: '/Users/me/work/alpha/.claude/worktrees/feat' }),
  ]);
  // another project, used from the CLI
  w('-Users-me-other-beta/sess-4444.jsonl', [
    prompt('b1', 3 * 60 * 60 * S, { sessionId: 'sess-4444', cwd: '/Users/me/other/beta', entrypoint: 'cli' }),
    assistant('b2', 'b1', 3 * 60 * 60 * S + 2 * S, 'FFF', 'claude-opus-5', usage(11, 110, 11), { sessionId: 'sess-4444', cwd: '/Users/me/other/beta', entrypoint: 'cli' }),
  ]);
});
after(() => rmSync(root, { recursive: true, force: true }));

const imp = () => createImportDb({ path: ':memory:', source: 'import:claude-code', note: 'test' });

test('scan: repeated streaming lines and forked copies count once; the final output_tokens wins', async () => {
  const scan = await scanTranscripts({ root });
  // AAA, BBB, CCC, DDD, EEE, FFF, SSS, TTT = 8 responses (the synthetic error is not one)
  assert.equal(scan.messages.size, 8);
  const aaa = scan.messages.get('msg_AAA');
  assert.equal(aaa.output, 200, 'last of the three lines');
  assert.deepEqual([aaa.input, aaa.read, aaa.w5, aaa.w1], [10, 5000, 400, 600]);
  assert.match(aaa.path, /sess-9999\.jsonl$/, 'the original session keeps the response, not the later fork that replayed it');
  assert.equal(aaa.reqKey, 'turn:u1');
  assert.equal(scan.stats.duplicateLines, 2);
  assert.ok(scan.stats.crossFileDuplicates >= 1);
  assert.equal(scan.stats.badLines, 1);
  assert.equal(scan.stats.syntheticErrors, 1);
});

test('requests: prompts and sub-agent runs become requests, with tenants, endpoints, status and cache-write tokens', async () => {
  const scan = await scanTranscripts({ root });
  const { db, priceBook } = imp();
  const b = buildRequests(scan, { priceBook });
  const byId = new Map(b.requests.map((r) => [r.id, r]));

  const t1 = byId.get('turn:u1');
  assert.equal(t1.tenant_id, 'alpha');
  assert.equal(t1.endpoint, '/main/vscode');
  assert.equal(t1.status, 200);
  assert.equal(t1.ts, T0);
  assert.equal(t1.duration_ms, 9 * S, 'prompt to the last response');
  assert.deepEqual(t1.llm_calls.map((c) => c.id), ['c:AAA', 'c:BBB']);
  const [m1, m2] = t1.llm_calls;
  assert.deepEqual([m1.input_tokens, m1.cached_tokens, m1.cache_write_tokens, m1.cache_write_1h_tokens, m1.output_tokens], [6010, 5000, 400, 600, 200], 'input_tokens is the whole prompt');
  assert.equal(m1.latency_ms, 4 * S, 'from the prompt it answers to the end of the response');
  assert.equal(m2.latency_ms, 3 * S, 'from the tool result it answers');

  const t2 = byId.get('turn:u3');
  assert.equal(t2.status, 429, 'the API error entry sets the status of its turn');
  assert.deepEqual(t2.llm_calls.map((c) => c.id), ['c:CCC']);

  const agent = byId.get('agent:xyz');
  assert.equal(agent.endpoint, '/agent/explore');
  assert.equal(agent.tenant_id, 'alpha');
  assert.deepEqual(agent.llm_calls.map((c) => c.id), ['c:SSS'], 'the unpriced model is skipped');
  assert.deepEqual([...b.unpriced], [['claude-unknown-9', 1]]);

  assert.equal(byId.get('turn:u9').llm_calls[0].id, 'c:DDD', 'a new turn added by the fork');
  const wt = [...byId.values()].find((r) => r.llm_calls[0]?.id === 'c:EEE');
  assert.equal(wt.tenant_id, 'alpha', 'a git worktree folds into its project');
  const beta = [...byId.values()].find((r) => r.llm_calls[0]?.id === 'c:FFF');
  assert.deepEqual([beta.tenant_id, beta.endpoint], ['beta', '/main/cli']);
  assert.deepEqual([...new Set(b.requests.map((r) => r.tenant_id))].sort(), ['alpha', 'beta']);
  for (let i = 1; i < b.requests.length; i++) assert.ok(b.requests[i - 1].ts <= b.requests[i].ts, 'ordered by time');
  db.close();
});

test('import: everything is accepted by the real ingest path, costs match a hand calculation, rollups are consistent', async () => {
  const scan = await scanTranscripts({ root });
  const x = imp();
  const b = buildRequests(scan, { priceBook: x.priceBook });
  const w = new BatchWriter(x.ingestor);
  for (const r of b.requests) w.add(r);
  w.flush();
  assert.equal(w.rejected, 0, w.rejectSamples.join('; '));
  assert.equal(w.accepted, b.requests.length);
  assert.deepEqual(verifyRollups(x.db), []);
  const cost = (id) => x.db.prepare('SELECT cost_micro_usd AS c FROM llm_calls WHERE id = ?').get(id).c;
  // sonnet-5-5: $2 in / $10 out / $0.20 read / $2.50 write-5m / $4 write-1h per Mtok
  assert.equal(cost('c:AAA'), 10 * 2 + 5000 * 0.2 + 400 * 2.5 + 600 * 4 + 200 * 10); // 6420
  assert.equal(cost('c:CCC'), 5 * 2 + 100 * 0.2 + 50 * 10); // 530
  // opus-5-5: $4 / $20 / $0.20
  assert.equal(cost('c:BBB'), 20 * 4 + 6000 * 0.2 + 300 * 20); // 7280
  const stored = x.db.prepare("SELECT cache_write_tokens AS a, cache_write_1h_tokens AS b FROM llm_calls WHERE id = 'c:AAA'").get();
  assert.deepEqual([stored.a, stored.b], [400, 600]);
  // the importer tags the database
  assert.equal(x.db.prepare("SELECT value FROM meta WHERE key = 'source'").get().value, 'import:claude-code');
  x.db.close();
});

test('privacy: no message text (prompts, answers, tool output) reaches the database', async () => {
  const scan = await scanTranscripts({ root });
  const x = imp();
  const b = buildRequests(scan, { priceBook: x.priceBook });
  const w = new BatchWriter(x.ingestor);
  for (const r of b.requests) w.add(r);
  w.flush();
  let everything = JSON.stringify(b.requests);
  for (const t of ['requests', 'llm_calls', 'rollups_hourly', 'meta', 'alerts']) everything += JSON.stringify(x.db.prepare(`SELECT * FROM ${t}`).all());
  assert.ok(!/SECRET/.test(everything), 'canary text must never be copied out of the transcripts');
  assert.ok(!/\/Users\/me/.test(everything), 'full paths are not stored either: only the folder-name label');
  x.db.close();
});

test('cross-check: token-exact session x model pairs validate the price table; partial counters are not compared', async () => {
  const scan = await scanTranscripts({ root });
  const x = imp();
  const c = buildRequests(scan, { priceBook: x.priceBook }).crossCheck;
  assert.equal(c.compared, 3);
  assert.equal(c.tokenExact, 2, 'sonnet-5-5 and opus-5-5 match; the haiku record is a partial counter');
  assert.ok(Math.abs(c.ratio - 1) < 1e-6, `ratio ${c.ratio}`);
  assert.deepEqual(Object.keys(c.byModel).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  x.db.close();
});

test('--since leaves older responses out', async () => {
  const scan = await scanTranscripts({ root });
  const x = imp();
  const b = buildRequests(scan, { priceBook: x.priceBook, sinceTs: T0 + 60 * 60 * S });
  assert.deepEqual(b.requests.map((r) => r.llm_calls[0].id).sort(), ['c:EEE', 'c:FFF'], 'only the worktree (+2h) and beta (+3h) responses are newer than +1h');
  assert.equal(b.skippedBefore, 6, 'AAA, BBB, CCC, DDD, SSS, TTT');
  x.db.close();
});

test('tenant labels: folder name, worktrees folded in, clashes resolved by the first differing ancestor', () => {
  assert.equal(projectRootOf('/a/b/.claude/worktrees/x/src'), '/a/b');
  assert.equal(projectRootOf('/a/b'), '/a/b');
  const m = labelRoots(['/Users/me/Sites/shop', '/Users/me/Desktop/Old Laptop/me/Sites/shop', '/p/widget', '/q/widget', '/solo', '/Users/u/Library/Application Support/Claude/scratch/x']);
  assert.equal(m.get('/solo'), 'solo');
  assert.equal(m.get('/p/widget'), 'widget-p');
  assert.equal(m.get('/q/widget'), 'widget-q');
  assert.equal(m.get('/Users/me/Sites/shop'), 'shop-Users');
  assert.equal(m.get('/Users/me/Desktop/Old Laptop/me/Sites/shop'), 'shop-Old-Laptop');
  assert.equal(m.get('/Users/u/Library/Application Support/Claude/scratch/x'), 'claude-desktop-scratch');
  const all = [...m.values()];
  assert.equal(new Set(all).size, all.length, 'labels are unique');
  for (const l of all) assert.match(l, /^[A-Za-z0-9._-]{1,64}$/);
  // very long / odd folder names still fit the tenant pattern
  const odd = labelRoots(['/x/' + 'n'.repeat(100), '/y/we ird$name']);
  for (const l of odd.values()) assert.match(l, /^[A-Za-z0-9._-]{1,64}$/);
});

test('cross-check helper: no cost records means nothing compared', () => {
  const c = crossCheck(new Map(), new Map());
  assert.deepEqual([c.compared, c.tokenExact, c.ratio], [0, 0, null]);
});
