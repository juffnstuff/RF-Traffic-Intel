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

  const rows = [];
  const failedDays = [];
  let totalDays = 0;
  const day = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (day <= end) {
    const iso = day.toISOString().slice(0, 10);
    totalDays++;
    // One bad day must not zero out the whole run: a 400 on the oldest day
    // is just the retention boundary disagreeing with our clock; skip it and
    // keep collecting. If EVERY day fails, that's a real config/auth problem
    // and we throw at the end so fetch-health shows it.
    let results;
    try {
      results = await searchStream(customerId, headers, `
        SELECT
          click_view.gclid,
          campaign.id,
          campaign.name,
          segments.date
        FROM click_view
        WHERE segments.date = '${iso}'
      `, `click_view ${iso}`);
    } catch (e) {
      failedDays.push(iso);
      console.warn(`    ⚠️  click_view ${iso} skipped: ${e.message.slice(0, 160)}`);
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
  if (failedDays.length) {
    console.warn(`    ⚠️  ${failedDays.length}/${totalDays} day(s) skipped: ${failedDays.slice(0, 5).join(', ')}${failedDays.length > 5 ? '…' : ''}`);
  }
  if (totalDays > 0 && failedDays.length === totalDays) {
    throw new Error(`click_view failed for all ${totalDays} day(s) — check Google Ads credentials/API access (first: ${failedDays[0]})`);
  }
  console.log(`    ${rows.length} click rows`);

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
