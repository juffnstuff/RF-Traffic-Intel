/**
 * db.js — PostgreSQL connection and schema management
 */

import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL not set');
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5,
    });
  }
  return pool;
}

export async function initDB() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS netsuite_daily (
      date DATE PRIMARY KEY,
      quotes_count INTEGER DEFAULT 0,
      quotes_total NUMERIC(15,2) DEFAULT 0,
      quotes_adj_count INTEGER DEFAULT 0,
      quotes_adj_total NUMERIC(15,2) DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      orders_total NUMERIC(15,2) DEFAULT 0,
      shipped_count INTEGER DEFAULT 0,
      shipped_total NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS fetch_log (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status TEXT,
      rows_upserted INTEGER DEFAULT 0,
      error TEXT
    )
  `);

  // Auto-migrate: if the dim table exists without the size_bucket or is_first
  // columns, drop it so the new schema gets created below. An empty dim table
  // triggers an auto-backfill on startup (see server.js), so the user doesn't
  // have to do anything manual — the first post-deploy load repopulates with
  // the current schema.
  const tableCheck = await p.query(`SELECT to_regclass('netsuite_daily_dim') as t`);
  if (tableCheck.rows[0].t) {
    const colCheck = await p.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'netsuite_daily_dim'
        AND column_name IN ('size_bucket', 'is_first')
    `);
    const present = new Set(colCheck.rows.map(r => r.column_name));
    if (!present.has('size_bucket') || !present.has('is_first')) {
      console.log('⚠️  Migrating netsuite_daily_dim — dropping for schema update (triggers refetch)');
      await p.query(`DROP TABLE netsuite_daily_dim`);
    }
  }

  // Line-level aggregation by (date, trantype, part_group, salesrep, size_bucket, is_first)
  //   trantype:    'quote', 'quote_adj', 'order', 'shipped'
  //   size_bucket: 'Under $5K', '$5K-$25K', '$25K-$100K', '$100K+'
  //   is_first:    'Y' when the transaction was flagged as the customer's first
  //                 (custbody_rf_firstquote for quotes, custbody_rf_firstorder
  //                 for orders/shipped); 'N' otherwise. Lets the dashboard split
  //                 net-new business from repeat business.
  await p.query(`
    CREATE TABLE IF NOT EXISTS netsuite_daily_dim (
      date DATE NOT NULL,
      trantype TEXT NOT NULL,
      part_group TEXT NOT NULL DEFAULT '',
      salesrep_id TEXT NOT NULL DEFAULT '',
      salesrep_name TEXT,
      size_bucket TEXT NOT NULL DEFAULT 'Under $5K',
      is_first CHAR(1) NOT NULL DEFAULT 'N',
      txn_count INTEGER DEFAULT 0,
      line_total NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, trantype, part_group, salesrep_id, size_bucket, is_first)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_date ON netsuite_daily_dim(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_partgroup ON netsuite_daily_dim(part_group)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_salesrep ON netsuite_daily_dim(salesrep_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_size ON netsuite_daily_dim(size_bucket)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_first ON netsuite_daily_dim(is_first)`);

  // GA4 aggregate daily — one row per date, whole-account totals.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily (
      date DATE PRIMARY KEY,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      avg_session_duration NUMERIC(10,2) DEFAULT 0,
      bounce_rate NUMERIC(6,4) DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // GA4 per-campaign daily — one row per (date, campaign_name). Campaign
  // is sessionCampaignName from GA4 (pulled from utm_campaign / Google Ads).
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_campaign (
      date DATE NOT NULL,
      campaign_name TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, campaign_name)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_campaign_date ON ga4_daily_by_campaign(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_campaign_name ON ga4_daily_by_campaign(campaign_name)`);

  // GA4 daily traffic dimensioned by sessionDefaultChannelGroup. Lets the
  // dashboard split organic / paid / direct / referral / social / etc. —
  // each channel typically has very different conversion behavior, so
  // aggregating them together obscures the real funnel signal.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_channel (
      date DATE NOT NULL,
      channel TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, channel)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_channel_date ON ga4_daily_by_channel(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_channel_name ON ga4_daily_by_channel(channel)`);

  // Per-(landing page) daily. landing_page is the URL path + querystring,
  // not just the path — strips of querystring tokens like utm_* are intentional
  // (different querystring → different landing experience for SEO purposes).
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_landing_page (
      date DATE NOT NULL,
      landing_page TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, landing_page)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_landing_date ON ga4_daily_by_landing_page(date)`);

  // Per-(source, medium) daily. Same row can have source="google", medium="organic"
  // and source="google", medium="cpc" on the same day — they're different
  // attributions, both legit.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_source_medium (
      date DATE NOT NULL,
      source TEXT NOT NULL,
      medium TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, source, medium)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_sm_date ON ga4_daily_by_source_medium(date)`);

  // Per-(first-touch source/medium) daily — first interaction in the session
  // chain, not the converting one. For a 30–90d B2B cycle this often tells a
  // very different story than session-source.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_first_touch (
      date DATE NOT NULL,
      first_source TEXT NOT NULL,
      first_medium TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, first_source, first_medium)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_ft_date ON ga4_daily_by_first_touch(date)`);

  // Per-device daily — desktop / mobile / tablet. Mobile vs desktop conv-rate
  // delta tells you whether mobile UX is leaking quotes.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_device (
      date DATE NOT NULL,
      device TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, device)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_device_date ON ga4_daily_by_device(date)`);

  // Per-country daily — geo split, headline "US vs ROW" is the most common
  // read but the long tail informs international ad spend.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_country (
      date DATE NOT NULL,
      country TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, country)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_country_date ON ga4_daily_by_country(date)`);

  // Per-event daily — used to surface conversion events (form submits,
  // phone-clicks, etc.) as their own KPIs. Rows where conversions > 0 are
  // the conversion-event subset; the rest is informational fired-event volume.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_event (
      date DATE NOT NULL,
      event_name TEXT NOT NULL,
      event_count INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, event_name)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_event_date ON ga4_daily_by_event(date)`);

  // Per-(new vs returning) daily. visitor_type in {new, returning, (not set)}.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ga4_daily_by_new_vs_returning (
      date DATE NOT NULL,
      visitor_type TEXT NOT NULL,
      sessions INTEGER DEFAULT 0,
      total_users INTEGER DEFAULT 0,
      new_users INTEGER DEFAULT 0,
      engaged_sessions INTEGER DEFAULT 0,
      screen_page_views INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      total_revenue NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, visitor_type)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ga4_nvr_date ON ga4_daily_by_new_vs_returning(date)`);

  // Google Ads per-campaign daily. cost/avg_cpc are post-normalization from
  // Google's cost_micros (cost_micros / 1_000_000). Integer counts stay ints.
  await p.query(`
    CREATE TABLE IF NOT EXISTS google_ads_daily_by_campaign (
      date DATE NOT NULL,
      campaign_id TEXT NOT NULL,
      campaign_name TEXT NOT NULL DEFAULT '',
      channel_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      cost NUMERIC(15,2) DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      conversions NUMERIC(10,2) DEFAULT 0,
      conversion_value NUMERIC(15,2) DEFAULT 0,
      avg_cpc NUMERIC(10,4) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, campaign_id)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_gads_date ON google_ads_daily_by_campaign(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_gads_campaign ON google_ads_daily_by_campaign(campaign_name)`);

  // HubSpot closed-won deals. One row per deal_id. Source/attribution fields
  // come from HubSpot's `hs_analytics_source*` on the deal record and power
  // the "which channel drove this deal" split on the Paid/SEO tabs.
  await p.query(`
    CREATE TABLE IF NOT EXISTS hubspot_deals (
      deal_id TEXT PRIMARY KEY,
      deal_name TEXT NOT NULL DEFAULT '',
      amount NUMERIC(15,2) DEFAULT 0,
      close_date DATE,
      stage TEXT NOT NULL DEFAULT '',
      stage_label TEXT NOT NULL DEFAULT '',
      pipeline TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      source_data_1 TEXT NOT NULL DEFAULT '',
      source_data_2 TEXT NOT NULL DEFAULT '',
      campaign_guid TEXT NOT NULL DEFAULT '',
      is_closed_won BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ,
      modified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_close_date ON hubspot_deals(close_date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_source ON hubspot_deals(source)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_won ON hubspot_deals(is_closed_won)`);

  // HubSpot marketing campaigns. Populated only when the account has
  // Marketing Hub (the /marketing/v3/campaigns endpoint is tier-gated).
  // When empty, the Paid tab falls back to matching deals by campaign name.
  await p.query(`
    CREATE TABLE IF NOT EXISTS hubspot_campaigns (
      campaign_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Google Search Console aggregate daily.
  await p.query(`
    CREATE TABLE IF NOT EXISTS gsc_daily (
      date DATE PRIMARY KEY,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr NUMERIC(6,4) DEFAULT 0,
      position NUMERIC(6,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Top queries / pages over a trailing window. window_end_date is the last
  // day of the window (we default to a rolling 28-day window). Keeping the
  // windowed shape lets us retain history for a trend line per query/page
  // without explode-on-every-day cardinality.
  await p.query(`
    CREATE TABLE IF NOT EXISTS gsc_top_queries (
      window_end_date DATE NOT NULL,
      query TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr NUMERIC(6,4) DEFAULT 0,
      position NUMERIC(6,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (window_end_date, query)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_gsc_queries_win ON gsc_top_queries(window_end_date)`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS gsc_top_pages (
      window_end_date DATE NOT NULL,
      page TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      ctr NUMERIC(6,4) DEFAULT 0,
      position NUMERIC(6,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (window_end_date, page)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_gsc_pages_win ON gsc_top_pages(window_end_date)`);

  // Core Web Vitals from the Chrome User Experience Report (CrUX). p75
  // values for LCP (ms), INP (ms), CLS (unitless). One row per CrUX
  // collection period's lastDate, per form factor — 'ALL' is the blended
  // read; 'PHONE' / 'DESKTOP' / 'TABLET' are the form-factor-specific
  // history (mobile vs desktop CWV typically differ noticeably).
  await p.query(`
    CREATE TABLE IF NOT EXISTS crux_daily (
      date DATE NOT NULL,
      form_factor TEXT NOT NULL DEFAULT 'ALL',
      lcp_p75 NUMERIC(10,2),
      inp_p75 NUMERIC(10,2),
      cls_p75 NUMERIC(8,4),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, form_factor)
    )
  `);
  // Migration path for the v1 schema where the PK was (date) only and
  // form_factor didn't exist. We add the column with a default, then swap
  // the PK. Idempotent — second run is a no-op.
  await p.query(`ALTER TABLE crux_daily ADD COLUMN IF NOT EXISTS form_factor TEXT NOT NULL DEFAULT 'ALL'`).catch(() => {});
  await p.query(`ALTER TABLE crux_daily DROP CONSTRAINT IF EXISTS crux_daily_pkey`).catch(() => {});
  await p.query(`ALTER TABLE crux_daily ADD PRIMARY KEY (date, form_factor)`).catch(() => {});

  // Per-page CrUX. One row per (date, page, form_factor). Date is the
  // fetch date (CrUX's queryRecord returns the current snapshot, not a
  // history per page), so accumulating snapshots over time gives us a
  // per-page trend automatically the same way gsc_top_queries does.
  await p.query(`
    CREATE TABLE IF NOT EXISTS crux_daily_by_page (
      date DATE NOT NULL,
      page TEXT NOT NULL,
      form_factor TEXT NOT NULL,
      lcp_p75 NUMERIC(10,2),
      inp_p75 NUMERIC(10,2),
      cls_p75 NUMERIC(8,4),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, page, form_factor)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_crux_page_date ON crux_daily_by_page(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_crux_page_path ON crux_daily_by_page(page)`);

  console.log('✅  Database tables ready');
}

export async function upsertDailyRows(rows) {
  const p = getPool();
  let upserted = 0;

  // Add columns if upgrading from older schema
  await p.query(`
    ALTER TABLE netsuite_daily ADD COLUMN IF NOT EXISTS quotes_adj_count INTEGER DEFAULT 0;
    ALTER TABLE netsuite_daily ADD COLUMN IF NOT EXISTS quotes_adj_total NUMERIC(15,2) DEFAULT 0;
  `).catch(() => {});

  for (const r of rows) {
    await p.query(`
      INSERT INTO netsuite_daily (date, quotes_count, quotes_total, quotes_adj_count, quotes_adj_total, orders_count, orders_total, shipped_count, shipped_total, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (date) DO UPDATE SET
        quotes_count = EXCLUDED.quotes_count,
        quotes_total = EXCLUDED.quotes_total,
        quotes_adj_count = EXCLUDED.quotes_adj_count,
        quotes_adj_total = EXCLUDED.quotes_adj_total,
        orders_count = EXCLUDED.orders_count,
        orders_total = EXCLUDED.orders_total,
        shipped_count = EXCLUDED.shipped_count,
        shipped_total = EXCLUDED.shipped_total,
        updated_at = NOW()
    `, [r.date, r.quotes_count, r.quotes_total, r.quotes_adj_count || 0, r.quotes_adj_total || 0, r.orders_count, r.orders_total, r.shipped_count, r.shipped_total]);
    upserted++;
  }

  return upserted;
}

export async function getAllDaily() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT date::text, quotes_count, quotes_total::float,
           COALESCE(quotes_adj_count, quotes_count) as quotes_adj_count,
           COALESCE(quotes_adj_total, quotes_total)::float as quotes_adj_total,
           orders_count, orders_total::float,
           shipped_count, shipped_total::float
    FROM netsuite_daily
    ORDER BY date ASC
  `);
  return rows;
}

export async function getRowCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as cnt FROM netsuite_daily');
  return parseInt(rows[0].cnt, 10);
}

export async function logFetch(status, rowsUpserted, error) {
  const p = getPool();
  await p.query(`
    INSERT INTO fetch_log (finished_at, status, rows_upserted, error)
    VALUES (NOW(), $1, $2, $3)
  `, [status, rowsUpserted, error]);
}

/**
 * Zero-fill missing calendar days in a daily array.
 *
 * NetSuite's GROUP BY only produces rows for days with activity, so the DB
 * has no rows for weekends, holidays, or any zero-activity day. That makes
 * the dashboard's "30 DMA" effectively a 30-business-day average regardless
 * of the Weekdays toggle. Zero-filling here gives every consumer a dense
 * calendar-day series, so rolling averages are proper calendar-day means and
 * the Weekdays filter does what it says.
 *
 * Shape of the zero row is inferred from the first input row: every key
 * other than `date` is copied with value 0.
 */
export function zerofillDaily(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(sorted.map(r => [r.date, r]));
  const zeroShape = Object.fromEntries(
    Object.keys(sorted[0]).filter(k => k !== 'date').map(k => [k, 0])
  );

  const filled = [];
  const cur = new Date(sorted[0].date + 'T00:00:00Z');
  const end = new Date(sorted[sorted.length - 1].date + 'T00:00:00Z');
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10);
    filled.push(byDate.has(iso) ? byDate.get(iso) : { date: iso, ...zeroShape });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return filled;
}

// ── Dim (line-level) helpers ─────────────────────────────────────────

export async function upsertDailyDimRows(rows, { replaceSince = null } = {}) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM netsuite_daily_dim WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO netsuite_daily_dim
          (date, trantype, part_group, salesrep_id, salesrep_name, size_bucket, is_first, txn_count, line_total, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (date, trantype, part_group, salesrep_id, size_bucket, is_first) DO UPDATE SET
          salesrep_name = EXCLUDED.salesrep_name,
          txn_count     = EXCLUDED.txn_count,
          line_total    = EXCLUDED.line_total,
          updated_at    = NOW()
      `, [
        r.date, r.trantype,
        r.part_group ?? '',
        r.salesrep_id ?? '',
        r.salesrep_name ?? null,
        r.size_bucket ?? 'Under $5K',
        r.is_first ?? 'N',
        r.txn_count ?? 0,
        r.line_total ?? 0,
      ]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getDimRowCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as cnt FROM netsuite_daily_dim');
  return parseInt(rows[0].cnt, 10);
}

export async function getFilterOptions() {
  const p = getPool();
  const [pg, sr] = await Promise.all([
    p.query(`
      SELECT part_group, SUM(line_total)::float as total
      FROM netsuite_daily_dim
      WHERE part_group <> ''
      GROUP BY part_group
      ORDER BY total DESC
    `),
    p.query(`
      SELECT salesrep_id, MAX(salesrep_name) as salesrep_name, SUM(line_total)::float as total
      FROM netsuite_daily_dim
      WHERE salesrep_id <> ''
      GROUP BY salesrep_id
      ORDER BY total DESC
    `),
  ]);
  return {
    partGroups: pg.rows.map(r => ({ value: r.part_group, total: r.total })),
    salesReps: sr.rows.map(r => ({ id: r.salesrep_id, name: r.salesrep_name || r.salesrep_id, total: r.total })),
  };
}

// Single source of truth for size buckets. `max` is the exclusive upper bound
// on |t.total| in $; the last bucket has max=null and catches everything above.
// The SQL CASE in fetch-netsuite-dim.js is derived from this — do not define
// thresholds or labels in two places.
export const SIZE_BUCKET_CONFIG = [
  { label: 'Under $5K',   max: 5000   },
  { label: '$5K-$25K',    max: 25000  },
  { label: '$25K-$100K',  max: 100000 },
  { label: '$100K+',      max: null   },
];
export const SIZE_BUCKETS = SIZE_BUCKET_CONFIG.map(b => b.label);

/**
 * Return per-part-group daily rows from the dim table. Used by the
 * by-part-group analysis tab to compute lead-lag r for each part group
 * independently. Rolls up across sales reps within each part group.
 * Optional sizeBucket filter narrows to one size-band.
 */
export async function getDailyByPartGroup({ sizeBucket, customerType = 'all' } = {}) {
  const p = getPool();
  const where = [`part_group <> ''`];
  const params = [];
  if (sizeBucket) {
    params.push(sizeBucket);
    where.push(`size_bucket = $${params.length}`);
  }
  if (customerType === 'new')    where.push(`is_first = 'Y'`);
  if (customerType === 'repeat') where.push(`is_first = 'N'`);
  const sql = `
    SELECT
      part_group,
      date::text as date,
      SUM(CASE WHEN trantype = 'quote'   THEN txn_count  ELSE 0 END)::int   as quotes_count,
      SUM(CASE WHEN trantype = 'quote'   THEN line_total ELSE 0 END)::float as quotes_total,
      SUM(CASE WHEN trantype = 'order'   THEN txn_count  ELSE 0 END)::int   as orders_count,
      SUM(CASE WHEN trantype = 'order'   THEN line_total ELSE 0 END)::float as orders_total,
      SUM(CASE WHEN trantype = 'shipped' THEN txn_count  ELSE 0 END)::int   as shipped_count,
      SUM(CASE WHEN trantype = 'shipped' THEN line_total ELSE 0 END)::float as shipped_total
    FROM netsuite_daily_dim
    WHERE ${where.join(' AND ')}
    GROUP BY part_group, date
    ORDER BY part_group, date ASC
  `;
  const { rows } = await p.query(sql, params);
  const byPg = new Map();
  for (const r of rows) {
    if (!byPg.has(r.part_group)) byPg.set(r.part_group, []);
    byPg.get(r.part_group).push({
      date: r.date,
      quotes_count: r.quotes_count, quotes_total: r.quotes_total,
      orders_count: r.orders_count, orders_total: r.orders_total,
      shipped_count: r.shipped_count, shipped_total: r.shipped_total,
    });
  }
  return Array.from(byPg.entries()).map(([part_group, daily]) => ({ part_group, daily }));
}

/**
 * Return the size-bucket list with per-bucket quote counts + totals so the UI
 * can show "Under $5K (4,062 quotes)" etc. on the filter chips.
 */
export async function getSizeBucketSummary() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT
      size_bucket,
      SUM(CASE WHEN trantype = 'quote' THEN txn_count  ELSE 0 END)::int   as quote_count,
      SUM(CASE WHEN trantype = 'quote' THEN line_total ELSE 0 END)::float as quote_total
    FROM netsuite_daily_dim
    GROUP BY size_bucket
  `);
  const byBucket = Object.fromEntries(rows.map(r => [r.size_bucket, r]));
  return SIZE_BUCKETS.map(b => ({
    bucket: b,
    quote_count: byBucket[b]?.quote_count ?? 0,
    quote_total: byBucket[b]?.quote_total ?? 0,
  }));
}

/**
 * Return daily rows (same shape as getAllDaily) aggregated from the dim table
 * with optional filters on part_group, salesrep_id, customerType, and size
 * bucket.
 *
 * customerType: 'all' | 'new' | 'repeat'  (defaults to 'all')
 *   'new'    → only rows where is_first = 'Y' (customer's first quote/order)
 *   'repeat' → only rows where is_first = 'N' (existing-customer activity)
 */
export async function getDailyDimFiltered({ partGroups = [], salesReps = [], customerType = 'all', sizeBucket = null } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (partGroups.length > 0) {
    params.push(partGroups);
    where.push(`part_group = ANY($${params.length})`);
  }
  if (salesReps.length > 0) {
    params.push(salesReps.map(String));
    where.push(`salesrep_id = ANY($${params.length})`);
  }
  if (sizeBucket) {
    params.push(sizeBucket);
    where.push(`size_bucket = $${params.length}`);
  }
  if (customerType === 'new')    where.push(`is_first = 'Y'`);
  if (customerType === 'repeat') where.push(`is_first = 'N'`);
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const sql = `
    SELECT
      date::text as date,
      SUM(CASE WHEN trantype = 'quote'     THEN txn_count  ELSE 0 END)::int   as quotes_count,
      SUM(CASE WHEN trantype = 'quote'     THEN line_total ELSE 0 END)::float as quotes_total,
      SUM(CASE WHEN trantype = 'quote_adj' THEN txn_count  ELSE 0 END)::int   as quotes_adj_count,
      SUM(CASE WHEN trantype = 'quote_adj' THEN line_total ELSE 0 END)::float as quotes_adj_total,
      SUM(CASE WHEN trantype = 'order'     THEN txn_count  ELSE 0 END)::int   as orders_count,
      SUM(CASE WHEN trantype = 'order'     THEN line_total ELSE 0 END)::float as orders_total,
      SUM(CASE WHEN trantype = 'shipped'   THEN txn_count  ELSE 0 END)::int   as shipped_count,
      SUM(CASE WHEN trantype = 'shipped'   THEN line_total ELSE 0 END)::float as shipped_total
    FROM netsuite_daily_dim
    ${whereSQL}
    GROUP BY date
    ORDER BY date ASC
  `;
  const { rows } = await p.query(sql, params);
  return rows;
}

// ── GA4 helpers ──────────────────────────────────────────────────────

export async function upsertGa4Daily(rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM ga4_daily WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO ga4_daily
          (date, sessions, total_users, new_users, engaged_sessions, screen_page_views,
           avg_session_duration, bounce_rate, conversions, total_revenue, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (date) DO UPDATE SET
          sessions = EXCLUDED.sessions,
          total_users = EXCLUDED.total_users,
          new_users = EXCLUDED.new_users,
          engaged_sessions = EXCLUDED.engaged_sessions,
          screen_page_views = EXCLUDED.screen_page_views,
          avg_session_duration = EXCLUDED.avg_session_duration,
          bounce_rate = EXCLUDED.bounce_rate,
          conversions = EXCLUDED.conversions,
          total_revenue = EXCLUDED.total_revenue,
          updated_at = NOW()
      `, [
        r.date, r.sessions ?? 0, r.total_users ?? 0, r.new_users ?? 0,
        r.engaged_sessions ?? 0, r.screen_page_views ?? 0,
        r.avg_session_duration ?? 0, r.bounce_rate ?? 0,
        r.conversions ?? 0, r.total_revenue ?? 0,
      ]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertGa4DailyByCampaign(rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM ga4_daily_by_campaign WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO ga4_daily_by_campaign
          (date, campaign_name, sessions, total_users, new_users, engaged_sessions,
           screen_page_views, conversions, total_revenue, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (date, campaign_name) DO UPDATE SET
          sessions = EXCLUDED.sessions,
          total_users = EXCLUDED.total_users,
          new_users = EXCLUDED.new_users,
          engaged_sessions = EXCLUDED.engaged_sessions,
          screen_page_views = EXCLUDED.screen_page_views,
          conversions = EXCLUDED.conversions,
          total_revenue = EXCLUDED.total_revenue,
          updated_at = NOW()
      `, [
        r.date, r.campaign_name,
        r.sessions ?? 0, r.total_users ?? 0, r.new_users ?? 0,
        r.engaged_sessions ?? 0, r.screen_page_views ?? 0,
        r.conversions ?? 0, r.total_revenue ?? 0,
      ]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getGa4Daily() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT date::text,
      sessions, total_users, new_users, engaged_sessions, screen_page_views,
      avg_session_duration::float as avg_session_duration,
      bounce_rate::float as bounce_rate,
      conversions,
      total_revenue::float as total_revenue
    FROM ga4_daily
    ORDER BY date ASC
  `);
  return rows;
}

export async function getGa4DailyFiltered({ campaigns = [] } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (campaigns.length > 0) {
    params.push(campaigns);
    where.push(`campaign_name = ANY($${params.length})`);
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await p.query(`
    SELECT
      date::text,
      SUM(sessions)::int          as sessions,
      SUM(total_users)::int       as total_users,
      SUM(new_users)::int         as new_users,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(screen_page_views)::int as screen_page_views,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue
    FROM ga4_daily_by_campaign
    ${whereSQL}
    GROUP BY date
    ORDER BY date ASC
  `, params);
  return rows;
}

/**
 * Campaign options for the filter dropdown.
 *
 * Returns only campaigns that had at least one session in the last 30 days.
 * That filters paused / retired PPC campaigns so the dropdown stays focused
 * on what's currently running.
 */
export async function getGa4CampaignOptions({ activeDays = 30 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT campaign_name,
      SUM(sessions)::int as sessions,
      SUM(conversions)::int as conversions,
      MAX(date)::text as last_seen
    FROM ga4_daily_by_campaign
    WHERE campaign_name <> ''
      AND campaign_name <> '(not set)'
      AND campaign_name <> '(direct)'
    GROUP BY campaign_name
    HAVING MAX(date) >= CURRENT_DATE - ($1::int || ' days')::interval
    ORDER BY sessions DESC
  `, [activeDays]);
  return rows.map(r => ({
    value: r.campaign_name,
    sessions: r.sessions,
    conversions: r.conversions,
    last_seen: r.last_seen,
  }));
}

export async function getGa4RowCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as cnt FROM ga4_daily');
  return parseInt(rows[0].cnt, 10);
}

// ── GA4 by-channel helpers ──────────────────────────────────────────

export async function upsertGa4DailyByChannel(rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM ga4_daily_by_channel WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO ga4_daily_by_channel
          (date, channel, sessions, total_users, new_users, engaged_sessions,
           screen_page_views, conversions, total_revenue, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (date, channel) DO UPDATE SET
          sessions = EXCLUDED.sessions,
          total_users = EXCLUDED.total_users,
          new_users = EXCLUDED.new_users,
          engaged_sessions = EXCLUDED.engaged_sessions,
          screen_page_views = EXCLUDED.screen_page_views,
          conversions = EXCLUDED.conversions,
          total_revenue = EXCLUDED.total_revenue,
          updated_at = NOW()
      `, [
        r.date, r.channel,
        r.sessions ?? 0, r.total_users ?? 0, r.new_users ?? 0,
        r.engaged_sessions ?? 0, r.screen_page_views ?? 0,
        r.conversions ?? 0, r.total_revenue ?? 0,
      ]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getGa4DailyByChannel({ channels = [] } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (channels.length > 0) {
    params.push(channels);
    where.push(`channel = ANY($${params.length})`);
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await p.query(`
    SELECT
      date::text,
      SUM(sessions)::int          as sessions,
      SUM(total_users)::int       as total_users,
      SUM(new_users)::int         as new_users,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(screen_page_views)::int as screen_page_views,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue
    FROM ga4_daily_by_channel
    ${whereSQL}
    GROUP BY date
    ORDER BY date ASC
  `, params);
  return rows;
}

export async function getGa4ChannelOptions() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT channel,
      SUM(sessions)::int as sessions,
      SUM(conversions)::int as conversions
    FROM ga4_daily_by_channel
    WHERE channel <> ''
    GROUP BY channel
    ORDER BY sessions DESC
  `);
  return rows.map(r => ({
    value: r.channel,
    sessions: r.sessions,
    conversions: r.conversions,
  }));
}

// Per-channel daily rows (NOT aggregated across channels). The frontend
// pivots this into a stacked chart + per-channel conversion table.
export async function getGa4ChannelsDaily() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT
      date::text,
      channel,
      sessions,
      total_users,
      new_users,
      engaged_sessions,
      screen_page_views,
      conversions,
      total_revenue::float as total_revenue
    FROM ga4_daily_by_channel
    WHERE channel <> ''
    ORDER BY date ASC, channel ASC
  `);
  return rows;
}

// Per-campaign aggregate stats over [since, until] (both optional, ISO dates).
// Returns one row per campaign sorted by sessions DESC, including conversion
// rate and the number of active days in the window for the campaign.
export async function getGa4CampaignStats({ since = null, until = null } = {}) {
  const p = getPool();
  const where = [
    `campaign_name <> ''`,
    `campaign_name <> '(not set)'`,
    `campaign_name <> '(direct)'`,
  ];
  const params = [];
  if (since) { params.push(since); where.push(`date >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`date <= $${params.length}::date`); }
  const { rows } = await p.query(`
    SELECT
      campaign_name,
      SUM(sessions)::int          as sessions,
      SUM(total_users)::int       as total_users,
      SUM(new_users)::int         as new_users,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(screen_page_views)::int as pageviews,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue,
      COUNT(DISTINCT date)::int   as active_days,
      MIN(date)::text             as first_seen,
      MAX(date)::text             as last_seen
    FROM ga4_daily_by_campaign
    WHERE ${where.join(' AND ')}
    GROUP BY campaign_name
    ORDER BY sessions DESC
  `, params);
  return rows.map(r => ({
    campaign_name: r.campaign_name,
    sessions: r.sessions,
    total_users: r.total_users,
    new_users: r.new_users,
    engaged_sessions: r.engaged_sessions,
    pageviews: r.pageviews,
    conversions: r.conversions,
    total_revenue: r.total_revenue,
    active_days: r.active_days,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
    engagement_rate: r.sessions > 0 ? r.engaged_sessions / r.sessions : null,
  }));
}

// ── GA4 dim-expansion helpers ───────────────────────────────────────
// These tables all share the same metric set (sessions, users, etc.)
// differing only by the dim column(s). Upserts are factored through
// _upsertGa4Dim where possible; getters are explicit because each one
// returns a different aggregate shape.

const STD_GA4_METRIC_COLS = [
  'sessions', 'total_users', 'new_users', 'engaged_sessions',
  'screen_page_views', 'conversions', 'total_revenue',
];

async function _upsertGa4Dim(table, dimCols, rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM ${table} WHERE date >= $1`, [replaceSince]);
    }
    const cols = ['date', ...dimCols, ...STD_GA4_METRIC_COLS];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updateSet = STD_GA4_METRIC_COLS
      .map(c => `${c} = EXCLUDED.${c}`)
      .concat('updated_at = NOW()')
      .join(', ');
    const conflict = ['date', ...dimCols].join(', ');
    const sql = `
      INSERT INTO ${table} (${cols.join(', ')}, updated_at)
      VALUES (${placeholders}, NOW())
      ON CONFLICT (${conflict}) DO UPDATE SET ${updateSet}
    `;
    let upserted = 0;
    for (const r of rows) {
      const params = [
        r.date,
        ...dimCols.map(c => r[c]),
        ...STD_GA4_METRIC_COLS.map(c => r[c] ?? 0),
      ];
      await client.query(sql, params);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertGa4DailyByLandingPage(rows, opts) {
  return _upsertGa4Dim('ga4_daily_by_landing_page', ['landing_page'], rows, opts);
}
export async function upsertGa4DailyBySourceMedium(rows, opts) {
  return _upsertGa4Dim('ga4_daily_by_source_medium', ['source', 'medium'], rows, opts);
}
export async function upsertGa4DailyByFirstTouch(rows, opts) {
  return _upsertGa4Dim('ga4_daily_by_first_touch', ['first_source', 'first_medium'], rows, opts);
}
export async function upsertGa4DailyByDevice(rows, opts) {
  return _upsertGa4Dim('ga4_daily_by_device', ['device'], rows, opts);
}
export async function upsertGa4DailyByCountry(rows, opts) {
  return _upsertGa4Dim('ga4_daily_by_country', ['country'], rows, opts);
}
export async function upsertGa4DailyByNewVsReturning(rows, opts) {
  return _upsertGa4Dim('ga4_daily_by_new_vs_returning', ['visitor_type'], rows, opts);
}

// Event table has a different metric set (event_count + conversions + revenue)
// so it gets its own upsert.
export async function upsertGa4DailyByEvent(rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM ga4_daily_by_event WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO ga4_daily_by_event
          (date, event_name, event_count, conversions, total_revenue, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (date, event_name) DO UPDATE SET
          event_count   = EXCLUDED.event_count,
          conversions   = EXCLUDED.conversions,
          total_revenue = EXCLUDED.total_revenue,
          updated_at    = NOW()
      `, [r.date, r.event_name, r.event_count ?? 0, r.conversions ?? 0, r.total_revenue ?? 0]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Aggregation getters — each returns one row per dim grouping over the
// optional [since, until] window. The shape mirrors getGa4CampaignStats so
// the UI tables can be reused.

async function _windowParams(since, until) {
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`date >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`date <= $${params.length}::date`); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function getGa4LandingPageStats({ since = null, until = null, limit = 100 } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const { rows } = await p.query(`
    SELECT landing_page,
      SUM(sessions)::int          as sessions,
      SUM(total_users)::int       as total_users,
      SUM(new_users)::int         as new_users,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(screen_page_views)::int as pageviews,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue,
      COUNT(DISTINCT date)::int   as active_days
    FROM ga4_daily_by_landing_page
    ${whereSql}
    GROUP BY landing_page
    HAVING SUM(sessions) > 0
    ORDER BY sessions DESC
    LIMIT ${Math.min(500, Math.max(10, parseInt(limit, 10) || 100))}
  `, params);
  return rows.map(r => ({
    landing_page: r.landing_page,
    sessions: r.sessions,
    total_users: r.total_users,
    new_users: r.new_users,
    engaged_sessions: r.engaged_sessions,
    pageviews: r.pageviews,
    conversions: r.conversions,
    total_revenue: r.total_revenue,
    active_days: r.active_days,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
    engagement_rate: r.sessions > 0 ? r.engaged_sessions / r.sessions : null,
  }));
}

export async function getGa4SourceMediumStats({ since = null, until = null, limit = 100 } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const { rows } = await p.query(`
    SELECT source, medium,
      SUM(sessions)::int          as sessions,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(new_users)::int         as new_users,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue,
      COUNT(DISTINCT date)::int   as active_days
    FROM ga4_daily_by_source_medium
    ${whereSql}
    GROUP BY source, medium
    HAVING SUM(sessions) > 0
    ORDER BY sessions DESC
    LIMIT ${Math.min(500, Math.max(10, parseInt(limit, 10) || 100))}
  `, params);
  return rows.map(r => ({
    source: r.source, medium: r.medium,
    sessions: r.sessions, engaged_sessions: r.engaged_sessions,
    new_users: r.new_users, conversions: r.conversions,
    total_revenue: r.total_revenue, active_days: r.active_days,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
    engagement_rate: r.sessions > 0 ? r.engaged_sessions / r.sessions : null,
  }));
}

export async function getGa4FirstTouchStats({ since = null, until = null, limit = 100 } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const { rows } = await p.query(`
    SELECT first_source, first_medium,
      SUM(sessions)::int          as sessions,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(new_users)::int         as new_users,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue
    FROM ga4_daily_by_first_touch
    ${whereSql}
    GROUP BY first_source, first_medium
    HAVING SUM(sessions) > 0
    ORDER BY sessions DESC
    LIMIT ${Math.min(500, Math.max(10, parseInt(limit, 10) || 100))}
  `, params);
  return rows.map(r => ({
    first_source: r.first_source, first_medium: r.first_medium,
    sessions: r.sessions, engaged_sessions: r.engaged_sessions,
    new_users: r.new_users, conversions: r.conversions,
    total_revenue: r.total_revenue,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
  }));
}

export async function getGa4DeviceStats({ since = null, until = null } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const { rows } = await p.query(`
    SELECT device,
      SUM(sessions)::int          as sessions,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(new_users)::int         as new_users,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue
    FROM ga4_daily_by_device
    ${whereSql}
    GROUP BY device
    HAVING SUM(sessions) > 0
    ORDER BY sessions DESC
  `, params);
  return rows.map(r => ({
    device: r.device,
    sessions: r.sessions, engaged_sessions: r.engaged_sessions,
    new_users: r.new_users, conversions: r.conversions,
    total_revenue: r.total_revenue,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
    engagement_rate: r.sessions > 0 ? r.engaged_sessions / r.sessions : null,
  }));
}

export async function getGa4CountryStats({ since = null, until = null, limit = 25 } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const { rows } = await p.query(`
    SELECT country,
      SUM(sessions)::int          as sessions,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(new_users)::int         as new_users,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue
    FROM ga4_daily_by_country
    ${whereSql}
    GROUP BY country
    HAVING SUM(sessions) > 0
    ORDER BY sessions DESC
    LIMIT ${Math.min(500, Math.max(5, parseInt(limit, 10) || 25))}
  `, params);
  return rows.map(r => ({
    country: r.country,
    sessions: r.sessions, engaged_sessions: r.engaged_sessions,
    new_users: r.new_users, conversions: r.conversions,
    total_revenue: r.total_revenue,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
  }));
}

export async function getGa4EventStats({ since = null, until = null, conversionsOnly = false } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const havingSql = conversionsOnly ? 'HAVING SUM(conversions) > 0' : 'HAVING SUM(event_count) > 0';
  const { rows } = await p.query(`
    SELECT event_name,
      SUM(event_count)::bigint   as event_count,
      SUM(conversions)::int      as conversions,
      SUM(total_revenue)::float  as total_revenue,
      COUNT(DISTINCT date)::int  as active_days
    FROM ga4_daily_by_event
    ${whereSql}
    GROUP BY event_name
    ${havingSql}
    ORDER BY ${conversionsOnly ? 'conversions' : 'event_count'} DESC
    LIMIT 200
  `, params);
  return rows.map(r => ({
    event_name: r.event_name,
    event_count: Number(r.event_count) || 0,
    conversions: r.conversions,
    total_revenue: r.total_revenue,
    active_days: r.active_days,
  }));
}

export async function getGa4NewVsReturningStats({ since = null, until = null } = {}) {
  const p = getPool();
  const { whereSql, params } = await _windowParams(since, until);
  const { rows } = await p.query(`
    SELECT visitor_type,
      SUM(sessions)::int          as sessions,
      SUM(engaged_sessions)::int  as engaged_sessions,
      SUM(conversions)::int       as conversions,
      SUM(total_revenue)::float   as total_revenue
    FROM ga4_daily_by_new_vs_returning
    ${whereSql}
    GROUP BY visitor_type
    HAVING SUM(sessions) > 0
    ORDER BY sessions DESC
  `, params);
  return rows.map(r => ({
    visitor_type: r.visitor_type,
    sessions: r.sessions, engaged_sessions: r.engaged_sessions,
    conversions: r.conversions, total_revenue: r.total_revenue,
    conversion_rate: r.sessions > 0 ? r.conversions / r.sessions : null,
    engagement_rate: r.sessions > 0 ? r.engaged_sessions / r.sessions : null,
  }));
}

// ── Google Ads helpers ───────────────────────────────────────────────

export async function upsertGoogleAdsDailyByCampaign(rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM google_ads_daily_by_campaign WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO google_ads_daily_by_campaign
          (date, campaign_id, campaign_name, channel_type, status,
           cost, clicks, impressions, conversions, conversion_value, avg_cpc, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (date, campaign_id) DO UPDATE SET
          campaign_name    = EXCLUDED.campaign_name,
          channel_type     = EXCLUDED.channel_type,
          status           = EXCLUDED.status,
          cost             = EXCLUDED.cost,
          clicks           = EXCLUDED.clicks,
          impressions      = EXCLUDED.impressions,
          conversions      = EXCLUDED.conversions,
          conversion_value = EXCLUDED.conversion_value,
          avg_cpc          = EXCLUDED.avg_cpc,
          updated_at       = NOW()
      `, [
        r.date, r.campaign_id,
        r.campaign_name ?? '', r.channel_type ?? '', r.status ?? '',
        r.cost ?? 0, r.clicks ?? 0, r.impressions ?? 0,
        r.conversions ?? 0, r.conversion_value ?? 0, r.avg_cpc ?? 0,
      ]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getGoogleAdsRowCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as cnt FROM google_ads_daily_by_campaign');
  return parseInt(rows[0].cnt, 10);
}

// Aggregate daily totals across all campaigns — feeds the Paid tab's DMA
// charts. CTR and avg CPC are re-derived from the summed numerators and
// denominators so a sparse high-CPC day can't skew the trend.
export async function getGoogleAdsDaily() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT
      date::text,
      SUM(cost)::float             as cost,
      SUM(clicks)::int             as clicks,
      SUM(impressions)::int        as impressions,
      SUM(conversions)::float      as conversions,
      SUM(conversion_value)::float as conversion_value
    FROM google_ads_daily_by_campaign
    GROUP BY date
    ORDER BY date ASC
  `);
  return rows.map(r => ({
    date: r.date,
    cost: r.cost,
    clicks: r.clicks,
    impressions: r.impressions,
    conversions: r.conversions,
    conversion_value: r.conversion_value,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : null,
    avg_cpc: r.clicks > 0 ? r.cost / r.clicks : null,
  }));
}

export async function getGoogleAdsCampaignStats({ since = null, until = null } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`date >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`date <= $${params.length}::date`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await p.query(`
    SELECT
      campaign_id,
      MAX(campaign_name)            as campaign_name,
      MAX(channel_type)             as channel_type,
      SUM(cost)::float              as cost,
      SUM(clicks)::int              as clicks,
      SUM(impressions)::int         as impressions,
      SUM(conversions)::float       as conversions,
      SUM(conversion_value)::float  as conversion_value,
      COUNT(DISTINCT date)::int     as active_days
    FROM google_ads_daily_by_campaign
    ${whereSQL}
    GROUP BY campaign_id
    ORDER BY cost DESC
  `, params);
  return rows.map(r => ({
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name,
    channel_type: r.channel_type,
    cost: r.cost,
    clicks: r.clicks,
    impressions: r.impressions,
    conversions: r.conversions,
    conversion_value: r.conversion_value,
    active_days: r.active_days,
    ctr: r.impressions > 0 ? r.clicks / r.impressions : null,
    avg_cpc: r.clicks > 0 ? r.cost / r.clicks : null,
    cost_per_conversion: r.conversions > 0 ? r.cost / r.conversions : null,
    roas: r.cost > 0 ? r.conversion_value / r.cost : null,
  }));
}

// ── HubSpot helpers ──────────────────────────────────────────────────

export async function upsertHubSpotDeals(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO hubspot_deals
          (deal_id, deal_name, amount, close_date, stage, stage_label, pipeline,
           owner_id, source, source_data_1, source_data_2, campaign_guid,
           is_closed_won, created_at, modified_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
        ON CONFLICT (deal_id) DO UPDATE SET
          deal_name     = EXCLUDED.deal_name,
          amount        = EXCLUDED.amount,
          close_date    = EXCLUDED.close_date,
          stage         = EXCLUDED.stage,
          stage_label   = EXCLUDED.stage_label,
          pipeline      = EXCLUDED.pipeline,
          owner_id      = EXCLUDED.owner_id,
          source        = EXCLUDED.source,
          source_data_1 = EXCLUDED.source_data_1,
          source_data_2 = EXCLUDED.source_data_2,
          campaign_guid = EXCLUDED.campaign_guid,
          is_closed_won = EXCLUDED.is_closed_won,
          created_at    = EXCLUDED.created_at,
          modified_at   = EXCLUDED.modified_at,
          updated_at    = NOW()
      `, [
        r.deal_id, r.deal_name ?? '', r.amount ?? 0, r.close_date,
        r.stage ?? '', r.stage_label ?? '', r.pipeline ?? '',
        r.owner_id ?? '', r.source ?? '',
        r.source_data_1 ?? '', r.source_data_2 ?? '', r.campaign_guid ?? '',
        !!r.is_closed_won, r.created_at, r.modified_at,
      ]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertHubSpotCampaigns(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  let upserted = 0;
  for (const r of rows) {
    await p.query(`
      INSERT INTO hubspot_campaigns (campaign_id, name, type, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (campaign_id) DO UPDATE SET
        name       = EXCLUDED.name,
        type       = EXCLUDED.type,
        created_at = EXCLUDED.created_at,
        updated_at = NOW()
    `, [r.campaign_id, r.name ?? '', r.type ?? '', r.created_at]);
    upserted++;
  }
  return upserted;
}

export async function getHubSpotDealCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as cnt FROM hubspot_deals');
  return parseInt(rows[0].cnt, 10);
}

// Closed-won deals in [since, until], optionally narrowed to one attribution
// source. Returns raw deal rows for the Paid/SEO campaign tables, plus
// pre-aggregated source totals for the KPI tiles.
export async function getHubSpotDealsWindow({ since = null, until = null, source = null } = {}) {
  const p = getPool();
  const where = [`is_closed_won = TRUE`, `close_date IS NOT NULL`];
  const params = [];
  if (since)  { params.push(since);  where.push(`close_date >= $${params.length}::date`); }
  if (until)  { params.push(until);  where.push(`close_date <= $${params.length}::date`); }
  if (source) { params.push(source); where.push(`source = $${params.length}`); }
  const whereSQL = 'WHERE ' + where.join(' AND ');
  const { rows } = await p.query(`
    SELECT deal_id, deal_name, amount::float as amount, close_date::text,
           source, source_data_1, source_data_2, campaign_guid
    FROM hubspot_deals
    ${whereSQL}
    ORDER BY close_date DESC, amount DESC
  `, params);
  return rows;
}

// Daily won-deal counts + revenue by source — feeds DMA charts on both tabs.
// Returns one row per (date, source) so the frontend can filter to the
// attribution source it cares about.
export async function getHubSpotDealsDailyBySource({ since = null } = {}) {
  const p = getPool();
  const params = [];
  const where = [`is_closed_won = TRUE`, `close_date IS NOT NULL`];
  if (since) { params.push(since); where.push(`close_date >= $${params.length}::date`); }
  const { rows } = await p.query(`
    SELECT
      close_date::text as date,
      COALESCE(NULLIF(source, ''), 'UNKNOWN') as source,
      COUNT(*)::int     as deals,
      SUM(amount)::float as revenue
    FROM hubspot_deals
    WHERE ${where.join(' AND ')}
    GROUP BY close_date, source
    ORDER BY close_date ASC
  `, params);
  return rows;
}

// Distinct source labels HubSpot has used. Used by the frontend to populate
// a source filter dropdown; the bare strings come from HubSpot unchanged.
export async function getHubSpotSources() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT COALESCE(NULLIF(source, ''), 'UNKNOWN') as source, COUNT(*)::int as deals
    FROM hubspot_deals
    WHERE is_closed_won = TRUE
    GROUP BY source
    ORDER BY deals DESC
  `);
  return rows;
}

// ── Google Search Console helpers ────────────────────────────────────

export async function upsertGscDaily(rows, { replaceSince = null } = {}) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    if (replaceSince) {
      await client.query(`DELETE FROM gsc_daily WHERE date >= $1`, [replaceSince]);
    }
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO gsc_daily (date, clicks, impressions, ctr, position, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (date) DO UPDATE SET
          clicks      = EXCLUDED.clicks,
          impressions = EXCLUDED.impressions,
          ctr         = EXCLUDED.ctr,
          position    = EXCLUDED.position,
          updated_at  = NOW()
      `, [r.date, r.clicks ?? 0, r.impressions ?? 0, r.ctr ?? 0, r.position ?? 0]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertGscTopQueries(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO gsc_top_queries (window_end_date, query, clicks, impressions, ctr, position, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (window_end_date, query) DO UPDATE SET
          clicks = EXCLUDED.clicks,
          impressions = EXCLUDED.impressions,
          ctr = EXCLUDED.ctr,
          position = EXCLUDED.position,
          updated_at = NOW()
      `, [r.window_end_date, r.query, r.clicks ?? 0, r.impressions ?? 0, r.ctr ?? 0, r.position ?? 0]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertGscTopPages(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO gsc_top_pages (window_end_date, page, clicks, impressions, ctr, position, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (window_end_date, page) DO UPDATE SET
          clicks = EXCLUDED.clicks,
          impressions = EXCLUDED.impressions,
          ctr = EXCLUDED.ctr,
          position = EXCLUDED.position,
          updated_at = NOW()
      `, [r.window_end_date, r.page, r.clicks ?? 0, r.impressions ?? 0, r.ctr ?? 0, r.position ?? 0]);
      upserted++;
    }
    await client.query('COMMIT');
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getGscRowCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*) as cnt FROM gsc_daily');
  return parseInt(rows[0].cnt, 10);
}

export async function getGscDaily() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT date::text,
      clicks, impressions,
      ctr::float      as ctr,
      position::float as position
    FROM gsc_daily
    ORDER BY date ASC
  `);
  return rows;
}

// Latest window snapshot for the SEO tab's top-queries / top-pages tables.
// kind: 'query' | 'page'. Defaults to the most recent window_end_date in the
// table; callers can pin a specific window via windowEnd.
export async function getGscTop({ kind, windowEnd = null, limit = 100 } = {}) {
  const p = getPool();
  const table = kind === 'page' ? 'gsc_top_pages' : 'gsc_top_queries';
  const dimCol = kind === 'page' ? 'page' : 'query';
  let end = windowEnd;
  if (!end) {
    const { rows } = await p.query(`SELECT MAX(window_end_date)::text as d FROM ${table}`);
    end = rows[0]?.d;
    if (!end) return { window_end: null, rows: [] };
  }
  const { rows } = await p.query(`
    SELECT ${dimCol} as dimension,
      clicks, impressions,
      ctr::float      as ctr,
      position::float as position
    FROM ${table}
    WHERE window_end_date = $1::date
    ORDER BY clicks DESC
    LIMIT $2
  `, [end, limit]);
  return { window_end: end, rows };
}

// Trend over time for a specific GSC query — uses the natural snapshot
// accumulation from gsc_top_queries (PK is (window_end_date, query) so
// every fetch leaves a daily breadcrumb). Returns one row per snapshot
// the query appeared in, sorted oldest → newest. Useful for the SEO
// "is this query slipping in rank" diagnostic that catches losses
// 2-6 weeks before sessions reflect them.
export async function getGscQueryHistory({ query, sinceDate = null } = {}) {
  if (!query) return [];
  const p = getPool();
  const params = [query];
  let whereExtra = '';
  if (sinceDate) { params.push(sinceDate); whereExtra = `AND window_end_date >= $${params.length}::date`; }
  const { rows } = await p.query(`
    SELECT window_end_date::text as date,
      clicks, impressions,
      ctr::float      as ctr,
      position::float as position
    FROM gsc_top_queries
    WHERE query = $1
    ${whereExtra}
    ORDER BY window_end_date ASC
  `, params);
  return rows;
}

// "Most volatile" queries — top movers by absolute position delta between
// the most recent two snapshots. Surfaces queries that gained or lost
// ranking visibility week-over-week.
export async function getGscQueryMovers({ limit = 25 } = {}) {
  const p = getPool();
  const { rows: dateRows } = await p.query(`
    SELECT window_end_date::text as date
    FROM gsc_top_queries
    GROUP BY window_end_date
    ORDER BY window_end_date DESC
    LIMIT 2
  `);
  if (dateRows.length < 2) return { latest: null, prior: null, movers: [] };
  const [latest, prior] = dateRows.map(r => r.date);
  const { rows } = await p.query(`
    SELECT
      l.query,
      l.clicks::int        as latest_clicks,
      l.impressions::int   as latest_impressions,
      l.position::float    as latest_position,
      p.clicks::int        as prior_clicks,
      p.impressions::int   as prior_impressions,
      p.position::float    as prior_position,
      (p.position - l.position)::float       as position_delta,
      (l.clicks - COALESCE(p.clicks, 0))::int as click_delta
    FROM gsc_top_queries l
    LEFT JOIN gsc_top_queries p
      ON p.query = l.query AND p.window_end_date = $2::date
    WHERE l.window_end_date = $1::date
      AND p.position IS NOT NULL
    ORDER BY ABS(p.position - l.position) DESC NULLS LAST
    LIMIT $3
  `, [latest, prior, Math.min(200, Math.max(5, parseInt(limit, 10) || 25))]);
  return { latest, prior, movers: rows };
}

// ── CrUX (Core Web Vitals) helpers ──────────────────────────────────

export async function upsertCruxDaily(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  let upserted = 0;
  for (const r of rows) {
    if (!r.date) continue;
    await p.query(`
      INSERT INTO crux_daily (date, form_factor, lcp_p75, inp_p75, cls_p75, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (date, form_factor) DO UPDATE SET
        lcp_p75    = EXCLUDED.lcp_p75,
        inp_p75    = EXCLUDED.inp_p75,
        cls_p75    = EXCLUDED.cls_p75,
        updated_at = NOW()
    `, [r.date, r.form_factor || 'ALL', r.lcp_p75, r.inp_p75, r.cls_p75]);
    upserted++;
  }
  return upserted;
}

// Origin-level history. Defaults to the blended ALL series so existing
// callers / UIs keep working unchanged; the form-factor split is opt-in.
export async function getCruxDaily({ formFactor = 'ALL' } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT date::text, form_factor,
      lcp_p75::float as lcp_p75,
      inp_p75::float as inp_p75,
      cls_p75::float as cls_p75
    FROM crux_daily
    WHERE form_factor = $1
    ORDER BY date ASC
  `, [formFactor]);
  return rows;
}

export async function getCruxDailyAllFormFactors() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT date::text, form_factor,
      lcp_p75::float as lcp_p75,
      inp_p75::float as inp_p75,
      cls_p75::float as cls_p75
    FROM crux_daily
    ORDER BY date ASC, form_factor ASC
  `);
  return rows;
}

export async function upsertCruxDailyByPage(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  let upserted = 0;
  for (const r of rows) {
    if (!r.date || !r.page || !r.form_factor) continue;
    await p.query(`
      INSERT INTO crux_daily_by_page (date, page, form_factor, lcp_p75, inp_p75, cls_p75, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (date, page, form_factor) DO UPDATE SET
        lcp_p75    = EXCLUDED.lcp_p75,
        inp_p75    = EXCLUDED.inp_p75,
        cls_p75    = EXCLUDED.cls_p75,
        updated_at = NOW()
    `, [r.date, r.page, r.form_factor, r.lcp_p75, r.inp_p75, r.cls_p75]);
    upserted++;
  }
  return upserted;
}

// Latest per-page CWV reads — one row per (page, form_factor) using each
// ── Cross-source insights ────────────────────────────────────────────
//
// Joins across GA4 / Google Ads / GSC. Each individual table is already
// well-indexed by date and the joined tuple, so these queries stay cheap
// even on multi-year ranges.

// Per-campaign aggregation joining Google Ads cost/clicks to GA4
// sessions/conversions on (date, campaign_name). FULL OUTER JOIN so
// campaigns visible in only one side still surface — useful for spotting
// (a) Ads campaigns that GA4 isn't seeing (tagging issue), and
// (b) GA4 campaigns with no spend (organic UTM, manual tagging).
export async function getCampaignRoi({ since = null, until = null } = {}) {
  const p = getPool();
  // Both CTEs filter by date independently; each gets its own $-placeholders
  // even though the values are the same. dateFilter pushes into the shared
  // params array as it builds each WHERE clause, so positional indices stay
  // monotonic across the two CTEs.
  const params = [];
  const dateFilter = (alias) => {
    const conds = [];
    if (since) { params.push(since); conds.push(`${alias}.date >= $${params.length}::date`); }
    if (until) { params.push(until); conds.push(`${alias}.date <= $${params.length}::date`); }
    return conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  };
  const adsWhere = dateFilter('a');
  const ga4Where = dateFilter('g');
  const sql = `
    WITH ads AS (
      SELECT
        campaign_name,
        SUM(cost)::float             as cost,
        SUM(clicks)::int             as ad_clicks,
        SUM(impressions)::int        as ad_impressions,
        SUM(conversions)::float      as ad_conversions,
        SUM(conversion_value)::float as ad_conversion_value
      FROM google_ads_daily_by_campaign a
      ${adsWhere}
      GROUP BY campaign_name
    ),
    ga4 AS (
      SELECT
        campaign_name,
        SUM(sessions)::int         as ga4_sessions,
        SUM(engaged_sessions)::int as ga4_engaged_sessions,
        SUM(total_users)::int      as ga4_users,
        SUM(conversions)::int      as ga4_conversions,
        SUM(total_revenue)::float  as ga4_revenue
      FROM ga4_daily_by_campaign g
      ${ga4Where}
      GROUP BY campaign_name
    )
    SELECT
      COALESCE(a.campaign_name, g.campaign_name) as campaign_name,
      COALESCE(a.cost, 0)                 as cost,
      COALESCE(a.ad_clicks, 0)            as ad_clicks,
      COALESCE(a.ad_impressions, 0)       as ad_impressions,
      COALESCE(a.ad_conversions, 0)       as ad_conversions,
      COALESCE(a.ad_conversion_value, 0)  as ad_conversion_value,
      COALESCE(g.ga4_sessions, 0)         as ga4_sessions,
      COALESCE(g.ga4_engaged_sessions, 0) as ga4_engaged_sessions,
      COALESCE(g.ga4_users, 0)            as ga4_users,
      COALESCE(g.ga4_conversions, 0)      as ga4_conversions,
      COALESCE(g.ga4_revenue, 0)          as ga4_revenue,
      (a.campaign_name IS NOT NULL)       as in_ads,
      (g.campaign_name IS NOT NULL)       as in_ga4
    FROM ads a
    FULL OUTER JOIN ga4 g ON a.campaign_name = g.campaign_name
    ORDER BY COALESCE(a.cost, 0) DESC, COALESCE(g.ga4_sessions, 0) DESC
  `;
  const { rows } = await p.query(sql, params);
  return rows.map(r => ({
    campaign_name: r.campaign_name,
    cost: Number(r.cost),
    ad_clicks: Number(r.ad_clicks),
    ad_impressions: Number(r.ad_impressions),
    ad_conversions: Number(r.ad_conversions),
    ad_conversion_value: Number(r.ad_conversion_value),
    ga4_sessions: Number(r.ga4_sessions),
    ga4_engaged_sessions: Number(r.ga4_engaged_sessions),
    ga4_users: Number(r.ga4_users),
    ga4_conversions: Number(r.ga4_conversions),
    ga4_revenue: Number(r.ga4_revenue),
    in_ads: r.in_ads,
    in_ga4: r.in_ga4,
    // Derived metrics — null when denominator is zero so the UI shows "—".
    ctr: r.ad_impressions > 0 ? r.ad_clicks / r.ad_impressions : null,
    avg_cpc: r.ad_clicks > 0 ? r.cost / r.ad_clicks : null,
    cost_per_session: r.ga4_sessions > 0 ? r.cost / r.ga4_sessions : null,
    cost_per_ga4_conv: r.ga4_conversions > 0 ? r.cost / r.ga4_conversions : null,
    roas: r.cost > 0 ? r.ga4_revenue / r.cost : null,
    sessions_per_click: r.ad_clicks > 0 ? r.ga4_sessions / r.ad_clicks : null,
  }));
}

// GSC top-pages snapshot joined to GA4 landing-page metrics aggregated
// across the same 28-day window. URL normalization: strip protocol+host
// from GSC's full URL, strip querystring from GA4's path-with-querystring.
// Result: ranked search pages with engagement/conversion alongside.
export async function getPagePerformance({ limit = 100 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    WITH latest_gsc AS (
      SELECT MAX(window_end_date) as max_date FROM gsc_top_pages
    ),
    gsc AS (
      SELECT
        regexp_replace(page, '^https?://[^/]+', '') as path,
        page                  as full_url,
        clicks                as gsc_clicks,
        impressions           as gsc_impressions,
        ctr::float            as gsc_ctr,
        position::float       as gsc_position
      FROM gsc_top_pages, latest_gsc
      WHERE window_end_date = latest_gsc.max_date
    ),
    ga4 AS (
      SELECT
        split_part(landing_page, '?', 1) as path,
        SUM(sessions)::int         as ga4_sessions,
        SUM(engaged_sessions)::int as ga4_engaged_sessions,
        SUM(total_users)::int      as ga4_users,
        SUM(conversions)::int      as ga4_conversions,
        SUM(total_revenue)::float  as ga4_revenue
      FROM ga4_daily_by_landing_page, latest_gsc
      WHERE date >= latest_gsc.max_date - INTERVAL '27 days'
        AND date <= latest_gsc.max_date
      GROUP BY split_part(landing_page, '?', 1)
    )
    SELECT
      gsc.path,
      gsc.full_url,
      gsc.gsc_clicks,
      gsc.gsc_impressions,
      gsc.gsc_ctr,
      gsc.gsc_position,
      COALESCE(ga4.ga4_sessions, 0)         as ga4_sessions,
      COALESCE(ga4.ga4_engaged_sessions, 0) as ga4_engaged_sessions,
      COALESCE(ga4.ga4_users, 0)            as ga4_users,
      COALESCE(ga4.ga4_conversions, 0)      as ga4_conversions,
      COALESCE(ga4.ga4_revenue, 0)          as ga4_revenue,
      (SELECT max_date::text FROM latest_gsc) as window_end_date
    FROM gsc
    LEFT JOIN ga4 ON gsc.path = ga4.path
    ORDER BY gsc.gsc_clicks DESC
    LIMIT $1
  `, [Math.min(500, Math.max(10, parseInt(limit, 10) || 100))]);
  return rows.map(r => ({
    path: r.path,
    full_url: r.full_url,
    window_end_date: r.window_end_date,
    gsc_clicks: Number(r.gsc_clicks),
    gsc_impressions: Number(r.gsc_impressions),
    gsc_ctr: r.gsc_ctr != null ? Number(r.gsc_ctr) : null,
    gsc_position: r.gsc_position != null ? Number(r.gsc_position) : null,
    ga4_sessions: Number(r.ga4_sessions),
    ga4_engaged_sessions: Number(r.ga4_engaged_sessions),
    ga4_users: Number(r.ga4_users),
    ga4_conversions: Number(r.ga4_conversions),
    ga4_revenue: Number(r.ga4_revenue),
    // Engagement rate from GA4 (engaged / sessions) for cross-reference
    // with GSC CTR — high CTR + low engagement = misleading SERP snippet.
    ga4_engagement_rate: r.ga4_sessions > 0 ? Number(r.ga4_engaged_sessions) / Number(r.ga4_sessions) : null,
  }));
}
