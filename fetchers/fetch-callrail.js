/**
 * fetch-callrail.js
 *
 * Pulls calls + form submissions + text messages + trackers + companies
 * from CallRail. Calls drive cross-source attribution: utm_campaign /
 * gclid / landing_page_url join straight to GA4 + Google Ads + GSC.
 *
 * Env required:
 *   CALLRAIL_API_KEY     — Settings → Integrations → API access
 *   CALLRAIL_ACCOUNT_ID  — visible in URL when viewing the account
 *
 * API: https://api.callrail.com/v3/a/{account_id}/{resource}.json
 *   Auth header: Authorization: Token token="<api_key>"
 *   Pagination: page + per_page (max 250); response includes total_pages
 *   Date filter on calls: start_date=YYYY-MM-DDTHH:MM:SS
 *
 * Resources requested via fields= are returned in the same envelope key
 * as the resource itself (calls → response.calls[], etc.).
 *
 * Fail-soft: if env vars are missing, the orchestrator skips with a log
 * line — matches how GA4/Ads/GSC are wired.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'callrail.json');

const PER_PAGE = 250;

function envOrNull(name) {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : null;
}

function requireEnv(name) {
  const v = envOrNull(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function buildUrl(accountId, resource, params = {}) {
  const u = new URL(`https://api.callrail.com/v3/a/${encodeURIComponent(accountId)}/${resource}`);
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function crFetch(url, label) {
  const apiKey = requireEnv('CALLRAIL_API_KEY');
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Token token="${apiKey}"`,
          Accept: 'application/json',
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
    // CallRail rate-limits at 1200 req/minute. 429 includes Retry-After.
    const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retriable || attempt >= MAX_ATTEMPTS - 1) {
      const body = await res.text().catch(() => '');
      const err = new Error(`${label} HTTP ${res.status}: ${body.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    const retryAfter = Number(res.headers.get('Retry-After'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(60000, retryAfter * 1000 + 250)
      : Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
    console.log(`    ⏳ ${label} HTTP ${res.status}; retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_ATTEMPTS})`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// All CallRail collection endpoints share the same envelope:
//   { page, per_page, total_pages, total_records, [resourceKey]: [...] }
// We pull every page until page >= total_pages.
async function fetchPaginated(accountId, resource, resourceKey, baseParams, label) {
  const out = [];
  let page = 1;
  while (true) {
    const url = buildUrl(accountId, resource, { ...baseParams, page, per_page: PER_PAGE });
    const res = await crFetch(url, `${label} p${page}`);
    const j = await res.json();
    const items = Array.isArray(j[resourceKey]) ? j[resourceKey] : [];
    out.push(...items);
    const total = Number(j.total_pages) || 1;
    if (page >= total || items.length === 0) break;
    page++;
  }
  return out;
}

// ── Field selection ─────────────────────────────────────────────────
// CallRail returns a small default set; ?fields= adds the rest. We pull
// everything we promote to columns plus a couple extras for raw.
const CALL_FIELDS = [
  'answered', 'business_phone_number', 'customer_city', 'customer_country',
  'customer_name', 'customer_phone_number', 'customer_state', 'direction',
  'duration', 'recording', 'recording_duration', 'start_time',
  'tracking_phone_number', 'voicemail', 'call_type', 'company_id', 'company_name',
  'created_at', 'device_type', 'first_call', 'lead_status', 'note', 'source',
  'source_name', 'tags', 'total_calls', 'value', 'tracker_id', 'keywords',
  'medium', 'campaign', 'referring_url', 'landing_page_url', 'last_requested_url',
  'referrer_domain', 'utm_source', 'utm_medium', 'utm_term', 'utm_content',
  'utm_campaign', 'ga', 'gclid', 'fbclid', 'msclkid',
  'keywords_spotted', 'agent_email', 'prior_calls',
].join(',');

// Form submissions accept a much smaller fields= allowlist than calls —
// no utm_*, no click IDs, no tracker_id. Per CallRail's own validation
// error, valid form fields include id, company_id, person_id, form_data,
// form_url, landing_page_url, referrer, referring_url, submitted_at,
// first_form, customer_*, formatted_*, source, keywords, campaign,
// medium, lead_status, note. We list explicitly so a future schema
// change won't silently drop fields we need.
const FORM_FIELDS = [
  'submitted_at', 'form_url', 'landing_page_url', 'referrer', 'referring_url',
  'form_data', 'company_id', 'source', 'campaign', 'medium', 'keywords',
  'lead_status', 'first_form', 'customer_phone_number', 'customer_name',
  'customer_email', 'note',
].join(',');

// text-messages, trackers, and companies don't document a stable fields=
// allowlist. We omit the param entirely and let CallRail return its
// default set — the normalizers tolerate missing fields by defaulting
// to null. If a specific field we need ends up missing, surface it
// here.
const TEXT_FIELDS = null;
const TRACKER_FIELDS = null;
const COMPANY_FIELDS = null;

// ── Normalizers (API payload → DB row) ──────────────────────────────

function pickEmail(c) {
  // Primary form-data payload usually has an "email" key; CallRail also
  // surfaces it as customer_email on form-submission rows directly.
  if (c.customer_email) return c.customer_email;
  if (c.form_data && typeof c.form_data === 'object') {
    return c.form_data.email || c.form_data.Email || null;
  }
  return null;
}

function normalizeCall(c) {
  return {
    id: String(c.id),
    start_time: c.start_time || null,
    customer_phone_number: c.customer_phone_number || null,
    customer_name: c.customer_name || null,
    customer_city: c.customer_city || null,
    customer_state: c.customer_state || null,
    customer_country: c.customer_country || null,
    tracking_phone_number: c.tracking_phone_number || null,
    business_phone_number: c.business_phone_number || null,
    duration: typeof c.duration === 'number' ? c.duration : (c.duration ? parseInt(c.duration, 10) : null),
    answered: typeof c.answered === 'boolean' ? c.answered : null,
    voicemail: typeof c.voicemail === 'boolean' ? c.voicemail : null,
    direction: c.direction || null,
    call_type: c.call_type || null,
    lead_status: c.lead_status || null,
    value: c.value != null && c.value !== '' ? Number(c.value) : null,
    first_call: typeof c.first_call === 'boolean' ? c.first_call : null,
    total_calls: typeof c.total_calls === 'number' ? c.total_calls : null,
    prior_calls: typeof c.prior_calls === 'number' ? c.prior_calls : null,
    agent_email: c.agent_email || null,
    device_type: c.device_type || null,
    tracker_id: c.tracker_id ? String(c.tracker_id) : null,
    company_id: c.company_id ? String(c.company_id) : null,
    company_name: c.company_name || null,
    source: c.source || null,
    source_name: c.source_name || null,
    campaign: c.campaign || null,
    medium: c.medium || null,
    keywords: c.keywords || null,
    referring_url: c.referring_url || null,
    landing_page_url: c.landing_page_url || null,
    last_requested_url: c.last_requested_url || null,
    referrer_domain: c.referrer_domain || null,
    utm_source: c.utm_source || null,
    utm_medium: c.utm_medium || null,
    utm_campaign: c.utm_campaign || null,
    utm_term: c.utm_term || null,
    utm_content: c.utm_content || null,
    gclid: c.gclid || null,
    fbclid: c.fbclid || null,
    msclkid: c.msclkid || null,
    ga_client_id: c.ga || null,
    recording: c.recording || null,
    recording_duration: c.recording_duration ? parseInt(c.recording_duration, 10) : null,
    tags: Array.isArray(c.tags) ? c.tags : null,
    keywords_spotted: Array.isArray(c.keywords_spotted) ? c.keywords_spotted : null,
    raw: c,
  };
}

function normalizeForm(f) {
  return {
    id: String(f.id),
    submitted_at: f.submitted_at || null,
    form_url: f.form_url || null,
    landing_page_url: f.landing_page_url || null,
    referrer: f.referrer || null,
    form_data: f.form_data || null,
    customer_name: f.form_data?.name || f.form_data?.Name || null,
    customer_email: pickEmail(f),
    customer_phone_number: f.form_data?.phone || f.form_data?.Phone || null,
    source: f.source || null,
    campaign: f.campaign || null,
    medium: f.medium || null,
    keywords: f.keywords || null,
    utm_source: f.utm_source || null,
    utm_medium: f.utm_medium || null,
    utm_campaign: f.utm_campaign || null,
    utm_term: f.utm_term || null,
    utm_content: f.utm_content || null,
    gclid: f.gclid || null,
    fbclid: f.fbclid || null,
    msclkid: f.msclkid || null,
    company_id: f.company_id ? String(f.company_id) : null,
    tracker_id: f.tracker_id ? String(f.tracker_id) : null,
    lead_status: f.lead_status || null,
    raw: f,
  };
}

function normalizeText(t) {
  return {
    id: String(t.id),
    customer_phone_number: t.customer_phone_number || null,
    tracking_phone_number: t.tracking_phone_number || null,
    customer_name: t.customer_name || null,
    initial_response: t.initial_response || null,
    state: t.state || null,
    last_message_time: t.last_message_time || null,
    lead_status: t.lead_status || null,
    company_id: t.company_id ? String(t.company_id) : null,
    tracker_id: t.tracker_id ? String(t.tracker_id) : null,
    source: t.source || null,
    campaign: t.campaign || null,
    medium: t.medium || null,
    raw: t,
  };
}

function normalizeTracker(t) {
  return {
    id: String(t.id),
    name: t.name || null,
    type: t.type || null,
    status: t.status || null,
    source: t.source || null,
    source_name: t.source_name || null,
    destination_number: t.destination_number || null,
    tracking_numbers: Array.isArray(t.tracking_numbers) ? t.tracking_numbers : null,
    company_id: t.company_id ? String(t.company_id) : null,
    campaign_name: t.campaign_name || null,
    raw: t,
  };
}

function normalizeCompany(c) {
  return {
    id: String(c.id),
    name: c.name || null,
    status: c.status || null,
    time_zone: c.time_zone || null,
    created_at_callrail: c.created_at || null,
    raw: c,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────

export async function fetchCallRail({ since = null } = {}) {
  const accountId = requireEnv('CALLRAIL_ACCOUNT_ID');
  const startDateParam = since ? formatStartDate(since) : null;

  console.log('🔄  CallRail fetch starting…');
  if (startDateParam) console.log(`    incremental since ${startDateParam}`);
  else                console.log(`    full pull (no start_date filter)`);

  // Each resource runs in its own try/catch — CallRail validates fields=
  // per-endpoint and a 4xx on one resource shouldn't abort the rest.
  // Add-on-gated endpoints (e.g. text-messages without SMS) return 403/404
  // and skip silently.
  const fetchOne = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        console.log(`    skipped (HTTP ${e.status}) — ${label} not enabled on this account`);
      } else {
        console.error(`    ⚠️  ${label} fetch failed: ${e.message}`);
      }
      return [];
    }
  };

  // Build the params object, only including fields= when the caller has
  // a curated allowlist for this endpoint.
  const withFields = (fields, extra = {}) => ({
    ...extra,
    ...(fields ? { fields } : {}),
  });

  console.log('  → calls…');
  const rawCalls = await fetchOne('calls', () => fetchPaginated(
    accountId, 'calls.json', 'calls',
    withFields(CALL_FIELDS, {
      sorting: 'start_time', order: 'asc',
      ...(startDateParam ? { start_date: startDateParam } : {}),
    }),
    'calls'));
  const calls = rawCalls.map(normalizeCall);
  console.log(`    ${calls.length} calls`);

  console.log('  → form submissions…');
  const rawForms = await fetchOne('form_submissions', () => fetchPaginated(
    accountId, 'form_submissions.json', 'form_submissions',
    withFields(FORM_FIELDS, {
      sorting: 'submitted_at', order: 'asc',
      ...(startDateParam ? { start_date: startDateParam } : {}),
    }),
    'forms'));
  const forms = rawForms.map(normalizeForm);
  console.log(`    ${forms.length} form submissions`);

  console.log('  → text messages…');
  // text-messages.json doesn't accept start_date — pull current page set
  // and let the upsert dedupe by id. Conversations are long-lived.
  const rawTexts = await fetchOne('text_messages', () => fetchPaginated(
    accountId, 'text-messages.json', 'text_messages',
    withFields(TEXT_FIELDS),
    'texts'));
  const texts = rawTexts.map(normalizeText);
  console.log(`    ${texts.length} text-message conversations`);

  console.log('  → trackers…');
  const rawTrackers = await fetchOne('trackers', () => fetchPaginated(
    accountId, 'trackers.json', 'trackers',
    withFields(TRACKER_FIELDS),
    'trackers'));
  const trackers = rawTrackers.map(normalizeTracker);
  console.log(`    ${trackers.length} trackers`);

  console.log('  → companies…');
  const rawCompanies = await fetchOne('companies', () => fetchPaginated(
    accountId, 'companies.json', 'companies',
    withFields(COMPANY_FIELDS),
    'companies'));
  const companies = rawCompanies.map(normalizeCompany);
  console.log(`    ${companies.length} companies`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'callrail',
    since: startDateParam,
    counts: {
      calls: calls.length, forms: forms.length, texts: texts.length,
      trackers: trackers.length, companies: companies.length,
    },
  }, null, 2));

  if (process.env.DATABASE_URL) {
    const {
      upsertCallRailCalls, upsertCallRailFormSubmissions, upsertCallRailTextMessages,
      replaceCallRailTrackers, replaceCallRailCompanies,
    } = await import('../db.js');
    const callsN = await upsertCallRailCalls(calls);
    const formsN = await upsertCallRailFormSubmissions(forms);
    const textsN = await upsertCallRailTextMessages(texts);
    const trackersN = await replaceCallRailTrackers(trackers);
    const companiesN = await replaceCallRailCompanies(companies);
    console.log(`✅  CallRail upsert: ${callsN} calls, ${formsN} forms, ${textsN} texts, ${trackersN} trackers, ${companiesN} companies`);
    return { calls: callsN, forms: formsN, texts: textsN, trackers: trackersN, companies: companiesN };
  }

  console.log('✅  CallRail cache written (no DATABASE_URL set; skipped upsert)');
  return { calls: calls.length, forms: forms.length, texts: texts.length,
           trackers: trackers.length, companies: companies.length };
}

// CallRail's start_date param wants 'YYYY-MM-DDTHH:MM:SS' — pass through
// when the caller already has that shape, otherwise treat as date-only.
function formatStartDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return s.slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00`;
  // Date object or ISO with TZ — round-trip through Date to be safe.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  // Default incremental window: last 60 days. --full pulls the entire
  // history (CallRail keeps calls forever on most plans).
  const since = args.includes('--full') ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  fetchCallRail({ since }).catch(e => {
    console.error('❌  CallRail fetch failed:', e.message);
    process.exit(1);
  });
}
