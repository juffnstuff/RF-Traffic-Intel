/**
 * fetch-netsuite-transactions.js
 *
 * Pulls per-transaction rows (one row per Estimate or SalesOrd) from
 * NetSuite. Replaces nothing — sits alongside the existing aggregate
 * fetchers. This is the level of granularity needed to attribute a
 * specific $X order back to the customer's first-touch campaign.
 *
 * created_from_id links a SalesOrd back to its originating Estimate when
 * the SO was created from a quote (lets us trace quote → SO → shipped).
 * The link lives in the `nexttransactionlink` system table — there is no
 * `createdfrom` column on the `transaction` record itself in this account.
 *
 * Modes:
 *   - Full: no filter — full backfill (~30K rows for a 4-year history).
 *   - Incremental: WHERE lastModifiedDate >= since — daily refresh.
 */

import 'dotenv/config';
import {
  runSuiteQL, parseNSDate, parseNSDateTime, assertIsoDate, buildFilter,
} from './_netsuite-suiteql.js';

const QUERY = (sinceFilter) => `
  SELECT
    t.id, t.recordType, t.tranId, t.entity AS customer_id,
    t.tranDate, t.createddate, t.lastModifiedDate, t.status,
    t.total, t.actualShipDate,
    t.employee AS sales_rep_id,
    BUILTIN.DF(t.employee) AS sales_rep_name,
    ntl.previousDoc AS created_from_id,
    t.custbody_rf_firstquote AS first_quote,
    t.custbody_rf_firstorder AS first_order,
    t.custbody_rf_lost_reason AS lost_reason_id
  FROM transaction t
  LEFT JOIN nexttransactionlink ntl
    ON ntl.nextDoc = t.id
    AND BUILTIN.DF(ntl.linkType) = 'Estimate Invoicing'
  WHERE t.recordType IN ('estimate', 'salesorder')
  ${sinceFilter}
  ORDER BY t.id
`.trim();

function bool(v) {
  if (v === true || v === false) return v;
  if (v == null) return null;
  const s = String(v).toUpperCase();
  if (s === 'T' || s === 'TRUE' || s === '1') return true;
  if (s === 'F' || s === 'FALSE' || s === '0') return false;
  return null;
}

function toBigInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const TRAN_TYPE_MAP = {
  estimate: 'Estimate',
  salesorder: 'SalesOrd',
};

function shapeRow(r) {
  const get = (a, b) => r[a] ?? r[b] ?? null;
  const transaction_id = toBigInt(get('id', 'ID'));
  if (transaction_id == null) return null;

  const recordTypeRaw = String(get('recordtype', 'RECORDTYPE') || '').toLowerCase();
  const tran_type = TRAN_TYPE_MAP[recordTypeRaw] || recordTypeRaw;

  return {
    transaction_id,
    tran_type,
    tran_id: get('tranid', 'TRANID'),
    customer_id: toBigInt(get('customer_id', 'CUSTOMER_ID')),
    tran_date: parseNSDate(get('trandate', 'TRANDATE')),
    created_date: parseNSDateTime(get('createddate', 'CREATEDDATE')),
    last_modified_date: parseNSDateTime(get('lastmodifieddate', 'LASTMODIFIEDDATE')),
    status: get('status', 'STATUS'),
    total: toNumber(get('total', 'TOTAL')),
    actual_ship_date: parseNSDate(get('actualshipdate', 'ACTUALSHIPDATE')),
    sales_rep_id: toBigInt(get('sales_rep_id', 'SALES_REP_ID')),
    sales_rep_name: get('sales_rep_name', 'SALES_REP_NAME'),
    created_from_id: toBigInt(get('created_from_id', 'CREATED_FROM_ID')),
    is_first_quote: bool(get('first_quote', 'FIRST_QUOTE')),
    is_first_order: bool(get('first_order', 'FIRST_ORDER')),
    lost_reason_id: toInt(get('lost_reason_id', 'LOST_REASON_ID')),
    raw: r,
  };
}

/**
 * @param {object} opts
 * @param {string|null} opts.since — ISO date; if null, full backfill
 */
export async function fetchNetSuiteTransactions({ since = null } = {}) {
  assertIsoDate(since);
  const mode = since ? `incremental (since ${since})` : 'full history';
  console.log(`🔎  NetSuite transactions fetch — ${mode}`);

  const sinceFilter = buildFilter(since, 't.lastModifiedDate');
  const sql = QUERY(sinceFilter);

  console.log('  → querying estimates + sales orders...');
  const raw = await runSuiteQL(sql, {
    maxRowsEnv: 'NS_TRANSACTIONS_MAX_ROWS',
    defaultMax: 500000,
    label: 'transaction rows',
  });
  console.log(`    ${raw.length} raw rows`);

  const rows = raw.map(shapeRow).filter(Boolean);
  console.log(`  → shaped ${rows.length} transactions`);

  if (process.env.DATABASE_URL) {
    const { upsertNetSuiteTransactions } = await import('../db.js');
    const upserted = await upsertNetSuiteTransactions(rows);
    console.log(`✅  Upserted ${upserted} transactions into PostgreSQL`);
    return { transactions: upserted };
  }
  console.log('⚠️  DATABASE_URL not set — transactions not persisted');
  return { transactions: 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  fetchNetSuiteTransactions({ since }).catch(e => {
    console.error('❌  Transactions fetch failed:', e.message);
    process.exit(1);
  });
}
