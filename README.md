# RF Traffic Intelligence

> Unified GA4 + Google Search Console + NetSuite timeline with 30/90 day moving averages and lead-lag correlation analysis.

---

## What This Does

Shows three data layers on one interactive timeline:

| Layer | Source | Metrics |
|-------|--------|---------|
| SEO Traffic | Google Search Console | Organic clicks, impressions, CTR, avg position |
| All Traffic | Google Analytics 4 | Sessions by source: organic, paid, direct, referral |
| Business Activity | NetSuite SuiteQL | Quotes (Estimates) and Sales Orders per day |

**Key features:**
- 30-day and 90-day trailing moving averages on every metric
- Normalized overlay view (all metrics scaled 0–100 for visual comparison)
- Lead-lag correlation: automatically measures how many days traffic leads quotes, and quotes lead orders
- Date range filter (1m / 3m / 6m / 1y / 2y / all)
- Weekday-only toggle (removes weekends for B2B context)
- One-click NetSuite refresh (~5 seconds)

---

## Setup — Step by Step

### Step 1 — Install dependencies

```bash
cd rf-traffic-intel
npm install
```

### Step 2 — Copy environment file

```bash
cp .env.example .env
```

### Step 3 — Set up Google Cloud (one-time, ~15 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Create a new project: **"RubberForm Intel"**
3. Enable these two APIs:
   - **Google Analytics Data API**
   - **Google Search Console API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
   - Application type: **Desktop App**
   - Name: "RF Traffic Intel"
5. Download the JSON → rename to `credentials.json` → save to `auth/credentials.json`
6. Fill in `.env`:
   ```
   GSC_SITE_URL=https://www.rubberform.com/
   GA4_PROPERTY_ID=YOUR_PROPERTY_ID
   ```
   Find your GA4 Property ID: GA4 → Admin → Property Settings (top right, 9-digit number)

7. Run the auth flow (opens browser, approve once):
   ```bash
   node auth/google-auth.js
   ```

### Step 4 — Set up NetSuite TBA credentials (optional but recommended)

If you already have NetSuite MCP running, you can skip this — the MCP fetcher works in Claude Code directly. For the standalone tool:

1. NetSuite → Setup → Integration → Manage Integrations → **New**
   - Name: "RF Traffic Intel"
   - Token-Based Authentication: ✅ checked
   - Save → copy Consumer Key and Consumer Secret to `.env`

2. Setup → Users/Roles → User Token Management → **New Token**
   - Application: RF Traffic Intel
   - User: your account
   - Save → copy Token ID and Token Secret to `.env`

### Step 5 — Fetch all data

```bash
# Full fetch (Google + NetSuite):
node fetchers/fetch-all.js

# NetSuite only (fast, no Google setup needed):
node fetchers/fetch-all.js --netsuite-only

# Use cached Google data, refresh NetSuite only:
node fetchers/fetch-all.js --skip-google
```

First run takes 1–2 minutes. Subsequent runs with `--skip-google` take ~10 seconds.

### Step 6 — Run the dashboard

**Development (live reload):**
```bash
npm run dev
# Dashboard: http://localhost:5174
# API: http://localhost:3737
```

**Production (built):**
```bash
npm run build
node server.js
# Both at: http://localhost:3737
```

---

## Refresh Schedule

NetSuite data should be refreshed daily. Set up a cron job:

```bash
# Refresh NetSuite every weekday at 8am
0 8 * * 1-5 cd /path/to/rf-traffic-intel && node fetchers/fetch-all.js --skip-google
```

Google data is cached and only needs refresh weekly (Search Console has a 3-day data lag anyway).

---

## Project Structure

```
rf-traffic-intel/
├── auth/
│   ├── google-auth.js      ← OAuth setup + token management
│   ├── credentials.json    ← ADD THIS (download from Google Cloud)
│   └── token.json          ← auto-generated after first auth
├── fetchers/
│   ├── fetch-gsc.js        ← Google Search Console daily data
│   ├── fetch-ga4.js        ← GA4 sessions by source
│   ├── fetch-netsuite.js   ← NetSuite SuiteQL quotes + orders
│   └── fetch-all.js        ← Master script, merges all sources
├── data/
│   └── cache/
│       ├── gsc-daily.json      ← GSC cache
│       ├── ga4-daily.json      ← GA4 cache
│       ├── netsuite-daily.json ← NetSuite cache
│       └── unified-daily.json  ← Merged dataset (what the dashboard reads)
├── dashboard/
│   ├── index.html
│   └── src/
│       ├── App.jsx             ← Main dashboard component
│       ├── main.jsx
│       └── utils/
│           └── analytics.js    ← MA, lead-lag, normalization utilities
├── server.js               ← Express API server
├── vite.config.js
├── package.json
└── .env                    ← YOUR credentials (never commit)
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/unified` | Full merged daily dataset |
| `GET /api/netsuite` | NetSuite data only |
| `GET /api/gsc` | Search Console data only |
| `GET /api/ga4` | GA4 data only |
| `GET /api/health` | Server status + cache ages |
| `POST /api/refresh/netsuite` | Re-fetch NetSuite in background |
| `POST /api/refresh/all` | Re-fetch everything in background |

Query params for `/api/unified`: `?start=2024-01-01&end=2025-01-01`

---

## Understanding the Lead-Lag Analysis

The dashboard automatically runs Pearson correlation at each lag from 0 to 45 days and finds the peak. Example interpretation:

> "Organic clicks leads Quotes by 14 days (r=0.61)"

This means: when organic clicks spike today, expect quotes to spike 14 days later, with moderate-to-strong correlation. Use this to set expectations after ad campaigns or SEO wins.

The mini bar charts in the lead-lag panel show correlation strength at each lag value — orange = peak lag, green = strong correlation, dark = weak.
