import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, Legend,
  CartesianGrid,
} from 'recharts';
import {
  DMALineChart, StatCard, fmtNum, fmtMoney, fmtPct, fmtDate, fmtAxisDate,
} from './DashboardView';
import {
  RELATIVE_RANGES, RangeDropdown, YearsDropdown,
  useLocalStorageState, clearAllFilters,
} from './FilterControls';
import { movingAverage, weekdaysOnly } from './utils/analytics';

// Seconds → "1m 23s" or "45s". Used for avg session duration KPI.
function fmtDuration(secs) {
  if (secs == null || Number.isNaN(secs)) return '—';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r.toString().padStart(2, '0')}s`;
}

// Palette for the stacked channel-mix chart. Picked to be distinguishable on
// the dark background and degrade gracefully when "Other" catches the long tail.
const CHANNEL_COLORS = [
  '#f59e0b', '#22d3ee', '#a78bfa', '#4ade80',
  '#f472b6', '#60a5fa', '#fbbf24', '#e879f9',
  '#94a3b8',
];

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

function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#0f172a', border: '1px solid #64748b', borderRadius: 6,
      padding: '10px 14px', fontSize: 12, lineHeight: 1.6,
    }}>
      <div style={{ color: '#f8fafc', fontWeight: 600, marginBottom: 4 }}>{fmtDate(label)}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: {formatter ? formatter(p.value) : fmtNum(p.value)}
        </div>
      ))}
    </div>
  );
}

function StackedChannelChart({ data, channels, formatter = fmtNum }) {
  const monthTicks = useMemo(() => {
    const starts = [];
    let prev = null;
    for (const row of data) {
      const m = row.date?.slice(0, 7);
      if (m && m !== prev) { starts.push(row.date); prev = m; }
    }
    const step = Math.max(1, Math.ceil(starts.length / 18));
    return starts.filter((_, i) => i % step === 0);
  }, [data]);

  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0,
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 4 }}>
        Sessions by channel (stacked daily)
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} syncId="rf-dashboard-charts" syncMethod="value"
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#64748b" strokeOpacity={0.4} />
          <XAxis
            dataKey="date" tickFormatter={fmtAxisDate}
            ticks={monthTicks} interval={0}
            tick={{ fill: '#cbd5e1', fontSize: 10 }}
            axisLine={{ stroke: '#94a3b8' }} tickLine={false}
          />
          <YAxis
            tickFormatter={formatter}
            tick={{ fill: '#cbd5e1', fontSize: 10 }}
            axisLine={false} tickLine={false} width={55}
          />
          <Tooltip content={<ChartTooltip formatter={formatter} />} />
          {channels.map((ch, i) => (
            <Area
              key={ch} type="monotone" dataKey={ch} name={ch}
              stackId="1"
              stroke={CHANNEL_COLORS[i % CHANNEL_COLORS.length]}
              fill={CHANNEL_COLORS[i % CHANNEL_COLORS.length]}
              fillOpacity={0.7} strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
          <Legend wrapperStyle={{ fontSize: 10, color: '#cbd5e1', paddingTop: 8 }} iconType="square" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChannelTable({ rows }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 480px', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 8 }}>
        Per-channel quality (visible range)
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Channel</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Sessions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>New users</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conversions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conv. rate</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Engaged %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.channel} style={{ borderTop: i === 0 ? 'none' : '1px solid #475569' }}>
              <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.channel}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.sessions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.new_users)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.conversions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.conversion_rate)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.engagement_rate)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} style={{ padding: '10px 8px', color: '#64748b' }}>No channel data in the current range.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CampaignTable({ rows }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 8 }}>
        Campaigns in the visible range — sorted by sessions
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Campaign</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Sessions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Users</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>New users</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conversions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conv. rate</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Engaged %</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Revenue</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Active days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.campaign_name} style={{ borderTop: i === 0 ? 'none' : '1px solid #475569' }}>
              <td style={{ padding: '6px 8px', fontWeight: 600, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.campaign_name}>
                {r.campaign_name}
              </td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.sessions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.total_users)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.new_users)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.conversions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.conversion_rate)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.engagement_rate)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(r.total_revenue)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{r.active_days}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={9} style={{ padding: '10px 8px', color: '#64748b' }}>
              No campaigns with sessions in the current range. "(not set)" and "(direct)" are excluded.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function GA4InsightsPage() {
  // Share filter state with the other tabs via the same localStorage keys, so
  // switching tabs preserves the user's time selection.
  const [range, setRange] = useLocalStorageState('range', '6m');
  const [selectedYears, setSelectedYears] = useLocalStorageState('years', []);
  const [weekdayOnly, setWeekdayOnly] = useLocalStorageState('weekdayOnly', false);
  const [showDaily, setShowDaily] = useLocalStorageState('showDaily', false);

  const [aggregate, setAggregate] = useState(null);
  const [channelsDaily, setChannelsDaily] = useState(null);
  const [campaignStats, setCampaignStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Aggregate + per-channel daily are range-independent; fetch once.
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/ga4').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ga4-channels-daily').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([agg, chans]) => {
        setAggregate(agg);
        setChannelsDaily(chans);
        if (!agg || (agg.daily || []).length === 0) {
          setError('No GA4 data yet. Run a GA4 fetch first.');
        } else {
          setError(null);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const availableYears = useMemo(() => {
    const rows = aggregate?.daily || [];
    if (!rows.length) return [];
    return Array.from(new Set(rows.map(d => d.date.slice(0, 4)))).sort();
  }, [aggregate]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  // Campaign stats refetch on range change — the server aggregates over
  // [since, until] so we can't filter client-side without per-day data.
  useEffect(() => {
    const rows = aggregate?.daily || [];
    if (!rows.length) return;
    const last = rows[rows.length - 1].date;
    const params = new URLSearchParams({ until: last });
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    fetch(`/api/ga4-campaign-stats?${params.toString()}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => setCampaignStats(j))
      .catch(() => setCampaignStats(null));
  }, [aggregate, cutoff, selectedYears]);

  // Build the main daily series with DMAs + a derived pages/session.
  const fullSeries = useMemo(() => {
    const rows = aggregate?.daily || [];
    if (!rows.length) return [];
    let ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    if (weekdayOnly) ordered = weekdaysOnly(ordered);

    const sessions  = ordered.map(d => Number(d.sessions) || 0);
    const users     = ordered.map(d => Number(d.total_users) || 0);
    const newUsers  = ordered.map(d => Number(d.new_users) || 0);
    const engaged   = ordered.map(d => Number(d.engaged_sessions) || 0);
    const pageviews = ordered.map(d => Number(d.screen_page_views) || 0);
    const conv      = ordered.map(d => Number(d.conversions) || 0);
    const bounce    = ordered.map(d => Number(d.bounce_rate) || 0);
    const duration  = ordered.map(d => Number(d.avg_session_duration) || 0);
    const pagesPerSession = ordered.map((_, i) => sessions[i] > 0 ? pageviews[i] / sessions[i] : 0);
    const convRate  = ordered.map((_, i) => sessions[i] > 0 ? conv[i] / sessions[i] : 0);
    const engRate   = ordered.map((_, i) => sessions[i] > 0 ? engaged[i] / sessions[i] : 0);

    const mmm = (xs) => [movingAverage(xs, 30), movingAverage(xs, 90)];
    const [sess30, sess90] = mmm(sessions);
    const [u30,    u90]    = mmm(users);
    const [nu30,   nu90]   = mmm(newUsers);
    const [eng30,  eng90]  = mmm(engaged);
    const [pv30,   pv90]   = mmm(pageviews);
    const [conv30, conv90] = mmm(conv);
    const [b30,    b90]    = mmm(bounce);
    const [d30,    d90]    = mmm(duration);
    const [pps30,  pps90]  = mmm(pagesPerSession);
    const [cr30,   cr90]   = mmm(convRate);
    const [er30,   er90]   = mmm(engRate);

    return ordered.map((d, i) => ({
      date: d.date,
      sessions: sessions[i], sess30: sess30[i], sess90: sess90[i],
      totalUsers: users[i], u30: u30[i], u90: u90[i],
      newUsers: newUsers[i], nu30: nu30[i], nu90: nu90[i],
      engagedSessions: engaged[i], eng30: eng30[i], eng90: eng90[i],
      pageviews: pageviews[i], pv30: pv30[i], pv90: pv90[i],
      conversions: conv[i], conv30: conv30[i], conv90: conv90[i],
      bounceRate: bounce[i], b30: b30[i], b90: b90[i],
      avgSessionDuration: duration[i], d30: d30[i], d90: d90[i],
      pagesPerSession: pagesPerSession[i], pps30: pps30[i], pps90: pps90[i],
      conversionRate: convRate[i], cr30: cr30[i], cr90: cr90[i],
      engagementRate: engRate[i], er30: er30[i], er90: er90[i],
    }));
  }, [aggregate, weekdayOnly]);

  const chartData = useMemo(() => {
    if (!fullSeries.length) return [];
    return fullSeries.filter(d => inRange(d, cutoff, selectedYears));
  }, [fullSeries, cutoff, selectedYears]);

  // Weighted aggregates over the visible window (KPI tiles). Bounce rate and
  // avg session duration are re-weighted by sessions so a sparse high-bounce
  // day can't distort the headline number.
  const kpi = useMemo(() => {
    if (chartData.length === 0) return null;
    const sum = (f) => chartData.reduce((s, r) => s + (r[f] || 0), 0);
    const weighted = (f) => {
      let num = 0, denom = 0;
      for (const r of chartData) {
        const w = r.sessions || 0;
        if (w > 0 && r[f] != null) { num += r[f] * w; denom += w; }
      }
      return denom > 0 ? num / denom : null;
    };
    const totalSessions = sum('sessions');
    const totalConv = sum('conversions');
    const totalEngaged = sum('engagedSessions');
    const totalPageviews = sum('pageviews');
    return {
      sessions: totalSessions,
      users: sum('totalUsers'),
      newUsers: sum('newUsers'),
      conversions: totalConv,
      conversionRate: totalSessions > 0 ? totalConv / totalSessions : null,
      engagementRate: totalSessions > 0 ? totalEngaged / totalSessions : null,
      bounceRate: weighted('bounceRate'),
      avgSessionDuration: weighted('avgSessionDuration'),
      pagesPerSession: totalSessions > 0 ? totalPageviews / totalSessions : null,
    };
  }, [chartData]);

  // Pivot per-(date, channel) rows into one row per date with columns per
  // channel, keeping only the top-N channels by sessions in the visible range
  // and folding the rest into "Other" so the stacked chart stays readable.
  const channelPivot = useMemo(() => {
    const rows = channelsDaily?.daily || [];
    if (rows.length === 0) return { data: [], channels: [], totals: [] };
    const visible = rows.filter(r => inRange(r, cutoff, selectedYears));
    if (visible.length === 0) return { data: [], channels: [], totals: [] };

    // Rank channels by sessions in the window.
    const totalByChannel = new Map();
    for (const r of visible) {
      totalByChannel.set(r.channel, (totalByChannel.get(r.channel) || 0) + (r.sessions || 0));
    }
    const ranked = [...totalByChannel.entries()].sort((a, b) => b[1] - a[1]);
    const topN = 6;
    const top = ranked.slice(0, topN).map(([c]) => c);
    const topSet = new Set(top);
    const channels = [...top, ranked.length > topN ? 'Other' : null].filter(Boolean);

    // Per-channel totals including the engagement/conversion ratios for the
    // side table. Re-derived from the daily rows rather than reusing
    // channelOptions so it honors the visible-range filter.
    const totals = channels.map(ch => {
      const keep = ch === 'Other'
        ? visible.filter(r => !topSet.has(r.channel))
        : visible.filter(r => r.channel === ch);
      const sessions = keep.reduce((s, r) => s + (r.sessions || 0), 0);
      const newUsers = keep.reduce((s, r) => s + (r.new_users || 0), 0);
      const engaged = keep.reduce((s, r) => s + (r.engaged_sessions || 0), 0);
      const conv = keep.reduce((s, r) => s + (r.conversions || 0), 0);
      return {
        channel: ch,
        sessions, new_users: newUsers, conversions: conv,
        conversion_rate: sessions > 0 ? conv / sessions : null,
        engagement_rate: sessions > 0 ? engaged / sessions : null,
      };
    }).filter(r => r.sessions > 0);

    // Pivot for the stacked chart. Use the filtered aggregate series as the
    // date spine so the chart x-axis matches everything else on the page.
    const byDate = new Map();
    for (const r of visible) {
      const bucket = topSet.has(r.channel) ? r.channel : 'Other';
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)[bucket] = (byDate.get(r.date)[bucket] || 0) + (r.sessions || 0);
    }
    const data = chartData.map(cd => {
      const row = { date: cd.date };
      for (const ch of channels) row[ch] = 0;
      const src = byDate.get(cd.date);
      if (src) for (const ch of channels) if (src[ch] != null) row[ch] = src[ch];
      return row;
    });
    return { data, channels, totals };
  }, [channelsDaily, cutoff, selectedYears, chartData]);

  const handleClear = useCallback(() => {
    setRange('6m');
    setSelectedYears([]);
    setWeekdayOnly(false);
    setShowDaily(false);
    clearAllFilters();
  }, [setRange, setSelectedYears, setWeekdayOnly, setShowDaily]);

  const subtitle = `GA4 property · ${chartData.length} days visible`;

  if (loading && !aggregate) {
    return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading GA4 data...</div>;
  }
  if (error && (!aggregate || (aggregate.daily || []).length === 0)) {
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 40px)' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>
          Tip: GA4 credentials may not be configured, or the backfill hasn't run yet.
          Trigger a refresh from the Overview tab once GA4 is connected.
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
          <RangeDropdown
            range={range}
            disabled={selectedYears.length > 0}
            onChange={r => { setSelectedYears([]); setRange(r); }}
          />
          <YearsDropdown
            selected={selectedYears}
            available={availableYears}
            onChange={setSelectedYears}
          />
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
            <input type="checkbox" checked={weekdayOnly} onChange={e => setWeekdayOnly(e.target.checked)} />
            Weekdays
          </label>
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showDaily} onChange={e => setShowDaily(e.target.checked)} />
            Show Daily
          </label>
          {(range !== '6m' || selectedYears.length > 0 || weekdayOnly || showDaily) && (
            <button
              onClick={handleClear}
              title="Reset range, year toggles, weekday filter"
              style={{
                background: '#7f1d1d', color: '#fecaca', border: 'none', borderRadius: 4,
                padding: '5px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <main style={{ padding: '16px clamp(12px, 4vw, 32px)', maxWidth: 1600, margin: '0 auto' }}>
        {kpi && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Sessions" value={fmtNum(kpi.sessions)} sub="in range" />
            <StatCard label="Users" value={fmtNum(kpi.users)} sub="in range" />
            <StatCard label="New users" value={fmtNum(kpi.newUsers)} sub={
              kpi.users > 0 ? `${Math.round(kpi.newUsers / kpi.users * 100)}% of users` : null
            } />
            <StatCard label="Conversions" value={fmtNum(kpi.conversions)} sub="in range" />
            <StatCard label="Conversion rate" value={fmtPct(kpi.conversionRate)} sub="conversions / sessions" />
            <StatCard label="Engagement rate" value={fmtPct(kpi.engagementRate)} sub="engaged / sessions" />
            <StatCard label="Bounce rate" value={fmtPct(kpi.bounceRate)} sub="weighted by sessions" />
            <StatCard label="Avg session" value={fmtDuration(kpi.avgSessionDuration)} sub="weighted by sessions" />
            <StatCard label="Pages / session" value={kpi.pagesPerSession != null ? kpi.pagesPerSession.toFixed(2) : '—'} sub="pageviews / sessions" />
          </div>
        )}

        {chartData.length > 0 && (
          <>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Traffic trend
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Sessions DMA" data={chartData}
                fieldRaw="sessions" field30="sess30" field90="sess90"
                formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="New users DMA" data={chartData}
                fieldRaw="newUsers" field30="nu30" field90="nu90"
                formatter={fmtNum} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="Conversions DMA" data={chartData}
                fieldRaw="conversions" field30="conv30" field90="conv90"
                formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Conversion rate DMA (conversions / sessions)" data={chartData}
                fieldRaw="conversionRate" field30="cr30" field90="cr90"
                formatter={fmtPct} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Engagement quality
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Bounce rate DMA" data={chartData}
                fieldRaw="bounceRate" field30="b30" field90="b90"
                formatter={fmtPct} showDaily={showDaily} />
              <DMALineChart title="Engagement rate DMA (engaged / sessions)" data={chartData}
                fieldRaw="engagementRate" field30="er30" field90="er90"
                formatter={fmtPct} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="Avg session duration DMA (seconds)" data={chartData}
                fieldRaw="avgSessionDuration" field30="d30" field90="d90"
                formatter={(v) => v == null ? '—' : fmtDuration(v)} showDaily={showDaily} />
              <DMALineChart title="Pages per session DMA" data={chartData}
                fieldRaw="pagesPerSession" field30="pps30" field90="pps90"
                formatter={(v) => v == null ? '—' : v.toFixed(2)} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Channel mix
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <StackedChannelChart
                data={channelPivot.data}
                channels={channelPivot.channels}
                formatter={fmtNum}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <ChannelTable rows={channelPivot.totals} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Campaign performance
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <CampaignTable rows={campaignStats?.campaigns || []} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
