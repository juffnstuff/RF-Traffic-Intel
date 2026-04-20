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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3737;
const CACHE_DIR = path.join(__dirname, 'data/cache');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dashboard/dist')));

const hasDB = !!process.env.DATABASE_URL;
const hasNS = !!(process.env.NS_ACCOUNT_ID && process.env.NS_CONSUMER_KEY &&
                  process.env.NS_CONSUMER_SECRET && process.env.NS_TOKEN_ID &&
                  process.env.NS_TOKEN_SECRET);
const hasAI = !!process.env.ANTHROPIC_API_KEY;

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
  if (!hasDB) return res.status(400).json({ error: 'Database not configured' });
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
  if (!hasDB) return res.status(400).json({ error: 'Database not configured' });
  try {
    const { getAllDaily, getDailyDimFiltered, getDimRowCount, zerofillDaily } = await import('./db.js');
    const partGroups = (req.query.partGroups || '').split(',').map(s => s.trim()).filter(Boolean);
    const salesReps  = (req.query.salesReps  || '').split(',').map(s => s.trim()).filter(Boolean);

    // When no filter is applied, route to the header-level source so this tab
    // visually matches Overview. The dim-table aggregation at (date, part_group,
    // rep, size_bucket) grain has edge cases — cross-group SUMs, line- vs
    // header-level $ semantics — that surface as divergence from Overview when
    // unfiltered. Switching to the header source eliminates that for the
    // no-filter case without breaking filtered slicing.
    let daily;
    const unfiltered = partGroups.length === 0 && salesReps.length === 0;
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
      daily = await getDailyDimFiltered({ partGroups, salesReps });
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

- "lead_lag" — Pearson r at the best lag (0–45 days) on the smoothed (30 DMA) series. Four variants:
  - "quotes_to_orders_count" — quote count → order count. Forecasts transaction volume.
  - "quotes_to_orders_dollars" — quote $ → order $. Forecasts revenue. **Use this as the primary forecasting signal in paragraph 3 — revenue is what the user cares about. Mention the count variant only if it disagrees materially.**
  - "orders_to_shipped_count" / "orders_to_shipped_dollars" — same, for orders → ship.
- "ga4" — website traffic from Google Analytics 4. If present, use it as an upstream leading indicator of quotes (traffic → quotes → orders → ship). If null, acknowledge the source is coming but don't speculate about what it would say.

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

Paragraph 3 — Open-quote conversion likelihood. This is the headline number the user cares about. Use lead_lag.quotes_to_orders_dollars (the $ correlation) as the primary signal: (a) state the expected order $ from the currently-open quote pipeline over the next N days using its best_lag_days (compute with the formulas above); (b) calibrate confidence from r using the scale above, in plain words — "high confidence", "a reasonable guide", "too noisy to forecast reliably"; (c) if quotes_to_orders_count tells a meaningfully different story (e.g. count r is strong but $ r is weak, suggesting deal-size volatility, or vice versa), call that out in one sentence; (d) end with one concrete watchlist item — a metric that's diverging, a lag that's unusually short/long, or a filter combination worth drilling into. If the primary $ r is weak (< 0.4), skip the projected numbers and instead explain what's making the signal unreliable and what the user could do to sharpen it (longer range, fewer filters, more data).

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
  if (!hasDB) return res.status(400).json({ error: 'Database not configured' });
  try {
    const { getDailyByPartGroup, getDimRowCount, getSizeBucketSummary, zerofillDaily } = await import('./db.js');
    const dimCount = await getDimRowCount();
    if (dimCount === 0) {
      return res.status(404).json({ error: 'No dim data yet. Run a dim fetch first.' });
    }
    const sizeBucket = (req.query.sizeBucket || '').trim() || null;
    const [groups, sizeBuckets] = await Promise.all([
      getDailyByPartGroup({ sizeBucket }),
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

app.post('/api/refresh/netsuite-dim', async (req, res) => {
  if (!hasNS) return res.status(400).json({ error: 'NetSuite credentials not configured' });
  const mode = req.query.mode || 'incremental';
  try {
    console.log(`🔄  Manual dim refresh (${mode})...`);
    const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
    let since = null;
    if (mode !== 'full') {
      const d = new Date();
      d.setDate(d.getDate() - 60);
      since = d.toISOString().slice(0, 10);
    }
    const result = await fetchNetSuiteDim({ since });
    res.json({ success: true, message: `Dim ${mode} refresh complete`, rows: result.rows });
  } catch (e) {
    console.error('Dim refresh failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/netsuite', (req, res) => {
  const p = path.join(CACHE_DIR, 'netsuite-daily.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No cache' });
  res.json(JSON.parse(fs.readFileSync(p)));
});

// Refresh endpoints
app.post('/api/refresh/netsuite', async (req, res) => {
  if (!hasNS) return res.status(400).json({ error: 'NetSuite credentials not configured' });

  const mode = req.query.mode || 'incremental';
  try {
    console.log(`🔄  Manual refresh (${mode})...`);
    const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');

    let since = null;
    if (mode !== 'full') {
      const d = new Date();
      d.setDate(d.getDate() - 60);
      since = d.toISOString().slice(0, 10);
    }

    const result = await fetchNetSuite({ since });
    res.json({
      success: true,
      message: `NetSuite ${mode} refresh complete`,
      rows: result.daily.length,
    });
  } catch (e) {
    console.error('Refresh failed:', e);
    res.status(500).json({ error: e.message });
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
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p));
        return (raw.daily || []).map(normalizeRow);
      } catch { /* skip bad files */ }
    }
  }
  return null;
}

// ── Startup ──────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🚀  RF Traffic Intelligence Server`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    DB: ${hasDB ? 'PostgreSQL connected' : 'not configured (using JSON cache)'}`);
  console.log(`    NS: ${hasNS ? 'credentials set' : 'not configured'}\n`);

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
            console.log('📦  Database empty — starting full historical backfill...');
            const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
            const r = await fetchNetSuite({ since: null });
            console.log(`✅  Backfill complete: ${r.daily.length} days`);
          }

          const { getDimRowCount } = await import('./db.js');
          const dimCount = await getDimRowCount();
          console.log(`    DB dim rows: ${dimCount}`);
          if (dimCount === 0 && hasNS) {
            console.log('📦  Dim table empty — starting line-level backfill...');
            const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
            const r = await fetchNetSuiteDim({ since: null });
            console.log(`✅  Dim backfill complete: ${r.rows} rows`);
          }
        } catch (e) {
          console.error('⚠️  Startup backfill failed:', e.message);
        }
      })();
    } catch (e) {
      console.error('⚠️  DB init failed:', e.message);
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

  // Schedule nightly refresh: weekdays at 2:00 AM (server timezone)
  if (hasNS) {
    cron.schedule('0 2 * * 1-5', async () => {
      console.log(`\n⏰  Cron: nightly NetSuite refresh (${new Date().toISOString()})`);
      try {
        const d = new Date();
        d.setDate(d.getDate() - 60);
        const since = d.toISOString().slice(0, 10);

        const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
        await fetchNetSuite({ since });

        const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
        await fetchNetSuiteDim({ since });

        console.log('✅  Cron refresh complete');
      } catch (e) {
        console.error('⚠️  Cron refresh failed:', e.message);
      }
    }, { timezone: 'America/New_York' });
    console.log('    ⏰ Cron scheduled: weekdays 2:00 AM ET');
  }
});
