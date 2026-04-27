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
| `GET /api/gsc` | Search Console daily aggregate |
| `GET /api/gsc-top?kind=query\|page` | Top 50 queries/pages for the latest 28d window |
| `GET /api/ga4` | GA4 data only |
| `GET /api/google-ads` | Google Ads daily aggregate (cost, clicks, impressions) |
| `GET /api/google-ads-campaigns?since=&until=` | Per-campaign window stats |
| `GET /api/hubspot-deals?since=&until=&source=` | Closed-won deals in window |
| `GET /api/hubspot-deals-daily` | Daily won counts + revenue by attribution source |
| `GET /api/health` | Server status + cache ages |
| `POST /api/refresh/netsuite` | Re-fetch NetSuite in background |
| `POST /api/refresh/ga4?mode=full\|incremental` | Re-fetch GA4 |
| `POST /api/refresh/google-ads?mode=full\|incremental` | Re-fetch Google Ads |
| `POST /api/refresh/hubspot?mode=full\|incremental` | Re-fetch HubSpot |
| `POST /api/refresh/gsc?mode=full\|incremental` | Re-fetch Search Console |

Query params for `/api/unified`: `?start=2024-01-01&end=2025-01-01`

---

## Paid + SEO KPI tabs — credential setup

Two dashboard tabs (**Paid KPIs** and **SEO KPIs**) join three new data sources to GA4 to compute CPA, ROAS, CTR, and organic search performance. All three are optional — each tab renders an empty-state error with a pointer to the right credentials if a source isn't configured. None of these block the other tabs (GA4 Insights, Overview, Part Group) from working.

### Google Ads (direct API)

Feeds the Paid KPIs tab's cost / clicks / impressions / CPC / CTR columns. Cost data is NOT fetched from GA4 or HubSpot — we hit the Google Ads API directly for accuracy and to avoid a dependency on having Google Ads linked to GA4.

1. **Developer token.** Sign in to the Google Ads Manager account at https://ads.google.com/aw/apicenter and request a token. "Basic access" is enough to read your own accounts; approval usually comes within hours.
2. **OAuth client.** In GCP Console → APIs & Services → Credentials, create a Desktop-app OAuth client. You'll get a `client_id` + `client_secret`.
3. **Refresh token.** One-time consent flow. The quickest path:
   ```
   # Open this URL in a browser (replace CLIENT_ID):
   https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent

   # Copy the authorization code Google gives you, then:
   curl -s -d "code=AUTH_CODE" \
        -d "client_id=CLIENT_ID" \
        -d "client_secret=CLIENT_SECRET" \
        -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob" \
        -d "grant_type=authorization_code" \
        https://oauth2.googleapis.com/token
   ```
   The response includes a `refresh_token` — save it.
4. **Customer ID.** The 10-digit Google Ads account id (no dashes). If it's under a Manager (MCC), also set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to the MCC's id.
5. Set all of `GOOGLE_ADS_*` vars in `.env` and POST to `/api/refresh/google-ads?mode=full` (or restart the server — it backfills automatically when the table is empty).

### HubSpot (Private App token)

Feeds both tabs: closed-won deals are the "true acquisition" denominator for CPA, and `hs_analytics_source` drives the paid-vs-organic split.

1. HubSpot → **Settings → Integrations → Private Apps → Create a private app**.
2. Scopes required (minimum):
   - `crm.objects.deals.read`
   - `crm.schemas.deals.read`
3. Optional (Marketing Hub Professional or higher, for campaign attribution):
   - `crm.objects.marketing_events.read`

   If you omit this and the account isn't on Marketing Hub, the Paid tab falls back to matching deals by `hs_analytics_source_data_1` / campaign name.
4. Copy the generated token into `HUBSPOT_PRIVATE_APP_TOKEN` and POST to `/api/refresh/hubspot?mode=full`.

### Google Search Console

Reuses the same `GOOGLE_CREDENTIALS_JSON` service account already in use for GA4. Only a permission grant is needed.

1. Find the service-account email inside `GOOGLE_CREDENTIALS_JSON` — it ends in `.iam.gserviceaccount.com`.
2. Go to https://search.google.com/search-console/users, select the property that matches `GSC_SITE_URL`, and add the service-account email as a User (Restricted is fine).
3. POST to `/api/refresh/gsc?mode=full` (or restart the server).

### Known limitations

- **Google Ads only:** multi-platform paid spend (Meta, LinkedIn, Bing) is not covered yet. Each would need its own fetcher or require HubSpot Marketing Hub with ads accounts connected.
- **Currency:** Google Ads returns cost in the account's native currency. `fmtMoney` displays as `$`; if the account is not USD, the symbol is misleading.
- **GSC lag:** Search Console data is 2–3 days behind real time. The SEO tab's latest points will reflect this.
- **Attribution granularity:** GA4 channel assignment (last-touch) and HubSpot `hs_analytics_source` (first-touch) can disagree. Each KPI is labelled by its source so readers don't conflate them.

---

## Understanding the Lead-Lag Analysis

The dashboard automatically runs Pearson correlation at each lag from 0 to 45 days and finds the peak. Example interpretation:

> "Organic clicks leads Quotes by 14 days (r=0.61)"

This means: when organic clicks spike today, expect quotes to spike 14 days later, with moderate-to-strong correlation. Use this to set expectations after ad campaigns or SEO wins.

The mini bar charts in the lead-lag panel show correlation strength at each lag value — orange = peak lag, green = strong correlation, dark = weak.
