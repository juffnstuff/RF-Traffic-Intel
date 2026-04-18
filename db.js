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

  // Auto-migrate: if the dim table exists without the size_bucket column, drop
  // it so the new schema gets created below. An empty dim table triggers an
  // auto-backfill on startup (see server.js), so the user doesn't have to do
  // anything manual — the first post-deploy load repopulates with buckets.
  const tableCheck = await p.query(`SELECT to_regclass('netsuite_daily_dim') as t`);
  if (tableCheck.rows[0].t) {
    const colCheck = await p.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'netsuite_daily_dim' AND column_name = 'size_bucket'
    `);
    if (colCheck.rows.length === 0) {
      console.log('⚠️  Migrating netsuite_daily_dim → adding size_bucket dimension (will trigger refetch)');
      await p.query(`DROP TABLE netsuite_daily_dim`);
    }
  }

  // Line-level aggregation by (date, trantype, part_group, salesrep, size_bucket)
  // trantype values: 'quote', 'quote_adj', 'order', 'shipped'
  // size_bucket values: 'Under $5K', '$5K-$25K', '$25K-$100K', '$100K+'
  await p.query(`
    CREATE TABLE IF NOT EXISTS netsuite_daily_dim (
      date DATE NOT NULL,
      trantype TEXT NOT NULL,
      part_group TEXT NOT NULL DEFAULT '',
      salesrep_id TEXT NOT NULL DEFAULT '',
      salesrep_name TEXT,
      size_bucket TEXT NOT NULL DEFAULT 'Under $5K',
      txn_count INTEGER DEFAULT 0,
      line_total NUMERIC(15,2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (date, trantype, part_group, salesrep_id, size_bucket)
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_date ON netsuite_daily_dim(date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_partgroup ON netsuite_daily_dim(part_group)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_salesrep ON netsuite_daily_dim(salesrep_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_dim_size ON netsuite_daily_dim(size_bucket)`);

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
          (date, trantype, part_group, salesrep_id, salesrep_name, size_bucket, txn_count, line_total, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (date, trantype, part_group, salesrep_id, size_bucket) DO UPDATE SET
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
export async function getDailyByPartGroup({ sizeBucket } = {}) {
  const p = getPool();
  const where = [`part_group <> ''`];
  const params = [];
  if (sizeBucket) {
    params.push(sizeBucket);
    where.push(`size_bucket = $${params.length}`);
  }
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
 * with optional filters on part_group and salesrep_id (arrays).
 */
export async function getDailyDimFiltered({ partGroups = [], salesReps = [] } = {}) {
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
