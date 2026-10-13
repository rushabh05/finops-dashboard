// Print the label `finops proxy --tenant-by-key` gives an API key, so you can name it in --key-map. The key is read from stdin (never a command-line argument,
// which would land in your shell history) and is not stored anywhere.
//
//   printf %s "$OPENAI_API_KEY" | finops key-label
import { keyLabel } from '../src/providers.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const key = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '').trim();
if (!key) { console.error('usage: printf %s "$API_KEY" | finops key-label   (the key is read from stdin)'); process.exit(2); }
console.log(keyLabel(key));
