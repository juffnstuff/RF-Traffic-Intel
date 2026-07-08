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

  // Clamp to the API's hard 90-day click_view retention (yesterday back,
  // today's clicks are still accruing and land on the next run).
  const oldestAllowed = isoDaysAgo(CLICK_VIEW_MAX_DAYS - 1);
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
  const day = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (day <= end) {
    const iso = day.toISOString().slice(0, 10);
    const results = await searchStream(customerId, headers, `
      SELECT
        click_view.gclid,
        campaign.id,
        campaign.name,
        segments.date
      FROM click_view
      WHERE segments.date = '${iso}'
    `, `click_view ${iso}`);
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
