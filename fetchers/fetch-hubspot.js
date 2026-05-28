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
 *     For the Rubberform NetSuite Quotes custom object (recommended):
 *       crm.schemas.custom.read       — lets us discover the objectTypeId
 *       crm.objects.custom.read       — lets us read quote records
 *     If those are absent the fetcher logs a friendly skip message and
 *     leaves hubspot_netsuite_quotes empty — the rest of the sync still
 *     runs.
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
  // HubSpot's first-touch + recent-touch timestamps. The latest-source
  // timestamp matters for per-quote attribution: a quote dated AFTER the
  // contact's hs_latest_source_timestamp is reliably attributable to the
  // latest source; quotes BEFORE that timestamp can only be reliably
  // attributed to hs_analytics_source (original / first-touch), because
  // hs_latest_source overwrites itself each new session.
  'hs_analytics_source', 'hs_analytics_source_data_1', 'hs_analytics_source_data_2',
  'hs_analytics_first_timestamp',
  'hs_latest_source', 'hs_latest_source_data_1', 'hs_latest_source_data_2',
  'hs_latest_source_timestamp',
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

// HubSpot's search API caps at the 10,000th result for any single query.
// To get all records past that, walk lastmodifieddate descending in
// 10k-row chunks, then re-issue the search with `lastmodifieddate < oldest`
// and repeat until the result set is shorter than 10k.
//
// Returns every object across the windows, de-duplicated by id (boundary
// rows can repeat when the cursor rolls over).
async function searchAllWithChunking({ endpoint, label, properties, sinceEpochMs = null, filterGroups = null, maxRecords = 500000 } = {}) {
  const seen = new Set();
  const out = [];
  // Start window: no upper bound. Lower bound is sinceEpochMs if provided.
  let upperBoundMs = null;
  while (true) {
    const baseFilters = [];
    if (sinceEpochMs) {
      baseFilters.push({ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(sinceEpochMs) });
    }
    if (upperBoundMs != null) {
      baseFilters.push({ propertyName: 'lastmodifieddate', operator: 'LT',  value: String(upperBoundMs) });
    }
    // Caller may pass filterGroups (OR'd groups) — merge baseFilters into each.
    const groups = filterGroups
      ? filterGroups.map(g => ({ filters: [...(g.filters || []), ...baseFilters] }))
      : (baseFilters.length ? [{ filters: baseFilters }] : []);

    let after = undefined;
    let chunkCount = 0;
    let chunkOldestMs = null;
    while (true) {
      const body = {
        filterGroups: groups,
        properties,
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100,
        after,
      };
      const res = await hsFetch(`${BASE}/${endpoint}/search`, {
        method: 'POST',
        body: JSON.stringify(body),
      }, label);
      const j = await res.json();
      for (const o of (j.results || [])) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        out.push(o);
        const ms = Date.parse(o.properties?.lastmodifieddate || o.properties?.hs_lastmodifieddate || '');
        if (Number.isFinite(ms) && (chunkOldestMs == null || ms < chunkOldestMs)) chunkOldestMs = ms;
      }
      chunkCount += (j.results || []).length;
      after = j.paging?.next?.after;
      if (!after) break;
      if (out.length > maxRecords) {
        console.warn(`    ⚠️  ${label} exceeded ${maxRecords} records — stopping`);
        return out;
      }
    }
    // If the chunk was under 100 it's the natural end of the data set
    // (since HubSpot returns at most 100 per page, anything under that
    // means we hit the tail). Also stop if we got 0 — defensive.
    if (chunkCount === 0) break;
    if (chunkCount < 100) break;
    // Past the 10k window? Re-issue with the oldest seen as the new upper bound.
    // The new query starts one ms earlier so the boundary row isn't lost; the
    // seen-set dedupe handles any repeat.
    if (chunkOldestMs == null) break; // can't advance without a timestamp; bail
    if (upperBoundMs != null && chunkOldestMs >= upperBoundMs) break; // not making progress
    upperBoundMs = chunkOldestMs + 1;
  }
  return out;
}

// ── Contact search (chunked) ──────────────────────────────────────────
// Pull every contact with an email OR a NetSuite quote number. ~74k+
// contacts blow past HubSpot's 10k-search cap, so we date-window-chunk.
async function fetchContacts({ sinceEpochMs = null } = {}) {
  return searchAllWithChunking({
    endpoint: 'crm/v3/objects/contacts',
    label: 'contacts.search',
    properties: CONTACT_PROPS,
    sinceEpochMs,
    filterGroups: [
      // Two groups (OR'd by HubSpot): contacts with an email OR contacts
      // with a NetSuite quote number on them. Either makes them joinable
      // to NetSuite data.
      { filters: [{ propertyName: 'email', operator: 'HAS_PROPERTY' }] },
      { filters: [{ propertyName: 'netsuite_quote_number', operator: 'HAS_PROPERTY' }] },
    ],
  });
}

// ── Rubberform NetSuite Quotes custom object ──────────────────────────
// The object is a true HubSpot custom object (not built-in `quotes`).
// We discover its objectTypeId via /crm/v3/schemas at runtime so we don't
// have to hard-code a `2-XXXXXXX` value that varies per HubSpot portal.
// Returns null when the schema can't be read (missing scope or no match)
// so the caller can skip the quote pull without failing the whole sync.
async function discoverQuoteSchema() {
  let res;
  try {
    res = await hsFetch(`${BASE}/crm/v3/schemas`, {}, 'schemas');
  } catch (e) {
    if (e.status === 403) {
      console.log('    ℹ︎  Quote-object schema lookup forbidden (Private App missing crm.schemas.custom.read?) — skipping quote sync');
      return null;
    }
    throw e;
  }
  const j = await res.json();
  const all = j.results || [];
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Score each schema against several candidate phrases — most specific first.
  // Any partial match earns inclusion in the candidate list; we then pick the
  // one with the best score.
  const candidates = [
    'rubberform netsuite quotes',
    'rubberform netsuite quote',
    'netsuite quotes',
    'netsuite quote',
    'ns quotes',
    'rubberform quotes',
    'quotes',
    'quote',
  ];
  let best = null;
  let bestScore = -1;
  for (const s of all) {
    const labels = [s.labels?.singular, s.labels?.plural, s.name, s.fullyQualifiedName]
      .filter(Boolean).map(norm);
    let score = -1;
    for (let i = 0; i < candidates.length; i++) {
      const c = norm(candidates[i]);
      if (labels.some(l => l === c)) { score = Math.max(score, 1000 - i); }
      else if (labels.some(l => l.includes(c))) { score = Math.max(score, 500 - i); }
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best || bestScore < 0) {
    console.log('    ℹ︎  Quote schema not found among custom objects — skipping quote sync');
    if (all.length > 0) {
      const names = all.map(s => `${s.labels?.plural || s.name || '?'} (${s.objectTypeId})`).join(', ');
      console.log(`       Custom objects available: ${names}`);
    }
    return null;
  }
  const props = (best.properties || []).map(p => p.name);
  console.log(`    → discovered quote schema: ${best.objectTypeId} (${best.labels?.plural || best.name}) · ${props.length} properties · match-score=${bestScore}`);
  return {
    objectTypeId: best.objectTypeId,
    propertyNames: props,
  };
}

// Pick which schema properties we want to persist. Done by string-match
// against a wanted-name list because the exact property names vary per
// portal (e.g. `parts_group` vs `part_group` vs `partgroup`). Anything
// matched is included; missing properties are silently skipped.
function pickQuotePropertyNames(allPropertyNames) {
  const wanted = [
    // identity / cross-system join keys
    'quote_no', 'quote_number', 'hs_quote_number',
    'email', 'company',
    // financial / status
    'status', 'hs_pipeline_stage',
    'price_level',
    'total', 'amount', 'tran_total', 'hs_quote_amount',
    'fulfillment_date', 'closedate',
    'include_in_forecast',
    // part-group (multiple spellings)
    'parts_group', 'part_group', 'partsgroup', 'partgroup',
    // owner / sales rep
    'hubspot_owner_id', 'sales_rep',
    // lifecycle timestamps (always there for custom objects)
    'hs_object_id', 'hs_createdate', 'hs_lastmodifieddate',
  ];
  const have = new Set(allPropertyNames);
  // Always include hs_object_id / createdate / lastmodifieddate; the rest
  // only if they exist on this portal's schema.
  return wanted.filter(n => have.has(n));
}

async function fetchNetsuiteQuotes({ objectTypeId, propertyNames, sinceEpochMs = null } = {}) {
  return searchAllWithChunking({
    endpoint: `crm/v3/objects/${objectTypeId}`,
    label: 'ns-quotes.search',
    properties: propertyNames,
    sinceEpochMs,
    filterGroups: null, // no filter — we want every quote
  });
}

// Pick the first available value across a list of candidate property names.
// Custom-object schemas vary per portal, so the safest thing is to map a
// canonical column (e.g. "quote_number") to whichever of [quote_no,
// quote_number, hs_quote_number] is populated on the row.
function pickFirst(props, candidates) {
  for (const n of candidates) {
    const v = props?.[n];
    if (v != null && v !== '') return v;
  }
  return null;
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
      hs_analytics_source:          p.hs_analytics_source || '',
      hs_analytics_source_data_1:   p.hs_analytics_source_data_1 || '',
      hs_analytics_source_data_2:   p.hs_analytics_source_data_2 || '',
      hs_analytics_first_timestamp: parseDate(p.hs_analytics_first_timestamp),
      hs_latest_source:             p.hs_latest_source || '',
      hs_latest_source_data_1:      p.hs_latest_source_data_1 || '',
      hs_latest_source_data_2:      p.hs_latest_source_data_2 || '',
      hs_latest_source_timestamp:   parseDate(p.hs_latest_source_timestamp),
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

  // ── Custom-object: Rubberform NetSuite Quotes ──────────────────────
  // Schema-discovered at runtime; quote-side property names vary per
  // portal so we resolve them dynamically and pick canonical values.
  let quoteRows = [];
  let quoteSchemaResolved = null;
  try {
    quoteSchemaResolved = await discoverQuoteSchema();
    if (quoteSchemaResolved) {
      const pickProps = pickQuotePropertyNames(quoteSchemaResolved.propertyNames);
      console.log(`  → ns-quotes... (${pickProps.length} props selected)`);
      const rawQuotes = await fetchNetsuiteQuotes({
        objectTypeId: quoteSchemaResolved.objectTypeId,
        propertyNames: pickProps,
        sinceEpochMs,
      });
      console.log(`    ${rawQuotes.length} quotes fetched`);
      quoteRows = rawQuotes.map(q => {
        const p = q.properties || {};
        const quoteNo = pickFirst(p, ['quote_no', 'quote_number', 'hs_quote_number']);
        const total   = pickFirst(p, ['total', 'amount', 'tran_total', 'hs_quote_amount']);
        const status  = pickFirst(p, ['status', 'hs_pipeline_stage']);
        const partsGroup = pickFirst(p, ['parts_group', 'part_group', 'partsgroup', 'partgroup']);
        const fulfillment = pickFirst(p, ['fulfillment_date', 'closedate']);
        const includeInForecast = pickFirst(p, ['include_in_forecast']);
        return {
          quote_object_id:    q.id,
          quote_no:           quoteNo || '',
          email:              p.email || '',
          email_normalized:   normalizeEmail(p.email),
          company:            p.company || '',
          status:             status || '',
          parts_group:        partsGroup || '',
          price_level:        p.price_level || '',
          total:              total != null && total !== '' ? Number(total) : null,
          fulfillment_date:   fulfillment ? String(fulfillment).slice(0, 10) : null,
          include_in_forecast: typeof includeInForecast === 'string'
            ? includeInForecast.toLowerCase() === 'yes' || includeInForecast.toLowerCase() === 'true'
            : !!includeInForecast,
          owner_id:           p.hubspot_owner_id || '',
          sales_rep:          p.sales_rep || '',
          created_at:         parseDate(p.hs_createdate),
          modified_at:        parseDate(p.hs_lastmodifieddate),
          raw:                p,
        };
      });
    }
  } catch (e) {
    console.error(`    ⚠️  ns-quotes fetch failed: ${e.message} — continuing without quote sync`);
  }

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
    quoteSchema: quoteSchemaResolved?.objectTypeId || null,
    deals: dealRows,
    contacts: contactRows,
    quotes: quoteRows,
    campaigns: campaignRows,
  }, null, 2));
  console.log(`✅  Wrote HubSpot cache: ${dealRows.length} deals + ${contactRows.length} contacts + ${quoteRows.length} quotes + ${campaignRows.length} campaigns`);

  if (process.env.DATABASE_URL) {
    const {
      upsertHubSpotDeals, upsertHubSpotContacts,
      upsertHubSpotNetsuiteQuotes, upsertHubSpotCampaigns,
    } = await import('../db.js');
    const dealsInserted = await upsertHubSpotDeals(dealRows);
    const contactsInserted = await upsertHubSpotContacts(contactRows);
    const quotesInserted = quoteRows.length > 0
      ? await upsertHubSpotNetsuiteQuotes(quoteRows)
      : 0;
    const campaignsInserted = campaignRows.length > 0
      ? await upsertHubSpotCampaigns(campaignRows)
      : 0;
    console.log(`✅  Upserted ${dealsInserted} deals + ${contactsInserted} contacts + ${quotesInserted} quotes + ${campaignsInserted} campaigns into PostgreSQL`);
    return { deals: dealsInserted, contacts: contactsInserted, quotes: quotesInserted, campaigns: campaignsInserted, campaignsAvailable };
  }
  return { deals: dealRows.length, contacts: contactRows.length, quotes: quoteRows.length, campaigns: campaignRows.length, campaignsAvailable };
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
