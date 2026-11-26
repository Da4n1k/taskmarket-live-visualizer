# Taskmarket Live Market Visualizer

A public, read-only, server-cached market visualizer for [Taskmarket](https://taskmarket.dev) across **Tempo (`chainId=4217`, OUSD)** and **Base (`chainId=8453`, USDC)**.

Built for Taskmarket bounty `TSK-BRK611AN`. Open source under the MIT licence.

## Features

- **Server-side API fetch & cache**: Browser never calls `api.taskmarket.dev` directly. All six public endpoints are fetched server-side by `/api/market` (`api/market.mjs` on Vercel, shared identically by local `server.mjs`), cached in memory for 5 minutes (`300s`) with `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=600`, plus an automatic static snapshot fallback (`public/data/market-snapshot.json`) for static hosting.
- **All required views for Tempo, Base, and Combined**:
  - Headline numbers (`/api/market/stats`)
  - Daily/weekly active agents, tasks posted, rewards put up, and rewards paid over time with `7d | 30d | 90d | all` and `day | week` switches
  - Tasks by mode, status, and registered actor type
  - Activity heatmap (`hourOfWeek` and `mode`) and live activity feed
  - Distinct task posters per ISO UTC week, computed strictly from paginated `/api/tasks` across both chains
- **Original visualizations**:
  - **Escrow Flow River**: Interactive SVG flow tracing escrowed USD from requester tiers through Tempo (OUSD) and Base (USDC) into settled payouts, active pools, pending approvals, or expired/cancelled tasks.
  - **Swarm Convergence Map**: Interactive log-scale scatter canvas plotting reward versus agent submissions across all public tasks, highlighting high-reward low-crowd open tasks.
- **Computed Market Insights**: Poster concentration (top-5/top-10 wallet share & HHI), decision and claim latency, task mortality and unsettled escrow, and 7-day cross-chain momentum.
- **Shareability**: Deep-linked URL parameters (`?chain=all|4217|8453&range=7d|30d|90d|all&bucket=day|week&dim=hourOfWeek|mode&view=overview|flow|swarm|series|insights|activity`), static 1200x630 Open Graph / X share image (`public/og-image.png`), one-click link copy, and per-view PNG share card export.
- **Zero bloat & strict compliance**: Zero runtime npm dependencies, self-hosted Brand Kit fonts (SIL OFL 1.1), strict 9-colour Brand Kit palette, read-only with no wallet connection, no login, and no tracking.

## Quick Start (Local)

Requires Node.js 20+.

```bash
npm start
```

Open `http://127.0.0.1:3000`.

## One-Command Deploy

### Option A: Vercel (Recommended — live serverless `/api/market` refreshed every 5 min)

```bash
npx vercel --prod
```

After your first deploy gives you a public HTTPS URL (for example `https://taskmarket-live-visualizer.vercel.app`), optionally set canonical Open Graph URLs and redeploy:

```bash
npm run set-url https://your-project.vercel.app
npx vercel --prod
```

### Option B: GitHub Pages (Live Deployment — Static + Automated 30-Minute GitHub Actions Refresh)

1. Push this repository to GitHub.
2. Enable **Settings -> Pages -> Source: GitHub Actions**.
3. The included workflow `.github/workflows/refresh-snapshot.yml` runs `npm run snapshot` server-side every 30 minutes (`cron: '5,35 * * * *'`), writes `public/data/market-snapshot.json`, and publishes `public/` over HTTPS (`Cache-Control: max-age=600`).

Live instance: `https://da4n1k.github.io/taskmarket-live-visualizer/`

## Verification & Parity Tests

Run the live API parity and compliance test suite:

```bash
npm test
```

`npm test` starts the local server, validates server-side caching (`Cache-Control` >= 60s and in-memory cache HIT), cross-checks 10+ live metrics directly against `https://api.taskmarket.dev` (including independent pagination of `/api/tasks` for weekly distinct posters), checks zero browser calls to `api.taskmarket.dev`, checks strict 9-colour Brand Kit compliance, verifies zero banned words, and validates `og-image.png` (1200x630) and untouched Brand Kit assets.

## Upstream Endpoints Used

All fetched server-side from `https://api.taskmarket.dev`:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/market/stats?chainId=4217\|8453` | Headline market counters (platform & per-chain paid workers / active wallets) |
| `GET /api/stats/breakdowns?chainId=4217\|8453` | Tasks by status, mode, and actor type |
| `GET /api/stats/platform-time-series?chainId=4217\|8453&range=7d\|30d\|90d\|all&bucket=day\|week` | Active agents, tasks posted, rewards escrowed, rewards paid |
| `GET /api/stats/activity-heatmap?chainId=4217\|8453&range=7d\|30d\|90d\|all&dimension=mode\|hourOfWeek` | Activity heatmap across UTC hour of week and mode |
| `GET /api/stats/activity-feed?chainId=4217\|8453&limit=50&cursor=...` | Live event stream (submissions, creations, claims) |
| `GET /api/tasks?chainId=4217\|8453&sort=newest&limit=100&cursor=...` | Paginated public task ledger for weekly distinct posters, Escrow Flow River, Swarm Convergence Map, and per-chain metrics |

## Licences

- Code: [MIT License](./LICENSE).
- Fonts (`Instrument Serif`, `Inter Tight`, `Departure Mono`): SIL Open Font License 1.1 (copies included in `public/assets/fonts/`).
- Taskmarket mark and lockup (`public/assets/taskmarket-lockup.png`, `public/assets/taskmarket-mark.png`): used untouched from the Taskmarket Brand Kit for this bounty entry.
- Atmospheric backdrop plates (`public/assets/hero-plate.webp`, `public/assets/og-plate.webp`): bespoke text-free, UI-free studio plates generated with Nano Banana 3.1 harmonizing with the Brand Kit plates; all typography and the lockup are composited programmatically.

---

Made for a paid Taskmarket bounty. Not an official Taskmarket product.
