import { pathToFileURL } from 'node:url';
import { createApp, createWorkspace } from './app.js';
import { createMultiApp } from './multi.js';
import { isLoopbackHost } from './security.js';
import { parseWebhookUrl } from './notify.js';

/*
 * Entry point (`npm start`) and the public import surface.
 *
 * The application code lives in app.js (one database: createWorkspace / createApp) and multi.js (several: createMultiApp). This file
 * only starts one of them, so neither has to import it back: an entry module that awaits a module which imports the entry module
 * again deadlocks ("unsettled top-level await"), which is exactly how the first published version of `npm start` failed.
 */
export { createApp, createWorkspace, createMultiApp };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // No DB_PATH: multi-database mode (every dashboard database in DATA_DIR, with a source switcher in the page).
  // DB_PATH set: exactly that one database, served at the root, no switcher.
  const multi = !process.env.DB_PATH;
  const log = (m) => console.log(`[finops] ${m}`);
  const app = multi ? await createMultiApp({ log }) : await createApp({ log });
  try {
    await app.listen();
  } catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `[finops] port ${app.cfg.port} is already in use - set PORT=<other>, or stop the process that has it (lsof -iTCP:${app.cfg.port} -sTCP:LISTEN)` : `[finops] ${e.message}`);
    process.exit(1);
  }
  const llm = app.cfg.anthropicKey ? `Anthropic (${app.cfg.anthropicModel})` : 'deterministic mock (set ANTHROPIC_API_KEY for Claude)';
  console.log(`[finops] dashboard on ${app.url}   explanations: ${llm}`);
  if (multi) console.log(`[finops] data sources in ${app.cfg.dataDir}: ${app.sources().map((s) => `${s.id} (${s.kind})`).join(', ')}  - switch between them in the page`);
  if (app.cfg.alertWebhookUrl) { const w = parseWebhookUrl(app.cfg.alertWebhookUrl, app.cfg.alertWebhookFormat); console.log(`[finops] new alerts are posted to ${w.host} (${w.format} format); simulated data never notifies`); }
  if (!isLoopbackHost(app.cfg.host)) console.log(`[finops] bound to ${app.cfg.host}${app.cfg.authToken ? ' with AUTH_TOKEN' : ' WITHOUT authentication (ALLOW_INSECURE=1)'} - also set ALLOWED_ORIGINS/ALLOWED_HOSTS for the names you serve; use HTTPS in front and COOKIE_SECURE=1.`);
  else if (app.cfg.authToken) console.log('[finops] AUTH_TOKEN is set: open /?token=<AUTH_TOKEN> once per browser, or send "Authorization: Bearer <AUTH_TOKEN>".');
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
