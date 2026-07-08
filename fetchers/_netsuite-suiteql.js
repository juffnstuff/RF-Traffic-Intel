/**
 * _netsuite-suiteql.js
 *
 * Shared OAuth 1.0 TBA signing + paginated SuiteQL client.
 *
 * The two original fetchers (fetch-netsuite.js, fetch-netsuite-dim.js) keep
 * their own inline copies of this logic to avoid churning known-good code in
 * the same commit that introduces the new per-customer / per-transaction
 * fetchers. New fetchers (customers, transactions) import from here. Future
 * cleanup can collapse the originals to this module too.
 */

import 'dotenv/config';
import crypto from 'crypto';
import fetch from 'node-fetch';

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildOAuthHeader({ method, baseUrl, queryParams, accountId, consumerKey, consumerSecret, tokenId, tokenSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: tokenId,
    oauth_version: '1.0',
  };
  const allParams = { ...oauthParams };
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) allParams[k] = String(v);
  }
  const paramString = Object.keys(allParams).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join('&');
  const signatureBaseString = [
    method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString),
  ].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(signatureBaseString).digest('base64');
  oauthParams.oauth_signature = signature;
  const headerParts = Object.keys(oauthParams).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');
  return `OAuth realm="${accountId}", ${headerParts}`;
}

/**
 * Run a SuiteQL query, paginated. Throws on row-cap hit so callers see
 * truncation as an error rather than silent data loss.
 *
 * @param {string} sql
 * @param {object} opts
 * @param {string} [opts.maxRowsEnv]  — env var name carrying the row cap
 * @param {number} [opts.defaultMax]  — default row cap if env unset
 * @param {string} [opts.label]       — short string for log messages
 */
export async function runSuiteQL(sql, { maxRowsEnv = 'NS_MAX_ROWS', defaultMax = 200000, label = 'rows' } = {}) {
  const accountId = requireEnv('NS_ACCOUNT_ID');
  const consumerKey = requireEnv('NS_CONSUMER_KEY');
  const consumerSecret = requireEnv('NS_CONSUMER_SECRET');
  const tokenId = requireEnv('NS_TOKEN_ID');
  const tokenSecret = requireEnv('NS_TOKEN_SECRET');

  const MAX_ROWS = Number(process.env[maxRowsEnv]) || defaultMax;
  const accountSlug = accountId.toLowerCase().replace(/_/g, '-');
  const baseUrl = `https://${accountSlug}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

  const rows = [];
  let offset = 0;
  const limit = 1000;
  let hasMore = true;
  let warned = false;
  const MAX_ATTEMPTS = 6;

  while (hasMore) {
    const queryParams = { limit: String(limit), offset: String(offset) };
    const fullUrl = `${baseUrl}?limit=${limit}&offset=${offset}`;

    let res;
    for (let attempt = 0; ; attempt++) {
      // Regenerate OAuth header on each attempt — nonce + timestamp must be unique per request.
      const authHeader = buildOAuthHeader({
        method: 'POST', baseUrl, queryParams,
        accountId, consumerKey, consumerSecret, tokenId, tokenSecret,
      });
      res = await fetch(fullUrl, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', Prefer: 'transient' },
        body: JSON.stringify({ q: sql }),
      });
      if (res.status !== 429 || attempt >= MAX_ATTEMPTS - 1) break;
      const retryAfter = res.headers.get('Retry-After');
      const headerMs = retryAfter && !Number.isNaN(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
      const waitMs = headerMs ?? Math.min(60000, 2000 * (2 ** attempt) + Math.floor(Math.random() * 1000));
      console.log(`    ⏳ 429 — concurrency limit; backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`    ✗ HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new Error(`SuiteQL error (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    rows.push(...(data.items || []));
    hasMore = data.hasMore === true;
    offset += limit;

    if (!warned && hasMore && offset >= MAX_ROWS * 0.8) {
      console.warn(`    ⚠️  approaching row cap (${offset}/${MAX_ROWS}) for ${label} — raise ${maxRowsEnv} if the result looks truncated`);
      warned = true;
    }
    if (hasMore && offset >= MAX_ROWS) {
      throw new Error(`SuiteQL row cap hit at ${offset} ${label} — raise ${maxRowsEnv} (currently ${MAX_ROWS}) to fetch the remainder.`);
    }
  }
  return rows;
}

/** Parse NetSuite's MM/DD/YYYY or YYYY-MM-DD date strings into ISO YYYY-MM-DD. */
export function parseNSDate(s) {
  if (!s) return null;
  const str = String(s);
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// NetSuite SuiteQL returns wall-clock timestamps in the account timezone
// with no zone marker. The old parser appended 'Z', mislabeling Eastern
// afternoons as UTC (~4–5h early) — which broke every comparison against
// genuinely-UTC HubSpot timestamps.
const NS_TIMEZONE = process.env.NS_TIMEZONE || 'America/New_York';

// Convert a wall-clock time in NS_TIMEZONE to a correct UTC ISO string.
function nsWallTimeToUtcIso(y, mo, d, hour, mm, ss) {
  const offsetAt = (t) => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: NS_TIMEZONE, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
                           +parts.hour, +parts.minute, +parts.second);
    return asUtc - t; // ms the zone is ahead of UTC at instant t
  };
  // Interpret the wall time as UTC, then correct by the zone offset at that
  // instant; re-measuring once handles DST-boundary edge cases.
  const guess = Date.UTC(y, mo - 1, d, hour, mm, ss);
  let ts = guess - offsetAt(guess);
  ts = guess - offsetAt(ts);
  return new Date(ts).toISOString();
}

/** Parse NetSuite datetime to ISO UTC timestamp (preserves time-of-day). */
export function parseNSDateTime(s) {
  if (!s) return null;
  const str = String(s);
  // "5/14/2026 3:42:17 pm" or "5/14/2026" or already-ISO.
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)?)?/i);
  if (!m) {
    const d = parseNSDate(str);
    return d ? `${d}T00:00:00Z` : null;
  }
  let [, mo, d, y, hh = '0', mm = '0', ss = '0', mer] = m;
  let hour = Number(hh);
  if (mer && mer.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (mer && mer.toLowerCase() === 'am' && hour === 12) hour = 0;
  return nsWallTimeToUtcIso(Number(y), Number(mo), Number(d), hour, Number(mm), Number(ss));
}

export function assertIsoDate(s) {
  if (s == null) return;
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid 'since' date: expected YYYY-MM-DD, got ${JSON.stringify(s)}`);
  }
}

export function buildFilter(sinceDateStr, col) {
  if (!sinceDateStr) return '';
  return `AND ${col} >= TO_DATE('${sinceDateStr}', 'YYYY-MM-DD')`;
}

/** Last 10 digits of any phone string, or null if fewer than 10 digits. */
export function phoneToDigits(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Lowercase + trim; returns null if it doesn't look like an email. */
export function normalizeEmail(email) {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  if (!e.includes('@') || e.length < 5) return null;
  return e;
}
