/**
 * fetch-crux.js
 *
 * Pulls the Chrome User Experience Report (CrUX) public history for the
 * configured origin. CrUX p75 LCP / INP / CLS are direct Google ranking
 * factors and a leading indicator of organic traffic decay — if site
 * speed degrades, GSC clicks/impressions follow within weeks.
 *
 * The History API returns up to 25 collection periods (typically weekly,
 * sometimes daily depending on traffic) with p75 timeseries. We persist
 * one row per period using the period's lastDate.
 *
 * Env:
 *   CRUX_API_KEY    — Google Cloud API key with the CrUX API enabled
 *                     https://developer.chrome.com/docs/crux/api
 *   GSC_SITE_URL    — reused as the CrUX origin (trailing slash stripped)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const CACHE_PATH = path.join(CACHE_DIR, 'crux.json');
const CRUX_URL = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function periodToIso(p) {
  const d = p?.lastDate;
  if (!d) return null;
  const y = String(d.year).padStart(4, '0');
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchCrux() {
  const apiKey = process.env.CRUX_API_KEY?.trim();
  const origin = process.env.GSC_SITE_URL?.trim();
  if (!apiKey) throw new Error('Missing CRUX_API_KEY env var');
  if (!origin) throw new Error('Missing GSC_SITE_URL env var (reused as CrUX origin)');

  // CrUX wants the origin without a trailing slash; we accept either form
  // in the env so both GSC and CrUX work without splitting the variable.
  const cleanOrigin = origin.replace(/\/$/, '');

  console.log(`🔎  CrUX fetch — ${cleanOrigin}`);

  const body = {
    origin: cleanOrigin,
    metrics: [
      'largest_contentful_paint',
      'interaction_to_next_paint',
      'cumulative_layout_shift',
    ],
  };

  const resp = await fetch(`${CRUX_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`CrUX API ${resp.status}: ${text.slice(0, 400)}`);
  }

  const data = await resp.json();
  const periods = data.record?.collectionPeriods ?? [];
  const m = data.record?.metrics ?? {};
  const lcp = m.largest_contentful_paint?.percentilesTimeseries?.p75s ?? [];
  const inp = m.interaction_to_next_paint?.percentilesTimeseries?.p75s ?? [];
  const cls = m.cumulative_layout_shift?.percentilesTimeseries?.p75s ?? [];

  const rows = periods.map((p, i) => ({
    date: periodToIso(p),
    lcp_p75: num(lcp[i]),
    inp_p75: num(inp[i]),
    // CLS is unitless and sometimes returned as a string with a decimal
    // point; coerce defensively.
    cls_p75: num(cls[i]),
  })).filter(r => r.date);

  console.log(`    ${rows.length} CrUX collection periods`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'crux',
    origin: cleanOrigin,
    daily: rows,
  }, null, 2));

  if (process.env.DATABASE_URL) {
    const { upsertCruxDaily } = await import('../db.js');
    const inserted = await upsertCruxDaily(rows);
    console.log(`✅  Upserted ${inserted} CrUX rows into PostgreSQL`);
    return { daily: inserted };
  }
  return { daily: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchCrux().catch(e => {
    console.error('❌  CrUX fetch failed:', e.message);
    process.exit(1);
  });
}
