import React, { useState, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, CartesianGrid,
  BarChart, Bar, Cell, ReferenceLine,
} from 'recharts';
import { movingAverage, leadLag, weekdaysOnly } from './utils/analytics';

const RELATIVE_RANGES = { '3m': 90, '6m': 180 };

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toFixed(0);
}
function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}
function fmtDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(parts[1],10)-1]} ${parseInt(parts[2],10)}, ${parts[0]}`;
}
function fmtAxisDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(parts[1],10)-1]} ${parts[0].slice(2)}`;
}

function StatCard({ label, value, sub, small }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 160px', minWidth: 140,
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 2 }}>{label}</div>
      <div style={{ color: '#f8fafc', fontSize: 24, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>{sub}</div>}
      {small && <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 2 }}>{small}</div>}
    </div>
  );
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

const LINE_COLORS = {
  daily: '#94a3b8',
  ma30: '#fbbf24',
  ma90: '#a78bfa',
};

function DMALineChart({ title, data, field30, field90, fieldRaw, formatter = fmtNum, currentValue, showDaily = true }) {
  const latest30 = data.length > 0 ? data[data.length - 1]?.[field30] : null;

  // One tick per month-start date in the visible data. If the view spans many
  // months, thin so labels don't collide (~18 ticks max for a typical tile).
  const monthTicks = useMemo(() => {
    const starts = [];
    let prevMonth = null;
    for (const row of data) {
      const m = row.date?.slice(0, 7); // "YYYY-MM"
      if (m && m !== prevMonth) {
        starts.push(row.date);
        prevMonth = m;
      }
    }
    const step = Math.max(1, Math.ceil(starts.length / 18));
    return starts.filter((_, i) => i % step === 0);
  }, [data]);

  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 480px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div>
          <div style={{ color: '#cbd5e1', fontSize: 11 }}>{title}</div>
          <div style={{ color: '#f8fafc', fontSize: 22, fontWeight: 700 }}>
            {formatter(currentValue ?? latest30)}
            <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>30 DMA</span>
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
          {fieldRaw && showDaily && (
            <Line
              type="monotone" dataKey={fieldRaw} name="Daily"
              stroke={LINE_COLORS.daily} strokeWidth={1} strokeOpacity={0.4}
              dot={false} activeDot={{ r: 3, fill: LINE_COLORS.daily }}
            />
          )}
          <Line
            type="monotone" dataKey={field30} name="30 DMA"
            stroke={LINE_COLORS.ma30} strokeWidth={2.5}
            dot={false} activeDot={{ r: 5, fill: LINE_COLORS.ma30, stroke: '#0f172a', strokeWidth: 2 }}
          />
          <Line
            type="monotone" dataKey={field90} name="90 DMA"
            stroke={LINE_COLORS.ma90} strokeWidth={2} strokeDasharray="4 3"
            dot={false} activeDot={{ r: 4, fill: LINE_COLORS.ma90, stroke: '#0f172a', strokeWidth: 2 }}
          />
          <Legend wrapperStyle={{ fontSize: 10, color: '#cbd5e1', paddingTop: 8 }} iconType="plainline" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function LeadLagTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{
      background: '#0f172a', border: '1px solid #64748b', borderRadius: 6,
      padding: '6px 10px', fontSize: 11, color: '#f8fafc', lineHeight: 1.5,
    }}>
      <div><strong>{p.lag}-day lag</strong></div>
      <div>r = {p.r.toFixed(2)}</div>
    </div>
  );
}

function LegendChip({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#94a3b8' }}>
      <span style={{ width: 8, height: 8, background: color, borderRadius: 2, display: 'inline-block' }} />
      {label}
    </span>
  );
}

function LeadLagCard({ title, subtitle, result }) {
  if (!result) return null;
  const { bestLag, bestR, correlations } = result;
  const absR = Math.abs(bestR);

  // Confidence scale matches the AI analysis prompt — keep these in sync.
  const strength = absR >= 0.7 ? 'Strong' : absR >= 0.4 ? 'Moderate' : 'Weak';
  const strengthColor = absR >= 0.7 ? '#22c55e' : absR >= 0.4 ? '#fbbf24' : '#94a3b8';
  const inverse = bestR < 0;
  const confidenceBlurb = absR >= 0.7
    ? 'Reliable forecast signal.'
    : absR >= 0.4
    ? 'Reasonable guide — treat projections as a range.'
    : 'Too noisy to forecast — try a longer range or fewer filters.';

  const data = correlations.map((r, lag) => ({ lag, r: +r.toFixed(3) }));

  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, flex: '1 1 320px', minWidth: 0 }}>
      <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 600 }}>{title}</div>
      {subtitle && <div style={{ color: '#64748b', fontSize: 10, marginTop: 2 }}>{subtitle}</div>}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <div style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700 }}>
          {bestLag}-day lag
        </div>
        <div style={{ color: '#94a3b8', fontSize: 13 }}>
          r = {bestR.toFixed(2)}
        </div>
        <div style={{ color: strengthColor, fontSize: 11, fontWeight: 600 }}>
          {strength}{inverse ? ' · inverse' : ''}
        </div>
      </div>

      <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2, marginBottom: 6 }}>
        {confidenceBlurb}
      </div>

      <ResponsiveContainer width="100%" height={110}>
        <BarChart data={data} margin={{ top: 4, right: 6, left: 0, bottom: 2 }}>
          <XAxis
            dataKey="lag" ticks={[0, 7, 14, 21, 30, 45]}
            tickFormatter={v => `${v}d`}
            tick={{ fill: '#cbd5e1', fontSize: 10 }}
            axisLine={{ stroke: '#475569' }} tickLine={false}
            interval={0}
          />
          <YAxis domain={[-1, 1]} hide />
          <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />
          <ReferenceLine y={0.4} stroke="#64748b" strokeDasharray="3 3" strokeWidth={1} />
          <ReferenceLine y={-0.4} stroke="#64748b" strokeDasharray="3 3" strokeWidth={1} />
          <Tooltip content={<LeadLagTooltip />} cursor={{ fill: '#0f172a', opacity: 0.3 }} />
          <Bar dataKey="r" isAnimationActive={false}>
            {data.map((d, i) => {
              const fill = i === bestLag
                ? '#f59e0b'
                : Math.abs(d.r) >= 0.4
                ? (d.r >= 0 ? '#22c55e' : '#ef4444')
                : '#334155';
              return <Cell key={i} fill={fill} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
        <LegendChip color="#f59e0b" label="best lag" />
        <LegendChip color="#22c55e" label="|r| ≥ 0.4 (meaningful)" />
        <LegendChip color="#ef4444" label="inverse" />
        <LegendChip color="#334155" label="noisy" />
        <span style={{ fontSize: 10, color: '#64748b' }}>dashed = ±0.4 threshold</span>
      </div>
    </div>
  );
}

/**
 * DashboardView — shared charts/controls/summary renderer.
 *
 * Props:
 *   daily            — array of daily rows from the API
 *   headerExtras     — optional ReactNode rendered in the control bar (e.g. filter chips)
 *   subtitle         — ReactNode rendered under the page title
 *   onRefresh        — optional async (mode: 'incremental' | 'full') => void
 *   refreshing       — whether a refresh is in flight
 *   sourceLabel      — string like "netsuite-db" for the small grey line under the title
 */
export default function DashboardView({
  daily = [],
  headerExtras = null,
  subtitle = null,
  onRefresh,
  refreshing = false,
  sourceLabel = '',
  aiContext = { page: 'overview' },   // { page, filters? } — metadata for the interpret call
}) {
  const [range, setRange] = useState('6m');
  const [selectedYears, setSelectedYears] = useState([]);
  const [weekdayOnly, setWeekdayOnly] = useState(true);
  const [showDaily, setShowDaily] = useState(false);
  const [aiText, setAiText] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  const availableYears = useMemo(() => {
    if (!daily?.length) return [];
    const years = new Set(daily.map(d => d.date.slice(0, 4)));
    return Array.from(years).sort();
  }, [daily]);

  const fullSeries = useMemo(() => {
    if (!daily?.length) return [];
    let rows = [...daily].sort((a, b) => a.date.localeCompare(b.date));
    if (weekdayOnly) rows = weekdaysOnly(rows);

    const quotes         = rows.map(d => d.quotes_count || 0);
    const quotesDollars  = rows.map(d => d.quotes_total || 0);
    const quotesAdjD     = rows.map(d => d.quotes_adj_total ?? d.quotes_total ?? 0);
    const orders         = rows.map(d => d.orders_count || 0);
    const ordersDollars  = rows.map(d => d.orders_total || 0);
    const shipped        = rows.map(d => d.shipped_count || 0);
    const shippedDollars = rows.map(d => d.shipped_total || 0);

    const qc30 = movingAverage(quotes, 30);
    const qc90 = movingAverage(quotes, 90);
    const qd30 = movingAverage(quotesDollars, 30);
    const qd90 = movingAverage(quotesDollars, 90);
    const qAdj30 = movingAverage(quotesAdjD, 30);
    const qAdj90 = movingAverage(quotesAdjD, 90);
    const oc30 = movingAverage(orders, 30);
    const oc90 = movingAverage(orders, 90);
    const od30 = movingAverage(ordersDollars, 30);
    const od90 = movingAverage(ordersDollars, 90);
    const sc30 = movingAverage(shipped, 30);
    const sc90 = movingAverage(shipped, 90);
    const sd30 = movingAverage(shippedDollars, 30);
    const sd90 = movingAverage(shippedDollars, 90);

    const closeRate = qc30.map((q, i) => (q == null || oc30[i] == null || q === 0 ? null : oc30[i] / q));
    const cr90 = qc90.map((q, i) => (q == null || oc90[i] == null || q === 0 ? null : oc90[i] / q));
    const captureRate = qAdj30.map((q, i) => (q == null || od30[i] == null || q === 0 ? null : od30[i] / q));
    const capt90 = qAdj90.map((q, i) => (q == null || od90[i] == null || q === 0 ? null : od90[i] / q));
    // Average order value — divide the 30/90 DMAs of $ and count for a smooth ratio
    const aovO30 = od30.map((d, i) => (d == null || oc30[i] == null || oc30[i] === 0 ? null : d / oc30[i]));
    const aovO90 = od90.map((d, i) => (d == null || oc90[i] == null || oc90[i] === 0 ? null : d / oc90[i]));
    const aovS30 = sd30.map((d, i) => (d == null || sc30[i] == null || sc30[i] === 0 ? null : d / sc30[i]));
    const aovS90 = sd90.map((d, i) => (d == null || sc90[i] == null || sc90[i] === 0 ? null : d / sc90[i]));

    return rows.map((d, i) => ({
      date: d.date,
      quotes_count: d.quotes_count || 0,
      orders_count: d.orders_count || 0,
      shipped_count: d.shipped_count || 0,
      quotes_total: d.quotes_total || 0,
      orders_total: d.orders_total || 0,
      shipped_total: d.shipped_total || 0,
      quotes: quotes[i], q30: qd30[i], q90: qd90[i], qc30: qc30[i], qc90: qc90[i],
      orders: orders[i], o30: od30[i], o90: od90[i], oc30: oc30[i], oc90: oc90[i],
      shipped: shipped[i], s30: sd30[i], s90: sd90[i], sc30: sc30[i], sc90: sc90[i],
      quotesDollars: quotesDollars[i], ordersDollars: ordersDollars[i], shippedDollars: shippedDollars[i],
      closeRate: closeRate[i], cr90: cr90[i],
      captureRate: captureRate[i], capt90: capt90[i],
      aovOrderDaily: orders[i] > 0 ? ordersDollars[i] / orders[i] : null,
      aovShipDaily:  shipped[i] > 0 ? shippedDollars[i] / shipped[i] : null,
      aovO30: aovO30[i], aovO90: aovO90[i],
      aovS30: aovS30[i], aovS90: aovS90[i],
    }));
  }, [daily, weekdayOnly]);

  const chartData = useMemo(() => {
    if (!fullSeries.length) return [];
    if (selectedYears.length > 0) {
      const ySet = new Set(selectedYears);
      return fullSeries.filter(d => ySet.has(d.date.slice(0, 4)));
    }
    if (range === 'all') return fullSeries;
    if (RELATIVE_RANGES[range]) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RELATIVE_RANGES[range]);
      const cutStr = cutoff.toISOString().slice(0, 10);
      return fullSeries.filter(d => d.date >= cutStr);
    }
    return fullSeries;
  }, [fullSeries, range, selectedYears]);

  const summary = useMemo(() => {
    if (chartData.length === 0) return null;
    const last = chartData[chartData.length - 1];
    const sumField = (f) => chartData.reduce((s, d) => s + (d[f] || 0), 0);
    return {
      q30: last.q30, o30: last.o30, s30: last.s30,
      qc30: last.qc30, oc30: last.oc30, sc30: last.sc30,
      closeRate: last.closeRate,
      captureRate: last.captureRate,
      aovO30: last.aovO30, aovS30: last.aovS30,
      totalQuotesDollars: sumField('quotes_total'),
      totalOrdersDollars: sumField('orders_total'),
      totalShippedDollars: sumField('shipped_total'),
      totalQ: sumField('quotes_count'),
      totalO: sumField('orders_count'),
    };
  }, [chartData]);

  const leadLagResults = useMemo(() => {
    if (chartData.length < 30) return {};
    // Correlate the 30-DMA-smoothed series rather than raw daily — far less
    // noise, more stable best-lag across views, and matches what the user
    // sees on the line charts. Pearson skips null pairs so leading-window
    // nulls (before the MA fills) don't pollute the result.
    const qc30 = chartData.map(d => d.qc30);
    const oc30 = chartData.map(d => d.oc30);
    const sc30 = chartData.map(d => d.sc30);
    const q30  = chartData.map(d => d.q30);
    const o30  = chartData.map(d => d.o30);
    const s30  = chartData.map(d => d.s30);
    return {
      // Count-based — "how many transactions" predicts "how many transactions"
      quotesToOrdersCount:  leadLag(qc30, oc30),
      ordersToShippedCount: leadLag(oc30, sc30),
      // Dollar-based — "how much $" predicts "how much $" (revenue forecasting)
      quotesToOrdersDollars:  leadLag(q30, o30),
      ordersToShippedDollars: leadLag(o30, s30),
    };
  }, [chartData]);

  // Build the compact JSON snapshot Claude reads. Uses current_30 (latest 30 DMA)
  // vs prior_30 (30 DMA from 30 rows earlier) so the model can state direction.
  const buildAISnapshot = useCallback(() => {
    if (chartData.length === 0) return null;
    const last = chartData[chartData.length - 1];
    const prior = chartData[Math.max(0, chartData.length - 31)];
    const sum = (f) => chartData.reduce((s, d) => s + (d[f] || 0), 0);
    const pick = (row) => ({
      quote_dollars: row.q30, orders_dollars: row.o30, shipped_dollars: row.s30,
      quote_count: row.qc30, orders_count: row.oc30, shipped_count: row.sc30,
      close_rate: row.closeRate, capture_rate: row.captureRate,
      aov_orders: row.aovO30, aov_shipped: row.aovS30,
    });
    return {
      page: aiContext.page,
      filters: aiContext.filters || null,
      range: selectedYears.length > 0 ? selectedYears.join(',') : range,
      days_visible: chartData.length,
      weekday_only: weekdayOnly,
      current_30: pick(last),
      prior_30: pick(prior),
      period_totals: {
        quote_dollars: sum('quotes_total'),
        orders_dollars: sum('orders_total'),
        shipped_dollars: sum('shipped_total'),
        quote_count: sum('quotes_count'),
        orders_count: sum('orders_count'),
        shipped_count: sum('shipped_count'),
      },
      lead_lag: (leadLagResults.quotesToOrdersCount || leadLagResults.ordersToShippedCount) ? {
        quotes_to_orders_count: leadLagResults.quotesToOrdersCount
          ? { best_lag_days: leadLagResults.quotesToOrdersCount.bestLag, r: +leadLagResults.quotesToOrdersCount.bestR.toFixed(3) }
          : null,
        quotes_to_orders_dollars: leadLagResults.quotesToOrdersDollars
          ? { best_lag_days: leadLagResults.quotesToOrdersDollars.bestLag, r: +leadLagResults.quotesToOrdersDollars.bestR.toFixed(3) }
          : null,
        orders_to_shipped_count: leadLagResults.ordersToShippedCount
          ? { best_lag_days: leadLagResults.ordersToShippedCount.bestLag, r: +leadLagResults.ordersToShippedCount.bestR.toFixed(3) }
          : null,
        orders_to_shipped_dollars: leadLagResults.ordersToShippedDollars
          ? { best_lag_days: leadLagResults.ordersToShippedDollars.bestLag, r: +leadLagResults.ordersToShippedDollars.bestR.toFixed(3) }
          : null,
      } : null,
      // GA4 web traffic: placeholder until the GA4 fetcher is wired in. The
      // system prompt tells the model to skip speculation when this is null.
      ga4: null,
    };
  }, [chartData, aiContext, range, selectedYears, weekdayOnly, leadLagResults]);

  const handleAIAnalysis = async () => {
    const snapshot = buildAISnapshot();
    if (!snapshot) return;
    setAiLoading(true);
    setAiError(null);
    setAiText(null);
    try {
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `API ${res.status}`);
      setAiText(json.text);
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <>
      <div style={{
        padding: '12px clamp(12px, 4vw, 32px)', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ color: '#64748b', fontSize: 11 }}>
          {subtitle || <>{sourceLabel} — {chartData.length} days</>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {[...Object.keys(RELATIVE_RANGES), 'all'].map(r => {
            const active = selectedYears.length === 0 && range === r;
            return (
              <button key={r} onClick={() => { setSelectedYears([]); setRange(r); }} style={{
                background: active ? '#f59e0b' : '#334155',
                color: active ? '#0f172a' : '#e2e8f0',
                border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>{r}</button>
            );
          })}
          <span style={{ width: 1, height: 18, background: '#475569', margin: '0 4px' }} />
          {availableYears.map(y => {
            const active = selectedYears.includes(y);
            return (
              <button
                key={y}
                onClick={() => setSelectedYears(prev => prev.includes(y) ? prev.filter(v => v !== y) : [...prev, y].sort())}
                style={{
                  background: active ? '#f59e0b' : '#334155',
                  color: active ? '#0f172a' : '#e2e8f0',
                  border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                }}
              >{y}</button>
            );
          })}
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
            <input type="checkbox" checked={weekdayOnly} onChange={e => setWeekdayOnly(e.target.checked)} />
            Weekdays
          </label>
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showDaily} onChange={e => setShowDaily(e.target.checked)} />
            Show Daily
          </label>
          <button onClick={handleAIAnalysis} disabled={aiLoading || chartData.length === 0} style={{
            background: aiLoading ? '#334155' : '#7c3aed', color: '#f8fafc', border: 'none', borderRadius: 4,
            padding: '5px 12px', cursor: aiLoading ? 'wait' : 'pointer', fontSize: 11, marginLeft: 6, fontWeight: 600,
          }}>
            {aiLoading ? 'Analyzing...' : '✨ AI Analysis'}
          </button>
          {onRefresh && (
            <>
              <button onClick={() => onRefresh('incremental')} disabled={refreshing} style={{
                background: '#164e63', color: '#67e8f9', border: 'none', borderRadius: 4,
                padding: '5px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>
                {refreshing ? 'Refreshing...' : '↻ Refresh'}
              </button>
              <button onClick={() => onRefresh('full')} disabled={refreshing} style={{
                background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 4,
                padding: '5px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}>
                Full Backfill
              </button>
            </>
          )}
        </div>
      </div>

      {headerExtras}

      <main style={{ padding: '16px clamp(12px, 4vw, 32px)', maxWidth: 1600, margin: '0 auto' }}>
        {summary && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Total Quote DMA" value={fmtMoney(summary.q30)} sub="30 DMA avg daily" small={`Period total: ${fmtMoney(summary.totalQuotesDollars)}`} />
            <StatCard label="Total Orders DMA" value={fmtMoney(summary.o30)} sub="30 DMA avg daily" small={`Period total: ${fmtMoney(summary.totalOrdersDollars)}`} />
            <StatCard label="Total Shipped DMA" value={fmtMoney(summary.s30)} sub="30 DMA avg daily" small={`Period total: ${fmtMoney(summary.totalShippedDollars)}`} />
            <StatCard label="Close Rate DMA" value={fmtPct(summary.closeRate)} sub="30 DMA orders/quotes (count)" />
            <StatCard label="Capture Rate DMA" value={fmtPct(summary.captureRate)} sub="30 DMA orders$/quotes$" />
            <StatCard label="Avg Order Value" value={fmtMoney(summary.aovO30)} sub="30 DMA orders$/count" />
            <StatCard label="Avg Shipped Value" value={fmtMoney(summary.aovS30)} sub="30 DMA shipped$/count" />
          </div>
        )}

        {(aiText || aiError || aiLoading) && (
          <div style={{
            background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)',
            border: '1px solid #4c1d95', borderRadius: 8, padding: '16px 20px',
            marginBottom: 20, position: 'relative',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: aiText || aiError ? 10 : 0 }}>
              <div style={{ color: '#c4b5fd', fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
                ✨ AI ANALYSIS {aiLoading && '(thinking…)'}
              </div>
              {(aiText || aiError) && (
                <button onClick={() => { setAiText(null); setAiError(null); }} style={{
                  background: 'transparent', color: '#a78bfa', border: '1px solid #4c1d95',
                  borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer',
                }}>dismiss</button>
              )}
            </div>
            {aiLoading && !aiText && (
              <div style={{ color: '#c4b5fd', fontSize: 13, fontStyle: 'italic' }}>
                Reading the current view and drafting an interpretation…
              </div>
            )}
            {aiError && (
              <div style={{ color: '#fca5a5', fontSize: 12 }}>
                {aiError.includes('ANTHROPIC_API_KEY')
                  ? 'AI is not configured. Add ANTHROPIC_API_KEY to the server environment (Railway → Variables) to enable this feature.'
                  : `Error: ${aiError}`}
              </div>
            )}
            {aiText && (
              <div style={{ color: '#ede9fe', fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {aiText}
              </div>
            )}
          </div>
        )}

        {(leadLagResults.quotesToOrdersCount || leadLagResults.ordersToShippedCount) && (
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontWeight: 600 }}>
              Lead-Lag Correlation
            </h2>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              How many days of delay give the tightest predictive link between the two series.
              Computed on the 30 DMA — same lines you see on the dollar/count charts above.
              Count r forecasts transaction volume; $ r forecasts revenue.
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <LeadLagCard
                title="Quotes → Sales Orders (count)"
                subtitle="How many days quote count typically leads order count"
                result={leadLagResults.quotesToOrdersCount}
              />
              <LeadLagCard
                title="Quotes → Sales Orders ($)"
                subtitle="How many days quote $ typically leads order $"
                result={leadLagResults.quotesToOrdersDollars}
              />
              <LeadLagCard
                title="Orders → Shipped (count)"
                subtitle="How many days order count typically leads shipped count"
                result={leadLagResults.ordersToShippedCount}
              />
              <LeadLagCard
                title="Orders → Shipped ($)"
                subtitle="How many days order $ typically leads shipped $"
                result={leadLagResults.ordersToShippedDollars}
              />
            </div>
          </div>
        )}

        {chartData.length > 0 && (
          <>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Dollar Value &amp; AOV
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Total Quote DMA (by quote creation date)" data={chartData}
                fieldRaw="quotesDollars" field30="q30" field90="q90" formatter={fmtMoney} showDaily={showDaily} />
              <DMALineChart title="Total Sales Order DMA (by date converted)" data={chartData}
                fieldRaw="ordersDollars" field30="o30" field90="o90" formatter={fmtMoney} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Total Shipped DMA (by actual ship date)" data={chartData}
                fieldRaw="shippedDollars" field30="s30" field90="s90" formatter={fmtMoney} showDaily={showDaily} />
              <DMALineChart title="Capture Rate DMA (sales order$ / quote$)" data={chartData}
                field30="captureRate" field90="capt90" formatter={fmtPct} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="Avg Order Value DMA (orders$ / orders count)" data={chartData}
                fieldRaw="aovOrderDaily" field30="aovO30" field90="aovO90" formatter={fmtMoney} showDaily={showDaily} />
              <DMALineChart title="Avg Shipped Value DMA (shipped$ / shipped count)" data={chartData}
                fieldRaw="aovShipDaily" field30="aovS30" field90="aovS90" formatter={fmtMoney} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Transaction Counts
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Quote Count DMA" data={chartData}
                fieldRaw="quotes" field30="qc30" field90="qc90" formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Sales Order Count DMA" data={chartData}
                fieldRaw="orders" field30="oc30" field90="oc90" formatter={fmtNum} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Shipped Order Count DMA (by actual ship date)" data={chartData}
                fieldRaw="shipped" field30="sc30" field90="sc90" formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Close Rate DMA (count)" data={chartData}
                field30="closeRate" field90="cr90" formatter={fmtPct} showDaily={showDaily} />
            </div>
          </>
        )}
      </main>
    </>
  );
}
