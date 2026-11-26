import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchLiveMarketPayload } from '../lib/market-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.resolve(__dirname, '../public/data/market-snapshot.json');

async function main() {
  console.log('Fetching live market data from https://api.taskmarket.dev ...');
  const payload = await fetchLiveMarketPayload();
  payload.meta.source = 'scheduled-snapshot';
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  const json = JSON.stringify(payload);
  await writeFile(OUT_FILE, json, 'utf8');
  console.log(
    `Wrote ${OUT_FILE} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB) — dataAsOf=${payload.meta.dataAsOf}, tasks=${payload.tasks.length}, weeks=${payload.weeklyPosters.length}`
  );
}

main().catch((err) => {
  console.error('Snapshot build failed:', err);
  process.exit(1);
});
