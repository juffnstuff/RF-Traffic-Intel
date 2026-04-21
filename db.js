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

// Ordered list of size buckets (small → large). Must match the CASE in the
// fetcher — keep these in sync.
export const SIZE_BUCKETS = ['Under $5K', '$5K-$25K', '$25K-$100K', '$100K+'];

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
