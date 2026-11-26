import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';
import { UPSTREAM_BASE, isoWeekStartUtc } from '../lib/market-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BRAND_HEXES = new Set([
  '#12100E',
  '#3A1420',
  '#221E1A',
  '#453E37',
  '#EFE9E2',
  '#FFF6E8',
  '#B0A79D',
  '#E74079',
  '#D9A097',
]);

const BANNED_PATTERNS = [
  /\brevolutionary\b/i,
  /\bgame[- ]changing\b/i,
  /\bthe future of work\b/i,
  /\binsane\b/i,
  /\b10x\b/i,
  /\bpassive income\b/i,
  /\bearn while you sleep\b/i,
  /\bget rich\b/i,
  /\bguaranteed\b/i,
  /\bprofit\b/i,
  /\breturns\b/i,
  /\binvestment\b/i,
  /\bprice prediction\b/i,
  /\bmoon\b/i,
  /\bairdrop\b/i,
  /\btoken launch\b/i,
  /\bAI will replace\b/i,
  /!!+/,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < maxRetries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(8000, ra * 1000) : 700 * (attempt + 1));
      continue;
    }
    assert.equal(res.status, 200, `Expected HTTP 200 from ${url}, got ${res.status}`);
    return { res, body: await res.json() };
  }
}

async function fetchAllTasksDirect(chainId) {
  const byId = new Map();
  let cursor = null;
  for (let p = 0; p < 60; p++) {
    const url = `${UPSTREAM_BASE}/api/tasks?chainId=${chainId}&sort=newest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body } = await fetchJson(url);
    for (const t of body.tasks || []) {
      if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
    }
    cursor = body.nextCursor;
    if (!cursor || !body.hasMore || !(body.tasks || []).length) break;
  }
  return [...byId.values()];
}

function readPngDimensions(buf) {
  const sig = buf.subarray(0, 8);
  assert.equal(sig.toString('hex'), '89504e470d0a1a0a', 'Invalid PNG signature');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('Taskmarket Live Visualizer — Verification & Live API Parity Suite\n');

  // Start local server on ephemeral port
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let apiData = null;
    let firstHeaders = null;

    await test('Server-side /api/market responds 200 with Cache-Control >= 60s and valid UTC dataAsOf', async () => {
      const { res, body } = await fetchJson(`${baseUrl}/api/market`);
      apiData = body;
      firstHeaders = res.headers;

      const cc = res.headers.get('cache-control') || '';
      const sMaxAge = Number((cc.match(/s-maxage=(\d+)/) || [])[1] || 0);
      const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1] || 0);
      assert.ok(sMaxAge >= 60, `Expected s-maxage >= 60, got "${cc}"`);
      assert.ok(maxAge >= 60, `Expected max-age >= 60, got "${cc}"`);
      assert.ok(body.meta?.dataAsOf, 'Missing meta.dataAsOf');
      const ageMs = Math.abs(Date.now() - Date.parse(body.meta.dataAsOf));
      assert.ok(ageMs < 60_000, `dataAsOf should be fresh (<60s), got delta ${ageMs}ms`);
    });

    await test('Server in-memory cache returns X-Cache-Status: HIT on subsequent request', async () => {
      const { res, body } = await fetchJson(`${baseUrl}/api/market`);
      assert.equal(res.headers.get('x-cache-status'), 'HIT', 'Second call should hit in-memory server cache');
      assert.equal(body.meta.dataAsOf, apiData.meta.dataAsOf, 'Cached payload dataAsOf must match');
    });

    await test('Live API parity across 10+ metrics (market/stats, breakdowns, time-series, heatmap, activity-feed)', async () => {
      const liveAll = await fetchJson(`${UPSTREAM_BASE}/api/market/stats`);
      const liveTempo = await fetchJson(`${UPSTREAM_BASE}/api/market/stats?chainId=4217`);
      const liveBase = await fetchJson(`${UPSTREAM_BASE}/api/market/stats?chainId=8453`);
      const liveBreakdowns = await fetchJson(`${UPSTREAM_BASE}/api/stats/breakdowns?chainId=4217`);
      const liveTs30Day = await fetchJson(`${UPSTREAM_BASE}/api/stats/platform-time-series?chainId=4217&range=30d&bucket=day`);
      const liveHm30Hour = await fetchJson(`${UPSTREAM_BASE}/api/stats/activity-heatmap?chainId=4217&range=30d&dimension=hourOfWeek`);
      const liveHm7Mode = await fetchJson(`${UPSTREAM_BASE}/api/stats/activity-heatmap?chainId=4217&range=7d&dimension=mode`);
      const liveFeed = await fetchJson(`${UPSTREAM_BASE}/api/stats/activity-feed?chainId=4217&limit=20`);

      // 1-4: Per-chain paidWorkers and activeWallets match live API verbatim
      assert.equal(apiData.marketStats['4217'].paidWorkers, liveTempo.body.paidWorkers, 'Tempo paidWorkers parity');
      assert.equal(apiData.marketStats['8453'].paidWorkers, liveBase.body.paidWorkers, 'Base paidWorkers parity');
      assert.equal(apiData.marketStats['4217'].activeWallets, liveTempo.body.activeWallets, 'Tempo activeWallets parity');
      assert.equal(apiData.marketStats['8453'].activeWallets, liveBase.body.activeWallets, 'Base activeWallets parity');

      // 5: Combined paidWorkers === Tempo + Base
      assert.equal(apiData.marketStats.all.paidWorkers, liveAll.body.paidWorkers, 'Combined paidWorkers parity');

      // 6: Registered workers within tiny live delta (<= 5 registrations during test)
      assert.ok(
        Math.abs(apiData.marketStats.all.registeredWorkers - liveAll.body.registeredWorkers) <= 5,
        'registeredWorkers live parity'
      );

      // 7-10: Completed prior UTC day in platform-time-series matches live API verbatim across 4 metrics
      const liveRows = liveTs30Day.body;
      const ourRows = apiData.timeSeries.all['30d'].day;
      assert.ok(liveRows.length >= 2 && ourRows.length === liveRows.length, '30d day series length match');
      const prevIdx = liveRows.length - 2; // Yesterday (complete UTC day)
      const livePrev = liveRows[prevIdx];
      const ourPrev = ourRows[prevIdx];
      assert.equal(ourPrev.bucket, livePrev.bucket, 'Prior day bucket date parity');
      assert.equal(ourPrev.tasksCreated, livePrev.tasksCreated, 'Prior day tasksCreated verbatim parity');
      assert.equal(ourPrev.activeAgents, livePrev.activeAgents, 'Prior day activeAgents verbatim parity');
      assert.equal(ourPrev.rewardVolumeRaw, String(livePrev.rewardVolume), 'Prior day rewardVolume verbatim parity');
      assert.equal(ourPrev.paidVolumeRaw, String(livePrev.paidVolume), 'Prior day paidVolume verbatim parity');

      // 11: Breakdowns modes match live API
      const getMode = (arr, m) => arr.find((x) => x.mode === m)?.count;
      for (const m of ['claim', 'pitch', 'benchmark', 'auction']) {
        assert.equal(
          getMode(apiData.breakdowns.all.mode, m),
          getMode(liveBreakdowns.body.mode, m),
          `Breakdown mode=${m} verbatim parity`
        );
      }

      // 12: Heatmap hourOfWeek and 7d mode boundary cells match live API verbatim
      assert.equal(apiData.heatmaps.all['30d'].hourOfWeek.rowKeys.length, 7);
      assert.equal(apiData.heatmaps.all['30d'].hourOfWeek.colKeys.length, 24);
      assert.equal(apiData.heatmaps.all['30d'].hourOfWeek.cells.length, liveHm30Hour.body.cells.length);
      const ourHm7Mode = apiData.heatmaps.all['7d'].mode;
      assert.deepEqual(ourHm7Mode.colKeys, liveHm7Mode.body.colKeys, '7d mode heatmap colKeys verbatim parity');
      const boundaryCol = liveHm7Mode.body.colKeys[0];
      const liveBoundaryBounty = liveHm7Mode.body.cells.find((c) => c.col === boundaryCol && c.row === 'bounty')?.count ?? 0;
      const ourBoundaryBounty = ourHm7Mode.cells.find((c) => c.col === boundaryCol && c.row === 'bounty')?.count ?? 0;
      assert.ok(
        Math.abs(ourBoundaryBounty - liveBoundaryBounty) <= 2,
        `7d mode boundary day (${boundaryCol}) bounty parity: got ${ourBoundaryBounty}, live ${liveBoundaryBounty}`
      );
      const prevCol = liveHm7Mode.body.colKeys[Math.max(0, liveHm7Mode.body.colKeys.length - 2)];
      for (const rowMode of ['bounty', 'claim']) {
        const liveCnt = liveHm7Mode.body.cells.find((c) => c.col === prevCol && c.row === rowMode)?.count ?? 0;
        const ourCnt = ourHm7Mode.cells.find((c) => c.col === prevCol && c.row === rowMode)?.count ?? 0;
        assert.equal(ourCnt, liveCnt, `7d mode heatmap (${prevCol}, ${rowMode}) verbatim parity`);
      }

      // 13: Activity feed populated from live upstream
      assert.ok(apiData.activityFeed.length >= 50, 'Activity feed has >= 50 items');
      assert.ok(liveFeed.body.items.length > 0);
    });

    await test('Distinct task posters per week matches independent pagination of /api/tasks for both chains', async () => {
      const directTempo = await fetchAllTasksDirect(4217);
      const directBase = await fetchAllTasksDirect(8453);
      assert.ok(apiData.weeklyPosters.length >= 10, 'Expected >= 10 weekly poster buckets');

      // Pick the last completed full week (index - 2) for exact deterministic comparison
      const targetRow = apiData.weeklyPosters[apiData.weeklyPosters.length - 2];
      const w = targetRow.week;
      const tempoSet = new Set();
      const baseSet = new Set();
      const allSet = new Set();
      for (const t of directTempo) {
        if (isoWeekStartUtc(t.createdAt) === w && t.requester) {
          tempoSet.add(t.requester.toLowerCase());
          allSet.add(t.requester.toLowerCase());
        }
      }
      for (const t of directBase) {
        if (isoWeekStartUtc(t.createdAt) === w && t.requester) {
          baseSet.add(t.requester.toLowerCase());
          allSet.add(t.requester.toLowerCase());
        }
      }
      assert.equal(targetRow.tempo, tempoSet.size, `Week ${w} distinct Tempo posters parity`);
      assert.equal(targetRow.base, baseSet.size, `Week ${w} distinct Base posters parity`);
      assert.equal(targetRow.all, allSet.size, `Week ${w} distinct Combined posters parity`);
    });

    await test('Escrow Flow River balances exactly across requester tiers, chains, and outcomes', async () => {
      for (const scope of ['all', '4217', '8453']) {
        const flow = apiData.escrowFlow[scope];
        const sumTiers = flow.tiers.reduce((a, n) => a + n.usd, 0);
        const sumChains = flow.chains.reduce((a, n) => a + n.usd, 0);
        const sumOutcomes = flow.outcomes.reduce((a, n) => a + n.usd, 0);
        assert.ok(Math.abs(sumTiers - flow.totalUsd) < 0.02, `${scope} tiers sum matches totalUsd`);
        assert.ok(Math.abs(sumChains - flow.totalUsd) < 0.02, `${scope} chains sum matches totalUsd`);
        assert.ok(Math.abs(sumOutcomes - flow.totalUsd) < 0.02, `${scope} outcomes sum matches totalUsd`);
      }
    });

    await test('Zero browser calls to api.taskmarket.dev & zero tracking/wallet-connect code', async () => {
      const appJs = await readFile(path.join(ROOT, 'public/app.js'), 'utf8');
      const indexHtml = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
      const combined = appJs + '\n' + indexHtml;

      assert.ok(!/fetch\s*\([^)]*api\.taskmarket\.dev/i.test(appJs), 'Browser JS must not fetch api.taskmarket.dev directly');
      assert.ok(!/window\.ethereum|walletconnect|wagmi|rainbowkit|ethers/i.test(combined), 'Must not include wallet connection');
      assert.ok(!/googletagmanager|google-analytics|gtag\(|plausible\.io|mixpanel|segment\.com|posthog/i.test(combined), 'Must not include tracking analytics');
    });

    await test('Strict Brand Kit 9-colour compliance across CSS and JS', async () => {
      for (const rel of ['public/styles.css', 'public/app.js']) {
        const txt = await readFile(path.join(ROOT, rel), 'utf8');
        const hexes = [...txt.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase());
        const illegal = [...new Set(hexes.filter((h) => !BRAND_HEXES.has(h)))];
        assert.deepEqual(illegal, [], `${rel} contains non-Brand-Kit hex colours: ${illegal.join(', ')}`);
      }
    });

    await test('Zero Brand Kit banned words across UI and documentation files', async () => {
      const files = ['public/index.html', 'public/app.js', 'public/styles.css'];
      for (const optional of ['README.md', 'notes.txt']) {
        try {
          await stat(path.join(ROOT, optional));
          files.push(optional);
        } catch {
          // Optional before docs step
        }
      }
      for (const rel of files) {
        const txt = await readFile(path.join(ROOT, rel), 'utf8');
        for (const pat of BANNED_PATTERNS) {
          const m = txt.match(pat);
          assert.equal(m, null, `${rel} contains banned term "${m?.[0]}" matching ${pat}`);
        }
      }
    });

    await test('Required footer statement, MIT LICENSE, untouched Brand assets, OFL licenses, and 1200x630 og-image.png', async () => {
      const indexHtml = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
      assert.ok(
        indexHtml.includes('Made for a paid Taskmarket bounty. Not an official Taskmarket product.'),
        'Footer must include exact required bounty disclaimer'
      );

      const license = await readFile(path.join(ROOT, 'LICENSE'), 'utf8');
      assert.ok(license.includes('MIT License'), 'LICENSE must be MIT');

      const lockupBuf = await readFile(path.join(ROOT, 'public/assets/taskmarket-lockup.png'));
      assert.deepEqual(readPngDimensions(lockupBuf), { width: 971, height: 176 }, 'Lockup must be untouched 971x176');

      const markBuf = await readFile(path.join(ROOT, 'public/assets/taskmarket-mark.png'));
      assert.deepEqual(readPngDimensions(markBuf), { width: 1000, height: 1000 }, 'Mark must be untouched 1000x1000');

      const ogBuf = await readFile(path.join(ROOT, 'public/og-image.png'));
      assert.deepEqual(readPngDimensions(ogBuf), { width: 1200, height: 630 }, 'og-image.png must be 1200x630 PNG');

      for (const f of [
        'DepartureMono-Regular.woff2',
        'DepartureMono-Regular.otf',
        'InstrumentSerif-Regular.ttf',
        'InstrumentSerif-Italic.ttf',
        'InterTight-Variable.ttf',
        'font-license-departure-mono.OFL.txt',
        'font-license-instrument-serif.OFL.txt',
        'font-license-inter-tight.OFL.txt',
      ]) {
        const st = await stat(path.join(ROOT, 'public/assets/fonts', f));
        assert.ok(st.size > 0, `Missing font/license asset: ${f}`);
      }
    });

    await test('Static frontend serves index.html, styles.css, app.js, and og-image.png cleanly', async () => {
      for (const route of ['/', '/styles.css', '/app.js', '/og-image.png', '/assets/taskmarket-lockup.png']) {
        const r = await fetch(`${baseUrl}${route}`);
        assert.equal(r.status, 200, `Expected 200 for ${route}`);
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\nSummary: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}.`);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
