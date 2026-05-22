/**
 * fetch-hubspot.js
 *
 * Pulls deals + contacts + marketing campaigns from HubSpot using a Private
 * App token. Contacts carry NetSuite-linked custom properties
 * (`netsuite_quote_number`, `netsuite_quote_status`, …) that the existing
 * NS↔HS middleware writes — those give us a direct primary-key bridge from a
 * HubSpot contact to a NetSuite transaction (tran_id), so we can attribute
 * NetSuite revenue back to HubSpot's first-touch source/campaign.
 *
 * Env required:
 *   HUBSPOT_PRIVATE_APP_TOKEN — Settings → Integrations → Private Apps → Create
 *     Minimum scopes:
 *       crm.objects.deals.read
 *       crm.schemas.deals.read
 *       crm.objects.contacts.read
 *       crm.schemas.contacts.read
 *     For campaigns (Marketing Hub only; safe to omit):
 *       crm.objects.marketing_events.read
 *
 * The /marketing/v3/campaigns endpoint is tier-gated. If it returns 403
 * we skip silently and fall back to the attribution fields already on each
 * deal (`hs_campaign`, `hs_analytics_source`, etc.).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'hubspot-deals.json');

const BASE = 'https://api.hubapi.com';

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function hsFetch(url, init = {}, label = 'hubspot') {
  const token = requireEnv('HUBSPOT_PRIVATE_APP_TOKEN');
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS - 1) throw e;
      const waitMs = Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
      console.log(`    ⏳ ${label} network error (${e.message}); retrying in ${Math.round(waitMs / 1000)}s`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.ok) return res;
    // 429 + 5xx → retry. HubSpot's 429s include a X-HubSpot-RateLimit-Interval-Milliseconds
    // header sometimes; honor it when present.
    const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retriable || attempt >= MAX_ATTEMPTS - 1) {
      const body = await res.text().catch(() => '');
      const err = new Error(`${label} HTTP ${res.status}: ${body.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    const hintMs = Number(res.headers.get('X-HubSpot-RateLimit-Interval-Milliseconds'));
    const waitMs = Number.isFinite(hintMs) && hintMs > 0
      ? Math.min(30000, hintMs + 500)
      : Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
    console.log(`    ⏳ ${label} HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ── Pipelines (stage GUID → human label + which stage is closed-won) ──
async function fetchPipelines() {
  const res = await hsFetch(`${BASE}/crm/v3/pipelines/deals`, {}, 'pipelines');
  const j = await res.json();
  const byStageId = new Map();
  const closedWonStageIds = new Set();
  for (const pipe of (j.results || [])) {
    for (const stage of (pipe.stages || [])) {
      byStageId.set(stage.id, { label: stage.label, pipeline: pipe.label });
      // HubSpot marks closed-won via stage metadata `probability: "1.0"` and
      // `isClosed: true`. Both keys live under stage.metadata.
      const meta = stage.metadata || {};
      const prob = Number(meta.probability);
      if (meta.isClosed === 'true' && prob === 1) {
        closedWonStageIds.add(stage.id);
      }
    }
  }
  return { byStageId, closedWonStageIds };
}

const DEAL_PROPS = [
  'dealname', 'amount', 'closedate', 'dealstage', 'pipeline',
  'hubspot_owner_id', 'hs_analytics_source', 'hs_analytics_source_data_1',
  'hs_analytics_source_data_2', 'hs_campaign',
  'createdate', 'hs_lastmodifieddate',
];

// Contact properties we care about. Two clusters:
//   1. HubSpot's first-touch attribution (hs_analytics_*, lead_source, gclid)
//      — this is the *real* lead-source signal we want to attribute revenue to.
//   2. NetSuite-linked fields written into HubSpot by the existing NS↔HS
//      middleware (netsuite_quote_*). These give us a direct, primary-key-style
//      bridge from a HubSpot contact to a NetSuite transaction via tran_id —
//      no email-normalization fuzz needed.
const CONTACT_PROPS = [
  // identity
  'email', 'firstname', 'lastname',
  // HubSpot first-touch + recent-touch attribution
  'hs_analytics_source', 'hs_analytics_source_data_1', 'hs_analytics_source_data_2',
  'hs_latest_source', 'hs_latest_source_data_1', 'hs_latest_source_data_2',
  'lead_source', 'source',
  'gclid',
  'first_campaign_contacted', 'last_campaign_contacted', 'current_roi_campaign',
  // NetSuite bridge fields (written by the existing NS↔HS integration)
  'netsuite_quote_number', 'netsuite_quote_date', 'netsuite_quote_status',
  'netsuite_contact_status', 'netsuite_lifecycle_stage',
  'netsuite_sales_rep', 'netsuite_subsidiary',
  'customer_type', 'company_type',
  // form metadata (useful for diagnostic on conversion path)
  'form_type',
  // lifecycle timestamps
  'createdate', 'lastmodifieddate',
];

// ── Deal search (paginated) ───────────────────────────────────────────
async function fetchDeals({ sinceEpochMs = null } = {}) {
  const results = [];
  let after = undefined;
  const filters = sinceEpochMs
    ? [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(sinceEpochMs) }]
    : [];
  while (true) {
    const body = {
      filterGroups: filters.length ? [{ filters }] : [],
      properties: DEAL_PROPS,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 100,
      after,
    };
    const res = await hsFetch(`${BASE}/crm/v3/objects/deals/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, 'deals.search');
    const j = await res.json();
    for (const d of (j.results || [])) results.push(d);
    after = j.paging?.next?.after;
    if (!after) break;
    // Bail-out cap to prevent a malformed response from looping forever.
    // 50k deals is well beyond any realistic private-app-tier account.
    if (results.length > 50000) {
      console.warn('    ⚠️  deal pagination exceeded 50k — stopping');
      break;
    }
  }
  return results;
}

// ── Contact search (paginated) ────────────────────────────────────────
// We pull every contact that has an email (anonymous contacts can't be
// joined to NetSuite anyway). Incremental mode filters by lastmodifieddate.
async function fetchContacts({ sinceEpochMs = null } = {}) {
  const results = [];
  let after = undefined;
  const filters = [
    // Require an email so the email-fallback NS join has something to work
    // with. Contacts without an email but with netsuite_quote_number set are
    // rare — but if it happens, we still want them: OR'd in via a separate
    // filterGroup (HubSpot treats filterGroups as OR'd together).
    { propertyName: 'email', operator: 'HAS_PROPERTY' },
  ];
  if (sinceEpochMs) {
    filters.push({
      propertyName: 'lastmodifieddate',
      operator: 'GTE',
      value: String(sinceEpochMs),
    });
  }
  const filterGroups = [
    { filters },
    // Always include contacts with a NetSuite quote number, even if no email.
    {
      filters: [
        { propertyName: 'netsuite_quote_number', operator: 'HAS_PROPERTY' },
        ...(sinceEpochMs ? [{
          propertyName: 'lastmodifieddate',
          operator: 'GTE',
          value: String(sinceEpochMs),
        }] : []),
      ],
    },
  ];
  while (true) {
    const body = {
      filterGroups,
      properties: CONTACT_PROPS,
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
      limit: 100,
      after,
    };
    const res = await hsFetch(`${BASE}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, 'contacts.search');
    const j = await res.json();
    for (const c of (j.results || [])) results.push(c);
    after = j.paging?.next?.after;
    if (!after) break;
    // Same bail-out cap pattern as deals. HubSpot's search API caps at
    // ~10k results per query anyway, so this is mainly belt-and-suspenders.
    if (results.length > 200000) {
      console.warn('    ⚠️  contact pagination exceeded 200k — stopping');
      break;
    }
  }
  return results;
}

// ── Marketing campaigns (tier-gated, optional) ────────────────────────
async function fetchCampaigns() {
  const results = [];
  let after = undefined;
  while (true) {
    const url = new URL(`${BASE}/marketing/v3/campaigns`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    let res;
    try {
      res = await hsFetch(url.toString(), {}, 'campaigns');
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        console.log('    ℹ︎  Marketing campaigns endpoint unavailable (non-Marketing-Hub tier) — skipping');
        return { results: [], available: false };
      }
      throw e;
    }
    const j = await res.json();
    for (const c of (j.results || [])) results.push(c);
    after = j.paging?.next?.after;
    if (!after) break;
  }
  return { results, available: true };
}

function normalizeEmail(e) {
  if (!e || typeof e !== 'string') return null;
  const trimmed = e.trim().toLowerCase();
  // Same shape as netsuite_customers.email_normalized so the email-fallback
  // join works as a plain equality.
  return trimmed || null;
}

function parseDate(s) {
  if (!s) return null;
  // HubSpot returns ISO strings or epoch-ms strings depending on the
  // property type. Both round-trip through Date cleanly.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function fetchHubSpot({ since = null } = {}) {
  requireEnv('HUBSPOT_PRIVATE_APP_TOKEN');

  const mode = since ? `incremental (since ${since})` : `full history`;
  console.log(`🔎  HubSpot fetch — ${mode}`);

  const { byStageId, closedWonStageIds } = await fetchPipelines();
  console.log(`    ${byStageId.size} deal stages loaded, ${closedWonStageIds.size} closed-won`);

  const sinceEpochMs = since ? new Date(since + 'T00:00:00Z').getTime() : null;
  console.log('  → deals...');
  const rawDeals = await fetchDeals({ sinceEpochMs });
  console.log(`    ${rawDeals.length} deals fetched`);

  const dealRows = rawDeals.map(d => {
    const p = d.properties || {};
    const stageId = p.dealstage || '';
    const stageInfo = byStageId.get(stageId) || {};
    return {
      deal_id:       d.id,
      deal_name:     p.dealname || '',
      amount:        Number(p.amount) || 0,
      close_date:    p.closedate ? p.closedate.slice(0, 10) : null,
      stage:         stageId,
      stage_label:   stageInfo.label || '',
      pipeline:      p.pipeline || '',
      owner_id:      p.hubspot_owner_id || '',
      source:        p.hs_analytics_source || '',
      source_data_1: p.hs_analytics_source_data_1 || '',
      source_data_2: p.hs_analytics_source_data_2 || '',
      campaign_guid: p.hs_campaign || '',
      is_closed_won: closedWonStageIds.has(stageId),
      created_at:    parseDate(p.createdate),
      modified_at:   parseDate(p.hs_lastmodifieddate),
    };
  });

  console.log('  → contacts...');
  const rawContacts = await fetchContacts({ sinceEpochMs });
  console.log(`    ${rawContacts.length} contacts fetched`);

  const contactRows = rawContacts.map(c => {
    const p = c.properties || {};
    return {
      contact_id:                c.id,
      email:                     p.email || '',
      email_normalized:          normalizeEmail(p.email),
      first_name:                p.firstname || '',
      last_name:                 p.lastname || '',
      hs_analytics_source:       p.hs_analytics_source || '',
      hs_analytics_source_data_1:p.hs_analytics_source_data_1 || '',
      hs_analytics_source_data_2:p.hs_analytics_source_data_2 || '',
      hs_latest_source:          p.hs_latest_source || '',
      hs_latest_source_data_1:   p.hs_latest_source_data_1 || '',
      hs_latest_source_data_2:   p.hs_latest_source_data_2 || '',
      lead_source:               p.lead_source || '',
      source:                    p.source || '',
      gclid:                     p.gclid || '',
      first_campaign_contacted:  p.first_campaign_contacted || '',
      last_campaign_contacted:   p.last_campaign_contacted || '',
      current_roi_campaign:      p.current_roi_campaign || '',
      // NetSuite bridge — the high-confidence join key to netsuite_transactions.tran_id
      netsuite_quote_number:     p.netsuite_quote_number || '',
      netsuite_quote_date:       p.netsuite_quote_date ? p.netsuite_quote_date.slice(0, 10) : null,
      netsuite_quote_status:     p.netsuite_quote_status || '',
      netsuite_contact_status:   p.netsuite_contact_status || '',
      netsuite_lifecycle_stage:  p.netsuite_lifecycle_stage || '',
      netsuite_sales_rep:        p.netsuite_sales_rep || '',
      netsuite_subsidiary:       p.netsuite_subsidiary || '',
      customer_type:             p.customer_type || '',
      company_type:              p.company_type || '',
      form_type:                 p.form_type || '',
      created_at:                parseDate(p.createdate),
      modified_at:               parseDate(p.lastmodifieddate),
    };
  });

  console.log('  → marketing campaigns...');
  const { results: rawCampaigns, available: campaignsAvailable } = await fetchCampaigns();
  const campaignRows = rawCampaigns.map(c => ({
    campaign_id: c.id,
    name:        c.name || c.properties?.hs_name || '',
    type:        c.type || '',
    created_at:  parseDate(c.createdAt),
  }));
  if (campaignsAvailable) console.log(`    ${campaignRows.length} campaigns fetched`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'hubspot',
    since,
    campaignsAvailable,
    deals: dealRows,
    contacts: contactRows,
    campaigns: campaignRows,
  }, null, 2));
  console.log(`✅  Wrote HubSpot cache: ${dealRows.length} deals + ${contactRows.length} contacts + ${campaignRows.length} campaigns`);

  if (process.env.DATABASE_URL) {
    const { upsertHubSpotDeals, upsertHubSpotContacts, upsertHubSpotCampaigns } = await import('../db.js');
    const dealsInserted = await upsertHubSpotDeals(dealRows);
    const contactsInserted = await upsertHubSpotContacts(contactRows);
    const campaignsInserted = campaignRows.length > 0
      ? await upsertHubSpotCampaigns(campaignRows)
      : 0;
    console.log(`✅  Upserted ${dealsInserted} deals + ${contactsInserted} contacts + ${campaignsInserted} campaigns into PostgreSQL`);
    return { deals: dealsInserted, contacts: contactsInserted, campaigns: campaignsInserted, campaignsAvailable };
  }
  return { deals: dealRows.length, contacts: contactRows.length, campaigns: campaignRows.length, campaignsAvailable };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  // HubSpot deals don't have a fixed history cap, so --full means "all deals"
  // and default is the modification-time incremental window.
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchHubSpot({ since }).catch(e => {
    console.error('❌  HubSpot fetch failed:', e.message);
    process.exit(1);
  });
}
