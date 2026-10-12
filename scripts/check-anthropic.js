// Live check of the Anthropic explanation source against the REAL API (needs ANTHROPIC_API_KEY; costs well under one cent).
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run check:llm
//   ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-opus-5-5 ANTHROPIC_EFFORT= npm run check:llm
//
// It sends the same request the dashboard sends (model, max_tokens, stream, output_config.effort) with a tiny prompt and reports
// whether the request is accepted, the time to first text, and what came back. If the API rejects `output_config.effort`
// for this model it retries without it and tells you to set ANTHROPIC_EFFORT= (empty). ANTHROPIC_BASE_URL is honoured (used to
// test this script against a local fake). Exit code 0 = the source works as configured.
import { loadConfig } from '../src/config.js';
import { anthropicSource } from '../src/explain.js';

const cfg = loadConfig();
if (!cfg.anthropicKey) {
  console.error('ANTHROPIC_API_KEY is not set. Example:  ANTHROPIC_API_KEY=sk-ant-... npm run check:llm');
  process.exit(2);
}
const system = 'You write one short sentence. No preamble.';
const user = 'Say that the FinOps dashboard connection works, and name your model if you know it.';

async function attempt(effort) {
  const t0 = Date.now();
  let first = null, chunks = 0, text = '';
  try {
    for await (const piece of anthropicSource({ apiKey: cfg.anthropicKey, model: cfg.anthropicModel, baseUrl: cfg.anthropicBaseUrl, effort, maxTokens: cfg.anthropicMaxTokens, system, user, signal: AbortSignal.timeout(60_000) })) {
      if (first === null) first = Date.now() - t0;
      chunks++;
      text += piece;
    }
    return { ok: true, first, ms: Date.now() - t0, chunks, text: text.trim() };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

console.log(`Checking ${cfg.anthropicBaseUrl}  model ${cfg.anthropicModel}  effort ${cfg.anthropicEffort || '(omitted)'}  max_tokens ${cfg.anthropicMaxTokens}`);
let r = await attempt(cfg.anthropicEffort);
let advice = null;
if (!r.ok && cfg.anthropicEffort && /^Anthropic API 400/.test(r.error) && /effort|output_config/i.test(r.error)) {
  console.log(`  rejected: ${r.error}`);
  console.log('  retrying without output_config.effort ...');
  const r2 = await attempt('');
  if (r2.ok) { advice = 'The API rejected output_config.effort for this model but works without it: set ANTHROPIC_EFFORT= (empty) when starting the dashboard.'; r = r2; }
  else r = { ...r2, error: `${r.error}  /  without effort: ${r2.error}` };
}
if (r.ok) {
  console.log(`PASS  first text after ${r.first} ms, ${r.chunks} chunks, ${r.ms} ms total`);
  console.log(`      "${r.text.slice(0, 200)}"`);
  if (advice) console.log(`NOTE  ${advice}`);
  process.exit(0);
}
console.error(`FAIL  ${r.error}`);
if (/401|403/.test(r.error)) console.error('      Check the key (and that it has API access: a Claude.ai subscription is not an API key).');
if (/404/.test(r.error)) console.error('      Check ANTHROPIC_MODEL: the model id may not exist for your account.');
if (/whole token budget/.test(r.error)) console.error('      Raise ANTHROPIC_MAX_TOKENS or lower ANTHROPIC_EFFORT.');
process.exit(1);
