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
