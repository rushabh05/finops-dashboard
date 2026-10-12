// Send one clearly labelled test message to ALERT_WEBHOOK_URL, to check the setup before an alert depends on it.
//
//   ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... npm run check:webhook      (or: finops check-webhook)
//   ALERT_WEBHOOK_FORMAT=auto|slack|discord|json   (auto picks by host)
//
// Exit code 0 = the endpoint answered 2xx. The URL is a secret, so only its host is ever printed.
import { loadConfig } from '../src/config.js';
import { Notifier, parseWebhookUrl } from '../src/notify.js';

const cli = !!process.env.FINOPS_CLI;
const cfg = loadConfig();
if (!cfg.alertWebhookUrl) {
  console.error(`ALERT_WEBHOOK_URL is not set. Example:  ALERT_WEBHOOK_URL=https://hooks.slack.com/services/... ${cli ? 'finops check-webhook' : 'npm run check:webhook'}`);
  process.exit(2);
}
let target;
try { target = parseWebhookUrl(cfg.alertWebhookUrl, cfg.alertWebhookFormat); } catch (e) { console.error(e.message); process.exit(2); }
console.log(`Sending a test message to ${target.host} (${target.format} format)...`);
const r = await new Notifier({ url: cfg.alertWebhookUrl, format: cfg.alertWebhookFormat, source: 'check-webhook' }).sendTest();
if (r.ok) { console.log(`  delivered (HTTP ${r.status}). Look for "Test message from the FinOps dashboard" in the channel.`); process.exit(0); }
console.error(`  FAILED: ${r.error}`);
process.exit(1);
