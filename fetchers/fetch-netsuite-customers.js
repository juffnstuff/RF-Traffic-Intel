/**
 * fetch-netsuite-customers.js
 *
 * Pulls per-customer identity rows from NetSuite via SuiteQL. One row per
 * active customer (~26K). The phone_digits + email_normalized columns are
 * the join keys we use to bridge to CallRail (by phone) and HubSpot
 * (by email).
 *
 * Modes:
 *   - Full: no filter — full backfill (initial load + occasional rebuild).
 *   - Incremental: WHERE lastModifiedDate >= since — daily refresh.
 *
 * Note: phone_digits assumes 10-digit US numbers. International customers
 * are <1% of the base; their phone_digits will still match if a CallRail
 * call uses the same trailing-10 form, but country-code-prefix variants
 * will not. Revisit if the customer base diversifies internationally.
 */

import 'dotenv/config';
import {
  runSuiteQL, parseNSDate, parseNSDateTime, assertIsoDate,
  buildFilter, phoneToDigits, normalizeEmail,
} from './_netsuite-suiteql.js';

const QUERY = (sinceFilter) => `
  SELECT
    c.id, c.entityId, c.companyName, c.firstName, c.lastName,
    c.email, c.altEmail, c.phone, c.url,
    c.isInactive, c.isPerson,
    BUILTIN.DF(c.category) AS category_name,
    BUILTIN.DF(c.leadSource) AS lead_source_name,
    c.salesRep AS sales_rep_id,
    BUILTIN.DF(c.salesRep) AS sales_rep_name,
    c.dateCreated, c.lastModifiedDate,
    c.firstOrderDate, c.lastOrderDate, c.firstSaleDate, c.lastSaleDate
  FROM customer c
  WHERE c.isInactive = 'F'
  ${sinceFilter}
  ORDER BY c.id
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

function shapeRow(r) {
  // SuiteQL returns column keys in lowercase regardless of SELECT casing.
  const get = (a, b) => r[a] ?? r[b] ?? null;
  const customer_id = toBigInt(get('id', 'ID'));
  if (customer_id == null) return null;

  const email = get('email', 'EMAIL');
  const phone = get('phone', 'PHONE');

  return {
    customer_id,
    entity_id: get('entityid', 'ENTITYID'),
    company_name: get('companyname', 'COMPANYNAME'),
    first_name: get('firstname', 'FIRSTNAME'),
    last_name: get('lastname', 'LASTNAME'),
    email,
    email_normalized: normalizeEmail(email),
    alt_email: get('altemail', 'ALTEMAIL'),
    phone,
    phone_digits: phoneToDigits(phone),
    url: get('url', 'URL'),
    is_inactive: bool(get('isinactive', 'ISINACTIVE')),
    is_person: bool(get('isperson', 'ISPERSON')),
    category_name: get('category_name', 'CATEGORY_NAME'),
    lead_source_name: get('lead_source_name', 'LEAD_SOURCE_NAME'),
    sales_rep_id: toBigInt(get('sales_rep_id', 'SALES_REP_ID')),
    sales_rep_name: get('sales_rep_name', 'SALES_REP_NAME'),
    date_created: parseNSDateTime(get('datecreated', 'DATECREATED')),
    last_modified_date: parseNSDateTime(get('lastmodifieddate', 'LASTMODIFIEDDATE')),
    first_order_date: parseNSDate(get('firstorderdate', 'FIRSTORDERDATE')),
    last_order_date: parseNSDate(get('lastorderdate', 'LASTORDERDATE')),
    first_sale_date: parseNSDate(get('firstsaledate', 'FIRSTSALEDATE')),
    last_sale_date: parseNSDate(get('lastsaledate', 'LASTSALEDATE')),
    raw: r,
  };
}

/**
 * @param {object} opts
 * @param {string|null} opts.since — ISO date; if null, full backfill
 */
export async function fetchNetSuiteCustomers({ since = null } = {}) {
  assertIsoDate(since);
  const mode = since ? `incremental (since ${since})` : 'full history';
  console.log(`🔎  NetSuite customers fetch — ${mode}`);

  const sinceFilter = buildFilter(since, 'c.lastModifiedDate');
  const sql = QUERY(sinceFilter);

  console.log('  → querying customers...');
  const raw = await runSuiteQL(sql, {
    maxRowsEnv: 'NS_CUSTOMERS_MAX_ROWS',
    defaultMax: 200000,
    label: 'customer rows',
  });
  console.log(`    ${raw.length} raw rows`);

  const rows = raw.map(shapeRow).filter(Boolean);
  console.log(`  → shaped ${rows.length} customer rows`);

  if (process.env.DATABASE_URL) {
    const { upsertNetSuiteCustomers } = await import('../db.js');
    const upserted = await upsertNetSuiteCustomers(rows);
    console.log(`✅  Upserted ${upserted} customers into PostgreSQL`);
    return { customers: upserted };
  }
  console.log('⚠️  DATABASE_URL not set — customers not persisted');
  return { customers: 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  fetchNetSuiteCustomers({ since }).catch(e => {
    console.error('❌  Customers fetch failed:', e.message);
    process.exit(1);
  });
}
