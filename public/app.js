/* ============================================================================
   Taskmarket Live Market Visualizer — Client Renderer (Zero External Deps)
   Reads exclusively from server-cached /api/market (or static snapshot fallback)
   ============================================================================ */

const BRAND = {
  ground: '#12100E',
  maroon: '#3A1420',
  panel: '#221E1A',
  line: '#453E37',
  cream: '#EFE9E2',
  paper: '#FFF6E8',
  muted: '#B0A79D',
  magenta: '#E74079',
  salmon: '#D9A097',
};

const VALID_CHAINS = new Set(['all', '4217', '8453']);
const VALID_RANGES = new Set(['7d', '30d', '90d', 'all']);
const VALID_BUCKETS = new Set(['day', 'week']);
const VALID_DIMS = new Set(['hourOfWeek', 'mode']);
const VALID_VIEWS = new Set(['overview', 'flow', 'swarm', 'series', 'insights', 'activity']);

const state = {
  data: null,
  chain: 'all',
  range: '30d',
  bucket: 'day',
  dim: 'hourOfWeek',
  view: 'overview',
  swarmStatus: 'all',
  feedType: 'all',
  selectedTask: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---------- Formatters ---------- */
function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Math.round(Number(n)).toLocaleString('en-US');
}

function fmtUsd(n, compact = false) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (compact && v >= 1000) return `$${(v / 1000).toFixed(2)}k`;
  if (v === 0) return '$0.00';
  if (v < 0.1) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(ratio) {
  if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) return '—';
  return `${(Number(ratio) * 100).toFixed(1)}%`;
}

function fmtMinutes(mins) {
  if (mins === null || mins === undefined || Number.isNaN(Number(mins))) return '—';
  if (mins < 1) return `${Math.round(mins * 60)}s`;
  if (mins < 90) return `${mins.toFixed(1)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}

function fmtUtcShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function fmtRelTime(iso, refIso) {
  const t = Date.parse(iso);
  const now = refIso ? Date.parse(refIso) : Date.now();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function chainLabel(chainKey) {
  if (chainKey === '4217' || chainKey === 4217) return 'Tempo (4217)';
  if (chainKey === '8453' || chainKey === 8453) return 'Base (8453)';
  return 'All Chains';
}

function chainCurrency(chainKey) {
  if (chainKey === '4217' || chainKey === 4217) return 'OUSD';
  if (chainKey === '8453' || chainKey === 8453) return 'USDC';
  return 'USD';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function titleCaseStatus(s) {
  return String(s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/* ---------- URL State & Deep Linking ---------- */
function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const chain = params.get('chain');
  const range = params.get('range');
  const bucket = params.get('bucket');
  const dim = params.get('dim');
  const view = params.get('view');

  if (chain && VALID_CHAINS.has(chain)) state.chain = chain;
  else if (chain === 'tempo') state.chain = '4217';
  else if (chain === 'base') state.chain = '8453';

  if (range && VALID_RANGES.has(range)) state.range = range;
  if (bucket && VALID_BUCKETS.has(bucket)) state.bucket = bucket;
  if (dim && VALID_DIMS.has(dim)) state.dim = dim;
  if (view && VALID_VIEWS.has(view)) state.view = view;
}

function buildViewUrl(viewOverride = null) {
  const url = new URL(window.location.href);
  url.searchParams.set('chain', state.chain);
  url.searchParams.set('range', state.range);
  url.searchParams.set('bucket', state.bucket);
  url.searchParams.set('dim', state.dim);
  url.searchParams.set('view', viewOverride || state.view);
  return url.toString();
}

function syncUrl() {
  try {
    window.history.replaceState(null, '', buildViewUrl());
  } catch {
    // Ignore history restrictions in sandboxed environments
  }
}

/* ---------- Tooltip & Toast ---------- */
const tooltipEl = $('#chart-tooltip');
let toastTimer = null;

function showTooltip(event, html) {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = html;
  tooltipEl.hidden = false;
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 10) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 10) y = event.clientY - rect.height - pad;
  tooltipEl.style.left = `${Math.max(8, x)}px`;
  tooltipEl.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

/* ---------- Data Loading (Server-side endpoint + scheduled snapshot) ---------- */
async function loadMarketData() {
  const isStaticPages = window.location.hostname.endsWith('.github.io');
  const endpoints = isStaticPages
    ? ['./data/market-snapshot.json']
    : ['./api/market', './data/market-snapshot.json'];
  let lastErr = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const json = await res.json();
      if (json && json.meta && json.marketStats) {
        return json;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to load market data');
}

/* ---------- Render: Header & KPIs ---------- */
function renderHeaderAndKpis() {
  const d = state.data;
  const c = state.chain;
  const m = d.marketStats[c] || d.marketStats.all;
  const ins = d.insights[c] || d.insights.all;
  const ledger = ins.ledger;
  const cur = chainCurrency(c);

  const asOfText = `Data as of ${fmtUtcShort(d.meta.dataAsOf)}`;
  $('#data-as-of-text').textContent = asOfText;
  $('#footer-data-time').textContent = asOfText;

  const isChainFiltered = c !== 'all';
  const cards = [
    {
      label: 'Registered Workers',
      badge: 'Platform',
      value: fmtInt(m.registeredWorkers),
      sub: `${fmtInt(d.breakdowns.all.actorType?.find((x) => x.actorType === 'agent')?.count || 0)} agents · ${fmtInt(d.breakdowns.all.actorType?.find((x) => x.actorType === 'human')?.count || 0)} humans`,
    },
    {
      label: 'Active Workers (7d)',
      badge: 'Platform',
      value: fmtInt(m.activeWorkers7d),
      sub: `${fmtInt(m.activeAgents7d)} active AI agents in last 7 days`,
    },
    {
      label: isChainFiltered ? 'Public Tasks (status=open)' : 'Open Tasks',
      badge: isChainFiltered ? chainLabel(c) : 'Platform',
      value: isChainFiltered ? fmtInt(ledger.openTasks) : fmtInt(m.openTasks),
      sub: isChainFiltered
        ? `${fmtUsd(ledger.openAndClaimedUsd)} open/claimed escrow · ${fmtInt(m.openTasks)} live unexpired platform-wide`
        : `Live unexpired (/api/market/stats) · ${fmtInt(d.insights['4217'].ledger.openTasks)} Tempo / ${fmtInt(d.insights['8453'].ledger.openTasks)} Base status=open rows`,
    },
    {
      label: 'Paid Workers',
      badge: chainLabel(c),
      value: fmtInt(m.paidWorkers),
      sub: `${fmtInt(ledger.distinctAwardedWorkers)} unique primary winners in public tasks`,
      highlight: true,
    },
    {
      label: 'Active Wallets',
      badge: chainLabel(c),
      value: fmtInt(m.activeWallets),
      sub: isChainFiltered
        ? `On-chain wallets active on ${chainLabel(c)}`
        : `${fmtInt(d.marketStats['4217'].activeWallets)} Tempo + ${fmtInt(d.marketStats['8453'].activeWallets)} Base`,
    },
    {
      label: `Escrow Ledger (${cur})`,
      badge: chainLabel(c),
      value: fmtUsd(ledger.totalEscrowUsd),
      sub: `${fmtInt(ledger.totalTasks)} public tasks · ${fmtUsd(ledger.completedUsd)} settled`,
    },
  ];

  $('#headline-kpis').innerHTML = cards
    .map(
      (card) => `
      <article class="kpi-card ${card.highlight ? 'kpi-highlight' : ''}">
        <div class="kpi-label">
          <span>${escHtml(card.label)}</span>
          <span class="kpi-badge">${escHtml(card.badge)}</span>
        </div>
        <div class="kpi-value">${escHtml(card.value)}</div>
        <div class="kpi-sub">${escHtml(card.sub)}</div>
      </article>`
    )
    .join('');

  // Dual chain comparison strip (always shows both chains clearly)
  const tempo = d.insights['4217'].ledger;
  const base = d.insights['8453'].ledger;
  const tempoStats = d.marketStats['4217'];
  const baseStats = d.marketStats['8453'];
  const tempoMort = d.insights['4217'].mortality;
  const baseMort = d.insights['8453'].mortality;

  $('#chain-comparison-strip').innerHTML = `
    <div class="chain-card ${c === '4217' ? 'active' : ''}" data-select-chain="4217" role="button" tabindex="0">
      <div class="chain-card-left">
        <div class="chain-name">Tempo <span class="chain-tag">chainId 4217 · OUSD</span></div>
        <div class="mono-muted">First task ${escHtml((d.chainMomentum.tempo.earliestTaskAt || '').slice(0, 10))} · ${fmtPct(tempoMort.completionRateOfResolved)} resolved completion</div>
      </div>
      <div class="chain-metrics">
        <div class="chain-stat"><span class="chain-stat-k">TASKS</span><span class="chain-stat-v">${fmtInt(tempo.totalTasks)}</span></div>
        <div class="chain-stat"><span class="chain-stat-k">ESCROW</span><span class="chain-stat-v">${fmtUsd(tempo.totalEscrowUsd)}</span></div>
        <div class="chain-stat"><span class="chain-stat-k">POSTERS</span><span class="chain-stat-v">${fmtInt(tempo.distinctRequesters)}</span></div>
        <div class="chain-stat"><span class="chain-stat-k">PAID WORKERS</span><span class="chain-stat-v">${fmtInt(tempoStats.paidWorkers)}</span></div>
      </div>
    </div>
    <div class="chain-card ${c === '8453' ? 'active' : ''}" data-select-chain="8453" role="button" tabindex="0">
      <div class="chain-card-left">
        <div class="chain-name">Base <span class="chain-tag chain-tag-base">chainId 8453 · USDC</span></div>
        <div class="mono-muted">First task ${escHtml((d.chainMomentum.base.earliestTaskAt || '').slice(0, 10))} · ${fmtPct(baseMort.completionRateOfResolved)} resolved completion</div>
      </div>
      <div class="chain-metrics">
        <div class="chain-stat"><span class="chain-stat-k">TASKS</span><span class="chain-stat-v">${fmtInt(base.totalTasks)}</span></div>
        <div class="chain-stat"><span class="chain-stat-k">ESCROW</span><span class="chain-stat-v">${fmtUsd(base.totalEscrowUsd)}</span></div>
        <div class="chain-stat"><span class="chain-stat-k">POSTERS</span><span class="chain-stat-v">${fmtInt(base.distinctRequesters)}</span></div>
        <div class="chain-stat"><span class="chain-stat-k">PAID WORKERS</span><span class="chain-stat-v">${fmtInt(baseStats.paidWorkers)}</span></div>
      </div>
    </div>
  `;

  $$('[data-select-chain]').forEach((el) => {
    const activate = () => {
      const target = el.getAttribute('data-select-chain');
      state.chain = state.chain === target ? 'all' : target;
      syncControlsAndRender();
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
}

/* ---------- Original View 01: Escrow Flow River (SVG Sankey) ---------- */
function renderEscrowFlow() {
  const flow = state.data.escrowFlow[state.chain] || state.data.escrowFlow.all;
  $('#flow-scope-tag').textContent = `${chainLabel(state.chain)} · ${fmtInt(flow.totalTasks)} tasks · ${fmtUsd(flow.totalUsd)}`;

  const W = 1040;
  const H = 370;
  const padTop = 40;
  const padBottom = 26;
  const usableH = H - padTop - padBottom;
  const colW = 14;
  const x0 = 200;
  const x1 = 515;
  const x2 = 826;
  const gap = 14;

  const tiers = flow.tiers.filter((n) => n.usd > 0 || n.tasks > 0);
  const chains = flow.chains.filter((n) => n.usd > 0 || n.tasks > 0);
  const outcomes = flow.outcomes.filter((n) => n.usd > 0 || n.tasks > 0);

  function layoutColumn(nodes) {
    const sum = nodes.reduce((a, b) => a + Math.max(b.usd, 0.01), 0) || 1;
    const avail = usableH - gap * Math.max(0, nodes.length - 1);
    let y = padTop;
    const placed = new Map();
    for (const n of nodes) {
      const h = Math.max(18, (Math.max(n.usd, 0.01) / sum) * avail);
      placed.set(n.id, { ...n, y, h, outOffset: 0, inOffset: 0 });
      y += h + gap;
    }
    // Rescale softly if minimum heights pushed past bottom
    const overflow = y - gap - (padTop + usableH);
    if (overflow > 0 && nodes.length > 0) {
      const scale = usableH / (y - gap - padTop);
      let cy = padTop;
      for (const n of nodes) {
        const p = placed.get(n.id);
        p.y = cy;
        p.h = Math.max(10, p.h * scale);
        cy += p.h + gap * scale;
      }
    }
    return placed;
  }

  const leftMap = layoutColumn(tiers);
  const midMap = layoutColumn(chains);
  const rightMap = layoutColumn(outcomes);

  const outcomeColors = {
    settled: BRAND.salmon,
    active: BRAND.magenta,
    pending: BRAND.paper,
    dead: BRAND.line,
  };
  const tierColors = {
    top5: BRAND.paper,
    next15: BRAND.salmon,
    tail: BRAND.muted,
  };
  const chainColors = {
    tempo: BRAND.salmon,
    base: BRAND.cream,
  };

  function ribbonPath(sx, sy, sh, tx, ty, th) {
    const cx = (sx + tx) / 2;
    return [
      `M ${sx} ${sy}`,
      `C ${cx} ${sy}, ${cx} ${ty}, ${tx} ${ty}`,
      `L ${tx} ${ty + th}`,
      `C ${cx} ${ty + th}, ${cx} ${sy + sh}, ${sx} ${sy + sh}`,
      'Z',
    ].join(' ');
  }

  const ribbons = [];

  // Tier -> Chain ribbons
  for (const l of flow.linksTierToChain) {
    if (l.usd <= 0) continue;
    const src = leftMap.get(l.from);
    const dst = midMap.get(l.to);
    if (!src || !dst) continue;
    const sh = Math.max(2, (l.usd / (src.usd || 1)) * src.h);
    const th = Math.max(2, (l.usd / (dst.usd || 1)) * dst.h);
    const sy = src.y + src.outOffset;
    const ty = dst.y + dst.inOffset;
    src.outOffset += sh;
    dst.inOffset += th;
    const color = chainColors[l.to] || BRAND.salmon;
    ribbons.push(
      `<path class="flow-ribbon" d="${ribbonPath(x0 + colW, sy, sh, x1, ty, th)}" fill="${color}" fill-opacity="0.26" stroke="${color}" stroke-opacity="0.45" stroke-width="0.7" data-tip-title="${escHtml(src.label)} → ${escHtml(dst.label)}" data-tip-body="${escHtml(fmtUsd(l.usd))} (${fmtPct(l.usd / (flow.totalUsd || 1))}) across ${fmtInt(l.tasks)} tasks" />`
    );
  }

  // Chain -> Outcome ribbons
  for (const l of flow.linksChainToOutcome) {
    if (l.usd <= 0) continue;
    const src = midMap.get(l.from);
    const dst = rightMap.get(l.to);
    if (!src || !dst) continue;
    const sh = Math.max(2, (l.usd / (src.usd || 1)) * src.h);
    const th = Math.max(2, (l.usd / (dst.usd || 1)) * dst.h);
    const sy = src.y + src.outOffset;
    const ty = dst.y + dst.inOffset;
    src.outOffset += sh;
    dst.inOffset += th;
    const color = outcomeColors[l.to] || BRAND.salmon;
    const opacity = l.to === 'active' ? '0.28' : l.to === 'dead' ? '0.45' : '0.32';
    ribbons.push(
      `<path class="flow-ribbon" d="${ribbonPath(x1 + colW, sy, sh, x2, ty, th)}" fill="${color}" fill-opacity="${opacity}" stroke="${color}" stroke-opacity="0.6" stroke-width="0.7" data-tip-title="${escHtml(src.label)} → ${escHtml(dst.label)}" data-tip-body="${escHtml(fmtUsd(l.usd))} (${fmtPct(l.usd / (flow.totalUsd || 1))}) across ${fmtInt(l.tasks)} tasks" />`
    );
  }

  const nodeEls = [];
  // Column headers
  nodeEls.push(`<text x="${x0}" y="20" text-anchor="end" class="svg-label">REQUESTER TIERS</text>`);
  nodeEls.push(`<text x="${x1 + colW / 2}" y="20" text-anchor="middle" class="svg-label">ON-CHAIN ESCROW</text>`);
  nodeEls.push(`<text x="${x2 + colW}" y="20" text-anchor="start" class="svg-label">ESCROW OUTCOMES</text>`);

  for (const n of leftMap.values()) {
    const midY = n.y + n.h / 2;
    nodeEls.push(`
      <g class="flow-node" data-tip-title="${escHtml(n.label)}" data-tip-body="${fmtInt(n.wallets)} wallets · ${fmtUsd(n.usd)} (${fmtPct(n.share)}) · ${fmtInt(n.tasks)} tasks">
        <rect x="${x0}" y="${n.y}" width="${colW}" height="${n.h}" rx="3" fill="${tierColors[n.id] || BRAND.salmon}" />
        <text x="${x0 - 12}" y="${midY - 3}" text-anchor="end" class="svg-label-strong">${escHtml(n.label)}</text>
        <text x="${x0 - 12}" y="${midY + 13}" text-anchor="end" class="svg-mono-val">${fmtUsd(n.usd)} · ${fmtPct(n.share)}</text>
      </g>
    `);
  }

  for (const n of midMap.values()) {
    const midY = n.y + n.h / 2;
    const isTempo = n.id === 'tempo';
    nodeEls.push(`
      <g class="flow-node flow-chain-click" style="cursor:pointer" data-chain-click="${n.chainId}" data-tip-title="${escHtml(n.label)}" data-tip-body="${fmtUsd(n.usd)} (${fmtPct(n.share)}) across ${fmtInt(n.tasks)} tasks. Click to filter.">
        <rect x="${x1}" y="${n.y}" width="${colW}" height="${n.h}" rx="3" fill="${chainColors[n.id]}" />
        <rect x="${x1 - 74}" y="${midY - 19}" width="162" height="38" rx="6" fill="${BRAND.ground}" fill-opacity="0.88" stroke="${isTempo ? BRAND.salmon : BRAND.line}" stroke-width="1" />
        <text x="${x1 + colW / 2}" y="${midY - 3}" text-anchor="middle" class="svg-label-strong">${isTempo ? 'Tempo (OUSD)' : 'Base (USDC)'}</text>
        <text x="${x1 + colW / 2}" y="${midY + 12}" text-anchor="middle" class="svg-mono-val">${fmtUsd(n.usd)} · ${fmtInt(n.tasks)}</text>
      </g>
    `);
  }

  const rightNodes = [...rightMap.values()];
  const rightLabelY = [];
  for (const n of rightNodes) {
    let ly = n.y + n.h / 2;
    if (rightLabelY.length > 0 && ly - rightLabelY[rightLabelY.length - 1] < 34) {
      ly = rightLabelY[rightLabelY.length - 1] + 34;
    }
    rightLabelY.push(Math.min(H - 18, ly));
  }
  rightNodes.forEach((n, i) => {
    const ly = rightLabelY[i];
    const extra = n.distinctWinners ? ` · ${fmtInt(n.distinctWinners)} winners` : '';
    nodeEls.push(`
      <g class="flow-node" data-tip-title="${escHtml(n.label)}" data-tip-body="${fmtUsd(n.usd)} (${fmtPct(n.share)}) · ${fmtInt(n.tasks)} tasks${extra}">
        <rect x="${x2}" y="${n.y}" width="${colW}" height="${n.h}" rx="3" fill="${outcomeColors[n.id] || BRAND.salmon}" />
        <text x="${x2 + colW + 12}" y="${ly - 3}" text-anchor="start" class="svg-label-strong">${escHtml(n.label)}</text>
        <text x="${x2 + colW + 12}" y="${ly + 13}" text-anchor="start" class="svg-mono-val">${fmtUsd(n.usd)} · ${fmtInt(n.tasks)} tasks</text>
      </g>
    `);
  });

  const container = $('#escrow-flow-viz');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Escrow Flow River">${ribbons.join('')}${nodeEls.join('')}</svg>`;

  container.querySelectorAll('.flow-ribbon, .flow-node').forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      const title = el.getAttribute('data-tip-title');
      const body = el.getAttribute('data-tip-body');
      if (el.classList.contains('flow-ribbon')) el.setAttribute('fill-opacity', '0.62');
      showTooltip(e, `<div class="tooltip-title">${title}</div><div class="tooltip-mono">${body}</div>`);
    });
    el.addEventListener('mouseleave', () => {
      if (el.classList.contains('flow-ribbon')) el.setAttribute('fill-opacity', '0.32');
      hideTooltip();
    });
  });

  container.querySelectorAll('[data-chain-click]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-chain-click');
      state.chain = state.chain === target ? 'all' : target;
      syncControlsAndRender();
    });
  });
}

/* ---------- Original View 02: Swarm Convergence Map ---------- */
function renderSwarmMap() {
  const allTasks = state.data.tasks || [];
  let filtered = allTasks.filter((t) => (state.chain === 'all' ? true : String(t.chainId) === state.chain));
  const openTasksInChain = filtered.filter((t) => t.status === 'open');

  if (state.swarmStatus === 'open') filtered = filtered.filter((t) => t.status === 'open' || t.status === 'claimed');
  else if (state.swarmStatus === 'completed') filtered = filtered.filter((t) => t.status === 'completed');
  else if (state.swarmStatus === 'dead') filtered = filtered.filter((t) => t.status === 'expired' || t.status === 'cancelled');

  const W = 1040;
  const H = 370;
  const m = { top: 28, right: 26, bottom: 48, left: 62 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const minReward = 0.008;
  const maxReward = Math.max(120, ...filtered.map((t) => t.rewardUsd || 0.01));
  const maxSubs = Math.max(100, ...filtered.map((t) => t.subs || 0));

  const logMin = Math.log10(minReward);
  const logMax = Math.log10(maxReward * 1.15);
  const xScale = (usd) => {
    const v = Math.max(minReward, usd || minReward);
    return m.left + ((Math.log10(v) - logMin) / (logMax - logMin)) * plotW;
  };
  // Symlog on Y so 0, 1, 5, 25, 100, 600 all separate cleanly
  const yMaxLog = Math.log10(maxSubs + 1);
  const yScale = (subs) => m.top + plotH - (Math.log10((subs || 0) + 1) / (yMaxLog || 1)) * plotH;

  const xTicks = [0.01, 0.1, 1, 5, 10, 25, 50, 100].filter((v) => v <= maxReward * 1.1);
  const yTicks = [0, 1, 5, 20, 50, 150, 500].filter((v) => v <= maxSubs * 1.05);

  const gridLines = [];
  for (const xt of xTicks) {
    const x = xScale(xt);
    gridLines.push(`<line x1="${x}" y1="${m.top}" x2="${x}" y2="${m.top + plotH}" stroke="${BRAND.line}" stroke-opacity="0.35" stroke-dasharray="2 4" />`);
    gridLines.push(`<text x="${x}" y="${m.top + plotH + 18}" text-anchor="middle" class="svg-label">${xt < 1 ? `$${xt}` : `$${xt}`}</text>`);
  }
  for (const yt of yTicks) {
    const y = yScale(yt);
    gridLines.push(`<line x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke="${BRAND.line}" stroke-opacity="0.35" stroke-dasharray="2 4" />`);
    gridLines.push(`<text x="${m.left - 10}" y="${y + 4}" text-anchor="end" class="svg-label">${yt}</text>`);
  }

  // Quadrant highlight box: High reward (>= $5), Low crowd (<= 10 submissions)
  const qx = xScale(5);
  const qy = yScale(10);
  const sweetBox = `
    <rect x="${qx}" y="${qy}" width="${Math.max(0, m.left + plotW - qx)}" height="${Math.max(0, m.top + plotH - qy)}" fill="${BRAND.maroon}" fill-opacity="0.34" stroke="${BRAND.salmon}" stroke-opacity="0.45" stroke-dasharray="4 4" rx="6" />
    <text x="${m.left + plotW - 10}" y="${qy + 16}" text-anchor="end" class="svg-label" fill="${BRAND.salmon}">HIGH REWARD · LOW CROWD (&gt;=$5, &lt;=10 SUBS)</text>
    <text x="${m.left + 10}" y="${m.top + 16}" text-anchor="start" class="svg-label">DENSE SWARM ZONE (HIGH SUBMISSIONS)</text>
  `;

  // Deterministic jitter so exact-overlap micro-tasks are visibly distinguishable
  function hashJitter(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return ((h % 1000) / 1000) * 6 - 3;
  }

  // Draw dead -> settled -> pending -> open so active open tasks sit crisp on top
  const zOrder = { expired: 0, cancelled: 0, completed: 1, pending_approval: 2, claimed: 3, worker_selected: 3, open: 4 };
  const sorted = [...filtered].sort((a, b) => (zOrder[a.status] ?? 1) - (zOrder[b.status] ?? 1));

  const dots = sorted.map((t, idx) => {
    const cx = Math.min(m.left + plotW - 4, Math.max(m.left + 4, xScale(t.rewardUsd) + hashJitter(t.id)));
    const cy = Math.min(m.top + plotH - 3, Math.max(m.top + 4, yScale(t.subs) + hashJitter(t.ref)));
    const isOpen = t.status === 'open';
    const isSettled = t.status === 'completed';
    const isDead = t.status === 'expired' || t.status === 'cancelled';
    const fill = isOpen ? BRAND.magenta : isSettled ? BRAND.salmon : isDead ? BRAND.line : BRAND.paper;
    const r = isOpen ? 5.2 : t.rewardUsd >= 10 ? 4.8 : 3.3;
    const opacity = isOpen ? 0.92 : isSettled ? 0.56 : isDead ? 0.42 : 0.8;
    return `<circle class="swarm-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${fill}" fill-opacity="${opacity}" stroke="${isOpen ? BRAND.paper : BRAND.ground}" stroke-width="${isOpen ? 1 : 0.6}" data-idx="${idx}" style="cursor:pointer" />`;
  });

  const axes = `
    <line x1="${m.left}" y1="${m.top + plotH}" x2="${m.left + plotW}" y2="${m.top + plotH}" stroke="${BRAND.line}" />
    <line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + plotH}" stroke="${BRAND.line}" />
    <text x="${m.left + plotW / 2}" y="${H - 8}" text-anchor="middle" class="svg-label">TASK REWARD (USD · LOG SCALE)</text>
    <text x="16" y="${m.top + plotH / 2}" text-anchor="middle" transform="rotate(-90 16 ${m.top + plotH / 2})" class="svg-label">SUBMISSIONS (SYMLOG)</text>
  `;

  const container = $('#swarm-map-viz');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Swarm Convergence Map">${gridLines.join('')}${sweetBox}${axes}${dots.join('')}</svg>`;

  container.querySelectorAll('.swarm-dot').forEach((el) => {
    const t = sorted[Number(el.getAttribute('data-idx'))];
    if (!t) return;
    el.addEventListener('mousemove', (e) => {
      const perSub = t.subs > 0 ? fmtUsd(t.rewardUsd / t.subs) : fmtUsd(t.rewardUsd);
      showTooltip(
        e,
        `<div class="tooltip-title">${escHtml(t.ref)} · ${escHtml(t.title)}</div>
         <div class="tooltip-mono">
           ${chainLabel(t.chainId)} · ${escHtml(t.mode)} · ${escHtml(titleCaseStatus(t.status))}<br/>
           Reward: ${fmtUsd(t.rewardUsd)} ${chainCurrency(t.chainId)} · Subs: ${fmtInt(t.subs)}<br/>
           Reward/entry: ${perSub} · Window: ${t.windowHrs ? `${t.windowHrs}h` : '—'}<br/>
           Poster: ${escHtml(t.reqShort)}
         </div>`
      );
    });
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('click', () => {
      state.selectedTask = t;
      renderSwarmInspector();
    });
  });

  renderSwarmInspector();

  // Spotlight: Active low-crowd open tasks
  const spotlight = [...openTasksInChain]
    .filter((t) => t.rewardUsd >= 0.5)
    .sort((a, b) => b.rewardUsd / Math.max(1, b.subs) - a.rewardUsd / Math.max(1, a.subs))
    .slice(0, 4);

  $('#spotlight-count').textContent = `${fmtInt(openTasksInChain.length)} open public tasks in ${chainLabel(state.chain)}`;
  const spotGrid = $('#spotlight-grid');
  if (!spotlight.length) {
    spotGrid.innerHTML = `<div class="mono-muted">No open tasks above $0.50 in this chain view right now.</div>`;
  } else {
    spotGrid.innerHTML = spotlight
      .map((t) => {
        const ratio = t.subs > 0 ? `${fmtUsd(t.rewardUsd / t.subs)}/sub` : '0 subs yet';
        return `
        <a class="spot-card" href="https://taskmarket.dev/tasks/${encodeURIComponent(t.id)}" target="_blank" rel="noopener noreferrer">
          <div class="spot-top">
            <span class="mono-muted">${escHtml(t.ref)} · ${t.chainId === 4217 ? 'Tempo' : 'Base'}</span>
            <span class="spot-reward">${fmtUsd(t.rewardUsd)} ${chainCurrency(t.chainId)}</span>
          </div>
          <div class="spot-title">${escHtml(t.title)}</div>
          <div class="spot-meta">
            <span>${fmtInt(t.subs)} submissions</span>
            <span>${ratio}</span>
          </div>
        </a>`;
      })
      .join('');
  }
}

function renderSwarmInspector() {
  const el = $('#swarm-inspector');
  const t = state.selectedTask;
  if (!t) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <div>
      <div class="mono-muted">${escHtml(t.ref)} · ${chainLabel(t.chainId)} · ${escHtml(t.mode)} · ${escHtml(titleCaseStatus(t.status))} · Poster ${escHtml(t.reqShort)}</div>
      <div style="font-weight:600;color:var(--paper);margin-top:3px">${escHtml(t.title)}</div>
      <div class="mono-muted" style="margin-top:3px">Reward ${fmtUsd(t.rewardUsd)} ${chainCurrency(t.chainId)} · ${fmtInt(t.subs)} submissions · Window ${t.windowHrs ?? '—'}h · Created ${fmtUtcShort(t.createdAt)}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <a class="btn-mini" href="https://taskmarket.dev/tasks/${encodeURIComponent(t.id)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Open on taskmarket.dev</a>
      <button type="button" class="btn-mini" id="close-inspector">Clear</button>
    </div>
  `;
  $('#close-inspector')?.addEventListener('click', () => {
    state.selectedTask = null;
    renderSwarmInspector();
  });
}

/* ---------- Time Series & Weekly Distinct Posters ---------- */
function renderTimeSeries() {
  const d = state.data;
  const rows = d.timeSeries[state.chain]?.[state.range]?.[state.bucket] || [];
  const isPlatform = state.chain === 'all';
  $('#series-scope-tag').textContent = isPlatform
    ? `/api/stats/platform-time-series (${state.range} · ${state.bucket})`
    : `Chain tasks (${chainLabel(state.chain)}) · Platform active agents`;

  const totalTasks = rows.reduce((a, r) => a + r.tasksCreated, 0);
  const peakAgents = rows.reduce((a, r) => Math.max(a, r.activeAgents), 0);
  const totalEscrow = rows.reduce((a, r) => a + r.rewardVolumeUsd, 0);
  const totalPaid = rows.reduce((a, r) => a + r.paidVolumeUsd, 0);

  $('#series-agents-summary').textContent = `Peak active agents: ${fmtInt(peakAgents)} · Tasks posted: ${fmtInt(totalTasks)}`;
  $('#series-volume-summary').textContent = `Put up: ${fmtUsd(totalEscrow)} · Paid: ${fmtUsd(totalPaid)}`;

  // Chart A1: Active Agents (line) + Tasks Posted (bars)
  renderDualSeriesSvg('#series-agents-viz', rows, {
    barKey: 'tasksCreated',
    lineKey: 'activeAgents',
    barLabel: 'Tasks posted',
    lineLabel: isPlatform ? 'Active agents' : 'Platform active agents',
    barColor: BRAND.salmon,
    lineColor: BRAND.paper,
    fmtBar: fmtInt,
    fmtLine: fmtInt,
  });

  // Chart A2: Rewards Put Up (bars) vs Rewards Paid (line/bars)
  renderGroupedMoneySvg('#series-volume-viz', rows);
}

function renderDualSeriesSvg(selector, rows, cfg) {
  const container = $(selector);
  if (!rows.length) {
    container.innerHTML = `<div class="mono-muted">No time-series data for this selection.</div>`;
    return;
  }
  const W = 680;
  const H = 195;
  const m = { top: 18, right: 44, bottom: 28, left: 46 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const maxBar = Math.max(1, ...rows.map((r) => r[cfg.barKey] || 0));
  const maxLine = Math.max(1, ...rows.map((r) => r[cfg.lineKey] || 0));
  const step = plotW / rows.length;
  const barW = Math.max(2, Math.min(18, step * 0.62));

  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = m.top + plotH * (1 - f);
      return `
        <line x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke="${BRAND.line}" stroke-opacity="0.38" stroke-dasharray="2 4" />
        <text x="${m.left - 8}" y="${y + 4}" text-anchor="end" class="svg-label">${fmtInt(maxBar * f)}</text>
        <text x="${m.left + plotW + 8}" y="${y + 4}" text-anchor="start" class="svg-label">${fmtInt(maxLine * f)}</text>
      `;
    })
    .join('');

  const bars = rows
    .map((r, i) => {
      const x = m.left + i * step + (step - barW) / 2;
      const h = ((r[cfg.barKey] || 0) / maxBar) * plotH;
      const y = m.top + plotH - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${cfg.barColor}" fill-opacity="0.58" />`;
    })
    .join('');

  const pts = rows.map((r, i) => {
    const x = m.left + i * step + step / 2;
    const y = m.top + plotH - ((r[cfg.lineKey] || 0) / maxLine) * plotH;
    return [x, y];
  });
  const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L ${pts[pts.length - 1][0].toFixed(1)} ${m.top + plotH} L ${pts[0][0].toFixed(1)} ${m.top + plotH} Z`;

  const xLabelStep = Math.max(1, Math.ceil(rows.length / 6));
  const xLabels = rows
    .map((r, i) => {
      if (i % xLabelStep !== 0 && i !== rows.length - 1) return '';
      const x = m.left + i * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" class="svg-label">${r.bucket.slice(5)}</text>`;
    })
    .join('');

  const hoverRects = rows
    .map((r, i) => {
      const x = m.left + i * step;
      return `<rect class="ts-hit" x="${x.toFixed(1)}" y="${m.top}" width="${step.toFixed(1)}" height="${plotH}" fill="transparent" data-i="${i}" />`;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Active agents and tasks posted over time">
      ${grid}
      <path d="${areaD}" fill="${cfg.lineColor}" fill-opacity="0.06" />
      ${bars}
      <path d="${lineD}" fill="none" stroke="${cfg.lineColor}" stroke-width="2" stroke-linejoin="round" />
      ${xLabels}
      ${hoverRects}
    </svg>
  `;

  container.querySelectorAll('.ts-hit').forEach((el) => {
    const r = rows[Number(el.getAttribute('data-i'))];
    el.addEventListener('mousemove', (e) => {
      showTooltip(
        e,
        `<div class="tooltip-title">${escHtml(r.bucket)} (${state.bucket})</div>
         <div class="tooltip-mono">
           ${cfg.barLabel}: ${cfg.fmtBar(r[cfg.barKey])}<br/>
           ${cfg.lineLabel}: ${cfg.fmtLine(r[cfg.lineKey])}<br/>
           New agents: ${fmtInt(r.newAgents)} · Completed: ${fmtInt(r.completedTasks)}
         </div>`
      );
    });
    el.addEventListener('mouseleave', hideTooltip);
  });
}

function renderGroupedMoneySvg(selector, rows) {
  const container = $(selector);
  if (!rows.length) {
    container.innerHTML = '';
    return;
  }
  const W = 680;
  const H = 185;
  const m = { top: 18, right: 16, bottom: 28, left: 56 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const maxV = Math.max(1, ...rows.map((r) => Math.max(r.rewardVolumeUsd || 0, r.paidVolumeUsd || 0)));
  const step = plotW / rows.length;
  const pairW = Math.max(4, Math.min(20, step * 0.72));
  const bw = Math.max(1.5, pairW / 2 - 0.8);

  const grid = [0, 0.5, 1]
    .map((f) => {
      const y = m.top + plotH * (1 - f);
      return `
        <line x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke="${BRAND.line}" stroke-opacity="0.38" stroke-dasharray="2 4" />
        <text x="${m.left - 8}" y="${y + 4}" text-anchor="end" class="svg-label">${fmtUsd(maxV * f, true)}</text>
      `;
    })
    .join('');

  const bars = rows
    .map((r, i) => {
      const x0 = m.left + i * step + (step - pairW) / 2;
      const hPut = ((r.rewardVolumeUsd || 0) / maxV) * plotH;
      const hPaid = ((r.paidVolumeUsd || 0) / maxV) * plotH;
      return `
        <rect x="${x0.toFixed(1)}" y="${(m.top + plotH - hPut).toFixed(1)}" width="${bw.toFixed(1)}" height="${hPut.toFixed(1)}" rx="1.5" fill="${BRAND.muted}" fill-opacity="0.65" />
        <rect x="${(x0 + bw + 1.5).toFixed(1)}" y="${(m.top + plotH - hPaid).toFixed(1)}" width="${bw.toFixed(1)}" height="${hPaid.toFixed(1)}" rx="1.5" fill="${BRAND.magenta}" fill-opacity="0.82" />
      `;
    })
    .join('');

  const xLabelStep = Math.max(1, Math.ceil(rows.length / 6));
  const xLabels = rows
    .map((r, i) => {
      if (i % xLabelStep !== 0 && i !== rows.length - 1) return '';
      const x = m.left + i * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" class="svg-label">${r.bucket.slice(5)}</text>`;
    })
    .join('');

  const hoverRects = rows
    .map((r, i) => {
      const x = m.left + i * step;
      return `<rect class="ts-hit" x="${x.toFixed(1)}" y="${m.top}" width="${step.toFixed(1)}" height="${plotH}" fill="transparent" data-i="${i}" />`;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rewards put up versus rewards paid over time">
      ${grid}
      ${bars}
      ${xLabels}
      ${hoverRects}
    </svg>
  `;

  container.querySelectorAll('.ts-hit').forEach((el) => {
    const r = rows[Number(el.getAttribute('data-i'))];
    el.addEventListener('mousemove', (e) => {
      showTooltip(
        e,
        `<div class="tooltip-title">${escHtml(r.bucket)}</div>
         <div class="tooltip-mono">
           Rewards put up: ${fmtUsd(r.rewardVolumeUsd)}<br/>
           Rewards paid: ${fmtUsd(r.paidVolumeUsd)}<br/>
           Settlements: ${fmtInt(r.settlements)}
         </div>`
      );
    });
    el.addEventListener('mouseleave', hideTooltip);
  });
}

function renderWeeklyPosters() {
  const weeksAll = state.data.weeklyPosters || [];
  const limitByRange = { '7d': 4, '30d': 8, '90d': 14, all: weeksAll.length };
  const rows = weeksAll.slice(-Math.min(weeksAll.length, limitByRange[state.range] || 12));

  const container = $('#weekly-posters-viz');
  if (!rows.length) {
    container.innerHTML = `<div class="mono-muted">No weekly poster records available.</div>`;
    return;
  }

  const key = state.chain === '4217' ? 'tempo' : state.chain === '8453' ? 'base' : 'all';
  const W = 500;
  const H = 290;
  const m = { top: 22, right: 16, bottom: 38, left: 42 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;

  const maxV = Math.max(1, ...rows.map((r) => (key === 'all' ? Math.max(r.all, r.tempo + r.base) : r[key])));
  const step = plotW / rows.length;
  const bw = Math.max(6, Math.min(26, step * 0.66));

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = m.top + plotH * (1 - f);
      return `
        <line x1="${m.left}" y1="${y}" x2="${m.left + plotW}" y2="${y}" stroke="${BRAND.line}" stroke-opacity="0.35" stroke-dasharray="2 4" />
        <text x="${m.left - 8}" y="${y + 4}" text-anchor="end" class="svg-label">${fmtInt(maxV * f)}</text>
      `;
    })
    .join('');

  const bars = rows
    .map((r, i) => {
      const x = m.left + i * step + (step - bw) / 2;
      if (key === 'all') {
        const hBase = (r.base / maxV) * plotH;
        const hTempo = (r.tempo / maxV) * plotH;
        const yBase = m.top + plotH - hBase;
        const yTempo = yBase - hTempo;
        return `
          <rect x="${x.toFixed(1)}" y="${yBase.toFixed(1)}" width="${bw.toFixed(1)}" height="${hBase.toFixed(1)}" rx="2" fill="${BRAND.muted}" fill-opacity="0.65" />
          <rect x="${x.toFixed(1)}" y="${yTempo.toFixed(1)}" width="${bw.toFixed(1)}" height="${hTempo.toFixed(1)}" rx="2" fill="${BRAND.salmon}" />
        `;
      }
      const h = (r[key] / maxV) * plotH;
      const y = m.top + plotH - h;
      const fill = key === 'tempo' ? BRAND.salmon : BRAND.cream;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}" />`;
    })
    .join('');

  // Deduplicated unique total marker line when showing All Chains
  const dedupLine =
    key === 'all'
      ? `<path d="${rows
          .map((r, i) => {
            const x = m.left + i * step + step / 2;
            const y = m.top + plotH - (r.all / maxV) * plotH;
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(' ')}" fill="none" stroke="${BRAND.paper}" stroke-width="1.8" />`
      : '';

  const xLabelStep = Math.max(1, Math.ceil(rows.length / 5));
  const xLabels = rows
    .map((r, i) => {
      if (i % xLabelStep !== 0 && i !== rows.length - 1) return '';
      const x = m.left + i * step + step / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 12}" text-anchor="middle" class="svg-label">${r.week.slice(5)}</text>`;
    })
    .join('');

  const hits = rows
    .map((r, i) => `<rect class="wp-hit" x="${(m.left + i * step).toFixed(1)}" y="${m.top}" width="${step.toFixed(1)}" height="${plotH}" fill="transparent" data-i="${i}" />`)
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distinct task posters per week">
      ${grid}
      ${bars}
      ${dedupLine}
      ${xLabels}
      ${hits}
    </svg>
    <div style="display:flex;gap:14px;margin-top:6px;font-family:var(--font-mono);font-size:10px;color:var(--muted);flex-wrap:wrap">
      <span><i class="swatch" style="background:var(--salmon)"></i> Tempo posters</span>
      <span><i class="swatch" style="background:var(--muted)"></i> Base posters</span>
      <span><i class="swatch" style="background:var(--paper)"></i> Combined unique line</span>
    </div>
  `;

  container.querySelectorAll('.wp-hit').forEach((el) => {
    const r = rows[Number(el.getAttribute('data-i'))];
    el.addEventListener('mousemove', (e) => {
      showTooltip(
        e,
        `<div class="tooltip-title">Week of ${escHtml(r.week)} (UTC Mon)</div>
         <div class="tooltip-mono">
           Distinct posters (all): ${fmtInt(r.all)}<br/>
           Tempo (4217): ${fmtInt(r.tempo)} posters · ${fmtInt(r.tasksTempo)} tasks<br/>
           Base (8453): ${fmtInt(r.base)} posters · ${fmtInt(r.tasksBase)} tasks
         </div>`
      );
    });
    el.addEventListener('mouseleave', hideTooltip);
  });

  const latest = weeksAll[weeksAll.length - 1];
  const peak = weeksAll.reduce((best, r) => (r[key] > best[key] ? r : best), weeksAll[0]);
  const totalDistinct = state.data.insights[state.chain]?.concentration.distinctRequesters || 0;

  $('#weekly-posters-summary').innerHTML = `
    <div class="mini-stat">
      <div class="mini-stat-k">CURRENT WEEK (${escHtml(latest.week.slice(5))})</div>
      <div class="mini-stat-v">${fmtInt(latest[key])}</div>
    </div>
    <div class="mini-stat">
      <div class="mini-stat-k">PEAK WEEK (${escHtml(peak.week.slice(5))})</div>
      <div class="mini-stat-v">${fmtInt(peak[key])}</div>
    </div>
    <div class="mini-stat">
      <div class="mini-stat-k">ALL-TIME UNIQUE</div>
      <div class="mini-stat-v">${fmtInt(totalDistinct)}</div>
    </div>
  `;
}

/* ---------- Market Insights Panel ---------- */
function renderInsights() {
  const ins = state.data.insights[state.chain] || state.data.insights.all;
  const cm = state.data.chainMomentum;
  const tempoIns = state.data.insights['4217'];
  const baseIns = state.data.insights['8453'];
  const c = ins.concentration;
  const t = ins.timing;
  const m = ins.mortality;

  $('#insights-scope-tag').textContent = `${chainLabel(state.chain)} · ${fmtInt(ins.ledger.totalTasks)} tasks`;

  const topRows = c.topRequestersByVolume
    .map(
      (r) => `
      <tr>
        <td class="addr">${escHtml(r.addressShort)}</td>
        <td class="num">${fmtInt(r.tasks)}</td>
        <td class="num">${fmtUsd(r.escrowUsd)}</td>
        <td class="num">${fmtPct(r.volumeShare)}</td>
        <td class="num">${fmtPct(r.completionRate)}</td>
      </tr>`
    )
    .join('');

  $('#insights-grid').innerHTML = `
    <article class="insight-card">
      <div class="insight-head">
        <h3 class="insight-title">01 · Poster Concentration</h3>
        <span class="mono-muted">HHI ${fmtInt(c.hhiVolume)}</span>
      </div>
      <div class="insight-hero">${fmtPct(c.top5VolumeShare)} <span class="mono-muted">by top 5 wallets</span></div>
      <p class="insight-note">
        Out of ${fmtInt(c.distinctRequesters)} distinct requester addresses, the top 5 commit ${fmtPct(c.top5VolumeShare)} of escrowed USD and ${fmtPct(c.top5TaskShare)} of tasks; top 10 account for ${fmtPct(c.top10VolumeShare)} of volume.
      </p>
      <table class="req-table" aria-label="Top requester wallets by escrow volume">
        <thead>
          <tr><th>WALLET</th><th class="num">TASKS</th><th class="num">ESCROW</th><th class="num">SHARE</th><th class="num">DONE</th></tr>
        </thead>
        <tbody>${topRows}</tbody>
      </table>
    </article>

    <article class="insight-card">
      <div class="insight-head">
        <h3 class="insight-title">02 · Speed &amp; Decision Timing</h3>
        <span class="mono-muted">n=${fmtInt(t.claimSampleCount)} claims</span>
      </div>
      <div class="insight-hero">${fmtMinutes(t.medianClaimMinutes)} <span class="mono-muted">median claim time</span></div>
      <p class="insight-note">
        Agents react quickly once tasks hit escrow: claim-mode tasks are reserved in a median of ${fmtMinutes(t.medianClaimMinutes)} (IQR ${fmtMinutes(t.p25ClaimMinutes)}–${fmtMinutes(t.p75ClaimMinutes)}).
      </p>
      <div class="insight-rows">
        <div class="insight-row"><span class="insight-row-k">Median recent submission latency (n=${fmtInt(t.submissionLatencySamples)})</span><span class="insight-row-v">${fmtMinutes(t.medianSubmissionLatencyMinutes)}</span></div>
        <div class="insight-row"><span class="insight-row-k">Median task open window</span><span class="insight-row-v">${t.medianWindowHours ? `${t.medianWindowHours.toFixed(1)}h` : '—'}</span></div>
        <div class="insight-row"><span class="insight-row-k">Completed before deadline (early settlement)</span><span class="insight-row-v">${fmtInt(t.earlySettledCount)} tasks</span></div>
        <div class="insight-row"><span class="insight-row-k">Average awarded worker rating (n=${fmtInt(t.ratedTasksCount)})</span><span class="insight-row-v">${t.avgRating !== null ? `${t.avgRating.toFixed(1)} / 100` : '—'}</span></div>
        <div class="insight-row"><span class="insight-row-k">Distinct awarded winner wallets</span><span class="insight-row-v">${fmtInt(ins.ledger.distinctAwardedWorkers)}</span></div>
      </div>
    </article>

    <article class="insight-card">
      <div class="insight-head">
        <h3 class="insight-title">03 · Task Mortality &amp; Unsettled Escrow</h3>
        <span class="mono-muted">${fmtInt(m.deadCount)} dead tasks</span>
      </div>
      <div class="insight-hero">${fmtPct(m.deadRateOfResolved)} <span class="mono-muted">of resolved tasks</span></div>
      <p class="insight-note">
        ${fmtInt(m.expiredCount)} tasks expired and ${fmtInt(m.cancelledCount)} were cancelled, leaving ${fmtUsd(m.strandedUsd)} unsettled (${fmtPct(m.deadZeroSubmissionShare)} of dead tasks had zero submissions).
      </p>
      <div class="insight-rows">
        <div class="insight-row"><span class="insight-row-k">Completion rate (of resolved)</span><span class="insight-row-v">${fmtPct(m.completionRateOfResolved)}</span></div>
        <div class="insight-row"><span class="insight-row-k">Mortality rate (of all public tasks)</span><span class="insight-row-v">${fmtPct(m.deadRateOfAll)}</span></div>
        <div class="insight-row"><span class="insight-row-k">Expired escrow volume</span><span class="insight-row-v">${fmtUsd(m.expiredUsd)} (${fmtInt(m.expiredCount)})</span></div>
        <div class="insight-row"><span class="insight-row-k">Cancelled escrow volume</span><span class="insight-row-v">${fmtUsd(m.cancelledUsd)} (${fmtInt(m.cancelledCount)})</span></div>
        <div class="insight-row"><span class="insight-row-k">Average submissions per task</span><span class="insight-row-v">${ins.ledger.avgSubmissionsPerTask.toFixed(1)}</span></div>
      </div>
    </article>

    <article class="insight-card">
      <div class="insight-head">
        <h3 class="insight-title">04 · Chain Momentum (Tempo vs Base)</h3>
        <span class="mono-muted">Last 7d vs prior 7d</span>
      </div>
      <div class="insight-hero">${fmtPct(cm.tempoShareTasks7d)} <span class="mono-muted">Tempo task share (7d)</span></div>
      <p class="insight-note">
        Over the last 7 days, Tempo accounted for ${fmtPct(cm.tempoShareTasks7d)} of new public tasks and ${fmtPct(cm.tempoShareUsd7d)} of new escrowed USD. Resolved task mortality is ${fmtPct(tempoIns.mortality.deadRateOfResolved)} on Tempo versus ${fmtPct(baseIns.mortality.deadRateOfResolved)} on Base.
      </p>
      <div class="insight-rows">
        <div class="insight-row"><span class="insight-row-k">Tempo 7d tasks (vs prior 7d)</span><span class="insight-row-v">${fmtInt(cm.tempo.last7d.tasks)} (prev ${fmtInt(cm.tempo.prev7d.tasks)})</span></div>
        <div class="insight-row"><span class="insight-row-k">Base 7d tasks (vs prior 7d)</span><span class="insight-row-v">${fmtInt(cm.base.last7d.tasks)} (prev ${fmtInt(cm.base.prev7d.tasks)})</span></div>
        <div class="insight-row"><span class="insight-row-k">Tempo 7d escrow vs Base 7d escrow</span><span class="insight-row-v">${fmtUsd(cm.tempo.last7d.usd)} vs ${fmtUsd(cm.base.last7d.usd)}</span></div>
        <div class="insight-row"><span class="insight-row-k">Resolved completion: Tempo vs Base</span><span class="insight-row-v">${fmtPct(tempoIns.mortality.completionRateOfResolved)} vs ${fmtPct(baseIns.mortality.completionRateOfResolved)}</span></div>
        <div class="insight-row"><span class="insight-row-k">Distinct posters (7d): Tempo vs Base</span><span class="insight-row-v">${fmtInt(cm.tempo.last7d.distinctPosters)} vs ${fmtInt(cm.base.last7d.distinctPosters)}</span></div>
      </div>
    </article>
  `;
}

/* ---------- Breakdowns: Status, Mode, Actor Type ---------- */
function renderBreakdowns() {
  const bd = state.data.breakdowns[state.chain] || state.data.breakdowns.all;
  const isAll = state.chain === 'all';
  $('#breakdowns-scope-tag').textContent = isAll ? '/api/stats/breakdowns' : `Public tasks · ${chainLabel(state.chain)}`;

  const renderGroup = (title, items, labelKey, colorFn) => {
    const sorted = [...(items || [])].sort((a, b) => b.count - a.count);
    const total = sorted.reduce((a, b) => a + Number(b.count || 0), 0) || 1;
    const rows = sorted
      .map((item) => {
        const share = (Number(item.count) / total) * 100;
        const fillClass = colorFn ? colorFn(item[labelKey]) : '';
        return `
          <div class="bar-row">
            <div class="bar-row-head">
              <span class="bar-name">${escHtml(titleCaseStatus(item[labelKey]))}</span>
              <span class="bar-val">${fmtInt(item.count)} (${share.toFixed(1)}%)</span>
            </div>
            <div class="bar-track"><div class="bar-fill ${fillClass}" style="width:${Math.max(1.5, share).toFixed(1)}%"></div></div>
          </div>`;
      })
      .join('');
    return `<div class="bd-col"><h3 class="bd-title">${escHtml(title)}</h3>${rows}</div>`;
  };

  const statusColor = (s) => {
    if (s === 'open') return 'fill-magenta';
    if (s === 'expired' || s === 'cancelled') return 'fill-line';
    if (s === 'pending_approval' || s === 'claimed') return 'fill-paper';
    return '';
  };

  $('#breakdowns-grid').innerHTML =
    renderGroup('Tasks by Status', bd.status, 'status', statusColor) +
    renderGroup('Tasks by Mode', bd.mode, 'mode', (m) => (m === 'bounty' ? '' : 'fill-paper')) +
    renderGroup('Registered Actor Type (Platform)', bd.actorType, 'actorType', (a) => (a === 'agent' ? '' : 'fill-magenta'));
}

/* ---------- Activity Heatmap ---------- */
function renderHeatmap() {
  const hm = state.data.heatmaps[state.chain]?.[state.range]?.[state.dim];
  const container = $('#heatmap-viz');
  if (!hm || !hm.rowKeys || !hm.colKeys) {
    container.innerHTML = `<div class="mono-muted">No heatmap data available.</div>`;
    return;
  }

  const cellMap = new Map();
  let maxCount = 0;
  let totalCount = 0;
  for (const cell of hm.cells || []) {
    const k = `${cell.row}|${cell.col}`;
    const c = Number(cell.count || 0);
    cellMap.set(k, cell);
    if (c > maxCount) maxCount = c;
    totalCount += c;
  }

  const rows = hm.rowKeys;
  const cols = hm.colKeys;
  const isHour = state.dim === 'hourOfWeek';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Brand-only 5-step intensity ramp using strictly the 9 Brand Kit colours + alpha
  const ramp = [
    'rgba(34, 30, 26, 0.95)',
    'rgba(58, 20, 32, 0.92)',
    'rgba(217, 160, 151, 0.36)',
    'rgba(217, 160, 151, 0.78)',
    BRAND.magenta,
  ];
  function cellColor(count) {
    if (!count || maxCount === 0) return ramp[0];
    const ratio = count / maxCount;
    if (ratio < 0.15) return ramp[1];
    if (ratio < 0.4) return ramp[2];
    if (ratio < 0.72) return ramp[3];
    return ramp[4];
  }

  const labelW = isHour ? 42 : 78;
  const cellW = isHour ? 20 : Math.max(4, Math.min(18, Math.floor(460 / Math.max(1, cols.length))));
  const cellH = isHour ? 24 : 32;
  const gap = isHour ? 3 : cols.length > 60 ? 1 : 2;
  const padTop = 24;
  const padRight = 10;
  const W = labelW + cols.length * (cellW + gap) + padRight;
  const H = padTop + rows.length * (cellH + gap) + 14;

  const rects = [];
  const labels = [];

  cols.forEach((col, ci) => {
    const x = labelW + ci * (cellW + gap);
    const showLabel = isHour ? ci % 3 === 0 : ci === 0 || ci === cols.length - 1 || ci % Math.max(1, Math.floor(cols.length / 5)) === 0;
    if (showLabel) {
      const text = isHour ? `${String(col).padStart(2, '0')}h` : String(col).slice(5);
      labels.push(`<text x="${x + cellW / 2}" y="14" text-anchor="middle" class="svg-label" style="font-size:9px">${escHtml(text)}</text>`);
    }
  });

  rows.forEach((row, ri) => {
    const y = padTop + ri * (cellH + gap);
    const rLabel = isHour ? dayNames[Number(row)] ?? row : titleCaseStatus(row);
    labels.push(`<text x="${labelW - 8}" y="${y + cellH / 2 + 4}" text-anchor="end" class="svg-label">${escHtml(rLabel)}</text>`);

    cols.forEach((col, ci) => {
      const x = labelW + ci * (cellW + gap);
      const cell = cellMap.get(`${row}|${col}`);
      const count = cell ? Number(cell.count || 0) : 0;
      const volUsd = cell && cell.volume ? Number(cell.volume) / 1e6 : 0;
      const fill = cellColor(count);
      const title = isHour ? `${rLabel} · ${String(col).padStart(2, '0')}:00 UTC` : `${rLabel} · ${col}`;
      const body = `${fmtInt(count)} events${volUsd > 0 ? ` · ${fmtUsd(volUsd)}` : ''}`;
      rects.push(
        `<rect class="hm-cell" x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="${gap >= 2 ? 3 : 1}" fill="${fill}" stroke="${BRAND.ground}" stroke-width="0.6" data-t="${escHtml(title)}" data-b="${escHtml(body)}" />`
      );
    });
  });

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity heatmap">${labels.join('')}${rects.join('')}</svg>`;
  container.querySelectorAll('.hm-cell').forEach((el) => {
    el.addEventListener('mousemove', (e) => {
      showTooltip(e, `<div class="tooltip-title">${el.getAttribute('data-t')}</div><div class="tooltip-mono">${el.getAttribute('data-b')}</div>`);
    });
    el.addEventListener('mouseleave', hideTooltip);
  });

  $('#heatmap-footer').innerHTML = `
    <span>${fmtInt(totalCount)} total events · Peak cell: ${fmtInt(maxCount)} (${state.range})</span>
    <span class="heat-scale">
      <span>Low</span>
      ${ramp.map((col) => `<span class="heat-cell-legend" style="background:${col}"></span>`).join('')}
      <span>Peak</span>
    </span>
  `;
}

/* ---------- Live Activity Feed ---------- */
function renderActivityFeed() {
  const feed = state.data.activityFeed || [];
  let items = feed.filter((e) => (state.chain === 'all' ? true : String(e.chainId) === state.chain));
  if (state.feedType !== 'all') items = items.filter((e) => e.type === state.feedType);

  const listEl = $('#activity-feed-list');
  if (!items.length) {
    listEl.innerHTML = `
      <div class="feed-item" style="grid-template-columns:1fr">
        <div class="mono-muted">
          No events matching ${chainLabel(state.chain)} / ${state.feedType} in the latest ${fmtInt(feed.length)} live feed records. Switch chain to All Chains to view recent platform stream.
        </div>
      </div>`;
    return;
  }

  const badgeInfo = {
    task_submitted: { text: 'SUBMIT', cls: 'type-submitted' },
    task_created: { text: 'POSTED', cls: 'type-created' },
    task_claimed: { text: 'CLAIMED', cls: 'type-claimed' },
  };

  listEl.innerHTML = items
    .slice(0, 40)
    .map((e) => {
      const b = badgeInfo[e.type] || { text: String(e.type || 'EVENT').toUpperCase(), cls: '' };
      const cur = chainCurrency(e.chainId);
      const amt = e.amountUsd !== null && e.amountUsd > 0 ? `<span class="feed-amount">${fmtUsd(e.amountUsd)} ${cur}</span>` : '';
      return `
      <a class="feed-item" href="https://taskmarket.dev/tasks/${encodeURIComponent(e.taskId)}" target="_blank" rel="noopener noreferrer">
        <span class="feed-badge ${b.cls}">${escHtml(b.text)}</span>
        <div class="feed-main">
          <div class="feed-title">${escHtml(e.taskTitle)}</div>
          <div class="feed-meta">
            <span>${e.chainId === 4217 ? 'Tempo 4217' : 'Base 8453'}</span>
            <span>${escHtml(e.actorShort)} (${escHtml(e.actorType)})</span>
          </div>
        </div>
        <div class="feed-right">
          ${amt}
          <span>${fmtRelTime(e.timestamp, state.data.meta.dataAsOf)}</span>
        </div>
      </a>`;
    })
    .join('');
}

/* ---------- Methods & Endpoints Section ---------- */
function renderMethods() {
  const meta = state.data.meta;
  const epList = (meta.endpointsUsed || []).map((ep) => `<li><span class="code-line">GET ${escHtml(meta.upstreamBase)}${escHtml(ep)}</span></li>`).join('');

  $('#methods-body').innerHTML = `
    <div class="methods-col">
      <h3>Upstream Endpoints (Server-Side Only)</h3>
      <ul>${epList}</ul>
      <h3>CLI Parity Reference</h3>
      <p>Official CLI shows the same statistics: <span class="code-line">taskmarket --network tempo stats --platform</span> and <span class="code-line">npm i -g @lucid-agents/taskmarket</span>.</p>
    </div>
    <div class="methods-col">
      <h3>Computations &amp; Cache Policy</h3>
      <ul>
        <li><strong>Data as of:</strong> <span class="code-line">${escHtml(meta.dataAsOf)}</span> (source: <span class="code-line">${escHtml(meta.source)}</span>, fetched in ${fmtInt(meta.fetchDurationMs)}ms).</li>
        <li><strong>Caching &amp; refresh:</strong> ${
          window.location.hostname.endsWith('.github.io') || meta.source === 'static-snapshot'
            ? 'Hosted on GitHub Pages with a scheduled GitHub Actions build (<span class="code-line">cron: 5,35 * * * *</span>, every 30 minutes) that fetches upstream server-side into <span class="code-line">data/market-snapshot.json</span> and serves via GitHub Pages CDN (<span class="code-line">Cache-Control: max-age=600</span>). Also includes a drop-in <span class="code-line">/api/market</span> serverless handler (300s TTL) for Vercel or Node.'
            : `Server fetches upstream via <span class="code-line">/api/market</span> with a ${fmtInt(meta.cacheTtlSeconds)}s in-memory TTL and HTTP header <span class="code-line">Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600</span>.`
        } The browser never contacts api.taskmarket.dev directly.</li>
        <li><strong>Distinct posters per week:</strong> Computed strictly from all paginated <span class="code-line">/api/tasks</span> pages (${fmtInt(meta.pagesFetched?.tempoTasks)} Tempo pages + ${fmtInt(meta.pagesFetched?.baseTasks)} Base pages), deduplicating lowercased <span class="code-line">requester</span> addresses per Monday-start ISO UTC week.</li>
        <li><strong>Token precision:</strong> Micro-unit amounts (<span class="code-line">10^6 = 1 OUSD / 1 USDC</span>) are summed in <span class="code-line">BigInt</span> before converting to USD.</li>
        <li><strong>Chain scope &amp; open-task counts:</strong> <span class="code-line">/api/market/stats</span> differentiates <span class="code-line">paidWorkers</span> and <span class="code-line">activeWallets</span> per chain, and its <span class="code-line">openTasks</span> counter tracks live unexpired open tasks platform-wide, whereas paginated <span class="code-line">/api/tasks?chainId=4217|8453</span> includes all public rows carrying <span class="code-line">status=open</span>. Upstream <span class="code-line">/api/stats/*</span> endpoints currently report platform-wide aggregates; selecting Tempo or Base derives exact chain-level task series, breakdowns, and heatmaps directly from <span class="code-line">/api/tasks</span>.</li>
        <li><strong>Privacy &amp; identities:</strong> Wallet addresses are rendered strictly as truncated hex prefixes. No guessed names, no wallet connect, no personal data tracking.</li>
      </ul>
    </div>
  `;
}

/* ---------- Client-Side Share Card PNG Generator (Per View, 1200x630) ---------- */
let lockupImgPromise = null;
let ogPlateImgPromise = null;

function loadImageOnce(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function loadLockupImg() {
  if (!lockupImgPromise) lockupImgPromise = loadImageOnce('./assets/taskmarket-lockup.png');
  return lockupImgPromise;
}

function loadOgPlateImg() {
  if (!ogPlateImgPromise) ogPlateImgPromise = loadImageOnce('./assets/og-plate.webp');
  return ogPlateImgPromise;
}

async function downloadShareCard(viewName) {
  if (!state.data) return;
  try {
    await document.fonts?.ready;
  } catch {
    // Continue with available fonts
  }
  const [lockup, ogPlate] = await Promise.all([loadLockupImg(), loadOgPlateImg()]);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');

  // 1. Background: Sculptural Nano Banana plate with directional obsidian scrim
  ctx.fillStyle = BRAND.ground;
  ctx.fillRect(0, 0, 1200, 630);
  if (ogPlate) {
    ctx.drawImage(ogPlate, 0, 0, 1200, 630);
    const scrim = ctx.createLinearGradient(0, 0, 1080, 0);
    scrim.addColorStop(0, 'rgba(18, 16, 14, 0.90)');
    scrim.addColorStop(0.55, 'rgba(18, 16, 14, 0.62)');
    scrim.addColorStop(1, 'rgba(18, 16, 14, 0.18)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, 1200, 630);
    const bottomScrim = ctx.createLinearGradient(0, 320, 0, 630);
    bottomScrim.addColorStop(0, 'rgba(18, 16, 14, 0)');
    bottomScrim.addColorStop(1, 'rgba(18, 16, 14, 0.72)');
    ctx.fillStyle = bottomScrim;
    ctx.fillRect(0, 0, 1200, 630);
  } else {
    const grad = ctx.createRadialGradient(980, 60, 40, 980, 60, 680);
    grad.addColorStop(0, 'rgba(58, 20, 32, 0.92)');
    grad.addColorStop(0.55, 'rgba(58, 20, 32, 0.28)');
    grad.addColorStop(1, 'rgba(18, 16, 14, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1200, 630);
  }

  // 2. Top-left untouched lockup (>= 30% width = 360px -> 360 x 65px) with clear space
  const lw = 360;
  const lh = Math.round((176 / 971) * lw);
  if (lockup) {
    ctx.drawImage(lockup, 64, 56, lw, lh);
  }
  // Top-right taskmarket.dev in Departure Mono
  ctx.font = '400 24px "Departure Mono", monospace';
  ctx.fillStyle = BRAND.cream;
  ctx.textAlign = 'right';
  ctx.fillText('taskmarket.dev', 1136, 98);
  ctx.textAlign = 'left';

  // Build view-specific live metrics
  const d = state.data;
  const c = state.chain;
  const ins = d.insights[c] || d.insights.all;
  const flow = d.escrowFlow[c] || d.escrowFlow.all;
  const stats = d.marketStats[c] || d.marketStats.all;
  const latestWeek = d.weeklyPosters[d.weeklyPosters.length - 1];

  const views = {
    overview: {
      headlineA: 'Live market ',
      headlineAccent: 'telemetry.',
      subtitle: `${chainLabel(c)} · ${fmtInt(ins.ledger.totalTasks)} public tasks · Data as of ${fmtUtcShort(d.meta.dataAsOf)}`,
      kpis: [
        { k: 'ACTIVE AGENTS (7D)', v: fmtInt(stats.activeAgents7d) },
        { k: 'PAID WORKERS', v: fmtInt(stats.paidWorkers) },
        { k: 'ESCROW LEDGER', v: fmtUsd(ins.ledger.totalEscrowUsd) },
        { k: 'SETTLED PAYOUTS', v: fmtUsd(ins.ledger.completedUsd) },
      ],
    },
    flow: {
      headlineA: 'Escrow in ',
      headlineAccent: 'motion.',
      subtitle: `${chainLabel(c)} · Top 5 requesters fund ${fmtPct(ins.concentration.top5VolumeShare)} of escrowed volume`,
      kpis: [
        { k: 'TOTAL ESCROW', v: fmtUsd(flow.totalUsd) },
        { k: 'SETTLED PAYOUTS', v: fmtUsd(flow.outcomes.find((o) => o.id === 'settled')?.usd || 0) },
        { k: 'OPEN & CLAIMED', v: fmtUsd(flow.outcomes.find((o) => o.id === 'active')?.usd || 0) },
        { k: 'EXPIRED / CANCELLED', v: fmtUsd(flow.outcomes.find((o) => o.id === 'dead')?.usd || 0) },
      ],
    },
    swarm: {
      headlineA: 'Where agents ',
      headlineAccent: 'converge.',
      subtitle: `${chainLabel(c)} · ${fmtInt(ins.ledger.totalSubmissions)} total submissions across ${fmtInt(ins.ledger.totalTasks)} tasks`,
      kpis: [
        { k: 'OPEN TASKS', v: fmtInt(ins.ledger.openTasks) },
        { k: 'AVG SUBS / TASK', v: ins.ledger.avgSubmissionsPerTask.toFixed(1) },
        { k: 'MEDIAN CLAIM TIME', v: fmtMinutes(ins.timing.medianClaimMinutes) },
        { k: 'AWARDED WINNERS', v: fmtInt(ins.ledger.distinctAwardedWorkers) },
      ],
    },
    series: {
      headlineA: 'Market ',
      headlineAccent: 'velocity.',
      subtitle: `${chainLabel(c)} · Range ${state.range.toUpperCase()} (${state.bucket}) · Tempo 7d share ${fmtPct(d.chainMomentum.tempoShareTasks7d)}`,
      kpis: [
        { k: 'TEMPO TASKS', v: fmtInt(d.insights['4217'].ledger.totalTasks) },
        { k: 'BASE TASKS', v: fmtInt(d.insights['8453'].ledger.totalTasks) },
        { k: 'WEEKLY POSTERS', v: fmtInt(latestWeek ? latestWeek.all : 0) },
        { k: 'ACTIVE WALLETS', v: fmtInt(stats.activeWallets) },
      ],
    },
    posters: {
      headlineA: 'Distinct ',
      headlineAccent: 'posters.',
      subtitle: `Computed from paginated /api/tasks · ISO UTC weekly unique requester wallets`,
      kpis: [
        { k: 'CURRENT WEEK', v: fmtInt(latestWeek ? latestWeek.all : 0) },
        { k: 'TEMPO UNIQUE', v: fmtInt(d.insights['4217'].concentration.distinctRequesters) },
        { k: 'BASE UNIQUE', v: fmtInt(d.insights['8453'].concentration.distinctRequesters) },
        { k: 'ALL-TIME UNIQUE', v: fmtInt(d.insights.all.concentration.distinctRequesters) },
      ],
    },
    insights: {
      headlineA: 'Market ',
      headlineAccent: 'signals.',
      subtitle: `${chainLabel(c)} · Concentration, speed, mortality, and cross-chain momentum`,
      kpis: [
        { k: 'TOP-5 SHARE', v: fmtPct(ins.concentration.top5VolumeShare) },
        { k: 'MEDIAN CLAIM', v: fmtMinutes(ins.timing.medianClaimMinutes) },
        { k: 'RESOLVED DONE', v: fmtPct(ins.mortality.completionRateOfResolved) },
        { k: 'TEMPO 7D SHARE', v: fmtPct(d.chainMomentum.tempoShareTasks7d) },
      ],
    },
  };

  const spec = views[viewName] || views.overview;

  // 3. One Instrument Serif headline with one magenta italic word
  ctx.font = '400 84px "Instrument Serif", Georgia, serif';
  ctx.fillStyle = BRAND.cream;
  ctx.fillText(spec.headlineA, 64, 248);
  const wA = ctx.measureText(spec.headlineA).width;
  ctx.font = 'italic 400 84px "Instrument Serif", Georgia, serif';
  ctx.fillStyle = BRAND.magenta;
  ctx.fillText(spec.headlineAccent, 64 + wA, 248);

  // Subtitle
  ctx.font = '500 22px "Inter Tight", sans-serif';
  ctx.fillStyle = BRAND.muted;
  ctx.fillText(spec.subtitle, 64, 294);

  // 4. Four Brand-Kit metric panels
  const cardW = 250;
  const cardH = 148;
  const cardGap = 24;
  spec.kpis.forEach((kpi, idx) => {
    const x = 64 + idx * (cardW + cardGap);
    const y = 344;
    ctx.fillStyle = BRAND.panel;
    ctx.strokeStyle = idx === 0 ? BRAND.salmon : BRAND.line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.font = '400 13px "Departure Mono", monospace';
    ctx.fillStyle = BRAND.muted;
    ctx.fillText(kpi.k, x + 20, y + 40);

    ctx.font = '400 34px "Departure Mono", monospace';
    ctx.fillStyle = BRAND.paper;
    ctx.fillText(kpi.v, x + 20, y + 102);
  });

  // 5. Footer sign-off
  ctx.strokeStyle = BRAND.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(64, 540);
  ctx.lineTo(1136, 540);
  ctx.stroke();

  ctx.font = '400 14px "Departure Mono", monospace';
  ctx.fillStyle = BRAND.muted;
  ctx.fillText(`DATA AS OF ${fmtUtcShort(d.meta.dataAsOf).toUpperCase()} · TEMPO (OUSD) & BASE (USDC)`, 64, 578);
  ctx.textAlign = 'right';
  ctx.fillText('MADE FOR A PAID TASKMARKET BOUNTY', 1136, 578);

  const link = document.createElement('a');
  link.download = `taskmarket-${viewName}-${state.chain}-${state.range}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  showToast(`Saved share card PNG (${viewName})`);
}

/* ---------- Controls & Full Render ---------- */
function syncControlButtons() {
  $$('#chain-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.chain === state.chain));
  $$('#range-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === state.range));
  $$('#bucket-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.bucket === state.bucket));
  $$('#view-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $$('#heatmap-dim-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.dim === state.dim));
  $$('#swarm-status-filter .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.swarmStatus === state.swarmStatus));
  $$('#feed-type-switch .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.feedType === state.feedType));
}

function renderAll() {
  if (!state.data) return;
  renderHeaderAndKpis();
  renderEscrowFlow();
  renderSwarmMap();
  renderTimeSeries();
  renderWeeklyPosters();
  renderInsights();
  renderBreakdowns();
  renderHeatmap();
  renderActivityFeed();
  renderMethods();
}

function syncControlsAndRender() {
  syncControlButtons();
  syncUrl();
  renderAll();
}

function bindEvents() {
  $$('#chain-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.chain = b.dataset.chain;
      state.selectedTask = null;
      syncControlsAndRender();
    })
  );

  $$('#range-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.range = b.dataset.range;
      syncControlsAndRender();
    })
  );

  $$('#bucket-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.bucket = b.dataset.bucket;
      syncControlsAndRender();
    })
  );

  $$('#view-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      syncControlButtons();
      syncUrl();
      const target = document.getElementById(`view-${state.view}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );

  $$('#heatmap-dim-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.dim = b.dataset.dim;
      syncControlButtons();
      syncUrl();
      renderHeatmap();
    })
  );

  $$('#swarm-status-filter .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.swarmStatus = b.dataset.swarmStatus;
      syncControlButtons();
      renderSwarmMap();
    })
  );

  $$('#feed-type-switch .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.feedType = b.dataset.feedType;
      syncControlButtons();
      renderActivityFeed();
    })
  );

  $('#btn-copy-link')?.addEventListener('click', async () => {
    const url = buildViewUrl();
    try {
      await navigator.clipboard.writeText(url);
      showToast('Copied deep link to clipboard');
    } catch {
      showToast(url);
    }
  });

  $$('[data-copy-view]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const view = btn.getAttribute('data-copy-view');
      const url = buildViewUrl(view);
      try {
        await navigator.clipboard.writeText(url);
        showToast(`Copied link to ${view} view`);
      } catch {
        showToast(url);
      }
    })
  );

  $('#btn-share-card-hero')?.addEventListener('click', () => downloadShareCard(state.view));
  $$('[data-share-view]').forEach((btn) =>
    btn.addEventListener('click', () => downloadShareCard(btn.getAttribute('data-share-view')))
  );

  $('#btn-toggle-methods')?.addEventListener('click', () => {
    const det = $('#methods-details');
    if (det) {
      det.open = !det.open;
      $('#btn-toggle-methods').setAttribute('aria-expanded', String(det.open));
      if (det.open) det.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
}

async function init() {
  readUrlState();
  syncControlButtons();
  bindEvents();

  try {
    state.data = await loadMarketData();
    renderAll();
    if (state.view && state.view !== 'overview') {
      const target = document.getElementById(`view-${state.view}`);
      target?.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  } catch (err) {
    const banner = $('#error-banner');
    banner.hidden = false;
    banner.textContent = `Unable to load server-cached market snapshot: ${err instanceof Error ? err.message : String(err)}`;
    $('#data-as-of-text').textContent = 'Feed unavailable';
  }
}

init();
