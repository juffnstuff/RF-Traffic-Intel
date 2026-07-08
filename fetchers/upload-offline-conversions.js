/**
 * upload-offline-conversions.js
 *
 * Pushes won NetSuite quote revenue back into Google Ads as offline click
 * conversions (gclid-keyed). This is what lets Smart Bidding optimize toward
 * actual quote revenue instead of on-site form fills — every ingredient is
 * already in the warehouse: the contact's gclid, the quote's won status and
 * value.
 *
 * Safety model:
 *   - DRY RUN by default: prints exactly what would upload, sends nothing.
 *   - `--live` actually calls uploadClickConversions.
 *   - Every attempt is recorded in google_ads_offline_uploads keyed by
 *     quote_no, so a quote is never uploaded twice (orderId also carries the
 *     quote_no, giving Google-side dedup as a second belt).
 *
 * Env (beyond the standard GOOGLE_ADS_* set):
 *   GOOGLE_ADS_CONVERSION_ACTION_ID — numeric id of an offline-conversion
 *     action of type "Import" (create under Goals → Conversions → New →
 *     Import → CRM). Required.
 *   GOOGLE_ADS_CONVERSION_CURRENCY  — optional, default USD.
 *
 * Usage:
 *   node fetchers/upload-offline-conversions.js            # dry run
 *   node fetchers/upload-offline-conversions.js --live     # real upload
 *   node fetchers/upload-offline-conversions.js --days 60  # lookback (default 90)
 */

import 'dotenv/config';
import {
  ADS_API_VERSION, requireEnv, getAccessToken, adsHeaders, fetchWithRetry,
} from './_google-ads-api.js';

// Google Ads wants "yyyy-MM-dd HH:mm:ss+00:00".
function toAdsDateTime(d) {
  const iso = new Date(d).toISOString(); // 2026-07-08T19:42:17.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

export async function uploadOfflineConversions({ days = 90, live = false } = {}) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const customerId = requireEnv('GOOGLE_ADS_CUSTOMER_ID').replace(/-/g, '');
  const conversionActionId = requireEnv('GOOGLE_ADS_CONVERSION_ACTION_ID');
  const currency = process.env.GOOGLE_ADS_CONVERSION_CURRENCY?.trim() || 'USD';
  const conversionAction = `customers/${customerId}/conversionActions/${conversionActionId}`;

  const { getWonQuotesWithGclid, markOfflineUpload } = await import('../db.js');
  const candidates = await getWonQuotesWithGclid({ days });
  console.log(`🔎  Offline conversions — ${candidates.length} won quote(s) with a gclid, last ${days}d, not yet uploaded`);
  if (!candidates.length) return { uploaded: 0, dryRun: !live };

  const conversions = candidates.map(c => ({
    gclid: c.gclid,
    conversionAction,
    // Google requires the conversion time to be AFTER the click; the won
    // date always is. Uploads older than the action's click-through window
    // get rejected per-row and recorded as errors below.
    conversionDateTime: toAdsDateTime(c.conversion_time),
    conversionValue: Number(c.value) || 0,
    currencyCode: currency,
    orderId: c.quote_no,
  }));

  if (!live) {
    for (const c of conversions) {
      console.log(`    [dry-run] ${c.orderId}: $${c.conversionValue} @ ${c.conversionDateTime} (gclid ${c.gclid.slice(0, 12)}…)`);
    }
    console.log(`💡  Dry run only — re-run with --live to upload ${conversions.length} conversion(s).`);
    return { uploaded: 0, candidates: conversions.length, dryRun: true };
  }

  const accessToken = await getAccessToken();
  const url = `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: adsHeaders(accessToken),
    body: JSON.stringify({ conversions, partialFailure: true }),
  }, 'uploadClickConversions');
  const j = await res.json();

  // partialFailure mode: failed rows are identified by index in the error
  // details; everything not named there succeeded.
  const failedByIndex = new Map();
  const pfe = j.partialFailureError;
  if (pfe?.details?.length) {
    for (const detail of pfe.details) {
      for (const err of (detail.errors || [])) {
        const idx = err.location?.fieldPathElements?.find(el => el.fieldName === 'conversions')?.index;
        if (idx != null) failedByIndex.set(Number(idx), err.message || 'unknown error');
      }
    }
    if (!failedByIndex.size) {
      // Couldn't attribute failures to rows — be conservative, mark all failed.
      conversions.forEach((_, i) => failedByIndex.set(i, pfe.message || 'partial failure'));
    }
  }

  let ok = 0, failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const err = failedByIndex.get(i) ?? null;
    if (err) failed++; else ok++;
    await markOfflineUpload({
      quote_no: c.quote_no,
      gclid: c.gclid,
      conversion_value: Number(c.value) || 0,
      conversion_time: c.conversion_time,
      status: err ? 'error' : 'success',
      error: err,
    });
  }
  console.log(`✅  Uploaded ${ok} conversion(s)` + (failed ? `, ${failed} failed (recorded; failed rows retry next run)` : ''));
  return { uploaded: ok, failed, dryRun: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? Math.max(1, parseInt(args[daysIdx + 1], 10) || 90) : 90;
  uploadOfflineConversions({ days, live }).catch(e => {
    console.error('❌  Offline conversion upload failed:', e.message);
    process.exit(1);
  });
}
