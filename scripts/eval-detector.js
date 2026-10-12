// Detector evaluation (not part of `npm test`): 14 seeds x 7 days of hourly evaluations with three injected anomalies.
// Prints, per seed, alerts raised OUTSIDE the injected windows (false positives / collateral) and whether each
// injected anomaly was found. Run:  node --disable-warning=ExperimentalWarning scripts/eval-detector.js
const P = new URL('../src/', import.meta.url).href;
const { openDb } = await import(P + 'db.js');
const { PriceBook, seedPrices } = await import(P + 'pricing.js');
const { Ingestor } = await import(P + 'ingest.js');
const { seedHistory } = await import(P + 'sim.js');
const { Detector } = await import(P + 'detector.js');
const HOUR = 3600000, DAY = 24 * HOUR;
const T = Date.UTC(2026, 9, 12, 0, 0, 0);
const inj = [
  { kind: 'tenant_cost_spike', tenant: 'globex', startTs: T - 60 * HOUR, endTs: T - 57 * HOUR },
  { kind: 'token_bloat', endpoint: '/v1/chat', startTs: T - 40 * HOUR, endTs: T - 37 * HOUR },
  { kind: 'retry_storm', tenant: 'acme', endpoint: '/v1/classify', startTs: T - 20 * HOUR, endTs: T - 17 * HOUR },
];
let totalFp = 0, misses = 0;
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42, 99, 1234, 2024]) {
  const db = openDb(); seedPrices(db);
  const ing = new Ingestor(db, new PriceBook(db));
  seedHistory(ing, { seed, days: 14, endTs: T, injections: inj });
  const det = new Detector(db);
  let fp = 0; const found = {}; const fpl = [];
  for (let b = T - 7 * DAY + HOUR; b <= T; b += HOUR) {
    const { hour, candidates } = det.evaluate(b);
    const w = inj.find((i) => hour >= i.startTs && hour < i.endTs);
    for (const c of candidates) {
      if (!w) { fp++; fpl.push(`${new Date(hour).toISOString().slice(5,13)} ${c.kind}@${c.tenant_id ?? '*'}/${c.endpoint ?? '*'} z=${c.score.toFixed(1)}`); continue; }
      const ok = (w.kind === 'tenant_cost_spike' && c.tenant_id === 'globex' && !c.endpoint && c.kind === 'cost_spike')
        || (w.kind === 'token_bloat' && c.endpoint === '/v1/chat' && !c.tenant_id && c.kind === 'tokens_per_request')
        || (w.kind === 'retry_storm' && c.kind === 'retry_storm' && (c.tenant_id === 'acme' || c.endpoint === '/v1/classify'));
      if (ok) found[w.kind] = (found[w.kind] || 0) + 1; else { fp++; fpl.push(`COLLATERAL ${c.kind}@${c.tenant_id ?? '*'}/${c.endpoint ?? '*'}`); }
    }
  }
  const missing = ['tenant_cost_spike', 'token_bloat', 'retry_storm'].filter((k) => !found[k]);
  totalFp += fp; misses += missing.length;
  console.log(`seed ${seed}: fp=${fp} found=${JSON.stringify(found)} ${missing.length ? 'MISSING ' + missing : ''} ${fpl.join(' | ')}`);
}
console.log({ totalFp, misses });
