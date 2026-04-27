/**
 * fetch-hubspot.js
 *
 * Pulls closed-won deals + marketing campaigns (when available) from HubSpot
 * using a Private App token. Feeds the Paid / SEO KPI tabs: deals act as the
 * "true acquisition" denominator for CPA, and `hs_analytics_source` drives
 * the paid-vs-organic attribution split.
 *
 * Env required:
 *   HUBSPOT_PRIVATE_APP_TOKEN — Settings → Integrations → Private Apps → Create
 *     Minimum scopes:
 *       crm.objects.deals.read
 *       crm.schemas.deals.read
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
    campaigns: campaignRows,
  }, null, 2));
  console.log(`✅  Wrote HubSpot cache: ${dealRows.length} deals + ${campaignRows.length} campaigns`);

  if (process.env.DATABASE_URL) {
    const { upsertHubSpotDeals, upsertHubSpotCampaigns } = await import('../db.js');
    const dealsInserted = await upsertHubSpotDeals(dealRows);
    const campaignsInserted = campaignRows.length > 0
      ? await upsertHubSpotCampaigns(campaignRows)
      : 0;
    console.log(`✅  Upserted ${dealsInserted} deals + ${campaignsInserted} campaigns into PostgreSQL`);
    return { deals: dealsInserted, campaigns: campaignsInserted, campaignsAvailable };
  }
  return { deals: dealRows.length, campaigns: campaignRows.length, campaignsAvailable };
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
