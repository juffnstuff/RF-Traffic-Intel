/**
 * fetch-google-ads-clicks.js
 *
 * Pulls click_view rows (gclid → campaign) from the Google Ads API into the
 * google_ads_clicks table. This is the exact-match attribution lane: HubSpot
 * contacts and CallRail calls both carry gclids, and joining gclid →
 * campaign_id survives campaign renames and case/whitespace drift that break
 * campaign-NAME string matching.
 *
 * API constraints (both handled here):
 *   - click_view queries must filter to exactly ONE day per request.
 *   - click_view data only exists for the last 90 days.
 *
 * Usage:
 *   node fetchers/fetch-google-ads-clicks.js            # last 14 days
 *   node fetchers/fetch-google-ads-clicks.js --full     # full 90-day window
 */

import 'dotenv/config';
import {
  requireEnv, getAccessToken, adsHeaders, searchStream,
} from './_google-ads-api.js';

const CLICK_VIEW_MAX_DAYS = 90;

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function fetchGoogleAdsClicks({ since = null } = {}) {
  const customerId = requireEnv('GOOGLE_ADS_CUSTOMER_ID').replace(/-/g, '');

  // Clamp to the API's hard 90-day click_view retention. Google evaluates
  // the boundary against the ADS ACCOUNT's timezone while our clock is UTC,
  // so today-89 can already be "day 91" there and 400s — keep two days of
  // margin (the boundary skip below is the real safety net).
  const oldestAllowed = isoDaysAgo(CLICK_VIEW_MAX_DAYS - 2);
  const startDate = (since && since > oldestAllowed) ? since : oldestAllowed;
  const endDate = isoDaysAgo(1);
  if (startDate > endDate) {
    console.log('🔎  Google Ads clicks — window empty, nothing to fetch');
    return { clicks: 0 };
  }

  console.log(`🔎  Google Ads clicks fetch — ${startDate} → ${endDate} (one request per day)`);
  const accessToken = await getAccessToken();
  const headers = adsHeaders(accessToken);

  // Progressively simpler query shapes. GAQL rejects the whole query with
  // INVALID_ARGUMENT if any selected field isn't allowed alongside
  // click_view on this account/API version, so on the first such failure we
  // step down a shape and retry the SAME day; the shape that works is kept
  // for the rest of the run. Names lost by the leaner shapes are backfilled
  // from google_ads_daily_by_campaign (campaign_id → name) after the loop.
  const QUERY_SHAPES = [
    { label: 'gclid+campaign.id+name', fields: 'click_view.gclid, campaign.id, campaign.name, segments.date' },
    { label: 'gclid+campaign.id',      fields: 'click_view.gclid, campaign.id, segments.date' },
    { label: 'gclid only',             fields: 'click_view.gclid, segments.date' },
  ];
  let shapeIdx = 0;

  const rows = [];
  const failedDays = [];
  let totalDays = 0;
  let lastError = null;
  const day = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (day <= end) {
    const iso = day.toISOString().slice(0, 10);
    totalDays++;
    let results = null;
    // Try the current shape; on failure, walk down the ladder for this day.
    while (shapeIdx < QUERY_SHAPES.length) {
      try {
        results = await searchStream(customerId, headers,
          `SELECT ${QUERY_SHAPES[shapeIdx].fields} FROM click_view WHERE segments.date = '${iso}'`,
          `click_view ${iso}`);
        break;
      } catch (e) {
        lastError = e;
        if (shapeIdx < QUERY_SHAPES.length - 1) {
          console.warn(`    ⚠️  shape "${QUERY_SHAPES[shapeIdx].label}" rejected (${e.message.slice(0, 200)}) — retrying ${iso} with "${QUERY_SHAPES[shapeIdx + 1].label}"`);
          shapeIdx++;
        } else {
          // Simplest shape also failed — this day is genuinely unfetchable
          // (retention boundary or a real API problem). Skip it.
          results = null;
          break;
        }
      }
    }
    if (results === null) {
      failedDays.push(iso);
      if (failedDays.length <= 3) console.warn(`    ⚠️  click_view ${iso} skipped: ${lastError?.message?.slice(0, 200)}`);
      day.setUTCDate(day.getUTCDate() + 1);
      continue;
    }
    for (const r of results) {
      const gclid = r.clickView?.gclid;
      if (!gclid) continue;
      rows.push({
        gclid,
        date: r.segments?.date ?? iso,
        campaign_id: String(r.campaign?.id ?? ''),
        campaign_name: r.campaign?.name ?? '',
      });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  if (shapeIdx > 0) {
    console.warn(`    ℹ︎  ran with reduced shape "${QUERY_SHAPES[shapeIdx].label}" — campaign names backfilled from the metrics table`);
  }
  if (failedDays.length) {
    console.warn(`    ⚠️  ${failedDays.length}/${totalDays} day(s) skipped: ${failedDays.slice(0, 5).join(', ')}${failedDays.length > 5 ? '…' : ''}`);
  }
  if (totalDays > 0 && failedDays.length === totalDays) {
    throw new Error(`click_view failed for all ${totalDays} day(s) — last error: ${lastError?.message?.slice(0, 300) || 'unknown'}`);
  }
  console.log(`    ${rows.length} click rows`);

  // Backfill campaign names for rows fetched under a leaner shape: the daily
  // metrics table already maps campaign_id → latest campaign_name.
  const needNames = rows.some(r => r.campaign_id && !r.campaign_name);
  if (needNames && process.env.DATABASE_URL) {
    const { getPool } = await import('../db.js');
    const { rows: nameRows } = await getPool().query(`
      SELECT DISTINCT ON (campaign_id) campaign_id, campaign_name
      FROM google_ads_daily_by_campaign
      ORDER BY campaign_id, date DESC
    `);
    const nameById = new Map(nameRows.map(r => [String(r.campaign_id), r.campaign_name]));
    for (const r of rows) {
      if (r.campaign_id && !r.campaign_name) r.campaign_name = nameById.get(r.campaign_id) ?? '';
    }
  }

  if (process.env.DATABASE_URL && rows.length) {
    const { upsertGoogleAdsClicks } = await import('../db.js');
    const upserted = await upsertGoogleAdsClicks(rows);
    console.log(`✅  Upserted ${upserted} gclid rows into PostgreSQL`);
    return { clicks: upserted };
  }
  return { clicks: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const since = args.includes('--full') ? null : isoDaysAgo(14);
  fetchGoogleAdsClicks({ since }).catch(e => {
    console.error('❌  Google Ads clicks fetch failed:', e.message);
    process.exit(1);
  });
}
