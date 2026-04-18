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
      const { getAllDaily } = await import('./db.js');
      daily = await getAllDaily();
    }

    if (!daily || daily.length === 0) {
      daily = loadFromCache();
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
    const { getDailyDimFiltered, getDimRowCount } = await import('./db.js');
    const partGroups = (req.query.partGroups || '').split(',').map(s => s.trim()).filter(Boolean);
    const salesReps  = (req.query.salesReps  || '').split(',').map(s => s.trim()).filter(Boolean);

    const dimCount = await getDimRowCount();
    if (dimCount === 0) {
      return res.status(404).json({ error: 'No dim data yet. Run a dim fetch first.' });
    }

    let daily = await getDailyDimFiltered({ partGroups, salesReps });

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
const AI_SYSTEM_PROMPT = `You are the in-dashboard analyst for RF Traffic Intelligence, a sales-operations dashboard for RubberForm (an industrial rubber-products manufacturer). You receive a JSON snapshot of the charts the user is currently looking at and write a short, business-ready interpretation.

Metric glossary:
- "quote_dollars" / "quote_count" — estimates created, bucketed by quote creation date.
- "orders_dollars" / "orders_count" — sales orders created (i.e. quotes that converted), bucketed by SO creation date.
- "shipped_dollars" / "shipped_count" — sales orders shipped, bucketed by actual ship date.
- "close_rate" — 30 DMA of orders_count / quotes_count. A volume-based conversion metric.
- "capture_rate" — 30 DMA of orders_dollars / adjusted quotes_dollars (excluding quotes marked "RF Alternate Solution" as lost reason). A dollar-weighted conversion metric.
- "aov_orders" / "aov_shipped" — average order value = dollars / count, on the 30 DMA. Rising AOV with flat count means bigger deals; falling AOV with flat count means smaller deals.
- "lead_lag" — the Pearson correlation r at the best lag (0–45 days) where quote activity predicts order activity, and order activity predicts shipped activity. |r| > 0.7 = strong, 0.4–0.7 = moderate, < 0.4 = weak / noisy.

Snapshot fields you'll receive:
- "page" — "overview" (full dataset) or "filtered" (sliced by part groups / sales reps).
- "filters" — present only when page=filtered. The specific part groups and reps the user chose; empty arrays mean "all".
- "range" — "3m" / "6m" / "all" / a custom year set like "2024,2025".
- "days_visible" — number of days in the current view.
- "weekday_only" — true means weekends are excluded.
- "current_30" — the latest 30 DMA value for each metric (what's showing as the big number on each card).
- "prior_30" — the 30 DMA value 30 days earlier in the same series. Use this to compute direction (current vs prior).
- "period_totals" — summed raw daily values over the visible range. Use these when talking about totals across the period.
- "lead_lag.quotes_to_orders" and "lead_lag.orders_to_shipped" — { "best_lag_days": N, "r": x }.

Write 3 short paragraphs, plain prose, no headers, no bullets, no markdown:

Paragraph 1 — What's happening. The headline on sales and pipeline right now. Name the 30 DMA figures for quote $ and orders $, and say whether they're up or down vs prior_30 (use percent change). If shipped $ differs meaningfully from orders $, mention it. If page=filtered, open by naming the filter set (e.g. "For Speed Bumps across reps Backman and Johnson…").

Paragraph 2 — Quality of demand. Close rate and capture rate — which way they're moving and what it implies. Then AOV: if aov_orders is rising with flat count, deals are getting bigger; if falling, smaller. Be specific: cite the current close / capture / AOV numbers.

Paragraph 3 — Forward signal + watchlist. Use lead_lag to say what the quote activity implies for orders over the next N days (where N = best_lag_days from quotes_to_orders). Note r strength so the user knows how much to trust it. End with one specific thing to keep an eye on — a metric that's diverging, a lag that's unusually short/long, a filter combination worth exploring.

Style rules:
- 2–3 sentences per paragraph, max.
- Abbreviate dollars ($1.2M, $450K, $3.4K).
- Percents to the nearest whole percent in prose (e.g. "up 12%").
- No preamble ("Here's the analysis…"), no sign-off, no hedging boilerplate ("as always, past performance…").
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

      // If DB is empty and NS creds are set, do a full backfill
      if (count === 0 && hasNS) {
        console.log('📦  Database empty — starting full historical backfill...');
        const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
        fetchNetSuite({ since: null })
          .then(r => console.log(`✅  Backfill complete: ${r.daily.length} days`))
          .catch(e => console.error('⚠️  Backfill failed:', e.message));
      }

      // Also backfill the dim table if empty
      try {
        const { getDimRowCount } = await import('./db.js');
        const dimCount = await getDimRowCount();
        console.log(`    DB dim rows: ${dimCount}`);
        if (dimCount === 0 && hasNS) {
          console.log('📦  Dim table empty — starting line-level backfill...');
          const { fetchNetSuiteDim } = await import('./fetchers/fetch-netsuite-dim.js');
          fetchNetSuiteDim({ since: null })
            .then(r => console.log(`✅  Dim backfill complete: ${r.rows} rows`))
            .catch(e => console.error('⚠️  Dim backfill failed:', e.message));
        }
      } catch (e) {
        console.error('⚠️  Dim count check failed:', e.message);
      }
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
