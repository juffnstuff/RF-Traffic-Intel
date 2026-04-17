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
        const { fetchNetSuite } = await import('./fetchers/fetch-netsuite.js');
        const d = new Date();
        d.setDate(d.getDate() - 60);
        await fetchNetSuite({ since: d.toISOString().slice(0, 10) });
        console.log('✅  Cron refresh complete');
      } catch (e) {
        console.error('⚠️  Cron refresh failed:', e.message);
      }
    }, { timezone: 'America/New_York' });
    console.log('    ⏰ Cron scheduled: weekdays 2:00 AM ET');
  }
});
