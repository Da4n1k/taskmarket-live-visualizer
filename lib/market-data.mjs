import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const UPSTREAM_BASE = 'https://api.taskmarket.dev';
export const CHAINS = {
  tempo: { id: 4217, key: 'tempo', name: 'Tempo', currency: 'OUSD' },
  base: { id: 8453, key: 'base', name: 'Base', currency: 'USDC' },
};
export const RANGES = ['7d', '30d', '90d', 'all'];
export const BUCKETS = ['day', 'week'];
export const CACHE_TTL_MS = 300_000; // 5 minutes (>= 60s, <= 1h)
export const CACHE_CONTROL_HEADER = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.resolve(__dirname, '../public/data/market-snapshot.json');

let memoryCache = null;
let inFlight = null;

function microToUsd(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  try {
    const bi = typeof raw === 'bigint' ? raw : BigInt(String(raw).split('.')[0]);
    const whole = bi / 1_000_000n;
    const frac = bi % 1_000_000n;
    return Number(whole) + Number(frac) / 1_000_000;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n / 1_000_000 : 0;
  }
}

function toBigIntSafe(raw) {
  if (raw === null || raw === undefined || raw === '') return 0n;
  try {
    return BigInt(String(raw).split('.')[0]);
  } catch {
    return 0n;
  }
}

export function truncateAddress(addr) {
  if (!addr || typeof addr !== 'string') return 'unknown';
  const clean = addr.trim();
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

export function isoWeekStartUtc(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

function isoDateUtc(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function firstLineTitle(description, fallbackRef) {
  if (!description || typeof description !== 'string') return fallbackRef || 'Untitled task';
  const line = description
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0 && !/^title$/i.test(l));
  const text = line || fallbackRef || 'Untitled task';
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(endpointPath, timeoutMs = 15_000, maxRetries = 4) {
  const url = `${UPSTREAM_BASE}${endpointPath}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'taskmarket-live-visualizer/1.0 (+https://taskmarket.dev)',
        },
        signal: controller.signal,
      });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(8000, retryAfter * 1000)
          : Math.min(5000, 450 * 2 ** attempt + Math.floor(Math.random() * 200));
        lastErr = new Error(`HTTP ${res.status} for ${endpointPath}`);
        if (attempt < maxRetries) {
          await sleep(delayMs);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${endpointPath}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep(Math.min(4000, 400 * 2 ** attempt));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const i = nextIdx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchAllTasksForChain(chainId, maxPages = 60) {
  const byId = new Map();
  let cursor = null;
  let pages = 0;
  while (pages < maxPages) {
    const qs = `/api/tasks?chainId=${chainId}&sort=newest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await fetchJson(qs);
    const batch = Array.isArray(data?.tasks) ? data.tasks : [];
    for (const task of batch) {
      if (task?.id && !byId.has(task.id)) byId.set(task.id, task);
    }
    pages++;
    cursor = data?.nextCursor || null;
    if (!cursor || !data?.hasMore || batch.length === 0) break;
  }
  return { tasks: [...byId.values()], pages };
}

async function fetchActivityFeedPages(pagesCount = 3) {
  const items = [];
  let cursor = null;
  for (let i = 0; i < pagesCount; i++) {
    const qs = `/api/stats/activity-feed?chainId=4217&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await fetchJson(qs);
    const batch = Array.isArray(data?.items) ? data.items : [];
    items.push(...batch);
    cursor = data?.nextCursor || null;
    if (!cursor || batch.length === 0) break;
  }
  return items;
}

function normalizeTimeSeries(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    bucket: r.bucket,
    tasksCreated: Number(r.tasksCreated || 0),
    rewardVolumeUsd: microToUsd(r.rewardVolume),
    rewardVolumeRaw: String(r.rewardVolume ?? '0'),
    completedTasks: Number(r.completedTasks || 0),
    newAgents: Number(r.newAgents || 0),
    activeAgents: Number(r.activeAgents || 0),
    paidVolumeUsd: microToUsd(r.paidVolume),
    paidVolumeRaw: String(r.paidVolume ?? '0'),
    settlements: Number(r.settlements || 0),
    ratings: Number(r.ratings || 0),
  }));
}

function buildChainTimeSeries(tasks, platformSeriesByRange) {
  const result = {};
  for (const range of RANGES) {
    result[range] = {};
    for (const bucket of BUCKETS) {
      const refSeries = platformSeriesByRange[range]?.[bucket] || [];
      const bucketMap = new Map();
      for (const row of refSeries) {
        bucketMap.set(row.bucket, {
          bucket: row.bucket,
          tasksCreated: 0,
          rewardMicro: 0n,
          completedTasks: 0,
          paidMicro: 0n,
          activeAgents: row.activeAgents,
          newAgents: row.newAgents,
          settlements: 0,
        });
      }
      for (const t of tasks) {
        if (!t.createdAt) continue;
        const key = bucket === 'week' ? isoWeekStartUtc(t.createdAt) : isoDateUtc(t.createdAt);
        const slot = bucketMap.get(key);
        if (!slot) continue;
        const rw = toBigIntSafe(t.reward);
        slot.tasksCreated += 1;
        slot.rewardMicro += rw;
        if (t.status === 'completed') {
          slot.completedTasks += 1;
          slot.paidMicro += rw;
          slot.settlements += Number(t.awardCount || 1);
        }
      }
      result[range][bucket] = refSeries.map((row) => {
        const slot = bucketMap.get(row.bucket);
        return {
          bucket: slot.bucket,
          tasksCreated: slot.tasksCreated,
          rewardVolumeUsd: microToUsd(slot.rewardMicro),
          rewardVolumeRaw: slot.rewardMicro.toString(),
          completedTasks: slot.completedTasks,
          paidVolumeUsd: microToUsd(slot.paidMicro),
          paidVolumeRaw: slot.paidMicro.toString(),
          activeAgents: slot.activeAgents,
          newAgents: slot.newAgents,
          settlements: slot.settlements,
        };
      });
    }
  }
  return result;
}

function buildBreakdownsFromTasks(tasks, platformActorType) {
  const statusCounts = new Map();
  const modeCounts = new Map();
  for (const t of tasks) {
    if (t.status) statusCounts.set(t.status, (statusCounts.get(t.status) || 0) + 1);
    if (t.mode) modeCounts.set(t.mode, (modeCounts.get(t.mode) || 0) + 1);
  }
  return {
    status: [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    mode: [...modeCounts.entries()]
      .map(([mode, count]) => ({ mode, count }))
      .sort((a, b) => b.count - a.count),
    actorType: platformActorType,
  };
}

function buildHeatmapsFromTasks(tasks, platformHeatmaps, nowMs) {
  const rangeDays = { '7d': 7, '30d': 30, '90d': 90, all: null };
  const out = {};
  for (const range of RANGES) {
    const days = rangeDays[range];
    const cutoffMs = days ? nowMs - days * 86_400_000 : 0;
    const filtered = days ? tasks.filter((t) => Date.parse(t.createdAt) >= cutoffMs) : tasks;

    // Mode heatmap
    const refMode = platformHeatmaps[range]?.mode || { rowKeys: ['bounty', 'claim', 'pitch', 'benchmark', 'auction'], colKeys: [] };
    const modeRowKeys = refMode.rowKeys || ['bounty', 'claim', 'pitch', 'benchmark', 'auction'];
    const modeColSet = new Set(refMode.colKeys || []);
    const modeCellsMap = new Map();
    for (const t of filtered) {
      const col = isoDateUtc(t.createdAt);
      const row = t.mode;
      if (!col || !row) continue;
      if (modeColSet.size > 0 && !modeColSet.has(col)) continue;
      const k = `${row}|${col}`;
      const cur = modeCellsMap.get(k) || { row, col, count: 0, vol: 0n };
      cur.count += 1;
      cur.vol += toBigIntSafe(t.reward);
      modeCellsMap.set(k, cur);
    }

    // Hour-of-week heatmap (row: 0=Sun..6=Sat matching upstream, col: 0..23 UTC)
    const hourCellsMap = new Map();
    for (const t of filtered) {
      const d = new Date(t.createdAt);
      if (Number.isNaN(d.getTime())) continue;
      const row = String(d.getUTCDay());
      const col = String(d.getUTCHours());
      const k = `${row}|${col}`;
      const cur = hourCellsMap.get(k) || { row, col, count: 0, vol: 0n };
      cur.count += 1;
      cur.vol += toBigIntSafe(t.reward);
      hourCellsMap.set(k, cur);
    }

    out[range] = {
      mode: {
        rowKeys: modeRowKeys,
        colKeys: refMode.colKeys || [...new Set([...modeCellsMap.values()].map((c) => c.col))].sort(),
        cells: [...modeCellsMap.values()].map((c) => ({ row: c.row, col: c.col, count: c.count, volume: c.vol.toString() })),
      },
      hourOfWeek: {
        rowKeys: ['0', '1', '2', '3', '4', '5', '6'],
        colKeys: Array.from({ length: 24 }, (_, i) => String(i)),
        cells: [...hourCellsMap.values()].map((c) => ({ row: c.row, col: c.col, count: c.count, volume: c.vol.toString() })),
      },
    };
  }
  return out;
}

function buildWeeklyPosters(tempoTasks, baseTasks) {
  const weeks = new Map();
  const ensure = (w) => {
    if (!weeks.has(w)) {
      weeks.set(w, {
        week: w,
        allSet: new Set(),
        tempoSet: new Set(),
        baseSet: new Set(),
        tasksAll: 0,
        tasksTempo: 0,
        tasksBase: 0,
        rewardAllMicro: 0n,
        rewardTempoMicro: 0n,
        rewardBaseMicro: 0n,
      });
    }
    return weeks.get(w);
  };

  for (const t of tempoTasks) {
    const w = isoWeekStartUtc(t.createdAt);
    if (!w) continue;
    const slot = ensure(w);
    const req = (t.requester || '').toLowerCase();
    if (req) {
      slot.allSet.add(req);
      slot.tempoSet.add(req);
    }
    slot.tasksAll += 1;
    slot.tasksTempo += 1;
    const rw = toBigIntSafe(t.reward);
    slot.rewardAllMicro += rw;
    slot.rewardTempoMicro += rw;
  }

  for (const t of baseTasks) {
    const w = isoWeekStartUtc(t.createdAt);
    if (!w) continue;
    const slot = ensure(w);
    const req = (t.requester || '').toLowerCase();
    if (req) {
      slot.allSet.add(req);
      slot.baseSet.add(req);
    }
    slot.tasksAll += 1;
    slot.tasksBase += 1;
    const rw = toBigIntSafe(t.reward);
    slot.rewardAllMicro += rw;
    slot.rewardBaseMicro += rw;
  }

  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((s) => ({
      week: s.week,
      all: s.allSet.size,
      tempo: s.tempoSet.size,
      base: s.baseSet.size,
      tasksAll: s.tasksAll,
      tasksTempo: s.tasksTempo,
      tasksBase: s.tasksBase,
      rewardAllUsd: microToUsd(s.rewardAllMicro),
      rewardTempoUsd: microToUsd(s.rewardTempoMicro),
      rewardBaseUsd: microToUsd(s.rewardBaseMicro),
    }));
}

function outcomeKey(status) {
  if (status === 'completed') return 'settled';
  if (status === 'open' || status === 'claimed' || status === 'worker_selected') return 'active';
  if (status === 'pending_approval') return 'pending';
  if (status === 'expired' || status === 'cancelled') return 'dead';
  return 'active';
}

function buildEscrowFlow(tasks) {
  // Rank requesters by total escrowed USD within this task slice
  const reqVol = new Map();
  for (const t of tasks) {
    const req = (t.requester || 'unknown').toLowerCase();
    reqVol.set(req, (reqVol.get(req) || 0n) + toBigIntSafe(t.reward));
  }
  const ranked = [...reqVol.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const tierOf = new Map();
  ranked.forEach(([addr], idx) => {
    if (idx < 5) tierOf.set(addr, 'top5');
    else if (idx < 20) tierOf.set(addr, 'next15');
    else tierOf.set(addr, 'tail');
  });

  const tiers = {
    top5: { id: 'top5', label: 'Top 5 Requesters', wallets: Math.min(5, ranked.length), tasks: 0, micro: 0n },
    next15: { id: 'next15', label: 'Requesters #6–20', wallets: Math.max(0, Math.min(15, ranked.length - 5)), tasks: 0, micro: 0n },
    tail: { id: 'tail', label: 'Long-Tail Requesters', wallets: Math.max(0, ranked.length - 20), tasks: 0, micro: 0n },
  };
  const chains = {
    tempo: { id: 'tempo', label: 'Tempo Escrow (OUSD)', chainId: 4217, tasks: 0, micro: 0n },
    base: { id: 'base', label: 'Base Escrow (USDC)', chainId: 8453, tasks: 0, micro: 0n },
  };
  const outcomes = {
    settled: { id: 'settled', label: 'Settled Payouts', tasks: 0, micro: 0n, winners: new Set() },
    active: { id: 'active', label: 'Open & Claimed', tasks: 0, micro: 0n },
    pending: { id: 'pending', label: 'Pending Approval', tasks: 0, micro: 0n },
    dead: { id: 'dead', label: 'Expired & Cancelled', tasks: 0, micro: 0n },
  };

  const tierToChain = new Map();
  const chainToOutcome = new Map();
  let totalMicro = 0n;

  for (const t of tasks) {
    const rw = toBigIntSafe(t.reward);
    totalMicro += rw;
    const req = (t.requester || 'unknown').toLowerCase();
    const tier = tierOf.get(req) || 'tail';
    const chain = t.chainId === 4217 ? 'tempo' : 'base';
    const out = outcomeKey(t.status);

    tiers[tier].tasks += 1;
    tiers[tier].micro += rw;
    chains[chain].tasks += 1;
    chains[chain].micro += rw;
    outcomes[out].tasks += 1;
    outcomes[out].micro += rw;
    if (out === 'settled' && t.primaryAward?.workerAddress) {
      outcomes.settled.winners.add(t.primaryAward.workerAddress.toLowerCase());
    }

    const k1 = `${tier}->${chain}`;
    const l1 = tierToChain.get(k1) || { from: tier, to: chain, tasks: 0, micro: 0n };
    l1.tasks += 1;
    l1.micro += rw;
    tierToChain.set(k1, l1);

    const k2 = `${chain}->${out}`;
    const l2 = chainToOutcome.get(k2) || { from: chain, to: out, tasks: 0, micro: 0n };
    l2.tasks += 1;
    l2.micro += rw;
    chainToOutcome.set(k2, l2);
  }

  const totalUsd = microToUsd(totalMicro);
  return {
    totalUsd,
    totalTasks: tasks.length,
    tiers: Object.values(tiers).map((n) => ({
      id: n.id,
      label: n.label,
      wallets: n.wallets,
      tasks: n.tasks,
      usd: microToUsd(n.micro),
      share: totalUsd > 0 ? microToUsd(n.micro) / totalUsd : 0,
    })),
    chains: Object.values(chains).map((n) => ({
      id: n.id,
      label: n.label,
      chainId: n.chainId,
      tasks: n.tasks,
      usd: microToUsd(n.micro),
      share: totalUsd > 0 ? microToUsd(n.micro) / totalUsd : 0,
    })),
    outcomes: Object.values(outcomes).map((n) => ({
      id: n.id,
      label: n.label,
      tasks: n.tasks,
      usd: microToUsd(n.micro),
      share: totalUsd > 0 ? microToUsd(n.micro) / totalUsd : 0,
      distinctWinners: n.winners ? n.winners.size : undefined,
    })),
    linksTierToChain: [...tierToChain.values()].map((l) => ({
      from: l.from,
      to: l.to,
      tasks: l.tasks,
      usd: microToUsd(l.micro),
    })),
    linksChainToOutcome: [...chainToOutcome.values()].map((l) => ({
      from: l.from,
      to: l.to,
      tasks: l.tasks,
      usd: microToUsd(l.micro),
    })),
  };
}

function buildInsights(tasks, feedEvents, nowMs) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let totalMicro = 0n;
  let completedMicro = 0n;
  let openMicro = 0n;
  let pendingMicro = 0n;
  let expiredMicro = 0n;
  let cancelledMicro = 0n;

  let completedCount = 0;
  let openCount = 0;
  let claimedCount = 0;
  let pendingCount = 0;
  let expiredCount = 0;
  let cancelledCount = 0;
  let deadZeroSubs = 0;
  let earlySettledCount = 0;
  let totalSubmissions = 0;
  let tasksWithSubmissions = 0;

  const reqMap = new Map();
  const awardedWorkers = new Set();
  const claimMins = [];
  const windowHrs = [];
  const ratings = [];

  for (const t of tasks) {
    const rw = toBigIntSafe(t.reward);
    totalMicro += rw;
    const subs = Number(t.submissionCount || 0);
    totalSubmissions += subs;
    if (subs > 0) tasksWithSubmissions += 1;

    if (t.status === 'completed') {
      completedCount += 1;
      completedMicro += rw;
      if (t.expiryTime && Date.parse(t.expiryTime) > nowMs) earlySettledCount += 1;
    } else if (t.status === 'open') {
      openCount += 1;
      openMicro += rw;
    } else if (t.status === 'claimed' || t.status === 'worker_selected') {
      claimedCount += 1;
      openMicro += rw;
    } else if (t.status === 'pending_approval') {
      pendingCount += 1;
      pendingMicro += rw;
    } else if (t.status === 'expired') {
      expiredCount += 1;
      expiredMicro += rw;
      if (subs === 0) deadZeroSubs += 1;
    } else if (t.status === 'cancelled') {
      cancelledCount += 1;
      cancelledMicro += rw;
      if (subs === 0) deadZeroSubs += 1;
    }

    const req = (t.requester || 'unknown').toLowerCase();
    const rc = reqMap.get(req) || { addr: req, tasks: 0, completed: 0, micro: 0n, chains: new Set() };
    rc.tasks += 1;
    if (t.status === 'completed') rc.completed += 1;
    rc.micro += rw;
    rc.chains.add(t.chainId);
    reqMap.set(req, rc);

    if (t.primaryAward?.workerAddress) {
      awardedWorkers.add(t.primaryAward.workerAddress.toLowerCase());
    }
    if (typeof t.primaryAward?.rating === 'number') {
      ratings.push(t.primaryAward.rating);
    }
    if (t.claimedAt && t.createdAt) {
      const m = (Date.parse(t.claimedAt) - Date.parse(t.createdAt)) / 60_000;
      if (Number.isFinite(m) && m >= 0) claimMins.push(m);
    }
    if (t.expiryTime && t.createdAt) {
      const h = (Date.parse(t.expiryTime) - Date.parse(t.createdAt)) / 3_600_000;
      if (Number.isFinite(h) && h > 0 && h < 10_000) windowHrs.push(h);
    }
  }

  claimMins.sort((a, b) => a - b);
  windowHrs.sort((a, b) => a - b);

  // Recent submission latency from live feed matched to tasks in this slice
  const subLatencyMins = [];
  for (const ev of feedEvents) {
    if (ev.type !== 'task_submitted') continue;
    const t = byId.get(ev.taskId);
    if (!t || !t.createdAt || !ev.timestamp) continue;
    const m = (Date.parse(ev.timestamp) - Date.parse(t.createdAt)) / 60_000;
    if (Number.isFinite(m) && m >= 0) subLatencyMins.push(m);
  }
  subLatencyMins.sort((a, b) => a - b);

  const reqListByVol = [...reqMap.values()].sort((a, b) => (b.micro > a.micro ? 1 : b.micro < a.micro ? -1 : b.tasks - a.tasks));
  const reqListByCnt = [...reqMap.values()].sort((a, b) => b.tasks - a.tasks);
  const totalUsd = microToUsd(totalMicro);
  const sumTopVol = (k) => reqListByVol.slice(0, k).reduce((acc, r) => acc + microToUsd(r.micro), 0);
  const sumTopCnt = (k) => reqListByCnt.slice(0, k).reduce((acc, r) => acc + r.tasks, 0);

  let hhiVolume = 0;
  if (totalUsd > 0) {
    for (const r of reqListByVol) {
      const sharePct = (microToUsd(r.micro) / totalUsd) * 100;
      hhiVolume += sharePct * sharePct;
    }
  }

  const deadCount = expiredCount + cancelledCount;
  const resolvedCount = completedCount + deadCount;

  return {
    ledger: {
      totalTasks: tasks.length,
      openTasks: openCount,
      claimedTasks: claimedCount,
      pendingTasks: pendingCount,
      completedTasks: completedCount,
      expiredTasks: expiredCount,
      cancelledTasks: cancelledCount,
      totalEscrowUsd: totalUsd,
      completedUsd: microToUsd(completedMicro),
      openAndClaimedUsd: microToUsd(openMicro),
      pendingUsd: microToUsd(pendingMicro),
      distinctRequesters: reqMap.size,
      distinctAwardedWorkers: awardedWorkers.size,
      totalSubmissions,
      avgSubmissionsPerTask: tasks.length ? totalSubmissions / tasks.length : 0,
      tasksWithSubmissions,
    },
    concentration: {
      distinctRequesters: reqMap.size,
      top1VolumeShare: totalUsd > 0 ? sumTopVol(1) / totalUsd : 0,
      top5VolumeShare: totalUsd > 0 ? sumTopVol(5) / totalUsd : 0,
      top10VolumeShare: totalUsd > 0 ? sumTopVol(10) / totalUsd : 0,
      top5TaskShare: tasks.length > 0 ? sumTopCnt(5) / tasks.length : 0,
      top10TaskShare: tasks.length > 0 ? sumTopCnt(10) / tasks.length : 0,
      hhiVolume: Math.round(hhiVolume),
      topRequestersByVolume: reqListByVol.slice(0, 5).map((r) => ({
        addressShort: truncateAddress(r.addr),
        tasks: r.tasks,
        completed: r.completed,
        completionRate: r.tasks ? r.completed / r.tasks : 0,
        escrowUsd: microToUsd(r.micro),
        volumeShare: totalUsd > 0 ? microToUsd(r.micro) / totalUsd : 0,
        chains: [...r.chains].sort(),
      })),
    },
    timing: {
      claimSampleCount: claimMins.length,
      medianClaimMinutes: quantile(claimMins, 0.5),
      p25ClaimMinutes: quantile(claimMins, 0.25),
      p75ClaimMinutes: quantile(claimMins, 0.75),
      submissionLatencySamples: subLatencyMins.length,
      medianSubmissionLatencyMinutes: quantile(subLatencyMins, 0.5),
      medianWindowHours: quantile(windowHrs, 0.5),
      earlySettledCount,
      ratedTasksCount: ratings.length,
      avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    },
    mortality: {
      expiredCount,
      cancelledCount,
      deadCount,
      deadRateOfAll: tasks.length ? deadCount / tasks.length : 0,
      deadRateOfResolved: resolvedCount ? deadCount / resolvedCount : 0,
      completionRateOfResolved: resolvedCount ? completedCount / resolvedCount : 0,
      expiredUsd: microToUsd(expiredMicro),
      cancelledUsd: microToUsd(cancelledMicro),
      strandedUsd: microToUsd(expiredMicro + cancelledMicro),
      deadZeroSubmissionShare: deadCount ? deadZeroSubs / deadCount : 0,
    },
  };
}

function buildChainMomentum(tempoTasks, baseTasks, nowMs) {
  const d7 = nowMs - 7 * 86_400_000;
  const d14 = nowMs - 14 * 86_400_000;

  const summarizeWindow = (list, startMs, endMs) => {
    let tasks = 0;
    let micro = 0n;
    const posters = new Set();
    for (const t of list) {
      const ts = Date.parse(t.createdAt);
      if (ts >= startMs && ts < endMs) {
        tasks += 1;
        micro += toBigIntSafe(t.reward);
        if (t.requester) posters.add(t.requester.toLowerCase());
      }
    }
    return { tasks, usd: microToUsd(micro), distinctPosters: posters.size };
  };

  const t7 = summarizeWindow(tempoTasks, d7, nowMs + 60_000);
  const tPrev7 = summarizeWindow(tempoTasks, d14, d7);
  const b7 = summarizeWindow(baseTasks, d7, nowMs + 60_000);
  const bPrev7 = summarizeWindow(baseTasks, d14, d7);

  const tasks7dTotal = t7.tasks + b7.tasks;
  const usd7dTotal = t7.usd + b7.usd;

  return {
    tempo: {
      chainId: 4217,
      currency: 'OUSD',
      last7d: t7,
      prev7d: tPrev7,
      earliestTaskAt: tempoTasks.length ? tempoTasks[tempoTasks.length - 1].createdAt : null,
    },
    base: {
      chainId: 8453,
      currency: 'USDC',
      last7d: b7,
      prev7d: bPrev7,
      earliestTaskAt: baseTasks.length ? baseTasks[baseTasks.length - 1].createdAt : null,
    },
    tempoShareTasks7d: tasks7dTotal ? t7.tasks / tasks7dTotal : 0,
    tempoShareUsd7d: usd7dTotal ? t7.usd / usd7dTotal : 0,
  };
}

function buildCompactTasks(tasks) {
  return tasks.map((t) => {
    const rewardUsd = microToUsd(t.reward);
    const subs = Number(t.submissionCount || 0);
    const windowHrs =
      t.createdAt && t.expiryTime
        ? Math.max(0, (Date.parse(t.expiryTime) - Date.parse(t.createdAt)) / 3_600_000)
        : null;
    return {
      id: t.id,
      ref: t.referenceCode || t.id.slice(0, 10),
      chainId: t.chainId,
      status: t.status,
      mode: t.mode,
      rewardUsd,
      subs,
      awards: Number(t.awardCount || 0),
      createdAt: t.createdAt,
      windowHrs: windowHrs !== null ? Math.round(windowHrs * 10) / 10 : null,
      reqShort: truncateAddress(t.requester),
      rating: typeof t.primaryAward?.rating === 'number' ? t.primaryAward.rating : null,
      title: firstLineTitle(t.description, t.referenceCode),
    };
  });
}

function buildCompactFeed(items) {
  return items.map((e) => ({
    type: e.type,
    timestamp: e.timestamp,
    taskId: e.taskId,
    taskTitle: e.taskTitle || 'Task activity',
    chainId: e.chainId,
    actorShort: truncateAddress(e.actor),
    actorType: e.actorType || 'unknown',
    amountUsd: e.amount ? microToUsd(e.amount) : null,
    rating: e.rating ?? null,
  }));
}

export async function fetchLiveMarketPayload() {
  const startedAt = Date.now();

  // Polite bounded-concurrency upstream fetches (max 3 concurrent to respect rate limits)
  const simpleJobs = [
    ['statsAll', '/api/market/stats'],
    ['statsTempo', '/api/market/stats?chainId=4217'],
    ['statsBase', '/api/market/stats?chainId=8453'],
    ['breakdownsTempo', '/api/stats/breakdowns?chainId=4217'],
    ['tsAllDay', '/api/stats/platform-time-series?chainId=4217&range=all&bucket=day'],
    ['tsAllWeek', '/api/stats/platform-time-series?chainId=4217&range=all&bucket=week'],
    ['hm7Mode', '/api/stats/activity-heatmap?chainId=4217&range=7d&dimension=mode'],
    ['hm30Mode', '/api/stats/activity-heatmap?chainId=4217&range=30d&dimension=mode'],
    ['hm90Mode', '/api/stats/activity-heatmap?chainId=4217&range=90d&dimension=mode'],
    ['hmAllMode', '/api/stats/activity-heatmap?chainId=4217&range=all&dimension=mode'],
    ['hm7Hour', '/api/stats/activity-heatmap?chainId=4217&range=7d&dimension=hourOfWeek'],
    ['hm30Hour', '/api/stats/activity-heatmap?chainId=4217&range=30d&dimension=hourOfWeek'],
    ['hm90Hour', '/api/stats/activity-heatmap?chainId=4217&range=90d&dimension=hourOfWeek'],
    ['hmAllHour', '/api/stats/activity-heatmap?chainId=4217&range=all&dimension=hourOfWeek'],
  ];

  const [simpleResults, tempoTaskPages, baseTaskPages, feedRaw] = await Promise.all([
    mapLimit(simpleJobs, 3, async ([key, ep]) => [key, await fetchJson(ep)]),
    fetchAllTasksForChain(4217),
    fetchAllTasksForChain(8453),
    fetchActivityFeedPages(2),
  ]);

  const fetched = Object.fromEntries(simpleResults);
  const {
    statsAll,
    statsTempo,
    statsBase,
    breakdownsTempo,
    tsAllDay,
    tsAllWeek,
    hm7Mode,
    hm30Mode,
    hm90Mode,
    hmAllMode,
    hm7Hour,
    hm30Hour,
    hm90Hour,
    hmAllHour,
  } = fetched;

  const dataAsOf = new Date().toISOString();
  const nowMs = Date.parse(dataAsOf);

  const normDayAll = normalizeTimeSeries(tsAllDay);
  const normWeekAll = normalizeTimeSeries(tsAllWeek);
  const platformTimeSeries = {
    '7d': { day: normDayAll.slice(-8), week: normWeekAll.slice(-2) },
    '30d': { day: normDayAll.slice(-31), week: normWeekAll.slice(-5) },
    '90d': { day: normDayAll.slice(-91), week: normWeekAll.slice(-14) },
    all: { day: normDayAll, week: normWeekAll },
  };

  const platformHeatmaps = {
    '7d': { mode: hm7Mode, hourOfWeek: hm7Hour },
    '30d': { mode: hm30Mode, hourOfWeek: hm30Hour },
    '90d': { mode: hm90Mode, hourOfWeek: hm90Hour },
    all: { mode: hmAllMode, hourOfWeek: hmAllHour },
  };

  const tempoTasks = tempoTaskPages.tasks;
  const baseTasks = baseTaskPages.tasks;
  const allTasks = [...tempoTasks, ...baseTasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const timeSeries = {
    all: platformTimeSeries,
    4217: buildChainTimeSeries(tempoTasks, platformTimeSeries),
    8453: buildChainTimeSeries(baseTasks, platformTimeSeries),
  };

  const breakdowns = {
    all: breakdownsTempo,
    4217: buildBreakdownsFromTasks(tempoTasks, breakdownsTempo.actorType || []),
    8453: buildBreakdownsFromTasks(baseTasks, breakdownsTempo.actorType || []),
  };

  const heatmaps = {
    all: platformHeatmaps,
    4217: buildHeatmapsFromTasks(tempoTasks, platformHeatmaps, nowMs),
    8453: buildHeatmapsFromTasks(baseTasks, platformHeatmaps, nowMs),
  };

  const weeklyPosters = buildWeeklyPosters(tempoTasks, baseTasks);

  const escrowFlow = {
    all: buildEscrowFlow(allTasks),
    4217: buildEscrowFlow(tempoTasks),
    8453: buildEscrowFlow(baseTasks),
  };

  const insights = {
    all: buildInsights(allTasks, feedRaw, nowMs),
    4217: buildInsights(tempoTasks, feedRaw, nowMs),
    8453: buildInsights(baseTasks, feedRaw, nowMs),
  };

  const chainMomentum = buildChainMomentum(tempoTasks, baseTasks, nowMs);
  const tasksCompact = buildCompactTasks(allTasks);
  const activityFeed = buildCompactFeed(feedRaw);

  return {
    meta: {
      dataAsOf,
      fetchDurationMs: Date.now() - startedAt,
      cacheTtlSeconds: Math.round(CACHE_TTL_MS / 1000),
      source: 'live-server',
      upstreamBase: UPSTREAM_BASE,
      chains: CHAINS,
      upstreamChainFiltered: {
        marketStatsPaidAndWallets: true,
        breakdowns: false,
        timeSeries: false,
        heatmap: false,
        tasks: true,
      },
      pagesFetched: {
        tempoTasks: tempoTaskPages.pages,
        baseTasks: baseTaskPages.pages,
        activityFeed: 2,
      },
      endpointsUsed: [
        '/api/market/stats?chainId=4217|8453',
        '/api/stats/breakdowns?chainId=4217|8453',
        '/api/stats/platform-time-series?chainId=4217|8453&range=7d|30d|90d|all&bucket=day|week',
        '/api/stats/activity-heatmap?chainId=4217|8453&range=7d|30d|90d|all&dimension=mode|hourOfWeek',
        '/api/stats/activity-feed?chainId=4217|8453&limit=50&cursor=...',
        '/api/tasks?chainId=4217|8453&sort=newest&limit=100&cursor=...',
      ],
    },
    marketStats: {
      all: statsAll,
      4217: statsTempo,
      8453: statsBase,
    },
    breakdowns,
    timeSeries,
    heatmaps,
    weeklyPosters,
    escrowFlow,
    insights,
    chainMomentum,
    tasks: tasksCompact,
    activityFeed,
  };
}

export async function getMarketData({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && memoryCache && now - memoryCache.cachedAt < CACHE_TTL_MS) {
    return { payload: memoryCache.payload, cacheStatus: 'HIT' };
  }

  if (!inFlight) {
    inFlight = fetchLiveMarketPayload()
      .then((payload) => {
        memoryCache = { payload, cachedAt: Date.now() };
        return payload;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  try {
    const payload = await inFlight;
    return { payload, cacheStatus: 'MISS' };
  } catch (err) {
    if (memoryCache) {
      return {
        payload: { ...memoryCache.payload, meta: { ...memoryCache.payload.meta, staleFallback: true } },
        cacheStatus: 'STALE',
      };
    }
    try {
      const raw = await readFile(SNAPSHOT_PATH, 'utf8');
      const snap = JSON.parse(raw);
      return {
        payload: { ...snap, meta: { ...snap.meta, staleFallback: true, source: 'snapshot-fallback' } },
        cacheStatus: 'SNAPSHOT',
      };
    } catch {
      throw err;
    }
  }
}
