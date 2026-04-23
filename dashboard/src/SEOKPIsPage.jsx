import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  DMALineChart, StatCard, fmtNum, fmtMoney, fmtPct, fmtRatio,
} from './DashboardView';
import {
  RELATIVE_RANGES, RangeDropdown, YearsDropdown,
  useLocalStorageState, clearAllFilters,
} from './FilterControls';
import { movingAverage, weekdaysOnly } from './utils/analytics';

function rangeCutoff(range, selectedYears) {
  if (selectedYears.length > 0) return null;
  if (range === 'all') return null;
  const days = RELATIVE_RANGES[range];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function inRange(row, cutoff, selectedYears) {
  if (selectedYears.length > 0) return selectedYears.includes(row.date.slice(0, 4));
  if (!cutoff) return true;
  return row.date >= cutoff;
}

// GA4 channel group for organic search.
const ORGANIC_CHANNEL = 'Organic Search';
const ORGANIC_HS_SOURCE = 'ORGANIC_SEARCH';

function TopTable({ title, rows, linkify }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 480px', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 8 }}>{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>{linkify ? 'Page' : 'Query'}</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Clicks</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Impr.</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>CTR</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Pos.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.dimension} style={{ borderTop: i === 0 ? 'none' : '1px solid #475569' }}>
              <td style={{ padding: '6px 8px', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.dimension}>
                {linkify
                  ? <a href={r.dimension} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>{r.dimension.replace(/^https?:\/\/[^/]+/, '')}</a>
                  : r.dimension}
              </td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.clicks)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.impressions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.ctr)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.position != null ? r.position.toFixed(1) : '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} style={{ padding: '10px 8px', color: '#64748b' }}>No data for this window.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function SEOKPIsPage() {
  const [range, setRange] = useLocalStorageState('range', '6m');
  const [selectedYears, setSelectedYears] = useLocalStorageState('years', []);
  const [weekdayOnly, setWeekdayOnly] = useLocalStorageState('weekdayOnly', false);
  const [showDaily, setShowDaily] = useLocalStorageState('showDaily', false);

  const [gsc, setGsc] = useState(null);
  const [topQueries, setTopQueries] = useState(null);
  const [topPages, setTopPages] = useState(null);
  const [ga4Channels, setGa4Channels] = useState(null);
  const [hsDealsDaily, setHsDealsDaily] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/gsc').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/gsc-top?kind=query&limit=50').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/gsc-top?kind=page&limit=50').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ga4-channels-daily').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/hubspot-deals-daily').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([g, q, p, c, h]) => {
        setGsc(g); setTopQueries(q); setTopPages(p); setGa4Channels(c); setHsDealsDaily(h);
        if (!g || (g.daily || []).length === 0) {
          setError('No Search Console data yet. Configure GSC_SITE_URL and run a GSC fetch.');
        } else {
          setError(null);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const availableYears = useMemo(() => {
    const rows = gsc?.daily || [];
    if (!rows.length) return [];
    return Array.from(new Set(rows.map(d => d.date.slice(0, 4)))).sort();
  }, [gsc]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  const fullSeries = useMemo(() => {
    const rows = gsc?.daily || [];
    if (!rows.length) return [];
    let ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    if (weekdayOnly) ordered = weekdaysOnly(ordered);

    // Organic sessions + conversions from GA4 by-channel.
    const sessByDate = new Map();
    const convByDate = new Map();
    for (const r of (ga4Channels?.daily || [])) {
      if (r.channel !== ORGANIC_CHANNEL) continue;
      sessByDate.set(r.date, (sessByDate.get(r.date) || 0) + (r.sessions || 0));
      convByDate.set(r.date, (convByDate.get(r.date) || 0) + (r.conversions || 0));
    }
    const dealsByDate = new Map();
    const revByDate = new Map();
    for (const r of (hsDealsDaily?.daily || [])) {
      if (r.source !== ORGANIC_HS_SOURCE) continue;
      dealsByDate.set(r.date, (dealsByDate.get(r.date) || 0) + (r.deals || 0));
      revByDate.set(r.date, (revByDate.get(r.date) || 0) + (r.revenue || 0));
    }

    const clicks   = ordered.map(d => Number(d.clicks) || 0);
    const impr     = ordered.map(d => Number(d.impressions) || 0);
    const ctr      = ordered.map(d => Number(d.ctr) || 0);
    const pos      = ordered.map(d => Number(d.position) || 0);
    const orgSess  = ordered.map(d => sessByDate.get(d.date) || 0);
    const orgConv  = ordered.map(d => convByDate.get(d.date) || 0);
    const orgDeals = ordered.map(d => dealsByDate.get(d.date) || 0);
    const orgRev   = ordered.map(d => revByDate.get(d.date) || 0);

    const mmm = (xs) => [movingAverage(xs, 30), movingAverage(xs, 90)];
    const [clk30, clk90] = mmm(clicks);
    const [imp30, imp90] = mmm(impr);
    const [ctr30, ctr90] = mmm(ctr);
    const [pos30, pos90] = mmm(pos);
    const [sess30, sess90] = mmm(orgSess);

    return ordered.map((d, i) => ({
      date: d.date,
      clicks: clicks[i], clk30: clk30[i], clk90: clk90[i],
      impressions: impr[i], imp30: imp30[i], imp90: imp90[i],
      ctr: ctr[i], ctr30: ctr30[i], ctr90: ctr90[i],
      position: pos[i], pos30: pos30[i], pos90: pos90[i],
      organicSessions: orgSess[i], sess30: sess30[i], sess90: sess90[i],
      organicConv: orgConv[i],
      organicDeals: orgDeals[i],
      organicRevenue: orgRev[i],
    }));
  }, [gsc, ga4Channels, hsDealsDaily, weekdayOnly]);

  const chartData = useMemo(() => {
    if (!fullSeries.length) return [];
    return fullSeries.filter(d => inRange(d, cutoff, selectedYears));
  }, [fullSeries, cutoff, selectedYears]);

  const kpi = useMemo(() => {
    if (chartData.length === 0) return null;
    const sum = (f) => chartData.reduce((s, r) => s + (r[f] || 0), 0);
    const weighted = (f, weightField = 'impressions') => {
      let num = 0, denom = 0;
      for (const r of chartData) {
        const w = r[weightField] || 0;
        if (w > 0 && r[f] != null) { num += r[f] * w; denom += w; }
      }
      return denom > 0 ? num / denom : null;
    };
    const clicks = sum('clicks');
    const impressions = sum('impressions');
    return {
      clicks, impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      avgPosition: weighted('position'),
      organicSessions: sum('organicSessions'),
      organicConv: sum('organicConv'),
      organicDeals: sum('organicDeals'),
      organicRevenue: sum('organicRevenue'),
    };
  }, [chartData]);

  const handleClear = useCallback(() => {
    setRange('6m');
    setSelectedYears([]);
    setWeekdayOnly(false);
    setShowDaily(false);
    clearAllFilters();
  }, [setRange, setSelectedYears, setWeekdayOnly, setShowDaily]);

  const subtitle = `Search Console + GA4 + HubSpot · ${chartData.length} days visible · GSC lags ~2-3 days`;

  if (loading && !gsc) {
    return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading SEO data...</div>;
  }
  if (error && (!gsc || (gsc.daily || []).length === 0)) {
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 40px)' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>
          GSC uses the same GA4 service account. Add its email as a User in Search Console
          at https://search.google.com/search-console/users, confirm <code>GSC_SITE_URL</code>
          matches the property exactly, then POST to <code>/api/refresh/gsc?mode=full</code>.
        </p>
      </div>
    );
  }

  return (
    <>
      <div style={{
        padding: '12px clamp(12px, 4vw, 32px)', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ color: '#64748b', fontSize: 11 }}>{subtitle}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <RangeDropdown range={range} disabled={selectedYears.length > 0}
            onChange={r => { setSelectedYears([]); setRange(r); }} />
          <YearsDropdown selected={selectedYears} available={availableYears} onChange={setSelectedYears} />
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
            <input type="checkbox" checked={weekdayOnly} onChange={e => setWeekdayOnly(e.target.checked)} />
            Weekdays
          </label>
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showDaily} onChange={e => setShowDaily(e.target.checked)} />
            Show Daily
          </label>
          {(range !== '6m' || selectedYears.length > 0 || weekdayOnly || showDaily) && (
            <button onClick={handleClear}
              style={{ background: '#7f1d1d', color: '#fecaca', border: 'none', borderRadius: 4,
                padding: '5px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      <main style={{ padding: '16px clamp(12px, 4vw, 32px)', maxWidth: 1600, margin: '0 auto' }}>
        {kpi && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Impressions" value={fmtNum(kpi.impressions)} sub="GSC" />
            <StatCard label="Clicks" value={fmtNum(kpi.clicks)} sub="GSC" />
            <StatCard label="CTR" value={fmtPct(kpi.ctr)} sub="clicks / impressions" />
            <StatCard label="Avg position" value={kpi.avgPosition != null ? kpi.avgPosition.toFixed(1) : '—'} sub="lower is better" />
            <StatCard label="Organic sessions" value={fmtNum(kpi.organicSessions)} sub="GA4 channel" />
            <StatCard label="Organic conversions" value={fmtNum(kpi.organicConv)} sub="GA4 key events" />
            <StatCard label="Deals (organic)" value={fmtNum(kpi.organicDeals)} sub="HubSpot closed-won" />
            <StatCard label="Revenue (organic)" value={fmtMoney(kpi.organicRevenue)} sub="HubSpot" />
          </div>
        )}

        {chartData.length > 0 && (
          <>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Search visibility
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Impressions DMA" data={chartData}
                fieldRaw="impressions" field30="imp30" field90="imp90"
                formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Clicks DMA" data={chartData}
                fieldRaw="clicks" field30="clk30" field90="clk90"
                formatter={fmtNum} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="CTR DMA" data={chartData}
                fieldRaw="ctr" field30="ctr30" field90="ctr90"
                formatter={fmtPct} showDaily={showDaily} />
              <DMALineChart title="Avg position DMA (lower is better)" data={chartData}
                fieldRaw="position" field30="pos30" field90="pos90"
                formatter={(v) => v == null ? '—' : v.toFixed(1)} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Organic → site traffic
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="Organic sessions DMA" data={chartData}
                fieldRaw="organicSessions" field30="sess30" field90="sess90"
                formatter={fmtNum} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Top queries &amp; pages (trailing 28 days)
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <TopTable title={`Top queries — window ending ${topQueries?.window_end ?? '—'}`} rows={topQueries?.rows || []} linkify={false} />
              <TopTable title={`Top pages — window ending ${topPages?.window_end ?? '—'}`} rows={topPages?.rows || []} linkify={true} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
