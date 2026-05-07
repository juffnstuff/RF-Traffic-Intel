import React, { useState, useEffect, useMemo } from 'react';
import { fmtNum, fmtMoney, fmtPct, fmtRatio } from './DashboardView';
import {
  RELATIVE_RANGES, RangeDropdown, YearsDropdown,
  useLocalStorageState, clearAllFilters,
} from './FilterControls';

function rangeCutoff(range, selectedYears) {
  if (selectedYears.length > 0) return null;
  if (range === 'all') return null;
  const days = RELATIVE_RANGES[range];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function VisibilityBadge({ inAds, inGa4 }) {
  // Visual diagnostic for tagging health: a campaign in Ads but not GA4
  // means UTM/auto-tagging isn't reaching analytics. The reverse means
  // GA4 is seeing a UTM that has no live spend (likely organic UTM or
  // legacy campaign).
  if (inAds && inGa4) return null;
  const label = inAds ? 'Ads only' : 'GA4 only';
  const color = inAds ? '#f59e0b' : '#94a3b8';
  return (
    <span style={{
      fontSize: 9,
      color,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      fontWeight: 700,
      marginLeft: 6,
    }}>{label}</span>
  );
}

function CampaignRoiTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No joined data in the selected window. Either GA4 or Google Ads has no rows here.
    </div>;
  }
  const totals = rows.reduce((acc, r) => {
    acc.cost += r.cost;
    acc.ad_clicks += r.ad_clicks;
    acc.ad_impressions += r.ad_impressions;
    acc.ga4_sessions += r.ga4_sessions;
    acc.ga4_conversions += r.ga4_conversions;
    acc.ga4_revenue += r.ga4_revenue;
    return acc;
  }, { cost: 0, ad_clicks: 0, ad_impressions: 0, ga4_sessions: 0, ga4_conversions: 0, ga4_revenue: 0 });
  const totalRoas = totals.cost > 0 ? totals.ga4_revenue / totals.cost : null;
  const totalCpa = totals.ga4_conversions > 0 ? totals.cost / totals.ga4_conversions : null;
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Campaign</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Cost</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Ad Clicks</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Impr.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Sessions</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Sess/Click</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Conv.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Revenue</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>CPA</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.campaign_name + i} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.campaign_name}>
                {r.campaign_name || <span style={{ color: 'var(--dso-text-faint)' }}>(unnamed)</span>}
                <VisibilityBadge inAds={r.in_ads} inGa4={r.in_ga4} />
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ad_clicks)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ad_impressions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_sessions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.sessions_per_click != null ? fmtRatio(r.sessions_per_click) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_conversions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.ga4_revenue)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.cost_per_ga4_conv != null ? fmtMoney(r.cost_per_ga4_conv) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.roas != null ? fmtRatio(r.roas) : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--dso-rule)', fontWeight: 700 }}>
            <td style={{ padding: '10px', color: 'var(--dso-text-dim)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.cost)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ad_clicks)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ad_impressions)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ga4_sessions)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>—</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ga4_conversions)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.ga4_revenue)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalCpa != null ? fmtMoney(totalCpa) : '—'}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoas != null ? fmtRatio(totalRoas) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function PagePerformanceTable({ rows, windowEnd }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No GSC page snapshot yet. Run a GSC fetch first.
    </div>;
  }
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        Latest GSC snapshot (window ending {windowEnd}) joined to GA4 over the same 28 days.
        Engagement gap = high CTR + low engagement → SERP click bait.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Page</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GSC Clicks</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Impr.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>CTR</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Avg Pos</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Sessions</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Engagement</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Conv.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.path + i} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.full_url}>
                {r.path || '/'}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.gsc_clicks)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.gsc_impressions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.gsc_ctr != null ? fmtPct(r.gsc_ctr) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.gsc_position != null ? r.gsc_position.toFixed(1) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_sessions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.ga4_engagement_rate != null ? fmtPct(r.ga4_engagement_rate) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_conversions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.ga4_revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CrossSourcePage() {
  const [range, setRange] = useLocalStorageState('range', '6m');
  const [selectedYears, setSelectedYears] = useLocalStorageState('years', []);
  const [campaigns, setCampaigns] = useState(null);
  const [pages, setPages] = useState(null);
  const [pageWindowEnd, setPageWindowEnd] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Years available depend on Ads + GA4 data extents — fetch a probe call
  // first so we can populate the YearsDropdown with real options.
  const [availableYears, setAvailableYears] = useState([]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    const qs = params.toString();
    Promise.all([
      fetch(`/api/insights/campaign-roi${qs ? '?' + qs : ''}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/insights/page-performance?limit=100').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([c, p]) => {
        setCampaigns(c?.campaigns || []);
        setPages(p?.pages || []);
        setPageWindowEnd(p?.pages?.[0]?.window_end_date || null);
        if (!c && !p) setError('Cross-source endpoints returned no data. Are GA4 and Ads/GSC backfilled?');
        else setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [cutoff, selectedYears]);

  // Probe years from the campaign rows once we have any.
  useEffect(() => {
    if (!campaigns) return;
    // Campaign-level rows are aggregated and don't have date — just fall back
    // to the last few years as filter options. Better than nothing; can wire
    // up a dedicated /api/insights/years endpoint later if useful.
    const now = new Date().getFullYear();
    setAvailableYears([now - 4, now - 3, now - 2, now - 1, now].map(String));
  }, [campaigns]);

  return (
    <div style={{ padding: '20px 24px', color: 'var(--dso-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{
            color: 'var(--dso-text-dim)',
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}>Cross-Source Insights</div>
          <div style={{
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
          }}>Where the data lines up</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <RangeDropdown range={range} onChange={setRange} disabled={selectedYears.length > 0} />
          <YearsDropdown available={availableYears} selected={selectedYears} onChange={setSelectedYears} />
          {(selectedYears.length > 0 || range !== '6m') && (
            <button
              onClick={() => { setRange('6m'); setSelectedYears([]); clearAllFilters(); }}
              style={{
                background: 'transparent',
                border: '1px solid var(--dso-rule)',
                color: 'var(--dso-text-dim)',
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
                borderRadius: 3,
              }}
            >Clear</button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ color: '#f87171', fontSize: 13, marginBottom: 16 }}>Error: {error}</div>
      )}
      {loading && (
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, marginBottom: 16 }}>Loading…</div>
      )}

      <section style={{ marginBottom: 28 }}>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>Campaign ROI — Google Ads × GA4</h3>
        <CampaignRoiTable rows={campaigns} />
      </section>

      <section>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>Page Performance — GSC × GA4</h3>
        <PagePerformanceTable rows={pages} windowEnd={pageWindowEnd} />
      </section>
    </div>
  );
}
