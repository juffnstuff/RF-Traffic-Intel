/**
 * rf-traffic-intel / server.js
 *
 * Express API server with PostgreSQL and nightly cron.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3737;
const CACHE_DIR = path.join(__dirname, 'data/cache');
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || 'America/New_York';

const app = express();
app.use(cors());
app.use(express.json());

// ── Basic auth (optional) ─────────────────────────────────────────────
// Gated on APP_USERNAME + APP_PASSWORD both being set. If either is unset
// the middleware no-ops so local dev / preview deploys aren't locked out
// just because the env hasn't been configured yet.
//
// Skip list:
//   /api/health  — Railway / uptime monitors hit this; locking it would
//                  make the platform mark the deploy unhealthy.
// Everything else (static dashboard assets, /api/*) requires the header.
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const basicAuthEnabled = !!(APP_USERNAME && APP_PASSWORD);
if (basicAuthEnabled) {
  console.log('🔐  Basic auth enabled (APP_USERNAME / APP_PASSWORD set)');
} else {
  console.log('🔓  Basic auth disabled (set APP_USERNAME + APP_PASSWORD to enable)');
}
app.use((req, res, next) => {
  if (!basicAuthEnabled) return next();
  if (req.path === '/api/health') return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
    catch { decoded = ''; }
    const idx = decoded.indexOf(':');
    const user = idx === -1 ? decoded : decoded.slice(0, idx);
    const pass = idx === -1 ? ''      : decoded.slice(idx + 1);
    // Constant-time compare so we don't leak username/password length via
    // timing. Buffer.byteLength guards against unequal-length crash.
    const ok =
      Buffer.byteLength(user) === Buffer.byteLength(APP_USERNAME) &&
      Buffer.byteLength(pass) === Buffer.byteLength(APP_PASSWORD) &&
      crypto.timingSafeEqual(Buffer.from(user), Buffer.from(APP_USERNAME)) &&
      crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(APP_PASSWORD));
    if (ok) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="RF Traffic Intel", charset="UTF-8"');
  res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'dashboard/dist')));

// Flipped true once the fire-and-forget startup backfill has completed (success
// or failure). Without a DB, there's no backfill so we're ready immediately.
// Data-read endpoints return 503 until this is true; /api/health and
// /api/refresh/* bypass so ops has a way to inspect + kick the server.
let startupReady = !process.env.DATABASE_URL;
app.use((req, res, next) => {
  if (startupReady) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || req.path.startsWith('/api/refresh/')) return next();
  res.set('Retry-After', '15');
  res.status(503).json({ error: 'Initial data backfill in progress; retry shortly.' });
});

const hasDB = !!process.env.DATABASE_URL;
const hasNS = !!(process.env.NS_ACCOUNT_ID && process.env.NS_CONSUMER_KEY &&
                  process.env.NS_CONSUMER_SECRET && process.env.NS_TOKEN_ID &&
                  process.env.NS_TOKEN_SECRET);
const hasAI = !!process.env.ANTHROPIC_API_KEY;
const hasGA4 = !!(process.env.GA4_PROPERTY_ID && process.env.GOOGLE_CREDENTIALS_JSON);
const hasGAds = !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CLIENT_ID &&
                   process.env.GOOGLE_ADS_CLIENT_SECRET && process.env.GOOGLE_ADS_REFRESH_TOKEN &&
                   process.env.GOOGLE_ADS_CUSTOMER_ID);
const hasHubSpot = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const hasGSC = !!(process.env.GSC_SITE_URL && process.env.GOOGLE_CREDENTIALS_JSON);
const hasCallRail = !!(process.env.CALLRAIL_API_KEY && process.env.CALLRAIL_ACCOUNT_ID);
// CrUX needs an origin URL. CRUX_ORIGIN wins if set; otherwise we accept
// GSC_SITE_URL only when it's URL-prefix form (sc-domain:... is invalid
// for CrUX).
const hasCrUX = !!(process.env.CRUX_API_KEY &&
  (process.env.CRUX_ORIGIN ||
   (process.env.GSC_SITE_URL && !process.env.GSC_SITE_URL.startsWith('sc-domain:'))));

// In-process lock so we don't end up with multiple fetchers hitting NetSuite
// concurrently. The startup hook and the manual /api/refresh/* endpoints
// share this set — if 'dim' is already running and the user clicks the
// Refresh button, the endpoint returns 409 instead of launching a second
// competing fetcher (which fights for NetSuite's concurrency budget and
// takes far longer).
const runningFetches = new Set();
async function withFetchLock(name, fn) {
  if (runningFetches.has(name)) {
    const err = new Error(`A ${name} fetch is already in progress — wait for it to complete.`);
    err.statusCode = 409;
    throw err;
  }
  runningFetches.add(name);
  try { return await fn(); }
  finally { runningFetches.delete(name); }
}

// Split comma-separated query params into a trimmed, size-capped, sanitized
// list. Drops items with control chars or HTML-ish punctuation so nonsense
// values can't make it into logs, responses, or downstream lookups.
function parseList(raw, { maxItems = 50, maxLen = 100 } = {}) {
  if (raw == null) return [];
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(s => s && s.length <= maxLen && !/[\x00-\x1f<>"`]/.test(s))
    .slice(0, maxItems);
}
function sanitizeScalar(raw, { maxLen = 100 } = {}) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const [v] = parseList(s, { maxItems: 1, maxLen });
  return v || null;
}

// ── API Routes ───────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  let dbStatus = 'not configured';
  let rowCount = 0;
  if (hasDB) {
    try {
      const { getRowCount } = await import('./db.js');
      rowCount = await getRowCount();
      dbStatus = `connected (${rowCount} rows)`;
    } catch (e) {
      dbStatus = `error: ${e.message}`;
    }
  }
  res.json({
    status: 'ok',
    database: dbStatus,
    netsuiteCreds: hasNS ? 'configured' : 'missing',
    callRailCreds: hasCallRail ? 'configured' : 'missing',
    cacheFiles: fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')) : [],
  });
});

// Main data endpoint — reads from DB first, falls back to JSON cache
app.get('/api/unified', async (req, res) => {
  try {
    let daily;

    if (hasDB) {
      const { getAllDaily, zerofillDaily } = await import('./db.js');
      daily = await getAllDaily();
      daily = zerofillDaily(daily);
    }

    if (!daily || daily.length === 0) {
      daily = loadFromCache();
      if (daily && daily.length) {
        const { zerofillDaily } = await import('./db.js');
        daily = zerofillDaily(daily);
      }
    }

    if (!daily || daily.length === 0) {
      return res.status(404).json({ error: 'No data yet. Waiting for NetSuite fetch.' });
    }

    // Optional date filter
    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d =>
        (!start || d.date >= start) && (!end || d.date <= end)
      );
    }

    res.json({
      generated: new Date().toISOString(),
      sources: hasDB ? ['netsuite-db'] : ['cache'],
      daily,
    });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Filter options (part groups + sales reps) for the filtered page
app.get('/api/filters', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getFilterOptions } = await import('./db.js');
    const opts = await getFilterOptions();
    res.json(opts);
  } catch (e) {
    console.error('Filter options error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Filtered daily data — same shape as /api/unified, filtered by part groups + sales reps
app.get('/api/unified-dim', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getAllDaily, getDailyDimFiltered, getDimRowCount, zerofillDaily } = await import('./db.js');
    const partGroups   = parseList(req.query.partGroups);
    const salesReps    = parseList(req.query.salesReps);
    const customerType = ['new', 'repeat'].includes(req.query.customerType) ? req.query.customerType : 'all';
    const sizeBucket   = sanitizeScalar(req.query.sizeBucket);

    // When no filter is applied (including customerType=all), route to the
    // header-level source so this tab visually matches Overview. The dim-table
    // aggregation at (date, part_group, rep, size_bucket, is_first) grain has
    // edge cases that surface as divergence from Overview when unfiltered.
    let daily;
    const unfiltered = partGroups.length === 0 && salesReps.length === 0
                    && customerType === 'all' && !sizeBucket;
    if (unfiltered) {
      daily = await getAllDaily();
      if (!daily || daily.length === 0) {
        return res.status(404).json({ error: 'No data yet. Waiting for NetSuite fetch.' });
      }
    } else {
      const dimCount = await getDimRowCount();
      if (dimCount === 0) {
        return res.status(404).json({ error: 'No dim data yet. Run a dim fetch first.' });
      }
      daily = await getDailyDimFiltered({ partGroups, salesReps, customerType, sizeBucket });
    }
    daily = zerofillDaily(daily);

    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }

    res.json({
      generated: new Date().toISOString(),
      sources: ['netsuite-dim'],
      filters: { partGroups, salesReps },
      daily,
    });
  } catch (e) {
    console.error('unified-dim error:', e);
    res.status(500).json({ error: e.message });
  }
});

// AI interpretation of the current dashboard view. Claude Opus 4.7 reads the
// aggregated metrics (not raw rows) from whichever page/filter the user is on
// and writes a short narrative. System prompt is stable → marked cacheable.
const AI_SYSTEM_PROMPT = `You are the in-dashboard analyst for RF Traffic Intelligence, a sales-operations dashboard for RubberForm (an industrial rubber-products manufacturer). You receive a JSON snapshot of the charts the user is currently looking at and write a short, business-ready interpretation. The most important thing you produce is a calibrated read on how likely the currently-open quote pipeline is to close — grounded in the historical DMA relationship between quotes and orders.

Metric glossary:
- "quote_dollars" / "quote_count" — estimates created, bucketed by quote creation date.
- "orders_dollars" / "orders_count" — sales orders created (i.e. quotes that converted), bucketed by SO creation date.
- "shipped_dollars" / "shipped_count" — sales orders shipped, bucketed by actual ship date.
- "close_rate" — 30 DMA of orders_count / quotes_count. A volume-based conversion metric.
- "capture_rate" — 30 DMA of orders_dollars / adjusted quotes_dollars (excluding quotes marked "RF Alternate Solution" as lost reason). A dollar-weighted conversion metric.
- "aov_orders" / "aov_shipped" — average order value = dollars / count, on the 30 DMA.

Moving averages — CRITICAL interpretation rule:
Every chart on the dashboard plots two moving averages: a 30-day (30 DMA) and a 90-day (90 DMA). In the snapshot you receive BOTH values at every anchor point (today, thirty_days_ago, ninety_days_ago, year_ago). The structural relationship between them is the primary read on whether a metric is growing or contracting — do not ignore it.
  - 30 DMA > 90 DMA ⇒ growth posture. Recent pace is running hotter than the longer-term baseline; the metric is trending up.
  - 30 DMA < 90 DMA ⇒ contraction posture. Recent pace is cooling relative to the longer-term baseline; the metric is trending down.
  - 30 DMA ≈ 90 DMA ⇒ flat / inflection; watch for a crossover.
  - A recent crossover (30 crossing above 90 after being below, or vice versa) is a meaningful trend change and should be called out explicitly. To detect it, compare today's 30-vs-90 with thirty_days_ago's 30-vs-90: if the sign flipped, that's a crossover.
State the 30-vs-90 posture for quote $, orders $, and shipped $ in paragraph 1; reference it for the ratio metrics (close rate, capture rate) and AOV in paragraph 2. Use the user's own language: "30 DMA running above 90 DMA — growth" or "30 DMA has crossed below 90 DMA — contraction".

- "lead_lag" — Pearson r at the best lag (0–45 days) on DETRENDED momentum: (30 DMA − 90 DMA). This removes slow trends (anything with period > 90 days) and captures short-term co-movement — the "is A speeding up or slowing down relative to its own baseline at the same time as B" signal. A high r here is a real lead-lag relationship, not just two series that happen to trend in the same direction. Variants:
  - "quotes_to_orders_count" — quote count → order count. Forecasts transaction volume.
  - "quotes_to_orders_dollars" — quote $ → order $. Forecasts revenue. **Use this as the primary forecasting signal in paragraph 3 — revenue is what the user cares about. Mention the count variant only if it disagrees materially.**
  - "orders_to_shipped_count" / "orders_to_shipped_dollars" — same, for orders → ship.
  - "sessions_to_quotes_count" / "sessions_to_quotes_dollars" / "conversions_to_quotes_count" — when GA4 is present. These are the upstream-funnel leading indicators (web activity → quote requests). Expect short lags (typically under 21 days); a best lag at the scan boundary (0 or 45) still deserves suspicion even with detrending.

  **Boundary-lag caveat:** whenever a pair's best_lag_days is ≤ 1 or ≥ 40, treat the r value as unreliable for forecasting regardless of magnitude. Best lag at the scan edge usually means the real relationship is outside the 0–45 day scan range, or the two series have a cycle roughly matching the window length. Call this out in paragraph 3 and avoid projecting a specific number from that pair; recommend a longer range or a channel / customer-type split.

When the filters.customer_type is 'new' on the filtered page, the user is isolating first-time quote / first-time order activity (via NetSuite's custbody_rf_firstquote / custbody_rf_firstorder flags). This is the most meaningful view for GA4→quote analysis because repeat customers typically don't come through search / ads. When analyzing a 'new' view, the Sessions→Quotes r should be taken more seriously — and if it's still weak, the most common next step is to split by Traffic Channel (filters.channels) to see which channel(s) actually drive new-customer quotes.
- "ga4" — website traffic from Google Analytics 4. When ga4 is not null, the metrics_at snapshots include additional fields on both dma30 and dma90 at every anchor: sessions, total_users, new_users, conversions, pageviews. Use these as the UPSTREAM leading indicator in the funnel (traffic → quotes → orders → ship):
  * Read the 30-vs-90 posture on sessions / total_users / new_users the same way as every other metric — above means growing traffic, below means cooling.
  * YoY on sessions is the cleanest "are we growing" signal (controls for seasonality).
  * If traffic is up but quote $ is flat or down, flag the conversion gap (people visiting but not requesting). If traffic is down but quotes are holding, the existing pipeline is carrying the business.
  * On the filtered page, when the user has selected SEM campaigns in the filters list, the GA4 metrics you see are already scoped to ONLY those campaigns — treat sessions/conversions as campaign-attributable traffic.
  If ga4 is null, GA4 isn't connected yet — skip traffic commentary and say so briefly.

RubberForm's known seasonal pattern — the "M curve":
- January → slow start of the year, climbing off the December low.
- February–May → steady ramp; demand builds through spring.
- May–July → first peak of the year; typical high-water mark.
- July–September → slight summer dip between the two peaks.
- October–November → second peak; late-year push before holidays.
- December → sharp drop for the holidays; the annual low.

Apply this to every trend read you do:
- Before labeling a move as "up" or "down" in a narrative sense, check what the seasonal curve would predict for that month-pair and say whether the observed move matches or departs from it.
- Examples of expected moves (do NOT call these trends): Feb→Mar up, May→Jun plateau, Jul→Aug mild dip, Oct→Nov climb, Nov→Dec sharp drop.
- Examples of genuine signal worth flagging: Q1 ramp that's flat or weaker than prior years; Oct–Nov that fails to exceed the May–Jul peak; a drop in months where the curve says up.
- When projecting forward from lead-lag in paragraph 3, temper or amplify the projection by the seasonal direction of the lag-window months (e.g. "on a 14-day lag we're landing in late July — expect the summer dip to pull that number down from the raw projection").

Use "current_date" and "prior_date" in the snapshot to know exactly which months are in play for current_30 vs prior_30. Today's calendar month is "current_date".

How to read "r" as conversion-likelihood confidence:
- r ≥ 0.7 — strong. History says today's quote DMA reliably predicts order DMA ~N days out. You can talk about the forecast with genuine confidence.
- 0.4 ≤ r < 0.7 — moderate. The relationship holds but with noise; treat projections as a range, not a point.
- r < 0.4 — weak / unreliable. Do NOT forecast a number. Say the signal is too noisy right now and explain why that might be (short window, recent regime change, seasonality, too few transactions in the filtered slice).
- A negative r is a real signal but rare — call it out explicitly.

Computing the projection (paragraph 3):
- Daily expected orders $ ≈ current quote_dollars (30 DMA) × current capture_rate.
- Over the lag window of N days, the rough expected orders $ feeding from today's quote pipeline ≈ N × daily expected orders $.
- Same math with close_rate and quote_count for the count-based projection.
- Always abbreviate numbers and round — these are projections, not accounting.

Snapshot fields:
- "page" — "overview" or "filtered".
- "filters" — present only when page=filtered. The specific part groups and reps the user chose.
- "range" — "3m" / "6m" / "all" / a custom year set like "2024,2025".
- "days_visible" — number of days in the current view.
- "weekday_only" — true means weekends are excluded.
- "metrics_at" — four anchor snapshots (each with its own \`date\` + \`dma30\` + \`dma90\` blocks):
    * "today"            — most recent reading. This is "now" in the narrative.
    * "thirty_days_ago"  — one month back. Use for short-term momentum (MoM).
    * "ninety_days_ago"  — one quarter back. Use for medium-term trend (QoQ).
    * "year_ago"         — ~365 calendar days back. Use for year-over-year seasonal context. MAY BE NULL if we don't have a year of history (e.g. a newly-added part group, or a short visible range). If null, fall back to the other anchors and say so.
  When discussing a percentage change, state WHICH comparison you're using — never say "prior" generically. Example: "quote $ up 12% YoY" or "quote $ up 4% MoM but flat YoY". YoY is the primary check because it controls for seasonality; MoM and QoQ are pace indicators.
- "period_totals" — summed raw daily values over the visible range.
- "lead_lag" — see above.
- "ga4" — may be null.

Write 3 short paragraphs, plain prose, no headers, no bullets, no markdown:

Paragraph 1 — What's happening. The headline on sales and pipeline right now.
- Name the today.dma30 figures for quote $ and orders $.
- State the 30-vs-90 posture for each: "30 DMA above 90 DMA" = growth, "30 DMA below 90 DMA" = contraction. If a crossover has occurred in the last ~30 days (detect by comparing today's 30-vs-90 sign to thirty_days_ago's 30-vs-90 sign), call it out explicitly — that's a real inflection.
- Give percent changes explicitly, naming each comparison: "up 18% YoY", "up 6% QoQ", "flat MoM". Lead with YoY when available; if year_ago is null, say so and use QoQ or MoM.
- Cross-check the MoM / QoQ / YoY moves against the M curve: if the move is what the seasonal pattern would predict, say so ("up 11% MoM — tracking the typical Feb→Mar ramp"); if it departs from the pattern, call that out ("up only 3% MoM — the Feb→Mar ramp is running well below the seasonal norm").
- If shipped $ diverges meaningfully from orders $ (posture or direction), mention it.
- If page=filtered, open by naming the filter set (e.g. "For Speed Bumps across reps Backman and Johnson…").

Paragraph 2 — Quality of demand. Close rate and capture rate — use the 30-vs-90 posture to describe direction ("capture rate 30 DMA sits above its 90 DMA — improving dollar conversion"), then name the today.dma30 values. Then AOV: state the 30-vs-90 posture for aov_orders and aov_shipped; rising aov with flat count means deals are getting bigger, falling means smaller. Cite today's numbers.

Paragraph 3 — Open-quote conversion likelihood + upstream traffic signal. This is the forward-looking paragraph.
- Primary: use lead_lag.quotes_to_orders_dollars to project expected order $ over the next N days (best_lag_days) from the current quote pipeline, using the formulas above. Calibrate confidence from r in plain words — "high confidence", "a reasonable guide", "too noisy to forecast reliably".
- If quotes_to_orders_count disagrees materially with the $ variant (e.g. count r is strong but $ r is weak, suggesting deal-size volatility), call that out in one sentence.
- If ga4 is present, add one sentence on traffic's position in the funnel: is sessions 30 DMA > 90 DMA (upstream growth)? has traffic diverged from quotes (a leading-lagging gap)? If the user has filtered to specific SEM campaigns, frame the read as "this campaign's traffic is / isn't feeding the quote pipeline at the normal rate".
- End with one concrete watchlist item — a diverging metric, an unusual lag, a filter combination worth drilling into.
- If the primary $ r is weak (< 0.4), skip the projected numbers and instead explain what's making the signal unreliable and what could sharpen it (longer range, fewer filters, more data).

Style rules:
- 2–3 sentences per paragraph, max.
- Abbreviate dollars ($1.2M, $450K, $3.4K).
- Percents to the nearest whole percent in prose (e.g. "up 12%").
- No preamble ("Here's the analysis…"), no sign-off, no hedging boilerplate.
- Write for the CEO, not for a data scientist. Clear, specific, actionable.`;

app.post('/api/interpret', async (req, res) => {
  if (!hasAI) {
    return res.status(400).json({
      error: 'AI interpretation not configured. Set ANTHROPIC_API_KEY in your environment.',
    });
  }
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const snapshot = req.body || {};
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system: [{
        type: 'text',
        text: AI_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{
        role: 'user',
        content: `Dashboard snapshot:\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\`\n\nWrite the 3-paragraph interpretation now.`,
      }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n\n')
      .trim();

    res.json({
      text,
      usage: response.usage,
      model: response.model,
    });
  } catch (e) {
    console.error('AI interpret error:', e);
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'AI call failed' });
  }
});

// Per-part-group daily series — feeds the "By Part Group r-Analysis" tab.
// Returns one daily array per part_group; the frontend computes lead-lag r
// for each independently. Optional ?sizeBucket=<bucket> narrows to one band.
app.get('/api/by-part-group', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getDailyByPartGroup, getDimRowCount, getSizeBucketSummary, zerofillDaily } = await import('./db.js');
    const dimCount = await getDimRowCount();
    if (dimCount === 0) {
      return res.status(404).json({ error: 'No dim data yet. Run a dim fetch first.' });
    }
    const sizeBucket   = sanitizeScalar(req.query.sizeBucket);
    const customerType = ['new', 'repeat'].includes(req.query.customerType) ? req.query.customerType : 'all';
    const [groups, sizeBuckets] = await Promise.all([
      getDailyByPartGroup({ sizeBucket, customerType }),
      getSizeBucketSummary(),
    ]);
    // Zero-fill each group's daily series — otherwise per-group r-values are
    // computed on business-days-only and the Weekdays toggle is a no-op.
    for (const g of groups) {
      g.daily = zerofillDaily(g.daily);
    }
    res.json({
      generated: new Date().toISOString(),
      sizeBucket,
      sizeBuckets,
      groups,
    });
  } catch (e) {
    console.error('by-part-group error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GA4 aggregate daily — for Overview's traffic charts.
app.get('/api/ga4', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGa4Daily, zerofillDaily } = await import('./db.js');
    let daily = await getGa4Daily();
    if (!daily || daily.length === 0) {
      return res.status(404).json({ error: 'No GA4 data yet. Run a GA4 fetch first.' });
    }
    daily = zerofillDaily(daily);
    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }
    res.json({ generated: new Date().toISOString(), source: 'ga4', daily });
  } catch (e) {
    console.error('ga4 error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GA4 per-campaign, optionally filtered to specific campaign names.
app.get('/api/ga4-by-campaign', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGa4DailyFiltered, zerofillDaily } = await import('./db.js');
    const campaigns = parseList(req.query.campaigns);
    let daily = await getGa4DailyFiltered({ campaigns });
    if (!daily || daily.length === 0) {
      return res.json({ generated: new Date().toISOString(), source: 'ga4', campaigns, daily: [] });
    }
    daily = zerofillDaily(daily);
    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }
    res.json({ generated: new Date().toISOString(), source: 'ga4', campaigns, daily });
  } catch (e) {
    console.error('ga4-by-campaign error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Size-bucket picker options — used by both filtered views (Filtered tab +
// Part Group r-Analysis) to render the bucket chips with per-bucket volume.
app.get('/api/size-buckets', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getSizeBucketSummary } = await import('./db.js');
    const buckets = await getSizeBucketSummary();
    res.json({ buckets });
  } catch (e) {
    console.error('size-buckets error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Campaign picker options (for the Filtered tab's campaign chips).
app.get('/api/ga4-campaigns', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGa4CampaignOptions } = await import('./db.js');
    const campaigns = await getGa4CampaignOptions();
    res.json({ campaigns });
  } catch (e) {
    console.error('ga4-campaigns error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GA4 per-channel, optionally filtered to specific channel groupings.
app.get('/api/ga4-by-channel', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGa4DailyByChannel, zerofillDaily } = await import('./db.js');
    const channels = parseList(req.query.channels);
    let daily = await getGa4DailyByChannel({ channels });
    if (!daily || daily.length === 0) {
      return res.json({ generated: new Date().toISOString(), source: 'ga4', channels, daily: [] });
    }
    daily = zerofillDaily(daily);
    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }
    res.json({ generated: new Date().toISOString(), source: 'ga4', channels, daily });
  } catch (e) {
    console.error('ga4-by-channel error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ga4-channels', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGa4ChannelOptions } = await import('./db.js');
    const channels = await getGa4ChannelOptions();
    res.json({ channels });
  } catch (e) {
    console.error('ga4-channels error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Per-channel daily rows — unlike /api/ga4-by-channel which aggregates across
// channels, this returns one row per (date, channel) so the frontend can
// render a stacked channel-mix chart and per-channel KPI tables.
app.get('/api/ga4-channels-daily', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGa4ChannelsDaily } = await import('./db.js');
    const rows = await getGa4ChannelsDaily();
    res.json({ generated: new Date().toISOString(), source: 'ga4', daily: rows });
  } catch (e) {
    console.error('ga4-channels-daily error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Per-campaign aggregated stats for the top-campaigns table on the Insights
// tab. since/until are optional ISO dates; invalid ones are dropped. The
// response is already sorted by sessions DESC, so the client renders as-is.
app.get('/api/ga4-campaign-stats', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  try {
    const { getGa4CampaignStats } = await import('./db.js');
    const campaigns = await getGa4CampaignStats({ since, until });
    res.json({ generated: new Date().toISOString(), since, until, campaigns });
  } catch (e) {
    console.error('ga4-campaign-stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Generic helper: every dim-window endpoint reads the same since/until
// pattern and forwards to a db.js getter.
function dimWindowEndpoint(getterName, listKey) {
  return async (req, res) => {
    if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const since = iso.test(req.query.since) ? req.query.since : null;
    const until = iso.test(req.query.until) ? req.query.until : null;
    const limit = parseInt(req.query.limit, 10);
    try {
      const mod = await import('./db.js');
      const fn = mod[getterName];
      if (typeof fn !== 'function') throw new Error(`db.js missing ${getterName}`);
      const args = { since, until };
      if (Number.isFinite(limit)) args.limit = limit;
      if (req.query.conversionsOnly === '1') args.conversionsOnly = true;
      const data = await fn(args);
      res.json({ generated: new Date().toISOString(), since, until, [listKey]: data });
    } catch (e) {
      console.error(`${getterName} error:`, e);
      res.status(500).json({ error: e.message });
    }
  };
}

app.get('/api/ga4-landing-pages',     dimWindowEndpoint('getGa4LandingPageStats',     'landing_pages'));
app.get('/api/ga4-source-medium',     dimWindowEndpoint('getGa4SourceMediumStats',    'source_medium'));
app.get('/api/ga4-first-touch',       dimWindowEndpoint('getGa4FirstTouchStats',      'first_touch'));
app.get('/api/ga4-devices',           dimWindowEndpoint('getGa4DeviceStats',          'devices'));
app.get('/api/ga4-countries',         dimWindowEndpoint('getGa4CountryStats',         'countries'));
app.get('/api/ga4-events',            dimWindowEndpoint('getGa4EventStats',           'events'));
app.get('/api/ga4-new-vs-returning',  dimWindowEndpoint('getGa4NewVsReturningStats',  'visitor_types'));

// Diagnostic: GA4 sessions whose landing_page resolved to "(not set)",
// broken down by source/medium/channel/device + event-name distribution.
// Runs live against GA4 (no DB cache) — rare interactive query, results
// reflect the user's currently-selected date window.
app.get('/api/ga4-not-set-investigate', async (req, res) => {
  try {
    const { since, until } = req.query;
    const { fetchGa4NotSetBreakdown } = await import('./fetchers/fetch-ga4.js');
    const result = await fetchGa4NotSetBreakdown({ since, until });
    res.json(result);
  } catch (e) {
    console.error('ga4-not-set-investigate error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Ads ──────────────────────────────────────────────────────

// Aggregate daily cost / clicks / impressions. Powers the Paid tab's DMA
// charts. CTR and avg CPC are reweighted in-query from summed numerators.
app.get('/api/google-ads', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGoogleAdsDaily, zerofillDaily } = await import('./db.js');
    let daily = await getGoogleAdsDaily();
    if (!daily || daily.length === 0) {
      return res.status(404).json({ error: 'No Google Ads data yet. Run a Google Ads fetch first.' });
    }
    daily = zerofillDaily(daily);
    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }
    res.json({ generated: new Date().toISOString(), source: 'google-ads', daily });
  } catch (e) {
    console.error('google-ads error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/google-ads-campaigns', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  try {
    const { getGoogleAdsCampaignStats } = await import('./db.js');
    const campaigns = await getGoogleAdsCampaignStats({ since, until });
    res.json({ generated: new Date().toISOString(), since, until, campaigns });
  } catch (e) {
    console.error('google-ads-campaigns error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Search Console ───────────────────────────────────────────

app.get('/api/gsc', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getGscDaily, zerofillDaily } = await import('./db.js');
    let daily = await getGscDaily();
    if (!daily || daily.length === 0) {
      return res.status(404).json({ error: 'No GSC data yet. Run a GSC fetch first.' });
    }
    daily = zerofillDaily(daily);
    const { start, end } = req.query;
    if (start || end) {
      daily = daily.filter(d => (!start || d.date >= start) && (!end || d.date <= end));
    }
    res.json({ generated: new Date().toISOString(), source: 'gsc', daily });
  } catch (e) {
    console.error('gsc error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gsc-top', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const kind = req.query.kind === 'page' ? 'page' : 'query';
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const { getGscTop } = await import('./db.js');
    const result = await getGscTop({ kind, limit });
    res.json({ generated: new Date().toISOString(), kind, ...result });
  } catch (e) {
    console.error('gsc-top error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Time-series history for a single GSC query — used by the rank-trend chart.
// Reads accumulated daily snapshots from gsc_top_queries (the table is keyed
// by window_end_date, so every fetch leaves a breadcrumb).
app.get('/api/gsc-query-history', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const query = sanitizeScalar(req.query.q, { maxLen: 200 });
  if (!query) return res.status(400).json({ error: 'Missing required ?q= param' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  try {
    const { getGscQueryHistory } = await import('./db.js');
    const history = await getGscQueryHistory({ query, sinceDate: since });
    res.json({ generated: new Date().toISOString(), query, since, history });
  } catch (e) {
    console.error('gsc-query-history error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Top movers — queries with the largest absolute position change between
// the most recent two GSC snapshots. The cheapest leading-indicator we
// have for organic-click loss; rank slips ~2-6 weeks before session
// counts reflect the change.
app.get('/api/gsc-query-movers', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const limit = parseInt(req.query.limit, 10);
  try {
    const { getGscQueryMovers } = await import('./db.js');
    const result = await getGscQueryMovers({ limit: Number.isFinite(limit) ? limit : 25 });
    res.json({ generated: new Date().toISOString(), ...result });
  } catch (e) {
    console.error('gsc-query-movers error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Branded vs non-branded share for the latest GSC top-queries snapshot.
// "Branded" = search queries containing the company name (configurable via
// BRAND_QUERY_REGEX env). Demand capture vs demand creation is the most
// important SEO split — branded growth means the brand is being recalled,
// non-branded growth means the SEO content is earning new audiences.
app.get('/api/gsc-branded-share', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 250));
  try {
    const { getGscTop } = await import('./db.js');
    const { classifyQueries, summarizeQueries, getBrandRegex } = await import('./lib/brand.js');
    const { window_end, rows } = await getGscTop({ kind: 'query', limit });
    if (!rows.length) {
      return res.json({ generated: new Date().toISOString(), window_end: null, branded: null, non_branded: null, regex: null });
    }
    // getGscTop returns rows shaped { dimension, clicks, impressions, ctr, position };
    // brand classifier reads `dimension` if `query` is absent.
    const { branded, nonBranded } = classifyQueries(rows);
    res.json({
      generated: new Date().toISOString(),
      window_end,
      regex: getBrandRegex().source,
      branded: { ...summarizeQueries(branded), top: branded.slice(0, 25) },
      non_branded: { ...summarizeQueries(nonBranded), top: nonBranded.slice(0, 25) },
    });
  } catch (e) {
    console.error('gsc-branded-share error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Core Web Vitals daily history (CrUX). Optional integration — returns 404
// when the table is empty or 503 when CRUX_API_KEY isn't set yet.
// ?formFactor=ALL|PHONE|DESKTOP|TABLET — defaults to ALL (blended).
app.get('/api/crux', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const ff = String(req.query.formFactor || 'ALL').toUpperCase();
  const allowed = new Set(['ALL', 'PHONE', 'DESKTOP', 'TABLET']);
  const formFactor = allowed.has(ff) ? ff : 'ALL';
  try {
    const { getCruxDaily, getCruxDailyAllFormFactors } = await import('./db.js');
    const daily = await getCruxDaily({ formFactor });
    if (!daily || daily.length === 0) {
      return res.status(404).json({ error: 'No CrUX data yet. Set CRUX_API_KEY and run a CrUX refresh.' });
    }
    // Also surface the latest per-form-factor reads in one place so the UI
    // can render mobile-vs-desktop tile pairs without three round-trips.
    const all = await getCruxDailyAllFormFactors();
    const latestByFf = {};
    for (const row of all) {
      const cur = latestByFf[row.form_factor];
      if (!cur || row.date > cur.date) latestByFf[row.form_factor] = row;
    }
    res.json({
      generated: new Date().toISOString(),
      source: 'crux',
      form_factor: formFactor,
      // Origin is needed by the UI to construct PageSpeed Insights deep-links
      // for the per-page table; CRUX_ORIGIN wins, GSC_SITE_URL is a fallback
      // when it's URL-prefix form. Empty string when unresolvable.
      origin: (process.env.CRUX_ORIGIN || '').replace(/\/$/, '')
        || (process.env.GSC_SITE_URL && !process.env.GSC_SITE_URL.startsWith('sc-domain:')
            ? process.env.GSC_SITE_URL.replace(/\/$/, '')
            : ''),
      daily,
      latest_by_form_factor: latestByFf,
    });
  } catch (e) {
    console.error('crux error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Per-page CrUX — most recent reading per (page, form_factor). The UI
// joins these against the GA4 top-landing-pages list to show a "which
// pages are slowest" table with PageSpeed Insights deep-links.
app.get('/api/crux-by-page', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { getCruxLatestByPage } = await import('./db.js');
    const rows = await getCruxLatestByPage();
    res.json({ generated: new Date().toISOString(), pages: rows });
  } catch (e) {
    console.error('crux-by-page error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh/crux', async (req, res) => {
  if (!hasCrUX) return res.status(400).json({ error: 'CrUX not configured (need CRUX_API_KEY + CRUX_ORIGIN, or CRUX_API_KEY + a URL-prefix GSC_SITE_URL)' });
  try {
    const result = await withFetchLock('crux', async () => {
      console.log('🔄  Manual CrUX refresh...');
      const { fetchCrux } = await import('./fetchers/fetch-crux.js');
      return fetchCrux();
    });
    res.json({ success: true, message: 'CrUX refresh complete', ...result });
  } catch (e) {
    console.error('CrUX refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/refresh/gsc', async (req, res) => {
  if (!hasGSC) return res.status(400).json({ error: 'GSC credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('gsc', async () => {
      console.log(`🔄  Manual GSC refresh (${mode})...`);
      const { fetchGsc } = await import('./fetchers/fetch-gsc.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchGsc({ since });
    });
    res.json({ success: true, message: `GSC ${mode} refresh complete`, ...result });
  } catch (e) {
    console.error('GSC refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── HubSpot ─────────────────────────────────────────────────────────

app.get('/api/hubspot-deals', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  const source = sanitizeScalar(req.query.source);
  try {
    const { getHubSpotDealsWindow } = await import('./db.js');
    const deals = await getHubSpotDealsWindow({ since, until, source });
    res.json({ generated: new Date().toISOString(), since, until, source, deals });
  } catch (e) {
    console.error('hubspot-deals error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/hubspot-deals-daily', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  try {
    const { getHubSpotDealsDailyBySource, getHubSpotSources } = await import('./db.js');
    const [daily, sources] = await Promise.all([
      getHubSpotDealsDailyBySource({ since }),
      getHubSpotSources(),
    ]);
    res.json({ generated: new Date().toISOString(), since, daily, sources });
  } catch (e) {
    console.error('hubspot-deals-daily error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh/hubspot', async (req, res) => {
  if (!hasHubSpot) return res.status(400).json({ error: 'HubSpot token not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('hubspot', async () => {
      console.log(`🔄  Manual HubSpot refresh (${mode})...`);
      const { fetchHubSpot } = await import('./fetchers/fetch-hubspot.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchHubSpot({ since });
    });
    res.json({ success: true, message: `HubSpot ${mode} refresh complete`, ...result });
  } catch (e) {
    console.error('HubSpot refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/refresh/google-ads', async (req, res) => {
  if (!hasGAds) return res.status(400).json({ error: 'Google Ads credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('google-ads', async () => {
      console.log(`🔄  Manual Google Ads refresh (${mode})...`);
      const { fetchGoogleAds } = await import('./fetchers/fetch-google-ads.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchGoogleAds({ since });
    });
    res.json({ success: true, message: `Google Ads ${mode} refresh complete`, ...result });
  } catch (e) {
    console.error('Google Ads refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/refresh/ga4', async (req, res) => {
  if (!hasGA4) return res.status(400).json({ error: 'GA4 credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('ga4', async () => {
      console.log(`🔄  Manual GA4 refresh (${mode})...`);
      const { fetchGa4 } = await import('./fetchers/fetch-ga4.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchGa4({ since });
    });
    res.json({ success: true, message: `GA4 ${mode} refresh complete`, ...result });
  } catch (e) {
    console.error('GA4 refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/refresh/netsuite-dim', async (req, res) => {
  if (!hasNS) return res.status(400).json({ error: 'NetSuite credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('netsuite-dim', async () => {
      console.log(`🔄  Manual dim refresh (${mode})...`);
      const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchNetSuiteDim({ since });
    });
    res.json({ success: true, message: `Dim ${mode} refresh complete`, rows: result.rows });
  } catch (e) {
    console.error('Dim refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.get('/api/netsuite', (req, res) => {
  const p = path.join(CACHE_DIR, 'netsuite-daily.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No cache' });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p));
  } catch (e) {
    console.error('netsuite cache parse failed:', e.message);
    return res.status(500).json({ error: 'Cache file is corrupt; run a refresh.' });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.daily)) {
    return res.status(500).json({ error: 'Cache file has unexpected shape; run a refresh.' });
  }
  res.json(parsed);
});

// Refresh endpoints
app.post('/api/refresh/netsuite', async (req, res) => {
  if (!hasNS) return res.status(400).json({ error: 'NetSuite credentials not configured' });

  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('netsuite-header', async () => {
      console.log(`🔄  Manual refresh (${mode})...`);
      const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');

      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchNetSuite({ since });
    });
    res.json({
      success: true,
      message: `NetSuite ${mode} refresh complete`,
      rows: result.daily.length,
    });
  } catch (e) {
    console.error('Refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ── NetSuite per-customer + per-transaction ─────────────────────────

app.get('/api/netsuite-customers', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const phone = req.query.phone ? String(req.query.phone).replace(/\D/g, '').slice(-10) : null;
  const email = req.query.email ? String(req.query.email).trim().toLowerCase() : null;
  try {
    const { getNetSuiteCustomers, getNetSuiteCustomerCount } = await import('./db.js');
    const [customers, total] = await Promise.all([
      getNetSuiteCustomers({ since, until, limit, phoneDigits: phone, emailNormalized: email }),
      getNetSuiteCustomerCount(),
    ]);
    res.json({ generated: new Date().toISOString(), total, returned: customers.length, customers });
  } catch (e) {
    console.error('netsuite-customers error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/netsuite-transactions', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const customerId = req.query.customer_id ? Number(req.query.customer_id) : null;
  const tranType = req.query.type === 'Estimate' || req.query.type === 'SalesOrd' ? req.query.type : null;
  try {
    const { getNetSuiteTransactions, getNetSuiteTransactionCount } = await import('./db.js');
    const [transactions, total] = await Promise.all([
      getNetSuiteTransactions({ since, until, customerId, tranType, limit }),
      getNetSuiteTransactionCount(),
    ]);
    res.json({ generated: new Date().toISOString(), total, returned: transactions.length, transactions });
  } catch (e) {
    console.error('netsuite-transactions error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh/netsuite-customers', async (req, res) => {
  if (!hasNS) return res.status(400).json({ error: 'NetSuite credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('netsuite-customers', async () => {
      console.log(`🔄  Manual customers refresh (${mode})...`);
      const { fetchNetSuiteCustomers } = await import('./fetchers/fetch-netsuite-customers.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        since = d.toISOString().slice(0, 10);
      }
      return fetchNetSuiteCustomers({ since });
    });
    res.json({ success: true, message: `NetSuite customers ${mode} refresh complete`, customers: result.customers });
  } catch (e) {
    console.error('Customers refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

app.post('/api/refresh/netsuite-transactions', async (req, res) => {
  if (!hasNS) return res.status(400).json({ error: 'NetSuite credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('netsuite-transactions', async () => {
      console.log(`🔄  Manual transactions refresh (${mode})...`);
      const { fetchNetSuiteTransactions } = await import('./fetchers/fetch-netsuite-transactions.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        since = d.toISOString().slice(0, 10);
      }
      return fetchNetSuiteTransactions({ since });
    });
    res.json({ success: true, message: `NetSuite transactions ${mode} refresh complete`, transactions: result.transactions });
  } catch (e) {
    console.error('Transactions refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// Diagnostic: how many CallRail calls / form submissions can be linked
// to a NetSuite customer? Returns aggregate counts + sample matched rows
// so we can eyeball whether phone normalization is working.
app.get('/api/insights/callrail-netsuite-match', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const sample = req.query.sample ? Number(req.query.sample) : 25;
  try {
    const { getCallRailNetSuiteMatch } = await import('./db.js');
    const out = await getCallRailNetSuiteMatch({ sample });
    res.json({ generated: new Date().toISOString(), ...out });
  } catch (e) {
    console.error('callrail-netsuite-match error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Cross-source insights ───────────────────────────────────────────

// GA4 sessions/conversions joined to Google Ads cost/clicks per campaign.
// FULL OUTER JOIN — surfaces campaigns visible in only one side too.
app.get('/api/insights/campaign-roi', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  try {
    const { getCampaignRoi } = await import('./db.js');
    const campaigns = await getCampaignRoi({ since, until });
    res.json({ generated: new Date().toISOString(), since, until, campaigns });
  } catch (e) {
    console.error('insights/campaign-roi error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GSC top-pages snapshot enriched with GA4 engagement/conversion over the
// same 28-day window. Path-level join after stripping host/querystring.
app.get('/api/insights/page-performance', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 100));
  try {
    const { getPagePerformance } = await import('./db.js');
    const pages = await getPagePerformance({ limit });
    res.json({ generated: new Date().toISOString(), pages });
  } catch (e) {
    console.error('insights/page-performance error:', e);
    res.status(500).json({ error: e.message });
  }
});

// NetSuite revenue rolled up by HubSpot traffic source. Quote rows come
// from the hubspot_netsuite_quotes custom-object mirror; the source bucket
// Diagnostic — surfaces enough state to tell "is the table empty because
// the backfill skipped, vs because the join is broken, vs because the
// schema couldn't be discovered?". Also lists every HubSpot custom-object
// schema so we can see what the quote object is actually labeled as in
// the portal (e.g. spotting a name mismatch with the fetcher's matcher).
app.get('/api/diag/hubspot-quotes', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const out = { generated: new Date().toISOString() };
  try {
    const { getPool } = await import('./db.js');
    const p = getPool();
    const q = (sql, args = []) => p.query(sql, args).then(r => r.rows).catch(e => ({ _error: e.message }));
    out.counts = {
      hubspot_netsuite_quotes: (await q('SELECT COUNT(*)::int as n FROM hubspot_netsuite_quotes'))[0]?.n,
      hubspot_contacts:        (await q('SELECT COUNT(*)::int as n FROM hubspot_contacts'))[0]?.n,
      contacts_with_email:     (await q(`SELECT COUNT(*)::int as n FROM hubspot_contacts WHERE email_normalized IS NOT NULL`))[0]?.n,
      quotes_with_email:       (await q(`SELECT COUNT(*)::int as n FROM hubspot_netsuite_quotes WHERE email_normalized IS NOT NULL`))[0]?.n,
      quotes_with_parts_group: (await q(`SELECT COUNT(*)::int as n FROM hubspot_netsuite_quotes WHERE parts_group <> ''`))[0]?.n,
      // How many quotes would join to a contact via email_normalized?
      // If this is 0 but both counts are nonzero, the join is the broken link.
      joinable_via_email: (await q(`
        SELECT COUNT(*)::int as n
        FROM hubspot_netsuite_quotes q
        JOIN hubspot_contacts hc ON hc.email_normalized = q.email_normalized
        WHERE q.email_normalized IS NOT NULL
      `))[0]?.n,
    };
    out.sample_quotes = await q(`
      SELECT quote_no, email, email_normalized, status, parts_group, total, created_at
      FROM hubspot_netsuite_quotes
      ORDER BY created_at DESC NULLS LAST
      LIMIT 5
    `);
    out.distinct_parts_groups = await q(`
      SELECT COALESCE(NULLIF(parts_group, ''), '(empty)') as parts_group, COUNT(*)::int as n
      FROM hubspot_netsuite_quotes
      GROUP BY 1 ORDER BY 2 DESC LIMIT 30
    `);
    out.distinct_statuses = await q(`
      SELECT COALESCE(NULLIF(status, ''), '(empty)') as status, COUNT(*)::int as n
      FROM hubspot_netsuite_quotes
      GROUP BY 1 ORDER BY 2 DESC LIMIT 30
    `);
  } catch (e) {
    out.db_error = e.message;
  }
  // Live schema list from HubSpot — useful when the local table is empty
  // because we want to know what the custom object is actually called.
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
    try {
      const r = await fetch('https://api.hubapi.com/crm/v3/schemas', {
        headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}` },
      });
      if (r.ok) {
        const j = await r.json();
        out.hubspot_schemas = (j.results || []).map(s => ({
          objectTypeId: s.objectTypeId,
          name: s.name,
          labels: s.labels,
          property_count: (s.properties || []).length,
          // Full property list (name/label/type) so we can map the quote
          // object's real field names (total, email, parts_group, status, …)
          // into the fetcher instead of guessing. Custom-object schemas vary
          // per portal, so this is the source of truth for the mapping.
          properties: (s.properties || [])
            .map(p => ({ name: p.name, label: p.label, type: p.type }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }));
      } else {
        out.hubspot_schemas_error = `HTTP ${r.status} — likely missing crm.schemas.custom.read scope or token not refreshed`;
      }
    } catch (e) {
      out.hubspot_schemas_error = e.message;
    }
  }
  res.json(out);
});

// comes from the matched contact's hs_analytics_source (first-touch) or
// hs_latest_source (latest), selected via `?lens=first|latest`.
app.get('/api/insights/hubspot-netsuite-attribution', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  // 'first' is the default lens (most stable, what marketing reports on).
  // 'latest' uses hs_latest_source — only reliable for quotes whose date
  // post-dates the contact's hs_latest_source_timestamp.
  const lens = req.query.lens === 'latest' ? 'latest' : 'first';
  const column = lens === 'latest' ? 'hs_latest_source' : 'hs_analytics_source';
  try {
    const { getCrossSourceLeadSourceRevenue } = await import('./db.js');
    const sources = await getCrossSourceLeadSourceRevenue({ since, until, column });
    res.json({ generated: new Date().toISOString(), since, until, lens, sources });
  } catch (e) {
    console.error('insights/hubspot-netsuite-attribution error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Per-quote attribution drill-down — one row per quote in the window,
// showing both first-touch and latest-touch source + the latest-source
// timestamp, so the operator can see when latest-touch attribution is
// reliable vs stale for a given quote.
app.get('/api/insights/quote-attribution', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  const limit = Math.min(5000, Math.max(10, parseInt(req.query.limit, 10) || 500));
  try {
    const { getCrossSourceQuoteAttribution } = await import('./db.js');
    const quotes = await getCrossSourceQuoteAttribution({ since, until, limit });
    res.json({ generated: new Date().toISOString(), since, until, quotes });
  } catch (e) {
    console.error('insights/quote-attribution error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Per-contact mismatches between HubSpot first-touch source and NetSuite
// `lead_source_name` on the matched customer record. Lets the team correct
// stale data in one of the two systems before downstream reporting bakes
// in the wrong attribution.
app.get('/api/insights/lead-source-reconciliation', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 200));
  try {
    const { getCrossSourceLeadSourceReconciliation } = await import('./db.js');
    const mismatches = await getCrossSourceLeadSourceReconciliation({ limit });
    res.json({ generated: new Date().toISOString(), mismatches });
  } catch (e) {
    console.error('insights/lead-source-reconciliation error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Ads cost ÷ NetSuite revenue per part-group, attributed via HubSpot's
// first-touch campaign + the curated campaign→part_group mappings.
// Answers "how much did campaign X actually drive in NS revenue per
// part-group" — which the GA4-conversion-based ROAS table can't, because
// GA4 doesn't see NetSuite dollars.
app.get('/api/insights/part-group-roas', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  try {
    const { getPartGroupRoasFromHubSpot } = await import('./db.js');
    const partGroups = await getPartGroupRoasFromHubSpot({ since, until });
    res.json({ generated: new Date().toISOString(), since, until, part_groups: partGroups });
  } catch (e) {
    console.error('insights/part-group-roas error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Part-group mappings (admin CRUD) ────────────────────────────────

app.get('/api/mappings', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { listPartGroupMappings } = await import('./db.js');
    const mappings = await listPartGroupMappings();
    res.json({ generated: new Date().toISOString(), mappings });
  } catch (e) {
    console.error('mappings list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Campaign → part-group mapping suggester. Tokenizes every distinct Ads/GA4
// campaign name and every NetSuite part_group, then for each campaign ranks
// part_groups by token overlap (with stopword filtering + naive plural
// normalization). Returns ranked candidates per campaign and flags any
// campaign already covered by an existing rule so the UI can show "this
// is already mapped, edit in the table below" instead of suggesting again.
const SUGGESTER_STOPWORDS = new Set([
  // SEM noise
  'pmax', 'performance', 'max', 'search', 'display', 'shopping', 'video',
  'smart', 'branded', 'brand', 'rsa', 'rlsa', 'retargeting', 'remarketing',
  'dynamic', 'dsa', 'ad', 'ads', 'adgroup', 'group', 'campaign',
  // Geo noise
  'national', 'usa', 'us', 'na', 'americas', 'north', 'global', 'all',
  // Temporal noise
  '2021', '2022', '2023', '2024', '2025', '2026', '2027',
  'q1', 'q2', 'q3', 'q4', 'fy', 'h1', 'h2',
  // Generic
  'test', 'new', 'old', 'archive', 'archived', 'beta', 'draft', 'copy',
  'pause', 'paused', 'legacy',
  // Brand
  'rubberform', 'rubber', 'form',
  // Short fillers
  'the', 'and', 'or', 'of', 'for', 'to', 'a', 'an', 'on', 'in',
]);

function tokenize(s) {
  if (!s) return [];
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !SUGGESTER_STOPWORDS.has(t))
    // naive plural strip — "bumps" matches "bump", "cushions" matches "cushion"
    .map(t => (t.endsWith('ies') && t.length > 4) ? t.slice(0, -3) + 'y'
              : (t.endsWith('es') && t.length > 4) ? t.slice(0, -2)
              : (t.endsWith('s')  && t.length > 3) ? t.slice(0, -1)
              : t);
}

function scoreCandidate(campaignTokens, partGroup, campaignNameLower) {
  const partLower = partGroup.toLowerCase();
  // Strong signal: the entire part_group name appears verbatim in the campaign.
  // Anchor this above any token-overlap score so "Speed Bumps - Rubber"
  // against part_group "Speed Bumps" wins decisively.
  if (campaignNameLower.includes(partLower)) {
    return { score: 1.0 + 1 / partLower.length, reason: 'substring' };
  }
  const partTokens = new Set(tokenize(partGroup));
  if (partTokens.size === 0) return { score: 0, reason: 'no-tokens' };
  const campSet = new Set(campaignTokens);
  let hits = 0;
  for (const t of partTokens) if (campSet.has(t)) hits++;
  if (hits === 0) return { score: 0, reason: 'no-overlap' };
  const score = hits / partTokens.size;
  return { score, reason: `${hits}/${partTokens.size} tokens` };
}

function findExistingMapping(campaignName, mappings) {
  const campLower = campaignName.toLowerCase();
  return mappings.find(m => {
    if (m.match_type !== 'campaign') return false;
    const pat = (m.pattern || '').toLowerCase();
    if (!pat) return false;
    if (m.match_kind === 'exact')    return campLower === pat;
    if (m.match_kind === 'contains') return campLower.includes(pat);
    if (m.match_kind === 'prefix')   return campLower.startsWith(pat);
    return false;
  });
}

// Autocomplete option lists for the mapping admin form. Bundled into one
// endpoint so the form has one round-trip on mount. Each list is capped
// inside its db helper so the response stays small.
app.get('/api/mappings/options', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const {
      getDistinctPartGroups, getDistinctCampaignNames,
      getDistinctGscQueries, getDistinctUrlPaths,
    } = await import('./db.js');
    const [part_groups, campaign_names, queries, urls] = await Promise.all([
      getDistinctPartGroups(),
      getDistinctCampaignNames(),
      getDistinctGscQueries().catch(() => []), // GSC not always loaded
      getDistinctUrlPaths().catch(() => []),
    ]);
    res.json({
      generated: new Date().toISOString(),
      part_groups,
      campaign_names,
      queries,
      urls,
    });
  } catch (e) {
    console.error('mappings options error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mappings/suggest-campaigns', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const {
      getDistinctCampaignsForSuggester, getDistinctPartGroups, listPartGroupMappings,
    } = await import('./db.js');
    const [campaigns, partGroups, mappings] = await Promise.all([
      getDistinctCampaignsForSuggester(),
      getDistinctPartGroups(),
      listPartGroupMappings(),
    ]);

    const suggestions = campaigns.map(c => {
      const existing = findExistingMapping(c.campaign_name, mappings);
      const campTokens = tokenize(c.campaign_name);
      const campLower  = c.campaign_name.toLowerCase();
      const ranked = partGroups
        .map(pg => ({ part_group: pg, ...scoreCandidate(campTokens, pg, campLower) }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      return {
        campaign_name: c.campaign_name,
        total_cost: c.total_cost,
        total_sessions: c.total_sessions,
        total_conversions: c.total_conversions,
        last_seen: c.last_seen,
        existing_mapping: existing
          ? { id: existing.id, part_group: existing.part_group, pattern: existing.pattern, match_kind: existing.match_kind }
          : null,
        candidates: ranked,
      };
    });

    res.json({
      generated: new Date().toISOString(),
      part_group_count: partGroups.length,
      part_groups: partGroups,
      campaign_count: campaigns.length,
      mapped_count: suggestions.filter(s => s.existing_mapping).length,
      suggestions,
    });
  } catch (e) {
    console.error('mappings suggest error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mappings', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { createPartGroupMapping } = await import('./db.js');
    const m = await createPartGroupMapping(req.body || {});
    res.status(201).json(m);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/mappings/:id', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { updatePartGroupMapping } = await import('./db.js');
    const m = await updatePartGroupMapping(id, req.body || {});
    res.json(m);
  } catch (e) {
    const status = e.message === 'Mapping not found' ? 404 : 400;
    res.status(status).json({ error: e.message });
  }
});

app.delete('/api/mappings/:id', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { deletePartGroupMapping } = await import('./db.js');
    const ok = await deletePartGroupMapping(id);
    if (!ok) return res.status(404).json({ error: 'Mapping not found' });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CallRail ────────────────────────────────────────────────────────

app.get('/api/callrail-daily', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  try {
    const { getCallRailDaily } = await import('./db.js');
    const daily = await getCallRailDaily({ since, until });
    res.json({ generated: new Date().toISOString(), since, until, daily });
  } catch (e) {
    console.error('callrail-daily error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/callrail-by-campaign', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  try {
    const { getCallRailByCampaign } = await import('./db.js');
    const campaigns = await getCallRailByCampaign({ since, until });
    res.json({ generated: new Date().toISOString(), since, until, campaigns });
  } catch (e) {
    console.error('callrail-by-campaign error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/callrail-calls', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const { getCallRailCalls } = await import('./db.js');
    const calls = await getCallRailCalls({ since, until, limit });
    res.json({ generated: new Date().toISOString(), since, until, calls });
  } catch (e) {
    console.error('callrail-calls error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/callrail-form-submissions', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const since = iso.test(req.query.since) ? req.query.since : null;
  const until = iso.test(req.query.until) ? req.query.until : null;
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const { getCallRailFormSubmissions } = await import('./db.js');
    const forms = await getCallRailFormSubmissions({ since, until, limit });
    res.json({ generated: new Date().toISOString(), since, until, forms });
  } catch (e) {
    console.error('callrail-form-submissions error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/callrail-text-messages', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  try {
    const { getCallRailTextMessages } = await import('./db.js');
    const messages = await getCallRailTextMessages({ limit });
    res.json({ generated: new Date().toISOString(), messages });
  } catch (e) {
    console.error('callrail-text-messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/callrail-trackers', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { listCallRailTrackers } = await import('./db.js');
    const trackers = await listCallRailTrackers();
    res.json({ generated: new Date().toISOString(), trackers });
  } catch (e) {
    console.error('callrail-trackers error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/callrail-companies', async (req, res) => {
  if (!hasDB) return res.status(503).json({ error: 'Database not configured' });
  try {
    const { listCallRailCompanies } = await import('./db.js');
    const companies = await listCallRailCompanies();
    res.json({ generated: new Date().toISOString(), companies });
  } catch (e) {
    console.error('callrail-companies error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh/callrail', async (req, res) => {
  if (!hasCallRail) return res.status(400).json({ error: 'CallRail credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    const result = await withFetchLock('callrail', async () => {
      console.log(`🔄  Manual CallRail refresh (${mode})…`);
      const { fetchCallRail } = await import('./fetchers/fetch-callrail.js');
      let since = null;
      if (mode !== 'full') {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        since = d.toISOString().slice(0, 10);
      }
      return fetchCallRail({ since });
    });
    res.json({ success: true, message: `CallRail ${mode} refresh complete`, ...result });
  } catch (e) {
    console.error('CallRail refresh failed:', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dashboard/dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      message: 'RF Traffic Intelligence API',
      endpoints: ['/api/unified', '/api/health'],
    });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeRow(d) {
  return {
    date: d.date,
    quotes_count: d.quotes_count ?? d.ns_quotes ?? d.quotes ?? 0,
    quotes_total: d.quotes_total ?? 0,
    orders_count: d.orders_count ?? d.ns_orders ?? d.orders ?? 0,
    orders_total: d.orders_total ?? 0,
    shipped_count: d.shipped_count ?? 0,
    shipped_total: d.shipped_total ?? 0,
  };
}

function loadFromCache() {
  const nsPath = path.join(CACHE_DIR, 'netsuite-daily.json');
  const unifiedPath = path.join(CACHE_DIR, 'unified-daily.json');

  for (const p of [nsPath, unifiedPath]) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p));
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.daily)) {
        console.warn(`⚠️  ${path.basename(p)}: unexpected shape, skipping`);
        continue;
      }
      return raw.daily.map(normalizeRow);
    } catch (e) {
      console.warn(`⚠️  ${path.basename(p)}: parse failed (${e.message}), skipping`);
    }
  }
  return null;
}

// ── Startup ──────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🚀  RF Traffic Intelligence Server`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    DB:   ${hasDB ? 'PostgreSQL connected' : 'not configured (using JSON cache)'}`);
  console.log(`    NS:   ${hasNS ? 'credentials set' : 'not configured'}`);
  console.log(`    GA4:  ${hasGA4 ? 'credentials set' : 'not configured'}`);
  console.log(`    GAds: ${hasGAds ? 'credentials set' : 'not configured'}`);
  console.log(`    HS:   ${hasHubSpot ? 'token set' : 'not configured'}`);
  console.log(`    GSC:  ${hasGSC ? 'credentials set' : 'not configured'}`);
  console.log(`    CR:   ${hasCallRail ? 'credentials set' : 'not configured'}`);
  console.log(`    AI:   ${hasAI ? 'Anthropic key set' : 'not configured'}\n`);

  // Initialize database
  if (hasDB) {
    try {
      const { initDB, getRowCount } = await import('./db.js');
      await initDB();
      const count = await getRowCount();
      console.log(`    DB rows: ${count}`);

      // Run backfills sequentially, not in parallel — NetSuite caps concurrent
      // SuiteQL calls (typically 5). The outer IIFE is fire-and-forget so the
      // server starts serving immediately, but inside we await each fetcher.
      (async () => {
        try {
          if (count === 0 && hasNS) {
            await withFetchLock('netsuite-header', async () => {
              console.log('📦  Database empty — starting full historical backfill...');
              const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
              const r = await fetchNetSuite({ since: null });
              console.log(`✅  Backfill complete: ${r.daily.length} days`);
            });
          }

          const { getDimRowCount, getGa4RowCount, getNetSuiteCustomerCount, getNetSuiteTransactionCount } = await import('./db.js');
          const dimCount = await getDimRowCount();
          console.log(`    DB dim rows: ${dimCount}`);
          if (dimCount === 0 && hasNS) {
            await withFetchLock('netsuite-dim', async () => {
              console.log('📦  Dim table empty — starting line-level backfill...');
              const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
              const r = await fetchNetSuiteDim({ since: null });
              console.log(`✅  Dim backfill complete: ${r.rows} rows`);
            });
          }

          // Per-customer identity table. Powers CallRail/HubSpot ↔ NetSuite
          // joins by phone_digits / email_normalized.
          const nsCustCount = await getNetSuiteCustomerCount();
          console.log(`    DB ns customers: ${nsCustCount}`);
          if (nsCustCount === 0 && hasNS) {
            await withFetchLock('netsuite-customers', async () => {
              console.log('📦  Customer table empty — starting customer backfill...');
              const { fetchNetSuiteCustomers } = await import('./fetchers/fetch-netsuite-customers.js');
              const r = await fetchNetSuiteCustomers({ since: null });
              console.log(`✅  Customer backfill complete: ${r.customers} customers`);
            });
          }

          // Per-transaction (Estimate + SalesOrd) rows. Needed for
          // order-level revenue attribution.
          const nsTxnCount = await getNetSuiteTransactionCount();
          console.log(`    DB ns transactions: ${nsTxnCount}`);
          if (nsTxnCount === 0 && hasNS) {
            await withFetchLock('netsuite-transactions', async () => {
              console.log('📦  Transaction table empty — starting transaction backfill...');
              const { fetchNetSuiteTransactions } = await import('./fetchers/fetch-netsuite-transactions.js');
              const r = await fetchNetSuiteTransactions({ since: null });
              console.log(`✅  Transaction backfill complete: ${r.transactions} transactions`);
            });
          }

          const ga4Count = await getGa4RowCount();
          console.log(`    DB ga4 rows: ${ga4Count}`);

          // Trigger a full GA4 fetch when either the aggregate table OR the
          // newer channel/campaign tables are empty — the fetcher writes all
          // three per run so a single call catches up any missing table.
          let needsGa4Fetch = ga4Count === 0;
          if (!needsGa4Fetch) {
            const { rows } = await (await import('./db.js')).getPool().query(`SELECT COUNT(*)::int as cnt FROM ga4_daily_by_channel`);
            if (rows[0].cnt === 0) {
              console.log('📦  GA4 by-channel table empty — refreshing full GA4 history to populate it...');
              needsGa4Fetch = true;
            }
          }
          if (needsGa4Fetch && hasGA4) {
            await withFetchLock('ga4', async () => {
              console.log('📦  GA4 backfill — starting full backfill (2y)...');
              const { fetchGa4 } = await import('./fetchers/fetch-ga4.js');
              const r = await fetchGa4({ since: null });
              console.log(`✅  GA4 backfill complete: ${r.aggregate} agg + ${r.byCampaign} campaign + ${r.byChannel} channel rows`);
            });
          }

          // Google Ads backfill — only if credentials are set. Fails soft:
          // a developer-token approval issue or bad OAuth shouldn't block
          // the rest of startup from finishing.
          if (hasGAds) {
            try {
              const { getGoogleAdsRowCount } = await import('./db.js');
              const gadsCount = await getGoogleAdsRowCount();
              console.log(`    DB google_ads rows: ${gadsCount}`);
              if (gadsCount === 0) {
                await withFetchLock('google-ads', async () => {
                  console.log('📦  Google Ads backfill — starting full backfill (2y)...');
                  const { fetchGoogleAds } = await import('./fetchers/fetch-google-ads.js');
                  const r = await fetchGoogleAds({ since: null });
                  console.log(`✅  Google Ads backfill complete: ${r.byCampaign} campaign-day rows`);
                });
              }
            } catch (e) {
              console.error('⚠️  Google Ads backfill failed:', e.message);
            }
          }

          // HubSpot backfill — deals + contacts + quotes + (optional) marketing campaigns.
          // Trigger if any of the three persisted tables is empty so a redeploy
          // that introduces a new table still self-heals when the others were
          // populated by a previous release.
          if (hasHubSpot) {
            try {
              const {
                getHubSpotDealCount, getHubSpotContactCount, getHubSpotNetsuiteQuotesCount,
              } = await import('./db.js');
              const [hsDeals, hsContacts, hsQuotes] = await Promise.all([
                getHubSpotDealCount(),
                getHubSpotContactCount().catch(() => 0),
                getHubSpotNetsuiteQuotesCount().catch(() => 0),
              ]);
              console.log(`    DB hubspot deals: ${hsDeals}, contacts: ${hsContacts}, ns-quotes: ${hsQuotes}`);
              if (hsDeals === 0 || hsContacts === 0 || hsQuotes === 0) {
                await withFetchLock('hubspot', async () => {
                  console.log('📦  HubSpot backfill — starting full backfill...');
                  const { fetchHubSpot } = await import('./fetchers/fetch-hubspot.js');
                  const r = await fetchHubSpot({ since: null });
                  console.log(`✅  HubSpot backfill complete: ${r.deals} deals + ${r.contacts || 0} contacts + ${r.quotes || 0} quotes + ${r.campaigns} campaigns`);
                });
              }
            } catch (e) {
              console.error('⚠️  HubSpot backfill failed:', e.message);
            }
          }

          // CallRail backfill — calls + forms + texts + trackers + companies.
          // CallRail keeps full history on most plans; first run pulls all of it.
          if (hasCallRail) {
            try {
              const { getCallRailRowCount } = await import('./db.js');
              const crCount = await getCallRailRowCount();
              console.log(`    DB callrail calls: ${crCount}`);
              if (crCount === 0) {
                await withFetchLock('callrail', async () => {
                  console.log('📦  CallRail backfill — starting full pull...');
                  const { fetchCallRail } = await import('./fetchers/fetch-callrail.js');
                  const r = await fetchCallRail({ since: null });
                  console.log(`✅  CallRail backfill complete: ${r.calls} calls, ${r.forms} forms, ${r.texts} texts, ${r.trackers} trackers, ${r.companies} companies`);
                });
              }
            } catch (e) {
              console.error('⚠️  CallRail backfill failed:', e.message);
            }
          }

          // Search Console backfill.
          if (hasGSC) {
            try {
              const { getGscRowCount } = await import('./db.js');
              const gscCount = await getGscRowCount();
              console.log(`    DB gsc rows: ${gscCount}`);
              if (gscCount === 0) {
                await withFetchLock('gsc', async () => {
                  console.log('📦  GSC backfill — starting full backfill (16mo)...');
                  const { fetchGsc } = await import('./fetchers/fetch-gsc.js');
                  const r = await fetchGsc({ since: null });
                  console.log(`✅  GSC backfill complete: ${r.daily} daily + ${r.topQueries} queries + ${r.topPages} pages`);
                });
              }
            } catch (e) {
              console.error('⚠️  GSC backfill failed:', e.message);
            }
          }
        } catch (e) {
          console.error('⚠️  Startup backfill failed:', e.message);
        } finally {
          startupReady = true;
          console.log('    ✅ Startup backfill checks complete — serving data endpoints.');
        }
      })();
    } catch (e) {
      console.error('⚠️  DB init failed:', e.message);
      // Let downstream endpoints surface their own errors instead of blocking
      // on 503 forever — operators need to see the real failure.
      startupReady = true;
    }
  } else if (hasNS) {
    // No DB, fetch to JSON cache
    console.log('🔑  Fetching NetSuite data to JSON cache...');
    import('./fetchers/fetch-netsuite.js')
      .then(({ fetchNetSuite }) => {
        const d = new Date();
        d.setDate(d.getDate() - 540);
        return fetchNetSuite({ since: d.toISOString().slice(0, 10) });
      })
      .then(() => console.log('✅  NetSuite cache updated'))
      .catch(e => console.error('⚠️  Fetch failed:', e.message));
  }

  // Schedule nightly refresh: weekdays at 2:00 AM (server timezone). Runs
  // any source that's credentialed — each fetcher is wrapped in its own
  // try/catch so one bad source doesn't skip the others.
  const anyNightlySource = hasNS || hasGA4 || hasGAds || hasHubSpot || hasGSC || hasCrUX || hasCallRail;
  if (anyNightlySource) {
    cron.schedule('0 2 * * 1-5', async () => {
      console.log(`\n⏰  Cron: nightly refresh (${new Date().toISOString()})`);
      const d = new Date();
      d.setDate(d.getDate() - 60);
      const since = d.toISOString().slice(0, 10);

      const runOne = async (label, fn) => {
        try { await fn(); }
        catch (e) { console.error(`⚠️  Cron ${label} failed:`, e.message); }
      };

      if (hasNS) {
        await runOne('netsuite', async () => {
          const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
          await fetchNetSuite({ since });
        });
        await runOne('netsuite-dim', async () => {
          const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
          await fetchNetSuiteDim({ since });
        });
        await runOne('netsuite-customers', async () => {
          const { fetchNetSuiteCustomers } = await import('./fetchers/fetch-netsuite-customers.js');
          await fetchNetSuiteCustomers({ since });
        });
        await runOne('netsuite-transactions', async () => {
          const { fetchNetSuiteTransactions } = await import('./fetchers/fetch-netsuite-transactions.js');
          await fetchNetSuiteTransactions({ since });
        });
      }
      if (hasGA4) {
        await runOne('ga4', async () => {
          const { fetchGa4 } = await import('./fetchers/fetch-ga4.js');
          await fetchGa4({ since });
        });
      }
      if (hasGAds) {
        await runOne('google-ads', async () => {
          const { fetchGoogleAds } = await import('./fetchers/fetch-google-ads.js');
          await fetchGoogleAds({ since });
        });
      }
      if (hasHubSpot) {
        await runOne('hubspot', async () => {
          const { fetchHubSpot } = await import('./fetchers/fetch-hubspot.js');
          await fetchHubSpot({ since });
        });
      }
      if (hasGSC) {
        await runOne('gsc', async () => {
          const { fetchGsc } = await import('./fetchers/fetch-gsc.js');
          await fetchGsc({ since });
        });
      }
      if (hasCrUX) {
        await runOne('crux', async () => {
          const { fetchCrux } = await import('./fetchers/fetch-crux.js');
          await fetchCrux();
        });
      }
      if (hasCallRail) {
        await runOne('callrail', async () => {
          const { fetchCallRail } = await import('./fetchers/fetch-callrail.js');
          await fetchCallRail({ since });
        });
      }

      console.log('✅  Cron refresh complete');
    }, { timezone: CRON_TIMEZONE });
    console.log(`    ⏰ Cron scheduled: weekdays 2:00 AM (${CRON_TIMEZONE})`);
  }
});
