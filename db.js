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

  // ── NetSuite per-customer identity ─────────────────────────────────
  // One row per active NetSuite customer. Carries the identifiers we use to
  // bridge to CallRail (by phone_digits) and HubSpot (by email_normalized).
  // raw JSONB preserves the full SuiteQL row so we can add columns later
  // without a refetch.
  await p.query(`
    CREATE TABLE IF NOT EXISTS netsuite_customers (
      customer_id BIGINT PRIMARY KEY,
      entity_id TEXT,
      company_name TEXT,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      email_normalized TEXT,
      alt_email TEXT,
      phone TEXT,
      phone_digits TEXT,
      url TEXT,
      is_inactive BOOLEAN,
      is_person BOOLEAN,
      category_name TEXT,
      lead_source_name TEXT,
      sales_rep_id BIGINT,
      sales_rep_name TEXT,
      date_created TIMESTAMPTZ,
      last_modified_date TIMESTAMPTZ,
      first_order_date DATE,
      last_order_date DATE,
      first_sale_date DATE,
      last_sale_date DATE,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_cust_phone ON netsuite_customers(phone_digits) WHERE phone_digits IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_cust_email ON netsuite_customers(email_normalized) WHERE email_normalized IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_cust_lastmod ON netsuite_customers(last_modified_date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_cust_first_order ON netsuite_customers(first_order_date) WHERE first_order_date IS NOT NULL`);

  // ── NetSuite per-transaction (Estimate + SalesOrd) ─────────────────
  // One row per quote or sales order. Linked back to a customer by
  // customer_id, enabling order-level revenue attribution to the customer's
  // first-touch campaign (joined via netsuite_customers → phone/email →
  // CallRail/HubSpot). createdfrom_id chains SalesOrd → originating Estimate.
  await p.query(`
    CREATE TABLE IF NOT EXISTS netsuite_transactions (
      transaction_id BIGINT PRIMARY KEY,
      tran_type TEXT NOT NULL,
      tran_id TEXT,
      customer_id BIGINT,
      tran_date DATE,
      created_date TIMESTAMPTZ,
      last_modified_date TIMESTAMPTZ,
      status TEXT,
      total NUMERIC(15,2),
      actual_ship_date DATE,
      sales_rep_id BIGINT,
      sales_rep_name TEXT,
      created_from_id BIGINT,
      is_first_quote BOOLEAN,
      is_first_order BOOLEAN,
      lost_reason_id INTEGER,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_txn_customer ON netsuite_transactions(customer_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_txn_date ON netsuite_transactions(tran_date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_txn_type ON netsuite_transactions(tran_type)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_txn_ship ON netsuite_transactions(actual_ship_date) WHERE actual_ship_date IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_txn_lastmod ON netsuite_transactions(last_modified_date)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_ns_txn_createdfrom ON netsuite_transactions(created_from_id) WHERE created_from_id IS NOT NULL`);

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

  // HubSpot contacts. The NetSuite↔HubSpot middleware writes the originating
  // NetSuite quote number into `netsuite_quote_number`. That COULD give a
  // direct primary-key join to a quote/transaction, but the current revenue
  // attribution (getCrossSourceLeadSourceRevenue / getPartGroupRoasFromHubSpot)
  // joins quotes → contacts on `email_normalized` only. The quote-number
  // bridge is captured here but not yet used as a high-confidence lane —
  // wiring it in (quote_no = netsuite_quote_number, email as fallback) is a
  // future improvement that would tighten attribution for contacts whose
  // email doesn't match the quote's email.
  await p.query(`
    CREATE TABLE IF NOT EXISTS hubspot_contacts (
      contact_id TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      email_normalized TEXT,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      hs_analytics_source TEXT NOT NULL DEFAULT '',
      hs_analytics_source_data_1 TEXT NOT NULL DEFAULT '',
      hs_analytics_source_data_2 TEXT NOT NULL DEFAULT '',
      hs_analytics_first_timestamp TIMESTAMPTZ,
      hs_latest_source TEXT NOT NULL DEFAULT '',
      hs_latest_source_data_1 TEXT NOT NULL DEFAULT '',
      hs_latest_source_data_2 TEXT NOT NULL DEFAULT '',
      hs_latest_source_timestamp TIMESTAMPTZ,
      lead_source TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      gclid TEXT NOT NULL DEFAULT '',
      first_campaign_contacted TEXT NOT NULL DEFAULT '',
      last_campaign_contacted TEXT NOT NULL DEFAULT '',
      current_roi_campaign TEXT NOT NULL DEFAULT '',
      netsuite_quote_number TEXT NOT NULL DEFAULT '',
      netsuite_quote_date DATE,
      netsuite_quote_status TEXT NOT NULL DEFAULT '',
      netsuite_contact_status TEXT NOT NULL DEFAULT '',
      netsuite_lifecycle_stage TEXT NOT NULL DEFAULT '',
      netsuite_sales_rep TEXT NOT NULL DEFAULT '',
      netsuite_subsidiary TEXT NOT NULL DEFAULT '',
      customer_type TEXT NOT NULL DEFAULT '',
      company_type TEXT NOT NULL DEFAULT '',
      form_type TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ,
      modified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Partial index on netsuite_quote_number so the high-confidence-lane join
  // hits an index instead of seq-scanning when most contacts have no NS quote.
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_contact_nsquote ON hubspot_contacts(netsuite_quote_number) WHERE netsuite_quote_number <> ''`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_contact_email ON hubspot_contacts(email_normalized) WHERE email_normalized IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_contact_source ON hubspot_contacts(hs_analytics_source)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_contact_gclid ON hubspot_contacts(gclid) WHERE gclid <> ''`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hs_contact_modified ON hubspot_contacts(modified_at)`);
  // Idempotent migrations for columns added after the initial release.
  // ADD COLUMN IF NOT EXISTS is safe to leave in forever — Postgres no-ops
  // when the column already exists.
  await p.query(`ALTER TABLE hubspot_contacts ADD COLUMN IF NOT EXISTS hs_analytics_first_timestamp TIMESTAMPTZ`);
  await p.query(`ALTER TABLE hubspot_contacts ADD COLUMN IF NOT EXISTS hs_latest_source_timestamp   TIMESTAMPTZ`);

  // Rubberform NetSuite Quotes custom object, mirrored from HubSpot.
  // Each row is one quote; `parts_group` is the canonical part-group
  // attribution on the revenue side (no campaign-mapping fuzz).
  // raw JSONB stores the full property bag so we can pull new fields
  // later without a migration round-trip.
  await p.query(`
    CREATE TABLE IF NOT EXISTS hubspot_netsuite_quotes (
      quote_object_id TEXT PRIMARY KEY,
      quote_no TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      email_normalized TEXT,
      company TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      parts_group TEXT NOT NULL DEFAULT '',
      ns_lead_source TEXT NOT NULL DEFAULT '',
      price_level TEXT NOT NULL DEFAULT '',
      total NUMERIC(15,2),
      fulfillment_date DATE,
      include_in_forecast BOOLEAN DEFAULT FALSE,
      owner_id TEXT NOT NULL DEFAULT '',
      sales_rep TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ,
      modified_at TIMESTAMPTZ,
      raw JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hsnsq_quote_no    ON hubspot_netsuite_quotes(quote_no) WHERE quote_no <> ''`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hsnsq_email       ON hubspot_netsuite_quotes(email_normalized) WHERE email_normalized IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hsnsq_status      ON hubspot_netsuite_quotes(status)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hsnsq_parts_group ON hubspot_netsuite_quotes(parts_group)`);
  // Idempotent migration: ns_lead_source (the quote's NetSuite Customer Lead
  // Source) added after initial release for the optional "NetSuite" lens.
  await p.query(`ALTER TABLE hubspot_netsuite_quotes ADD COLUMN IF NOT EXISTS ns_lead_source TEXT NOT NULL DEFAULT ''`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hsnsq_created     ON hubspot_netsuite_quotes(created_at)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_hsnsq_modified    ON hubspot_netsuite_quotes(modified_at)`);

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

  // Part-group attribution rules. Each row maps a pattern (a campaign
  // name, a GSC query, or a URL path) to a part_group. match_type picks
  // the source field; match_kind picks how the pattern is compared.
  // Curated by hand via the Cross-Source admin UI — no fetcher writes
  // here.
  await p.query(`
    CREATE TABLE IF NOT EXISTS part_group_mappings (
      id SERIAL PRIMARY KEY,
      part_group TEXT NOT NULL,
      match_type TEXT NOT NULL CHECK (match_type IN ('campaign', 'query', 'url')),
      match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'contains', 'prefix')),
      pattern TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_pgm_partgroup ON part_group_mappings(part_group)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_pgm_type ON part_group_mappings(match_type)`);

  // ── CallRail ─────────────────────────────────────────────────────
  // Per-call rows (one row = one phone call). Attribution columns mirror
  // GA4/Ads tagging so we can join: utm_campaign → ga4_daily_by_campaign
  // and google_ads_daily_by_campaign; gclid → direct Ads click match;
  // landing_page_url → ga4_daily_by_landing_page.
  // raw JSONB preserves the full API payload so we can add fields later
  // without a migration.
  await p.query(`
    CREATE TABLE IF NOT EXISTS callrail_calls (
      id TEXT PRIMARY KEY,
      start_time TIMESTAMPTZ NOT NULL,
      customer_phone_number TEXT,
      customer_name TEXT,
      customer_city TEXT,
      customer_state TEXT,
      customer_country TEXT,
      tracking_phone_number TEXT,
      business_phone_number TEXT,
      duration INTEGER,
      answered BOOLEAN,
      voicemail BOOLEAN,
      direction TEXT,
      call_type TEXT,
      lead_status TEXT,
      value NUMERIC(15,2),
      first_call BOOLEAN,
      total_calls INTEGER,
      prior_calls INTEGER,
      agent_email TEXT,
      device_type TEXT,
      tracker_id TEXT,
      company_id TEXT,
      company_name TEXT,
      source TEXT,
      source_name TEXT,
      campaign TEXT,
      medium TEXT,
      keywords TEXT,
      referring_url TEXT,
      landing_page_url TEXT,
      last_requested_url TEXT,
      referrer_domain TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      gclid TEXT,
      fbclid TEXT,
      msclkid TEXT,
      ga_client_id TEXT,
      recording TEXT,
      recording_duration INTEGER,
      tags JSONB,
      keywords_spotted JSONB,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_calls_start ON callrail_calls(start_time)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_calls_utm_campaign ON callrail_calls(utm_campaign)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_calls_campaign ON callrail_calls(campaign)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_calls_gclid ON callrail_calls(gclid) WHERE gclid IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_calls_landing ON callrail_calls(landing_page_url)`);

  // Form submissions captured by CallRail tracking pixel — same shape as
  // calls minus call-specific fields, plus form_data.
  await p.query(`
    CREATE TABLE IF NOT EXISTS callrail_form_submissions (
      id TEXT PRIMARY KEY,
      submitted_at TIMESTAMPTZ NOT NULL,
      form_url TEXT,
      landing_page_url TEXT,
      referrer TEXT,
      form_data JSONB,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone_number TEXT,
      source TEXT,
      campaign TEXT,
      medium TEXT,
      keywords TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      gclid TEXT,
      fbclid TEXT,
      msclkid TEXT,
      company_id TEXT,
      tracker_id TEXT,
      lead_status TEXT,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_forms_submitted ON callrail_form_submissions(submitted_at)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_forms_utm_campaign ON callrail_form_submissions(utm_campaign)`);

  // Text-message conversations on tracking numbers. CallRail returns one
  // row per conversation (the message body lives in raw.messages[]).
  await p.query(`
    CREATE TABLE IF NOT EXISTS callrail_text_messages (
      id TEXT PRIMARY KEY,
      customer_phone_number TEXT,
      tracking_phone_number TEXT,
      customer_name TEXT,
      initial_response TEXT,
      state TEXT,
      last_message_time TIMESTAMPTZ,
      lead_status TEXT,
      company_id TEXT,
      tracker_id TEXT,
      source TEXT,
      campaign TEXT,
      medium TEXT,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_callrail_texts_last ON callrail_text_messages(last_message_time)`);

  // Tracker config — which tracking number routes which campaign/source.
  // Rarely changes; rebuilt fresh each fetch (DELETE + INSERT).
  await p.query(`
    CREATE TABLE IF NOT EXISTS callrail_trackers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      status TEXT,
      source TEXT,
      source_name TEXT,
      destination_number TEXT,
      tracking_numbers JSONB,
      company_id TEXT,
      campaign_name TEXT,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Companies — the org tier in CallRail. Single-business installs have
  // exactly one row; agencies have many. Used for filtering downstream.
  await p.query(`
    CREATE TABLE IF NOT EXISTS callrail_companies (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      time_zone TEXT,
      created_at_callrail TIMESTAMPTZ,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
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

// ── NetSuite per-customer + per-transaction ─────────────────────────

export async function upsertNetSuiteCustomers(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO netsuite_customers (
          customer_id, entity_id, company_name, first_name, last_name,
          email, email_normalized, alt_email, phone, phone_digits, url,
          is_inactive, is_person, category_name, lead_source_name,
          sales_rep_id, sales_rep_name,
          date_created, last_modified_date,
          first_order_date, last_order_date, first_sale_date, last_sale_date,
          raw, fetched_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,NOW()
        )
        ON CONFLICT (customer_id) DO UPDATE SET
          entity_id          = EXCLUDED.entity_id,
          company_name       = EXCLUDED.company_name,
          first_name         = EXCLUDED.first_name,
          last_name          = EXCLUDED.last_name,
          email              = EXCLUDED.email,
          email_normalized   = EXCLUDED.email_normalized,
          alt_email          = EXCLUDED.alt_email,
          phone              = EXCLUDED.phone,
          phone_digits       = EXCLUDED.phone_digits,
          url                = EXCLUDED.url,
          is_inactive        = EXCLUDED.is_inactive,
          is_person          = EXCLUDED.is_person,
          category_name      = EXCLUDED.category_name,
          lead_source_name   = EXCLUDED.lead_source_name,
          sales_rep_id       = EXCLUDED.sales_rep_id,
          sales_rep_name     = EXCLUDED.sales_rep_name,
          date_created       = EXCLUDED.date_created,
          last_modified_date = EXCLUDED.last_modified_date,
          first_order_date   = EXCLUDED.first_order_date,
          last_order_date    = EXCLUDED.last_order_date,
          first_sale_date    = EXCLUDED.first_sale_date,
          last_sale_date     = EXCLUDED.last_sale_date,
          raw                = EXCLUDED.raw,
          fetched_at         = NOW()
      `, [
        r.customer_id, r.entity_id, r.company_name, r.first_name, r.last_name,
        r.email, r.email_normalized, r.alt_email, r.phone, r.phone_digits, r.url,
        r.is_inactive, r.is_person, r.category_name, r.lead_source_name,
        r.sales_rep_id, r.sales_rep_name,
        r.date_created, r.last_modified_date,
        r.first_order_date, r.last_order_date, r.first_sale_date, r.last_sale_date,
        r.raw ? JSON.stringify(r.raw) : null,
      ]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getNetSuiteCustomerCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*)::int as cnt FROM netsuite_customers');
  return rows[0].cnt;
}

export async function getNetSuiteCustomerMaxLastModified() {
  const p = getPool();
  const { rows } = await p.query('SELECT MAX(last_modified_date) as m FROM netsuite_customers');
  return rows[0].m || null;
}

export async function getNetSuiteCustomers({ since = null, until = null, limit = 100, phoneDigits = null, emailNormalized = null } = {}) {
  const p = getPool();
  const params = [];
  const conds = [];
  if (since) { params.push(since); conds.push(`last_modified_date >= $${params.length}`); }
  if (until) { params.push(until); conds.push(`last_modified_date < $${params.length}`); }
  if (phoneDigits) { params.push(phoneDigits); conds.push(`phone_digits = $${params.length}`); }
  if (emailNormalized) { params.push(emailNormalized); conds.push(`email_normalized = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  const { rows } = await p.query(`
    SELECT customer_id, entity_id, company_name, email, phone, phone_digits, email_normalized,
           sales_rep_name, lead_source_name, first_order_date, last_order_date,
           date_created, last_modified_date
    FROM netsuite_customers
    ${where}
    ORDER BY last_modified_date DESC NULLS LAST
    LIMIT $${params.length}
  `, params);
  return rows;
}

export async function upsertNetSuiteTransactions(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO netsuite_transactions (
          transaction_id, tran_type, tran_id, customer_id,
          tran_date, created_date, last_modified_date, status, total,
          actual_ship_date, sales_rep_id, sales_rep_name, created_from_id,
          is_first_quote, is_first_order, lost_reason_id, raw, fetched_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,NOW()
        )
        ON CONFLICT (transaction_id) DO UPDATE SET
          tran_type          = EXCLUDED.tran_type,
          tran_id            = EXCLUDED.tran_id,
          customer_id        = EXCLUDED.customer_id,
          tran_date          = EXCLUDED.tran_date,
          created_date       = EXCLUDED.created_date,
          last_modified_date = EXCLUDED.last_modified_date,
          status             = EXCLUDED.status,
          total              = EXCLUDED.total,
          actual_ship_date   = EXCLUDED.actual_ship_date,
          sales_rep_id       = EXCLUDED.sales_rep_id,
          sales_rep_name     = EXCLUDED.sales_rep_name,
          created_from_id    = EXCLUDED.created_from_id,
          is_first_quote     = EXCLUDED.is_first_quote,
          is_first_order     = EXCLUDED.is_first_order,
          lost_reason_id     = EXCLUDED.lost_reason_id,
          raw                = EXCLUDED.raw,
          fetched_at         = NOW()
      `, [
        r.transaction_id, r.tran_type, r.tran_id, r.customer_id,
        r.tran_date, r.created_date, r.last_modified_date, r.status, r.total,
        r.actual_ship_date, r.sales_rep_id, r.sales_rep_name, r.created_from_id,
        r.is_first_quote, r.is_first_order, r.lost_reason_id,
        r.raw ? JSON.stringify(r.raw) : null,
      ]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getNetSuiteTransactionCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*)::int as cnt FROM netsuite_transactions');
  return rows[0].cnt;
}

export async function getNetSuiteTransactionMaxLastModified() {
  const p = getPool();
  const { rows } = await p.query('SELECT MAX(last_modified_date) as m FROM netsuite_transactions');
  return rows[0].m || null;
}

export async function getNetSuiteTransactions({ since = null, until = null, customerId = null, tranType = null, limit = 100 } = {}) {
  const p = getPool();
  const params = [];
  const conds = [];
  if (since) { params.push(since); conds.push(`tran_date >= $${params.length}`); }
  if (until) { params.push(until); conds.push(`tran_date < $${params.length}`); }
  if (customerId) { params.push(Number(customerId)); conds.push(`customer_id = $${params.length}`); }
  if (tranType) { params.push(tranType); conds.push(`tran_type = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 1000));
  const { rows } = await p.query(`
    SELECT transaction_id, tran_type, tran_id, customer_id, tran_date, total, status,
           actual_ship_date, sales_rep_name, created_from_id,
           is_first_quote, is_first_order, lost_reason_id,
           created_date, last_modified_date
    FROM netsuite_transactions
    ${where}
    ORDER BY tran_date DESC NULLS LAST, transaction_id DESC
    LIMIT $${params.length}
  `, params);
  return rows;
}

/**
 * Diagnostic: how many CallRail calls / form submissions can be matched
 * to a NetSuite customer by phone (calls) or email (forms)?
 * Phase 1 validation that the identity bridge actually links real data.
 */
export async function getCallRailNetSuiteMatch({ sample = 25 } = {}) {
  const p = getPool();
  const sampleN = Math.min(Math.max(Number(sample) || 25, 0), 200);

  const summary = await p.query(`
    WITH call_match AS (
      SELECT
        COUNT(*) AS total_calls,
        COUNT(c.customer_id) AS matched_calls,
        COUNT(DISTINCT c.customer_id) FILTER (WHERE c.customer_id IS NOT NULL) AS matched_customers
      FROM callrail_calls cr
      LEFT JOIN netsuite_customers c
        ON c.phone_digits = RIGHT(REGEXP_REPLACE(cr.customer_phone_number, '\\D', '', 'g'), 10)
       AND LENGTH(REGEXP_REPLACE(cr.customer_phone_number, '\\D', '', 'g')) >= 10
    ),
    form_match AS (
      SELECT
        COUNT(*) AS total_forms,
        COUNT(c1.customer_id) AS matched_forms_by_email,
        COUNT(c2.customer_id) AS matched_forms_by_phone
      FROM callrail_form_submissions f
      LEFT JOIN netsuite_customers c1
        ON c1.email_normalized = LOWER(TRIM(f.customer_email))
       AND f.customer_email IS NOT NULL AND POSITION('@' IN f.customer_email) > 0
      LEFT JOIN netsuite_customers c2
        ON c2.phone_digits = RIGHT(REGEXP_REPLACE(f.customer_phone_number, '\\D', '', 'g'), 10)
       AND LENGTH(REGEXP_REPLACE(f.customer_phone_number, '\\D', '', 'g')) >= 10
    )
    SELECT cm.total_calls, cm.matched_calls, cm.matched_customers,
           fm.total_forms, fm.matched_forms_by_email, fm.matched_forms_by_phone
    FROM call_match cm, form_match fm
  `);

  const samples = sampleN > 0 ? await p.query(`
    SELECT
      cr.id AS call_id,
      cr.start_time,
      cr.customer_name AS callrail_name,
      cr.customer_phone_number,
      cr.utm_campaign,
      cr.gclid,
      c.customer_id,
      c.entity_id,
      c.company_name AS netsuite_name,
      c.email,
      c.first_order_date,
      c.last_order_date
    FROM callrail_calls cr
    JOIN netsuite_customers c
      ON c.phone_digits = RIGHT(REGEXP_REPLACE(cr.customer_phone_number, '\\D', '', 'g'), 10)
     AND LENGTH(REGEXP_REPLACE(cr.customer_phone_number, '\\D', '', 'g')) >= 10
    ORDER BY cr.start_time DESC
    LIMIT $1
  `, [sampleN]) : { rows: [] };

  return {
    summary: summary.rows[0] || {},
    sample_matches: samples.rows,
  };
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
    let upserted = 0, skipped = 0;
    for (const r of rows) {
      await client.query('SAVEPOINT hs_row');
      try {
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
        await client.query('RELEASE SAVEPOINT hs_row');
        upserted++;
      } catch (rowErr) {
        // One malformed row must not roll back the whole batch. Skip it,
        // keep the good rows, and surface a sample of what failed.
        await client.query('ROLLBACK TO SAVEPOINT hs_row');
        skipped++;
        if (skipped <= 5) console.warn(`    ⚠️  skipped deal ${r.deal_id}: ${rowErr.message}`);
      }
    }
    await client.query('COMMIT');
    if (skipped) console.warn(`    ⚠️  upsertHubSpotDeals skipped ${skipped}/${rows.length} bad rows`);
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

// ── Won NetSuite quotes by lead source (replaces the HubSpot-deal tiles) ──
// The team's revenue truth is the NetSuite quote object, not HubSpot deals.
// Attribution comes from the matched contact's first-touch hs_analytics_source
// (joined by email). "Won" = quote status ILIKE '%won%'. The quote's own date
// (created_at, sourced from ns_date) is the time axis, mirroring how deals
// used close_date. Returned shape matches the old deal-daily rows —
// { date, source, quotes, revenue } — so the Paid/SEO tiles map 1:1.
export async function getQuotesWonDailyBySource({ since = null } = {}) {
  const p = getPool();
  const params = [];
  const where = [`q.status ILIKE '%won%'`, `q.created_at IS NOT NULL`];
  if (since) { params.push(since); where.push(`q.created_at >= $${params.length}::date`); }
  const { rows } = await p.query(`
    SELECT
      q.created_at::date::text                                   as date,
      COALESCE(NULLIF(hc.hs_analytics_source, ''), 'UNKNOWN')    as source,
      COUNT(*)::int                                              as quotes,
      SUM(q.total)::float                                        as revenue
    FROM hubspot_netsuite_quotes q
    LEFT JOIN hubspot_contacts hc
      ON hc.email_normalized = q.email_normalized
     AND q.email_normalized IS NOT NULL
    WHERE ${where.join(' AND ')}
    GROUP BY 1, 2
    ORDER BY 1 ASC
  `, params);
  return rows;
}

// Won quotes in [since, until] with the matched contact's source + campaign
// fields, so the Paid campaign table can attribute won-quote revenue to a
// Google Ads campaign the same way it did with deals (keyed by source_data_*).
// Returns { amount, source, source_data_1, source_data_2 } per won quote.
export async function getQuotesWonWindow({ since = null, until = null, source = null } = {}) {
  const p = getPool();
  const where = [`q.status ILIKE '%won%'`, `q.created_at IS NOT NULL`];
  const params = [];
  if (since)  { params.push(since);  where.push(`q.created_at >= $${params.length}::date`); }
  if (until)  { params.push(until);  where.push(`q.created_at <  $${params.length}::date + INTERVAL '1 day'`); }
  if (source) { params.push(source); where.push(`hc.hs_analytics_source = $${params.length}`); }
  const { rows } = await p.query(`
    SELECT
      q.quote_no,
      q.total::float                                as amount,
      COALESCE(NULLIF(hc.hs_analytics_source, ''), 'UNKNOWN') as source,
      hc.hs_analytics_source_data_1                 as source_data_1,
      hc.hs_analytics_source_data_2                 as source_data_2
    FROM hubspot_netsuite_quotes q
    LEFT JOIN hubspot_contacts hc
      ON hc.email_normalized = q.email_normalized
     AND q.email_normalized IS NOT NULL
    WHERE ${where.join(' AND ')}
    ORDER BY q.total DESC NULLS LAST
  `, params);
  return rows;
}

// ── HubSpot contacts ─────────────────────────────────────────────────

export async function upsertHubSpotContacts(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0, skipped = 0;
    for (const r of rows) {
      await client.query('SAVEPOINT hs_row');
      try {
      await client.query(`
        INSERT INTO hubspot_contacts (
          contact_id, email, email_normalized, first_name, last_name,
          hs_analytics_source, hs_analytics_source_data_1, hs_analytics_source_data_2, hs_analytics_first_timestamp,
          hs_latest_source, hs_latest_source_data_1, hs_latest_source_data_2, hs_latest_source_timestamp,
          lead_source, source, gclid,
          first_campaign_contacted, last_campaign_contacted, current_roi_campaign,
          netsuite_quote_number, netsuite_quote_date, netsuite_quote_status,
          netsuite_contact_status, netsuite_lifecycle_stage,
          netsuite_sales_rep, netsuite_subsidiary,
          customer_type, company_type, form_type,
          created_at, modified_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16,
          $17, $18, $19,
          $20, $21, $22,
          $23, $24,
          $25, $26,
          $27, $28, $29,
          $30, $31, NOW()
        )
        ON CONFLICT (contact_id) DO UPDATE SET
          email                        = EXCLUDED.email,
          email_normalized             = EXCLUDED.email_normalized,
          first_name                   = EXCLUDED.first_name,
          last_name                    = EXCLUDED.last_name,
          hs_analytics_source          = EXCLUDED.hs_analytics_source,
          hs_analytics_source_data_1   = EXCLUDED.hs_analytics_source_data_1,
          hs_analytics_source_data_2   = EXCLUDED.hs_analytics_source_data_2,
          hs_analytics_first_timestamp = EXCLUDED.hs_analytics_first_timestamp,
          hs_latest_source             = EXCLUDED.hs_latest_source,
          hs_latest_source_data_1      = EXCLUDED.hs_latest_source_data_1,
          hs_latest_source_data_2      = EXCLUDED.hs_latest_source_data_2,
          hs_latest_source_timestamp   = EXCLUDED.hs_latest_source_timestamp,
          lead_source                  = EXCLUDED.lead_source,
          source                       = EXCLUDED.source,
          gclid                        = EXCLUDED.gclid,
          first_campaign_contacted     = EXCLUDED.first_campaign_contacted,
          last_campaign_contacted      = EXCLUDED.last_campaign_contacted,
          current_roi_campaign         = EXCLUDED.current_roi_campaign,
          netsuite_quote_number        = EXCLUDED.netsuite_quote_number,
          netsuite_quote_date          = EXCLUDED.netsuite_quote_date,
          netsuite_quote_status        = EXCLUDED.netsuite_quote_status,
          netsuite_contact_status      = EXCLUDED.netsuite_contact_status,
          netsuite_lifecycle_stage     = EXCLUDED.netsuite_lifecycle_stage,
          netsuite_sales_rep           = EXCLUDED.netsuite_sales_rep,
          netsuite_subsidiary          = EXCLUDED.netsuite_subsidiary,
          customer_type                = EXCLUDED.customer_type,
          company_type                 = EXCLUDED.company_type,
          form_type                    = EXCLUDED.form_type,
          created_at                   = EXCLUDED.created_at,
          modified_at                  = EXCLUDED.modified_at,
          updated_at                   = NOW()
      `, [
        r.contact_id, r.email ?? '', r.email_normalized, r.first_name ?? '', r.last_name ?? '',
        r.hs_analytics_source ?? '', r.hs_analytics_source_data_1 ?? '', r.hs_analytics_source_data_2 ?? '', r.hs_analytics_first_timestamp,
        r.hs_latest_source ?? '', r.hs_latest_source_data_1 ?? '', r.hs_latest_source_data_2 ?? '', r.hs_latest_source_timestamp,
        r.lead_source ?? '', r.source ?? '', r.gclid ?? '',
        r.first_campaign_contacted ?? '', r.last_campaign_contacted ?? '', r.current_roi_campaign ?? '',
        r.netsuite_quote_number ?? '', r.netsuite_quote_date, r.netsuite_quote_status ?? '',
        r.netsuite_contact_status ?? '', r.netsuite_lifecycle_stage ?? '',
        r.netsuite_sales_rep ?? '', r.netsuite_subsidiary ?? '',
        r.customer_type ?? '', r.company_type ?? '', r.form_type ?? '',
        r.created_at, r.modified_at,
      ]);
        await client.query('RELEASE SAVEPOINT hs_row');
        upserted++;
      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT hs_row');
        skipped++;
        if (skipped <= 5) console.warn(`    ⚠️  skipped contact ${r.contact_id}: ${rowErr.message}`);
      }
    }
    await client.query('COMMIT');
    if (skipped) console.warn(`    ⚠️  upsertHubSpotContacts skipped ${skipped}/${rows.length} bad rows`);
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getHubSpotContactCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*)::int as cnt FROM hubspot_contacts');
  return rows[0].cnt;
}

// ── HubSpot NetSuite Quotes (custom object) ─────────────────────────

export async function upsertHubSpotNetsuiteQuotes(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0, skipped = 0;
    for (const r of rows) {
      await client.query('SAVEPOINT hs_row');
      try {
      await client.query(`
        INSERT INTO hubspot_netsuite_quotes (
          quote_object_id, quote_no, email, email_normalized, company,
          status, parts_group, ns_lead_source, price_level, total, fulfillment_date,
          include_in_forecast, owner_id, sales_rep,
          created_at, modified_at, raw, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        ON CONFLICT (quote_object_id) DO UPDATE SET
          quote_no            = EXCLUDED.quote_no,
          email               = EXCLUDED.email,
          email_normalized    = EXCLUDED.email_normalized,
          company             = EXCLUDED.company,
          status              = EXCLUDED.status,
          parts_group         = EXCLUDED.parts_group,
          ns_lead_source      = EXCLUDED.ns_lead_source,
          price_level         = EXCLUDED.price_level,
          total               = EXCLUDED.total,
          fulfillment_date    = EXCLUDED.fulfillment_date,
          include_in_forecast = EXCLUDED.include_in_forecast,
          owner_id            = EXCLUDED.owner_id,
          sales_rep           = EXCLUDED.sales_rep,
          created_at          = EXCLUDED.created_at,
          modified_at         = EXCLUDED.modified_at,
          raw                 = EXCLUDED.raw,
          updated_at          = NOW()
      `, [
        r.quote_object_id, r.quote_no ?? '', r.email ?? '', r.email_normalized, r.company ?? '',
        r.status ?? '', r.parts_group ?? '', r.ns_lead_source ?? '', r.price_level ?? '', r.total ?? null, r.fulfillment_date,
        !!r.include_in_forecast, r.owner_id ?? '', r.sales_rep ?? '',
        r.created_at, r.modified_at, r.raw ? JSON.stringify(r.raw) : null,
      ]);
        await client.query('RELEASE SAVEPOINT hs_row');
        upserted++;
      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT hs_row');
        skipped++;
        if (skipped <= 5) console.warn(`    ⚠️  skipped quote ${r.quote_object_id}: ${rowErr.message}`);
      }
    }
    await client.query('COMMIT');
    if (skipped) console.warn(`    ⚠️  upsertHubSpotNetsuiteQuotes skipped ${skipped}/${rows.length} bad rows`);
    return upserted;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getHubSpotNetsuiteQuotesCount() {
  const p = getPool();
  const { rows } = await p.query('SELECT COUNT(*)::int as cnt FROM hubspot_netsuite_quotes');
  return rows[0].cnt;
}

// Lead-source bucket for a row. Mirrors HubSpot's analytics source taxonomy
// but folds blanks to '(UNKNOWN)' so the rollup doesn't silently drop them.
// Caller picks which column to bucket on:
//   'hs_analytics_source' — HubSpot first-touch / original (stable per contact)
//   'hs_latest_source'    — HubSpot latest session source (overwrites on new sessions)
//   'netsuite'            — the quote's own NetSuite Customer Lead Source
//                           (q.ns_lead_source). Independent of the contact join,
//                           so it works even for the ~93% OFFLINE/integration
//                           contacts whose HubSpot source is frozen. Treat as
//                           advisory — it's rep-entered in NetSuite.
function hsSourceBucketSql(column) {
  if (column === 'netsuite') return `COALESCE(NULLIF(q.ns_lead_source, ''), '(UNKNOWN)')`;
  const allowed = new Set(['hs_analytics_source', 'hs_latest_source']);
  if (!allowed.has(column)) throw new Error(`Invalid attribution column: ${column}`);
  return `COALESCE(NULLIF(hc.${column}, ''), '(UNKNOWN)')`;
}

function hsCampaignDrilldownSql(column) {
  const allowed = new Set(['hs_analytics_source', 'hs_latest_source']);
  if (!allowed.has(column)) throw new Error(`Invalid attribution column: ${column}`);
  return column === 'hs_analytics_source'
    ? 'hc.hs_analytics_source_data_1'
    : 'hc.hs_latest_source_data_1';
}

// Revenue attribution by HubSpot traffic source.
// Source of truth shifted: revenue + parts_group come from
// hubspot_netsuite_quotes (the custom-object mirror); attribution columns
// come from the matched contact (joined via email_normalized).
//
// `column` picks which contact column to bucket on:
//   'hs_analytics_source'  = first-touch / original  (stable per contact)
//   'hs_latest_source'     = latest session source   (overwrites on new sessions)
//
// Quotes with no email-matched contact still get counted under '(UNKNOWN)'
// so totals match the NetSuite-side total; the operator can see how much
// revenue is unattributed and drill in.
export async function getCrossSourceLeadSourceRevenue({ since = null, until = null, column = 'hs_analytics_source' } = {}) {
  const p = getPool();
  const sourceCol = hsSourceBucketSql(column);
  const params = [];
  const dateConds = [];
  // Quote's own `created_at` is when the NetSuite quote was created
  // (mirrored from HubSpot). Date-window on that, not on contact dates.
  if (since) { params.push(since); dateConds.push(`q.created_at >= $${params.length}::date`); }
  if (until) { params.push(until); dateConds.push(`q.created_at <  $${params.length}::date + INTERVAL '1 day'`); }
  const dateWhere = dateConds.length ? `WHERE ${dateConds.join(' AND ')}` : '';
  const sql = `
    WITH joined AS (
      SELECT
        q.quote_object_id,
        q.quote_no,
        q.total::float as total,
        q.status,
        q.parts_group,
        q.created_at,
        hc.contact_id,
        ${sourceCol} as hs_source
      FROM hubspot_netsuite_quotes q
      LEFT JOIN hubspot_contacts hc
        ON hc.email_normalized = q.email_normalized
       AND q.email_normalized IS NOT NULL
      ${dateWhere}
    )
    SELECT
      hs_source,
      COUNT(*)::int                                                                       as quotes,
      COUNT(DISTINCT contact_id) FILTER (WHERE contact_id IS NOT NULL)::int               as contacts,
      SUM(total)::float                                                                    as revenue,
      COUNT(*) FILTER (WHERE status ILIKE '%won%')::int                                    as wins,
      SUM(total) FILTER (WHERE status ILIKE '%won%')::float                                as revenue_won,
      COUNT(*) FILTER (WHERE contact_id IS NULL)::int                                     as quotes_unattributed,
      SUM(total) FILTER (WHERE contact_id IS NULL)::float                                  as revenue_unattributed
    FROM joined
    GROUP BY hs_source
    ORDER BY revenue DESC NULLS LAST
  `;
  const { rows } = await p.query(sql, params);
  return rows;
}

// Per-quote attribution drill-down. One row per quote in the window with
// both first-touch and latest-touch attribution + the latest-source
// timestamp, so the operator can see when a "latest" source post-dates
// the quote (stale) vs predates it (accurate at the time).
export async function getCrossSourceQuoteAttribution({ since = null, until = null, limit = 1000 } = {}) {
  const p = getPool();
  const params = [];
  const dateConds = [];
  if (since) { params.push(since); dateConds.push(`q.created_at >= $${params.length}::date`); }
  if (until) { params.push(until); dateConds.push(`q.created_at <  $${params.length}::date + INTERVAL '1 day'`); }
  const dateWhere = dateConds.length ? `WHERE ${dateConds.join(' AND ')}` : '';
  params.push(limit);
  const { rows } = await p.query(`
    SELECT
      q.quote_object_id,
      q.quote_no,
      q.email,
      q.company,
      q.status,
      q.parts_group,
      q.total::float                       as total,
      q.created_at,
      q.fulfillment_date,
      hc.contact_id,
      NULLIF(hc.hs_analytics_source, '')   as original_source,
      NULLIF(hc.hs_analytics_source_data_1, '') as original_campaign,
      NULLIF(hc.hs_latest_source, '')      as latest_source,
      NULLIF(hc.hs_latest_source_data_1,'') as latest_campaign,
      hc.hs_latest_source_timestamp,
      -- Is the contact's latest-source timestamp BEFORE this quote? If so,
      -- the latest source is the more reliable lens for this quote.
      -- If AFTER, the latest source was set on a later session and tells
      -- you nothing about what drove the quote (first-touch is the truth).
      CASE
        WHEN hc.hs_latest_source_timestamp IS NULL THEN NULL
        WHEN q.created_at IS NULL                  THEN NULL
        WHEN hc.hs_latest_source_timestamp <= q.created_at THEN TRUE
        ELSE FALSE
      END                                  as latest_predates_quote
    FROM hubspot_netsuite_quotes q
    LEFT JOIN hubspot_contacts hc
      ON hc.email_normalized = q.email_normalized
     AND q.email_normalized IS NOT NULL
    ${dateWhere}
    ORDER BY q.created_at DESC NULLS LAST, q.quote_no DESC
    LIMIT $${params.length}
  `, params);
  return rows;
}

// HubSpot vs NetSuite lead-source reconciliation.
// One row per contact where HubSpot's first-touch source disagrees with
// the customer's NetSuite `lead_source_name`. Surfacing these mismatches
// lets the team correct one of the two systems before any reporting bakes
// in stale lead-source data. Joins via the NetSuite customer (email-normalized
// match) so even unbridged contacts can be reconciled.
export async function getCrossSourceLeadSourceReconciliation({ limit = 200 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT
      hc.contact_id,
      hc.email,
      hc.first_name,
      hc.last_name,
      hc.hs_analytics_source                                       as hs_source,
      NULLIF(hc.hs_analytics_source_data_1, '')                    as hs_campaign,
      c.customer_id,
      c.entity_id                                                  as ns_entity,
      c.lead_source_name                                           as ns_lead_source,
      -- Latest HubSpot quote for this contact (if any) — useful context
      -- when deciding which system to correct.
      q.quote_no                                                   as latest_quote_no,
      q.status                                                     as latest_quote_status,
      hc.modified_at
    FROM hubspot_contacts hc
    JOIN netsuite_customers c
      ON c.email_normalized = hc.email_normalized
    LEFT JOIN LATERAL (
      SELECT quote_no, status
      FROM hubspot_netsuite_quotes q
      WHERE q.email_normalized = hc.email_normalized
      ORDER BY q.created_at DESC NULLS LAST
      LIMIT 1
    ) q ON TRUE
    WHERE hc.email_normalized IS NOT NULL
      AND COALESCE(NULLIF(hc.hs_analytics_source, ''), '(UNKNOWN)')
          <> COALESCE(NULLIF(c.lead_source_name,        ''), '(UNKNOWN)')
    ORDER BY hc.modified_at DESC NULLS LAST
    LIMIT $1
  `, [limit]);
  return rows;
}

// Part-group ROAS — Ads cost vs revenue per part-group.
//
// Revenue side: the HubSpot NetSuite Quotes custom object carries
// `parts_group` directly on each quote, so no campaign→part_group mapping
// fuzz is needed on revenue. Quotes with no parts_group go to '(unmapped)'.
//
// Cost side: Google Ads has no concept of part-group, so we still need the
// curated `part_group_mappings` table to attribute campaign spend to a
// part-group. Spend that doesn't match any mapping rolls up under
// '(unmapped)' so the operator can see how much spend isn't yet attributed.
//
// Won-only metric reported alongside total so the operator can compare
// gross-quote ROAS to closed-won ROAS.
export async function getPartGroupRoasFromHubSpot({ since = null, until = null } = {}) {
  const p = getPool();
  const params = [];
  const adsDateConds = [];
  const qDateConds = [];
  if (since) {
    params.push(since);
    adsDateConds.push(`a.date >= $${params.length}::date`);
    qDateConds.push(`q.created_at >= $${params.length}::date`);
  }
  if (until) {
    params.push(until);
    adsDateConds.push(`a.date <= $${params.length}::date`);
    qDateConds.push(`q.created_at <  $${params.length}::date + INTERVAL '1 day'`);
  }
  const adsWhere = adsDateConds.length ? `WHERE ${adsDateConds.join(' AND ')}` : '';
  const qWhere   = qDateConds.length   ? `WHERE ${qDateConds.join(' AND ')}`   : '';
  // Canonicalize part-group names so revenue and cost land on the same ROAS
  // row. "Spill Containment" and "Next Gen Spill Containment" are one product
  // line for ROAS (per RubberForm), so both collapse to "Spill Containment".
  // NB: "MLSB" is intentionally NOT merged here — it spans speed bumps and
  // spill depending on the SKUs on the order (RF-MLSB3/4 = speed bumps,
  // RF-MLSBMINI = spill), which the quote-level parts_group can't distinguish,
  // so it stays its own line rather than being misattributed.
  const canon = (expr) => `CASE WHEN lower(btrim(${expr})) IN ('spill containment', 'next gen spill containment')
        THEN 'Spill Containment' ELSE ${expr} END`;
  const sql = `
    WITH ads_by_campaign AS (
      SELECT campaign_name,
             SUM(cost)::float as cost,
             SUM(clicks)::int as ad_clicks,
             SUM(impressions)::int as ad_impressions
      FROM google_ads_daily_by_campaign a
      ${adsWhere}
      GROUP BY campaign_name
    ),
    ads_by_partgroup AS (
      SELECT
        ${canon('m.part_group')} as part_group,
        SUM(a.cost)           as cost,
        SUM(a.ad_clicks)      as ad_clicks,
        SUM(a.ad_impressions) as ad_impressions
      FROM ads_by_campaign a
      JOIN part_group_mappings m
        ON m.match_type = 'campaign'
       AND (
         (m.match_kind = 'exact'    AND a.campaign_name = m.pattern) OR
         (m.match_kind = 'contains' AND a.campaign_name ILIKE '%' || m.pattern || '%') OR
         (m.match_kind = 'prefix'   AND a.campaign_name ILIKE m.pattern || '%')
       )
      GROUP BY 1
    ),
    -- Spend that matched no campaign→part_group rule. Surfaces the gap
    -- between Ads spend and the curated mapping coverage.
    ads_unmapped AS (
      SELECT '(unmapped)'::text   as part_group,
             SUM(a.cost)          as cost,
             SUM(a.ad_clicks)     as ad_clicks,
             SUM(a.ad_impressions) as ad_impressions
      FROM ads_by_campaign a
      WHERE NOT EXISTS (
        SELECT 1 FROM part_group_mappings m
        WHERE m.match_type = 'campaign'
          AND (
            (m.match_kind = 'exact'    AND a.campaign_name = m.pattern) OR
            (m.match_kind = 'contains' AND a.campaign_name ILIKE '%' || m.pattern || '%') OR
            (m.match_kind = 'prefix'   AND a.campaign_name ILIKE m.pattern || '%')
          )
      )
    ),
    ads_full AS (
      SELECT * FROM ads_by_partgroup
      UNION ALL
      SELECT * FROM ads_unmapped WHERE cost IS NOT NULL
    ),
    -- Revenue per part_group straight off the quote object — no mapping.
    revenue_by_partgroup AS (
      SELECT
        ${canon(`COALESCE(NULLIF(q.parts_group, ''), '(unmapped)')`)} as part_group,
        COUNT(*)::int                                     as quotes,
        SUM(q.total)::float                               as revenue,
        COUNT(*) FILTER (WHERE q.status ILIKE '%won%')::int as quotes_won,
        SUM(q.total) FILTER (WHERE q.status ILIKE '%won%')::float as revenue_won
      FROM hubspot_netsuite_quotes q
      ${qWhere}
      GROUP BY 1
    )
    SELECT
      COALESCE(a.part_group, r.part_group)   as part_group,
      COALESCE(a.cost, 0)                    as cost,
      COALESCE(a.ad_clicks, 0)               as ad_clicks,
      COALESCE(a.ad_impressions, 0)          as ad_impressions,
      COALESCE(r.quotes, 0)                  as quotes,
      COALESCE(r.revenue, 0)                 as revenue,
      COALESCE(r.quotes_won, 0)              as quotes_won,
      COALESCE(r.revenue_won, 0)             as revenue_won,
      CASE WHEN COALESCE(a.cost, 0) > 0
        THEN COALESCE(r.revenue, 0)     / a.cost ELSE NULL END as roas,
      CASE WHEN COALESCE(a.cost, 0) > 0
        THEN COALESCE(r.revenue_won, 0) / a.cost ELSE NULL END as roas_won
    FROM ads_full a
    FULL OUTER JOIN revenue_by_partgroup r ON r.part_group = a.part_group
    ORDER BY revenue DESC NULLS LAST, cost DESC
  `;
  const { rows } = await p.query(sql, params);
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

// Latest per-page CrUX snapshot — one row per (page, form_factor) at its most
// recent fetch date. Feeds the "slowest pages" CWV table on GA4 Insights,
// which pivots (page, form_factor) into PHONE/DESKTOP columns. This function
// was referenced by /api/crux-by-page but never defined, so that endpoint
// 500'd on every call until now.
export async function getCruxLatestByPage() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT DISTINCT ON (page, form_factor)
      page, form_factor,
      lcp_p75::float as lcp_p75,
      inp_p75::float as inp_p75,
      cls_p75::float as cls_p75,
      date::text
    FROM crux_daily_by_page
    ORDER BY page, form_factor, date DESC
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
  // Each CTE filters by date independently; each gets its own $-placeholders
  // even though the values are the same. The ads/ga4 CTEs filter on a date
  // column; CallRail filters on start_time (timestamptz) so it gets a
  // separate helper.
  const params = [];
  const dateFilter = (alias) => {
    const conds = [];
    if (since) { params.push(since); conds.push(`${alias}.date >= $${params.length}::date`); }
    if (until) { params.push(until); conds.push(`${alias}.date <= $${params.length}::date`); }
    return conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  };
  const tsFilter = (alias, column) => {
    const conds = [];
    if (since) { params.push(since); conds.push(`${alias}.${column} >= $${params.length}::date`); }
    // until is treated inclusive of the entire day — < (until + 1 day).
    if (until) { params.push(until); conds.push(`${alias}.${column} <  $${params.length}::date + INTERVAL '1 day'`); }
    return conds;
  };
  const adsWhere = dateFilter('a');
  const ga4Where = dateFilter('g');
  const crConds = tsFilter('c', 'start_time');
  // Keep calls with any attribution signal: explicit campaign tagging OR
  // a click-ID we'll bucket into a network-level "untagged" pseudo-
  // campaign in the SELECT. Calls with neither (organic phone, direct
  // dial, no tagging at all) are excluded from the per-campaign rollup.
  crConds.push(`(
    COALESCE(NULLIF(c.utm_campaign, ''), NULLIF(c.campaign, '')) IS NOT NULL
    OR COALESCE(c.gclid,   '') <> ''
    OR COALESCE(c.fbclid,  '') <> ''
    OR COALESCE(c.msclkid, '') <> ''
  )`);
  const crWhere = 'WHERE ' + crConds.join(' AND ');

  // Forms only have CallRail's normalized `campaign` field for
  // attribution — the API doesn't surface utm_campaign or click IDs on
  // form submissions. Filter on submitted_at and require a non-empty
  // campaign so untagged form submissions don't pollute the rollup.
  const formConds = tsFilter('f', 'submitted_at');
  formConds.push(`NULLIF(f.campaign, '') IS NOT NULL`);
  const formWhere = 'WHERE ' + formConds.join(' AND ');
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
    ),
    callrail AS (
      SELECT
        -- Campaign attribution priority:
        --   1. utm_campaign (manual UTM, most reliable)
        --   2. campaign (CallRail's normalized field; populated when GA
        --      auto-tagging or first-party UTM is present)
        --   3. click-ID fallback bucket — preserves the call in the
        --      rollup even when no campaign tagging arrived. Lets the
        --      operator see "X calls from Google Ads, untagged" and
        --      fix the tagging gap rather than silently dropping the
        --      attribution.
        COALESCE(
          NULLIF(c.utm_campaign, ''),
          NULLIF(c.campaign, ''),
          CASE WHEN COALESCE(c.gclid, '')   <> '' THEN '(google ads — untagged)' END,
          CASE WHEN COALESCE(c.fbclid, '')  <> '' THEN '(facebook — untagged)'   END,
          CASE WHEN COALESCE(c.msclkid, '') <> '' THEN '(microsoft ads — untagged)' END
        ) as campaign_name,
        COUNT(*)::int                                                as cr_calls,
        SUM(CASE WHEN c.answered THEN 1 ELSE 0 END)::int             as cr_answered,
        SUM(CASE WHEN c.first_call THEN 1 ELSE 0 END)::int           as cr_first_calls,
        SUM(COALESCE(c.duration, 0))::int                            as cr_duration_seconds,
        SUM(COALESCE(c.value, 0))::float                             as cr_value,
        SUM(CASE WHEN c.lead_status = 'good_lead' THEN 1 ELSE 0 END)::int as cr_good_leads
      FROM callrail_calls c
      ${crWhere}
      GROUP BY 1
    ),
    forms AS (
      SELECT
        f.campaign as campaign_name,
        COUNT(*)::int                                                       as form_subs,
        SUM(CASE WHEN f.lead_status = 'good_lead' THEN 1 ELSE 0 END)::int   as form_good_leads
      FROM callrail_form_submissions f
      ${formWhere}
      GROUP BY 1
    ),
    names AS (
      SELECT campaign_name FROM ads      WHERE campaign_name IS NOT NULL
      UNION
      SELECT campaign_name FROM ga4      WHERE campaign_name IS NOT NULL
      UNION
      SELECT campaign_name FROM callrail WHERE campaign_name IS NOT NULL
      UNION
      SELECT campaign_name FROM forms    WHERE campaign_name IS NOT NULL
    )
    SELECT
      n.campaign_name,
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
      COALESCE(c.cr_calls, 0)             as cr_calls,
      COALESCE(c.cr_answered, 0)          as cr_answered,
      COALESCE(c.cr_first_calls, 0)       as cr_first_calls,
      COALESCE(c.cr_duration_seconds, 0)  as cr_duration_seconds,
      COALESCE(c.cr_value, 0)             as cr_value,
      COALESCE(c.cr_good_leads, 0)        as cr_good_leads,
      COALESCE(f.form_subs, 0)            as form_subs,
      COALESCE(f.form_good_leads, 0)      as form_good_leads,
      (a.campaign_name IS NOT NULL)       as in_ads,
      (g.campaign_name IS NOT NULL)       as in_ga4,
      (c.campaign_name IS NOT NULL)       as in_callrail,
      (f.campaign_name IS NOT NULL)       as in_forms
    FROM names n
    LEFT JOIN ads      a ON a.campaign_name = n.campaign_name
    LEFT JOIN ga4      g ON g.campaign_name = n.campaign_name
    LEFT JOIN callrail c ON c.campaign_name = n.campaign_name
    LEFT JOIN forms    f ON f.campaign_name = n.campaign_name
    ORDER BY COALESCE(a.cost, 0) DESC, COALESCE(g.ga4_sessions, 0) DESC, COALESCE(c.cr_calls, 0) DESC
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
    cr_calls: Number(r.cr_calls),
    cr_answered: Number(r.cr_answered),
    cr_first_calls: Number(r.cr_first_calls),
    cr_duration_seconds: Number(r.cr_duration_seconds),
    cr_value: Number(r.cr_value),
    cr_good_leads: Number(r.cr_good_leads),
    form_subs: Number(r.form_subs),
    form_good_leads: Number(r.form_good_leads),
    in_ads: r.in_ads,
    in_ga4: r.in_ga4,
    in_callrail: r.in_callrail,
    in_forms: r.in_forms,
    // Derived metrics — null when denominator is zero so the UI shows "—".
    ctr: r.ad_impressions > 0 ? r.ad_clicks / r.ad_impressions : null,
    avg_cpc: r.ad_clicks > 0 ? r.cost / r.ad_clicks : null,
    cost_per_session: r.ga4_sessions > 0 ? r.cost / r.ga4_sessions : null,
    cost_per_ga4_conv: r.ga4_conversions > 0 ? r.cost / r.ga4_conversions : null,
    cost_per_call: r.cr_calls > 0 ? r.cost / r.cr_calls : null,
    cost_per_answered: r.cr_answered > 0 ? r.cost / r.cr_answered : null,
    cost_per_form: r.form_subs > 0 ? r.cost / r.form_subs : null,
    answered_rate: r.cr_calls > 0 ? r.cr_answered / r.cr_calls : null,
    // Combined leads = answered calls + form submissions, treated as a
    // unified "phone+form" denominator. Cost-per-lead reads naturally
    // ("we paid X to land each tracked lead, regardless of channel").
    cost_per_lead: (r.cr_answered + r.form_subs) > 0 ? r.cost / (Number(r.cr_answered) + Number(r.form_subs)) : null,
    total_leads: Number(r.cr_answered) + Number(r.form_subs),
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

// ── Part-group mapping CRUD ──────────────────────────────────────────

const VALID_MATCH_TYPES = new Set(['campaign', 'query', 'url']);
const VALID_MATCH_KINDS = new Set(['exact', 'contains', 'prefix']);

function validateMappingFields({ part_group, match_type, match_kind, pattern }) {
  if (!part_group || typeof part_group !== 'string' || !part_group.trim()) {
    throw new Error('part_group is required');
  }
  if (!VALID_MATCH_TYPES.has(match_type)) {
    throw new Error(`match_type must be one of: ${[...VALID_MATCH_TYPES].join(', ')}`);
  }
  if (!VALID_MATCH_KINDS.has(match_kind)) {
    throw new Error(`match_kind must be one of: ${[...VALID_MATCH_KINDS].join(', ')}`);
  }
  if (!pattern || typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('pattern is required');
  }
}

// Used by the campaign → part-group mapping suggester. Returns one row
// per distinct campaign_name across Google Ads + GA4, with rollup metrics
// so the UI can sort by spend / sessions / conversions. The OUTER JOIN
// catches campaigns that appear in one table but not the other (paid
// names without GA4 tagging, or organic campaigns from GA4 that don't
// exist in Ads).
export async function getDistinctCampaignsForSuggester() {
  const p = getPool();
  const { rows } = await p.query(`
    WITH ads AS (
      SELECT campaign_name,
             SUM(cost)::float        AS total_cost,
             SUM(conversions)::float AS total_conversions,
             MAX(date)::text         AS last_seen
      FROM google_ads_daily_by_campaign
      WHERE campaign_name <> ''
      GROUP BY campaign_name
    ),
    ga4 AS (
      SELECT campaign_name,
             SUM(sessions)::int      AS total_sessions,
             SUM(conversions)::float AS ga4_conversions,
             MAX(date)::text         AS last_seen
      FROM ga4_daily_by_campaign
      WHERE campaign_name <> ''
        AND campaign_name <> '(not set)'
        AND campaign_name <> '(direct)'
      GROUP BY campaign_name
    )
    SELECT
      COALESCE(ads.campaign_name, ga4.campaign_name) AS campaign_name,
      COALESCE(ads.total_cost, 0)::float             AS total_cost,
      COALESCE(ga4.total_sessions, 0)::int           AS total_sessions,
      COALESCE(ads.total_conversions, ga4.ga4_conversions, 0)::float AS total_conversions,
      GREATEST(ads.last_seen, ga4.last_seen)         AS last_seen
    FROM ads
    FULL OUTER JOIN ga4 USING (campaign_name)
    ORDER BY total_cost DESC NULLS LAST, total_sessions DESC NULLS LAST
  `);
  return rows;
}

// Distinct non-empty part groups from the NetSuite line-level dim table.
// The canonical source — these strings exactly match what's stored on
// quote/SO lines, so a mapping pattern set against them roll up
// correctly downstream.
export async function getDistinctPartGroups() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT DISTINCT part_group
    FROM netsuite_daily_dim
    WHERE part_group <> ''
    ORDER BY part_group ASC
  `);
  return rows.map(r => r.part_group);
}

// Distinct campaign names across Google Ads and GA4. Used as autocomplete
// hints in the part-group mapping admin when match_type='campaign'.
// Sorted by recency-weighted volume so the most-used campaigns appear
// first in the typeahead. Capped to keep the datalist responsive.
export async function getDistinctCampaignNames({ limit = 500 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    WITH ads AS (
      SELECT campaign_name, SUM(clicks)::bigint AS weight, MAX(date) AS last_seen
      FROM google_ads_daily_by_campaign
      WHERE COALESCE(campaign_name, '') <> ''
      GROUP BY campaign_name
    ),
    ga4 AS (
      SELECT campaign_name, SUM(sessions)::bigint AS weight, MAX(date) AS last_seen
      FROM ga4_daily_by_campaign
      WHERE COALESCE(campaign_name, '') <> ''
      GROUP BY campaign_name
    ),
    combined AS (
      SELECT campaign_name, weight, last_seen FROM ads
      UNION ALL
      SELECT campaign_name, weight, last_seen FROM ga4
    )
    SELECT campaign_name
    FROM combined
    GROUP BY campaign_name
    ORDER BY MAX(last_seen) DESC NULLS LAST, SUM(weight) DESC
    LIMIT $1
  `, [limit]);
  return rows.map(r => r.campaign_name);
}

// Distinct GSC search queries from the most recent snapshot window. Capped
// because the queries table can have tens of thousands of rare long-tail
// queries — only the top N by clicks are useful as autocomplete hints.
export async function getDistinctGscQueries({ limit = 500 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    WITH latest AS (
      SELECT MAX(window_end_date) AS d FROM gsc_top_queries
    )
    SELECT query
    FROM gsc_top_queries, latest
    WHERE gsc_top_queries.window_end_date = latest.d
      AND COALESCE(query, '') <> ''
    ORDER BY clicks DESC, impressions DESC
    LIMIT $1
  `, [limit]);
  return rows.map(r => r.query);
}

// Distinct URL paths from GA4 landing pages, ranked by recent sessions.
// Used for match_type='url' autocomplete. Path-only (strip host + query)
// so the suggestions match what an operator would type.
export async function getDistinctUrlPaths({ limit = 500 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT
      -- Strip query string + fragment; leave the path as-is for matching.
      regexp_replace(landing_page, '[\\?#].*$', '') AS path,
      SUM(sessions)::bigint AS sessions
    FROM ga4_daily_by_landing_page
    WHERE COALESCE(landing_page, '') <> ''
      AND date > (CURRENT_DATE - INTERVAL '180 days')
    GROUP BY 1
    ORDER BY sessions DESC
    LIMIT $1
  `, [limit]);
  return rows.map(r => r.path);
}

export async function listPartGroupMappings() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT id, part_group, match_type, match_kind, pattern, notes,
           created_at, updated_at
    FROM part_group_mappings
    ORDER BY part_group ASC, match_type ASC, pattern ASC
  `);
  return rows;
}

export async function createPartGroupMapping({ part_group, match_type, match_kind, pattern, notes = null }) {
  validateMappingFields({ part_group, match_type, match_kind, pattern });
  const p = getPool();
  const { rows } = await p.query(`
    INSERT INTO part_group_mappings (part_group, match_type, match_kind, pattern, notes)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, part_group, match_type, match_kind, pattern, notes, created_at, updated_at
  `, [part_group.trim(), match_type, match_kind, pattern.trim(), notes?.trim() || null]);
  return rows[0];
}

export async function updatePartGroupMapping(id, { part_group, match_type, match_kind, pattern, notes }) {
  validateMappingFields({ part_group, match_type, match_kind, pattern });
  const p = getPool();
  const { rows } = await p.query(`
    UPDATE part_group_mappings
    SET part_group = $2,
        match_type = $3,
        match_kind = $4,
        pattern    = $5,
        notes      = $6,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, part_group, match_type, match_kind, pattern, notes, created_at, updated_at
  `, [id, part_group.trim(), match_type, match_kind, pattern.trim(), notes?.trim() || null]);
  if (rows.length === 0) throw new Error('Mapping not found');
  return rows[0];
}

export async function deletePartGroupMapping(id) {
  const p = getPool();
  const { rowCount } = await p.query(`DELETE FROM part_group_mappings WHERE id = $1`, [id]);
  return rowCount > 0;
}

// ── CallRail helpers ─────────────────────────────────────────────────

// Upsert a batch of call rows. Each row is the normalized object the
// fetcher produces (NOT the raw API payload). Conflicts on id are
// updated in place — CallRail mutates lead_status, value, tags, and
// recording metadata after the fact when a user reviews the call.
export async function upsertCallRailCalls(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO callrail_calls (
          id, start_time, customer_phone_number, customer_name, customer_city,
          customer_state, customer_country, tracking_phone_number, business_phone_number,
          duration, answered, voicemail, direction, call_type, lead_status, value,
          first_call, total_calls, prior_calls, agent_email, device_type,
          tracker_id, company_id, company_name,
          source, source_name, campaign, medium, keywords,
          referring_url, landing_page_url, last_requested_url, referrer_domain,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          gclid, fbclid, msclkid, ga_client_id,
          recording, recording_duration, tags, keywords_spotted, raw, fetched_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
          $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
          $41,$42,$43,$44,$45,$46,$47,NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          start_time            = EXCLUDED.start_time,
          duration              = EXCLUDED.duration,
          answered              = EXCLUDED.answered,
          voicemail             = EXCLUDED.voicemail,
          lead_status           = EXCLUDED.lead_status,
          value                 = EXCLUDED.value,
          total_calls           = EXCLUDED.total_calls,
          tags                  = EXCLUDED.tags,
          keywords_spotted      = EXCLUDED.keywords_spotted,
          recording             = EXCLUDED.recording,
          recording_duration    = EXCLUDED.recording_duration,
          raw                   = EXCLUDED.raw,
          fetched_at            = NOW()
      `, [
        r.id, r.start_time, r.customer_phone_number, r.customer_name, r.customer_city,
        r.customer_state, r.customer_country, r.tracking_phone_number, r.business_phone_number,
        r.duration, r.answered, r.voicemail, r.direction, r.call_type, r.lead_status, r.value,
        r.first_call, r.total_calls, r.prior_calls, r.agent_email, r.device_type,
        r.tracker_id, r.company_id, r.company_name,
        r.source, r.source_name, r.campaign, r.medium, r.keywords,
        r.referring_url, r.landing_page_url, r.last_requested_url, r.referrer_domain,
        r.utm_source, r.utm_medium, r.utm_campaign, r.utm_term, r.utm_content,
        r.gclid, r.fbclid, r.msclkid, r.ga_client_id,
        r.recording, r.recording_duration,
        r.tags ? JSON.stringify(r.tags) : null,
        r.keywords_spotted ? JSON.stringify(r.keywords_spotted) : null,
        r.raw ? JSON.stringify(r.raw) : null,
      ]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertCallRailFormSubmissions(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO callrail_form_submissions (
          id, submitted_at, form_url, landing_page_url, referrer, form_data,
          customer_name, customer_email, customer_phone_number,
          source, campaign, medium, keywords,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          gclid, fbclid, msclkid, company_id, tracker_id, lead_status, raw, fetched_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          submitted_at = EXCLUDED.submitted_at,
          form_data    = EXCLUDED.form_data,
          lead_status  = EXCLUDED.lead_status,
          raw          = EXCLUDED.raw,
          fetched_at   = NOW()
      `, [
        r.id, r.submitted_at, r.form_url, r.landing_page_url, r.referrer,
        r.form_data ? JSON.stringify(r.form_data) : null,
        r.customer_name, r.customer_email, r.customer_phone_number,
        r.source, r.campaign, r.medium, r.keywords,
        r.utm_source, r.utm_medium, r.utm_campaign, r.utm_term, r.utm_content,
        r.gclid, r.fbclid, r.msclkid, r.company_id, r.tracker_id, r.lead_status,
        r.raw ? JSON.stringify(r.raw) : null,
      ]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertCallRailTextMessages(rows) {
  if (!rows || rows.length === 0) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await client.query(`
        INSERT INTO callrail_text_messages (
          id, customer_phone_number, tracking_phone_number, customer_name,
          initial_response, state, last_message_time, lead_status,
          company_id, tracker_id, source, campaign, medium, raw, fetched_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          state             = EXCLUDED.state,
          last_message_time = EXCLUDED.last_message_time,
          lead_status       = EXCLUDED.lead_status,
          raw               = EXCLUDED.raw,
          fetched_at        = NOW()
      `, [
        r.id, r.customer_phone_number, r.tracking_phone_number, r.customer_name,
        r.initial_response, r.state, r.last_message_time, r.lead_status,
        r.company_id, r.tracker_id, r.source, r.campaign, r.medium,
        r.raw ? JSON.stringify(r.raw) : null,
      ]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Trackers + companies are config — small, mostly static. Replace whole
// table on each fetch so deletions on the CallRail side propagate.
export async function replaceCallRailTrackers(rows) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM callrail_trackers');
    let n = 0;
    for (const r of rows || []) {
      await client.query(`
        INSERT INTO callrail_trackers (
          id, name, type, status, source, source_name, destination_number,
          tracking_numbers, company_id, campaign_name, raw, fetched_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      `, [
        r.id, r.name, r.type, r.status, r.source, r.source_name, r.destination_number,
        r.tracking_numbers ? JSON.stringify(r.tracking_numbers) : null,
        r.company_id, r.campaign_name,
        r.raw ? JSON.stringify(r.raw) : null,
      ]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function replaceCallRailCompanies(rows) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM callrail_companies');
    let n = 0;
    for (const r of rows || []) {
      await client.query(`
        INSERT INTO callrail_companies (id, name, status, time_zone, created_at_callrail, raw, fetched_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
      `, [r.id, r.name, r.status, r.time_zone, r.created_at_callrail,
          r.raw ? JSON.stringify(r.raw) : null]);
      n++;
    }
    await client.query('COMMIT');
    return n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Last-seen call timestamp — used by the fetcher for incremental pulls.
export async function getCallRailMaxStartTime() {
  const p = getPool();
  const { rows } = await p.query(`SELECT MAX(start_time) AS max FROM callrail_calls`);
  return rows[0]?.max || null;
}

export async function getCallRailRowCount() {
  const p = getPool();
  const { rows } = await p.query(`SELECT COUNT(*)::int AS cnt FROM callrail_calls`);
  return rows[0]?.cnt || 0;
}

// ── CallRail read APIs ───────────────────────────────────────────────

// Daily totals — calls, answered, total duration, lead value sum. Drives
// a timeseries chart and the calls KPI tile.
export async function getCallRailDaily({ since = null, until = null } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`start_time >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`start_time <  $${params.length}::date + INTERVAL '1 day'`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await p.query(`
    SELECT
      (start_time AT TIME ZONE 'UTC')::date::text   AS date,
      COUNT(*)::int                                  AS calls,
      SUM(CASE WHEN answered THEN 1 ELSE 0 END)::int AS answered,
      SUM(CASE WHEN first_call THEN 1 ELSE 0 END)::int AS first_calls,
      SUM(COALESCE(duration, 0))::int                AS duration_seconds,
      SUM(COALESCE(value, 0))::float                 AS value_sum
    FROM callrail_calls
    ${whereSQL}
    GROUP BY 1
    ORDER BY 1 ASC
  `, params);
  return rows;
}

// Per-campaign aggregation. Coalesces utm_campaign → campaign so calls
// tagged via UTM and via CallRail's "source" engine both roll up.
export async function getCallRailByCampaign({ since = null, until = null } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`start_time >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`start_time <  $${params.length}::date + INTERVAL '1 day'`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { rows } = await p.query(`
    SELECT
      -- Attribution priority: utm_campaign → campaign → click-ID
      -- network bucket → '(not set)'. Click-ID fallbacks surface
      -- auto-tagged calls that would otherwise drop from per-campaign
      -- views. See getCampaignRoi for the same logic.
      COALESCE(
        NULLIF(utm_campaign, ''),
        NULLIF(campaign, ''),
        CASE WHEN COALESCE(gclid, '')   <> '' THEN '(google ads — untagged)' END,
        CASE WHEN COALESCE(fbclid, '')  <> '' THEN '(facebook — untagged)'   END,
        CASE WHEN COALESCE(msclkid, '') <> '' THEN '(microsoft ads — untagged)' END,
        '(not set)'
      ) AS campaign_name,
      COUNT(*)::int                                                   AS calls,
      SUM(CASE WHEN answered THEN 1 ELSE 0 END)::int                  AS answered,
      SUM(CASE WHEN first_call THEN 1 ELSE 0 END)::int                AS first_calls,
      SUM(COALESCE(duration, 0))::int                                 AS duration_seconds,
      SUM(COALESCE(value, 0))::float                                  AS value_sum,
      SUM(CASE WHEN lead_status = 'good_lead' THEN 1 ELSE 0 END)::int AS good_leads
    FROM callrail_calls
    ${whereSQL}
    GROUP BY 1
    ORDER BY calls DESC
  `, params);
  return rows;
}

// Recent calls list for the calls table view. Defaults to 100 most recent.
export async function getCallRailCalls({ since = null, until = null, limit = 100 } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`start_time >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`start_time <  $${params.length}::date + INTERVAL '1 day'`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(Math.min(1000, Math.max(1, parseInt(limit, 10) || 100)));
  const { rows } = await p.query(`
    SELECT
      id, start_time, duration, answered, voicemail, direction, call_type,
      lead_status, value, first_call, total_calls, agent_email,
      customer_phone_number, customer_name, customer_city, customer_state,
      tracking_phone_number, source, source_name, campaign, medium, keywords,
      utm_source, utm_medium, utm_campaign, gclid, landing_page_url,
      tracker_id, company_name
    FROM callrail_calls
    ${whereSQL}
    ORDER BY start_time DESC
    LIMIT $${params.length}
  `, params);
  return rows.map(r => ({
    ...r,
    start_time: r.start_time?.toISOString() || null,
    value: r.value != null ? Number(r.value) : null,
  }));
}

// Recent form submissions — newest first.
export async function getCallRailFormSubmissions({ since = null, until = null, limit = 100 } = {}) {
  const p = getPool();
  const where = [];
  const params = [];
  if (since) { params.push(since); where.push(`submitted_at >= $${params.length}::date`); }
  if (until) { params.push(until); where.push(`submitted_at <  $${params.length}::date + INTERVAL '1 day'`); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(Math.min(1000, Math.max(1, parseInt(limit, 10) || 100)));
  const { rows } = await p.query(`
    SELECT
      id, submitted_at, form_url, landing_page_url, referrer,
      customer_name, customer_email, customer_phone_number,
      source, campaign, medium, keywords, lead_status,
      company_id, tracker_id, form_data
    FROM callrail_form_submissions
    ${whereSQL}
    ORDER BY submitted_at DESC
    LIMIT $${params.length}
  `, params);
  return rows.map(r => ({
    ...r,
    submitted_at: r.submitted_at?.toISOString() || null,
  }));
}

// Recent text-message conversations — newest activity first.
export async function getCallRailTextMessages({ limit = 100 } = {}) {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT
      id, customer_phone_number, tracking_phone_number, customer_name,
      initial_response, state, last_message_time, lead_status,
      company_id, tracker_id, source, campaign, medium
    FROM callrail_text_messages
    ORDER BY last_message_time DESC NULLS LAST
    LIMIT $1
  `, [Math.min(1000, Math.max(1, parseInt(limit, 10) || 100))]);
  return rows.map(r => ({
    ...r,
    last_message_time: r.last_message_time?.toISOString() || null,
  }));
}

// Trackers config — which tracking number routes which campaign. Small
// table; the UI shows everything.
export async function listCallRailTrackers() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT id, name, type, status, source, source_name, destination_number,
           tracking_numbers, company_id, campaign_name
    FROM callrail_trackers
    ORDER BY status DESC, name ASC
  `);
  return rows;
}

export async function listCallRailCompanies() {
  const p = getPool();
  const { rows } = await p.query(`
    SELECT id, name, status, time_zone, created_at_callrail
    FROM callrail_companies
    ORDER BY name ASC
  `);
  return rows.map(r => ({
    ...r,
    created_at_callrail: r.created_at_callrail?.toISOString() || null,
  }));
}
