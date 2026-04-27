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

// GA4's sessionDefaultChannelGroup labels used for Paid attribution. Matches
// the values GA4 returns for channel groupings that spend money.
const PAID_CHANNEL_NAMES = new Set(['Paid Search', 'Paid Social', 'Paid Video', 'Paid Shopping', 'Paid Other', 'Display', 'Cross-network']);

// HubSpot source labels that correspond to paid acquisition. HubSpot returns
// these as upper-snake strings; we compare against them verbatim.
const PAID_HS_SOURCES = new Set(['PAID_SEARCH', 'PAID_SOCIAL', 'OTHER_CAMPAIGNS']);

function CampaignTable({ rows, dealsByCampaign }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 8 }}>
        Google Ads campaigns in the visible range — sorted by cost
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Campaign</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Cost</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Clicks</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Impr.</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>CTR</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Avg CPC</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>GAds conv.</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>HS deals</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>HS revenue</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>CPA</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const hs = dealsByCampaign.get(r.campaign_id) || dealsByCampaign.get(r.campaign_name) || { deals: 0, revenue: 0 };
            const cpa = hs.deals > 0 ? r.cost / hs.deals : null;
            const roas = r.cost > 0 ? hs.revenue / r.cost : null;
            return (
              <tr key={r.campaign_id} style={{ borderTop: i === 0 ? 'none' : '1px solid #475569' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.campaign_name}>
                  {r.campaign_name}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.clicks)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.impressions)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.ctr)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.avg_cpc != null ? '$' + r.avg_cpc.toFixed(2) : '—'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.conversions)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(hs.deals)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(hs.revenue)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{cpa != null ? fmtMoney(cpa) : '—'}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}>{roas != null ? fmtRatio(roas) : '—'}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={11} style={{ padding: '10px 8px', color: '#64748b' }}>
              No Google Ads campaigns with spend in the current range.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function PaidKPIsPage() {
  const [range, setRange] = useLocalStorageState('range', '6m');
  const [selectedYears, setSelectedYears] = useLocalStorageState('years', []);
  const [weekdayOnly, setWeekdayOnly] = useLocalStorageState('weekdayOnly', false);
  const [showDaily, setShowDaily] = useLocalStorageState('showDaily', false);

  const [gads, setGads] = useState(null);
  const [gadsCampaigns, setGadsCampaigns] = useState(null);
  const [hsDealsDaily, setHsDealsDaily] = useState(null);
  const [hsDealsWindow, setHsDealsWindow] = useState(null);
  const [ga4Channels, setGa4Channels] = useState(null);
  const [ga4Agg, setGa4Agg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/google-ads').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/hubspot-deals-daily').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ga4-channels-daily').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ga4').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([g, h, c, a]) => {
        setGads(g);
        setHsDealsDaily(h);
        setGa4Channels(c);
        setGa4Agg(a);
        if (!g || (g.daily || []).length === 0) {
          setError('No Google Ads data yet. Add GOOGLE_ADS_* credentials and run a Google Ads fetch.');
        } else {
          setError(null);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const availableYears = useMemo(() => {
    const rows = gads?.daily || ga4Agg?.daily || [];
    if (!rows.length) return [];
    return Array.from(new Set(rows.map(d => d.date.slice(0, 4)))).sort();
  }, [gads, ga4Agg]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  // Campaign + deal window stats refetch on range change.
  useEffect(() => {
    const rows = gads?.daily || [];
    if (!rows.length) return;
    const last = rows[rows.length - 1].date;
    const params = new URLSearchParams({ until: last });
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    const qs = params.toString();
    Promise.all([
      fetch(`/api/google-ads-campaigns?${qs}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/hubspot-deals?${qs}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([cmp, deals]) => {
        setGadsCampaigns(cmp);
        setHsDealsWindow(deals);
      });
  }, [gads, cutoff, selectedYears]);

  // Build the main daily series: cost / clicks / impressions from Google Ads,
  // paid-sessions from GA4 by-channel, paid-sourced HubSpot deals per day.
  const fullSeries = useMemo(() => {
    const gadsRows = gads?.daily || [];
    if (!gadsRows.length) return [];
    let ordered = [...gadsRows].sort((a, b) => a.date.localeCompare(b.date));
    if (weekdayOnly) ordered = weekdaysOnly(ordered);

    // Paid sessions per day: sum GA4 channel rows whose channel is in PAID_CHANNEL_NAMES.
    const paidSessByDate = new Map();
    for (const r of (ga4Channels?.daily || [])) {
      if (!PAID_CHANNEL_NAMES.has(r.channel)) continue;
      paidSessByDate.set(r.date, (paidSessByDate.get(r.date) || 0) + (r.sessions || 0));
    }

    // Paid-sourced HubSpot deals + revenue per day.
    const paidDealsByDate = new Map();
    const paidRevByDate = new Map();
    for (const r of (hsDealsDaily?.daily || [])) {
      if (!PAID_HS_SOURCES.has(r.source)) continue;
      paidDealsByDate.set(r.date, (paidDealsByDate.get(r.date) || 0) + (r.deals || 0));
      paidRevByDate.set(r.date, (paidRevByDate.get(r.date) || 0) + (r.revenue || 0));
    }

    const cost      = ordered.map(d => Number(d.cost) || 0);
    const clicks    = ordered.map(d => Number(d.clicks) || 0);
    const impr      = ordered.map(d => Number(d.impressions) || 0);
    const gadsConv  = ordered.map(d => Number(d.conversions) || 0);
    const paidSess  = ordered.map(d => paidSessByDate.get(d.date) || 0);
    const hsDeals   = ordered.map(d => paidDealsByDate.get(d.date) || 0);
    const hsRev     = ordered.map(d => paidRevByDate.get(d.date) || 0);
    const cpa       = ordered.map((_, i) => hsDeals[i] > 0 ? cost[i] / hsDeals[i] : 0);
    const roas      = ordered.map((_, i) => cost[i] > 0 ? hsRev[i] / cost[i] : 0);
    const ctr       = ordered.map((_, i) => impr[i] > 0 ? clicks[i] / impr[i] : 0);
    const cpc       = ordered.map((_, i) => clicks[i] > 0 ? cost[i] / clicks[i] : 0);

    const mmm = (xs) => [movingAverage(xs, 30), movingAverage(xs, 90)];
    const [cost30, cost90]     = mmm(cost);
    const [clk30, clk90]       = mmm(clicks);
    const [ctr30, ctr90]       = mmm(ctr);
    const [cpc30, cpc90]       = mmm(cpc);
    const [cpa30, cpa90]       = mmm(cpa);
    const [roas30, roas90]     = mmm(roas);

    return ordered.map((d, i) => ({
      date: d.date,
      cost: cost[i], cost30: cost30[i], cost90: cost90[i],
      clicks: clicks[i], clk30: clk30[i], clk90: clk90[i],
      impressions: impr[i],
      gadsConv: gadsConv[i],
      paidSessions: paidSess[i],
      hsDeals: hsDeals[i],
      hsRevenue: hsRev[i],
      ctr: ctr[i], ctr30: ctr30[i], ctr90: ctr90[i],
      avgCpc: cpc[i], cpc30: cpc30[i], cpc90: cpc90[i],
      cpa: cpa[i], cpa30: cpa30[i], cpa90: cpa90[i],
      roas: roas[i], roas30: roas30[i], roas90: roas90[i],
    }));
  }, [gads, ga4Channels, hsDealsDaily, weekdayOnly]);

  const chartData = useMemo(() => {
    if (!fullSeries.length) return [];
    return fullSeries.filter(d => inRange(d, cutoff, selectedYears));
  }, [fullSeries, cutoff, selectedYears]);

  const kpi = useMemo(() => {
    if (chartData.length === 0) return null;
    const sum = (f) => chartData.reduce((s, r) => s + (r[f] || 0), 0);
    const cost = sum('cost');
    const clicks = sum('clicks');
    const impressions = sum('impressions');
    const gadsConv = sum('gadsConv');
    const paidSessions = sum('paidSessions');
    const hsDeals = sum('hsDeals');
    const hsRevenue = sum('hsRevenue');
    return {
      cost, clicks, impressions, gadsConv, paidSessions, hsDeals, hsRevenue,
      ctr: impressions > 0 ? clicks / impressions : null,
      avgCpc: clicks > 0 ? cost / clicks : null,
      costPerSession: paidSessions > 0 ? cost / paidSessions : null,
      cpa: hsDeals > 0 ? cost / hsDeals : null,
      cpaGa4: gadsConv > 0 ? cost / gadsConv : null,
      roas: cost > 0 ? hsRevenue / cost : null,
    };
  }, [chartData]);

  // Deal counts by campaign — joins GAds campaign_name (and deal's
  // source_data_1 / campaign_guid) so the campaign table can show a deals
  // column. This is a name-match fallback; a true campaign_guid match only
  // works when HubSpot Marketing Hub populates hs_campaign.
  const dealsByCampaign = useMemo(() => {
    const map = new Map();
    for (const d of (hsDealsWindow?.deals || [])) {
      if (!PAID_HS_SOURCES.has(d.source)) continue;
      // source_data_1 is often the ad network / campaign name in HubSpot.
      // campaign_guid matches when Marketing Hub is present.
      const keys = [d.campaign_guid, d.source_data_1, d.source_data_2].filter(Boolean);
      for (const k of keys) {
        const cur = map.get(k) || { deals: 0, revenue: 0 };
        cur.deals += 1;
        cur.revenue += Number(d.amount) || 0;
        map.set(k, cur);
      }
    }
    return map;
  }, [hsDealsWindow]);

  const handleClear = useCallback(() => {
    setRange('6m');
    setSelectedYears([]);
    setWeekdayOnly(false);
    setShowDaily(false);
    clearAllFilters();
  }, [setRange, setSelectedYears, setWeekdayOnly, setShowDaily]);

  const subtitle = `Google Ads + HubSpot + GA4 · ${chartData.length} days visible`;

  if (loading && !gads) {
    return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading paid media data...</div>;
  }
  if (error && (!gads || (gads.daily || []).length === 0)) {
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 40px)' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>
          Configure <code>GOOGLE_ADS_DEVELOPER_TOKEN</code>, <code>GOOGLE_ADS_CLIENT_ID</code>,
          <code> GOOGLE_ADS_CLIENT_SECRET</code>, <code>GOOGLE_ADS_REFRESH_TOKEN</code>, and
          <code> GOOGLE_ADS_CUSTOMER_ID</code>, then POST to <code>/api/refresh/google-ads?mode=full</code>.
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
            <StatCard label="Cost" value={fmtMoney(kpi.cost)} sub="Google Ads, in range" />
            <StatCard label="Clicks" value={fmtNum(kpi.clicks)} sub="Google Ads" />
            <StatCard label="Impressions" value={fmtNum(kpi.impressions)} sub="Google Ads" />
            <StatCard label="CTR" value={fmtPct(kpi.ctr)} sub="clicks / impressions" />
            <StatCard label="Avg CPC" value={kpi.avgCpc != null ? '$' + kpi.avgCpc.toFixed(2) : '—'} sub="cost / clicks" />
            <StatCard label="Paid sessions" value={fmtNum(kpi.paidSessions)} sub="GA4, paid channels" />
            <StatCard label="Cost / session" value={kpi.costPerSession != null ? '$' + kpi.costPerSession.toFixed(2) : '—'} sub="cost / paid sessions" />
            <StatCard label="Deals (paid)" value={fmtNum(kpi.hsDeals)} sub="HubSpot closed-won" />
            <StatCard label="Revenue (paid)" value={fmtMoney(kpi.hsRevenue)} sub="HubSpot" />
            <StatCard label="CPA" value={kpi.cpa != null ? fmtMoney(kpi.cpa) : '—'} sub="cost / HubSpot deals" />
            <StatCard label="ROAS" value={kpi.roas != null ? fmtRatio(kpi.roas) : '—'} sub="revenue / cost" />
            <StatCard label="CPA (GAds conv.)" value={kpi.cpaGa4 != null ? fmtMoney(kpi.cpaGa4) : '—'} sub="cost / GAds conversions" />
          </div>
        )}

        {chartData.length > 0 && (
          <>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Spend trend
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Cost DMA" data={chartData}
                fieldRaw="cost" field30="cost30" field90="cost90"
                formatter={fmtMoney} showDaily={showDaily} />
              <DMALineChart title="Clicks DMA" data={chartData}
                fieldRaw="clicks" field30="clk30" field90="clk90"
                formatter={fmtNum} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="CTR DMA" data={chartData}
                fieldRaw="ctr" field30="ctr30" field90="ctr90"
                formatter={fmtPct} showDaily={showDaily} />
              <DMALineChart title="Avg CPC DMA" data={chartData}
                fieldRaw="avgCpc" field30="cpc30" field90="cpc90"
                formatter={(v) => v == null ? '—' : '$' + v.toFixed(2)} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Acquisition quality
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="CPA DMA (cost / HubSpot deals)" data={chartData}
                fieldRaw="cpa" field30="cpa30" field90="cpa90"
                formatter={(v) => v == null || v === 0 ? '—' : fmtMoney(v)} showDaily={showDaily} />
              <DMALineChart title="ROAS DMA (revenue / cost)" data={chartData}
                fieldRaw="roas" field30="roas30" field90="roas90"
                formatter={fmtRatio} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Campaign performance
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <CampaignTable rows={gadsCampaigns?.campaigns || []} dealsByCampaign={dealsByCampaign} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
