/**
 * rf-traffic-intel / server.js
 *
 * Express API server. Serves cached JSON to the React dashboard.
 * Keeps Google tokens server-side (never exposed to browser).
 *
 * Endpoints:
 *   GET /api/unified          → full unified daily dataset
 *   GET /api/summary          → high-level stats
 *   POST /api/refresh/netsuite → re-fetch NetSuite only (fast, ~5s)
 *   POST /api/refresh/all      → re-fetch all sources (slow, ~30s)
 *
 * Usage:
 *   node server.js     → starts on port 3737
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3737;
const CACHE_DIR = path.join(__dirname, 'data/cache');
const UNIFIED_PATH = path.join(CACHE_DIR, 'unified-daily.json');

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard build
app.use(express.static(path.join(__dirname, 'dashboard/dist')));

// ── API Routes ────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  const hasData = fs.existsSync(UNIFIED_PATH);
  const stat = hasData ? fs.statSync(UNIFIED_PATH) : null;
  res.json({
    status: 'ok',
    hasData,
    dataAge: stat ? Math.round((Date.now() - stat.mtimeMs) / 60000) + ' minutes' : null,
    cacheFiles: fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')) : [],
  });
});

// Normalize row to the current schema (handles old demo format too)
function normalizeRow(d) {
  return {
    date: d.date,
    quotes_count: d.quotes_count ?? d.ns_quotes ?? d.quotes ?? 0,
    quotes_total: d.quotes_total ?? 0,
    orders_count: d.orders_count ?? d.ns_orders ?? d.orders ?? 0,
    orders_total: d.orders_total ?? 0,
    shipped_count: d.shipped_count ?? 0,
    shipped_total: d.shipped_total ?? 0,
    gsc_clicks: d.gsc_clicks ?? 0,
    gsc_impressions: d.gsc_impressions ?? 0,
    ga4_sessions: d.ga4_sessions ?? 0,
  };
}

// Main data endpoint — prefers fresh netsuite cache, then unified, then old demo
app.get('/api/unified', (req, res) => {
  const netsuitePath = path.join(CACHE_DIR, 'netsuite-daily.json');
  let data;

  // Prefer netsuite-daily.json if it's fresh (from live fetch)
  const nsExists = fs.existsSync(netsuitePath);
  const unifiedExists = fs.existsSync(UNIFIED_PATH);

  let useNS = false;
  if (nsExists && unifiedExists) {
    const nsStat = fs.statSync(netsuitePath);
    const unifiedStat = fs.statSync(UNIFIED_PATH);
    useNS = nsStat.mtimeMs > unifiedStat.mtimeMs;
  } else if (nsExists) {
    useNS = true;
  }

  if (useNS) {
    const ns = JSON.parse(fs.readFileSync(netsuitePath));
    data = {
      generated: ns.generated,
      sources: ns.sources || ['netsuite'],
      daily: (ns.daily || []).map(normalizeRow),
    };
  } else if (unifiedExists) {
    const raw = JSON.parse(fs.readFileSync(UNIFIED_PATH));
    data = {
      generated: raw.generated,
      sources: raw.sources || ['demo'],
      daily: (raw.daily || []).map(normalizeRow),
    };
  } else {
    return res.status(404).json({
      error: 'No data yet. Run: node fetchers/fetch-netsuite.js',
    });
  }

  // Optional date filter
  const { start, end } = req.query;
  if (start || end) {
    data.daily = data.daily.filter(d =>
      (!start || d.date >= start) && (!end || d.date <= end)
    );
  }

  res.json(data);
});

// Individual source endpoints
app.get('/api/netsuite', (req, res) => {
  const p = path.join(CACHE_DIR, 'netsuite-daily.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Run fetch-netsuite.js first' });
  res.json(JSON.parse(fs.readFileSync(p)));
});

app.get('/api/gsc', (req, res) => {
  const p = path.join(CACHE_DIR, 'gsc-daily.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Run fetch-gsc.js first' });
  res.json(JSON.parse(fs.readFileSync(p)));
});

app.get('/api/ga4', (req, res) => {
  const p = path.join(CACHE_DIR, 'ga4-daily.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Run fetch-ga4.js first' });
  res.json(JSON.parse(fs.readFileSync(p)));
});

// Refresh endpoints — re-fetch data on demand
app.post('/api/refresh/netsuite', async (req, res) => {
  try {
    console.log('🔄  Refreshing NetSuite data...');
    const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
    const result = await fetchNetSuite();
    res.json({
      success: true,
      message: 'NetSuite data refreshed',
      rows: result.daily.length,
      generated: result.generated,
    });
  } catch (e) {
    console.error('Refresh failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/refresh/all', async (req, res) => {
  res.json({ success: true, message: 'Full refresh queued. Check server logs.' });
  const { exec } = await import('child_process');
  exec('node fetchers/fetch-all.js', (err, stdout) => {
    if (err) console.error('Refresh error:', err);
    else console.log('Refresh complete:', stdout);
  });
});

// SPA fallback
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dashboard/dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      message: 'RF Traffic Intelligence API',
      endpoints: ['/api/unified', '/api/netsuite', '/api/gsc', '/api/ga4', '/api/health'],
      dashboard: 'Run: npm run dev (for development with live reload)',
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀  RF Traffic Intelligence Server`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    API: http://localhost:${PORT}/api/unified`);
  console.log(`\n    Data status: ${fs.existsSync(UNIFIED_PATH) ? '✅ cached data available' : '⚠️  no data yet — run: node fetchers/fetch-all.js'}\n`);

  // Auto-fetch NetSuite data on startup if credentials are present
  const hasNSCreds = process.env.NS_ACCOUNT_ID && process.env.NS_CONSUMER_KEY &&
                     process.env.NS_CONSUMER_SECRET && process.env.NS_TOKEN_ID &&
                     process.env.NS_TOKEN_SECRET;

  if (hasNSCreds) {
    console.log('🔑  NetSuite credentials detected — fetching fresh data in background...');
    import('./fetchers/fetch-netsuite.js')
      .then(({ fetchNetSuite }) => fetchNetSuite())
      .then(() => console.log('✅  NetSuite auto-fetch complete'))
      .catch(e => console.error('⚠️  NetSuite auto-fetch failed:', e.message));
  } else {
    console.log('ℹ️   NetSuite credentials not set — using cached/demo data');
  }
});
