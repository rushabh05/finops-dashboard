// Seeds the database (history through the real ingest path) without starting the HTTP server.
//   npm run seed            (honours DB_PATH, SEED_DAYS, SEED_VOLUME, SIM_SEED)
import { createApp } from '../src/server.js';

const app = await createApp({ log: (m) => console.log(`[seed] ${m}`), simAutoStart: false });
const n = app.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
console.log(`[seed] database at ${app.cfg.dbPath} holds ${n.toLocaleString('en-US')} requests`);
await app.close();
