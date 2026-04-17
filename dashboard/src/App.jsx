import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, CartesianGrid, ReferenceDot,
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
      background: '#334155', borderRadius: 8, padding: '16px 20px',
      flex: '1 1 180px', minWidth: 160,
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 2 }}>{label}</div>
      <div style={{ color: '#f8fafc', fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
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
  daily: '#94a3b8',  // slate-400, faint background
  ma30: '#fbbf24',   // amber-400, primary
  ma90: '#a78bfa',   // violet-400, dashed
};

function DMALineChart({ title, data, field30, field90, fieldRaw, formatter = fmtNum, currentValue, showDaily = true }) {
  const latest30 = data.length > 0 ? data[data.length - 1]?.[field30] : null;

  // Thin out X axis ticks
  const tickInterval = Math.max(1, Math.floor(data.length / 8));

  return (
    <div style={{ background: '#334155', borderRadius: 8, padding: '16px 20px', flex: '1 1 580px', minWidth: 400 }}>
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
            dataKey="date"
            tickFormatter={fmtAxisDate}
            interval={tickInterval}
            tick={{ fill: '#cbd5e1', fontSize: 10 }}
            axisLine={{ stroke: '#94a3b8' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={formatter}
            tick={{ fill: '#cbd5e1', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={55}
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
          <Legend
            wrapperStyle={{ fontSize: 10, color: '#cbd5e1', paddingTop: 8 }}
            iconType="plainline"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function MiniBar({ correlations, bestLag }) {
  const maxAbs = Math.max(...correlations.map(Math.abs), 0.01);
  return (
    <div style={{ display: 'flex', gap: 1, height: 40, alignItems: 'flex-end' }}>
      {correlations.map((r, i) => {
        const h = (Math.abs(r) / maxAbs) * 100;
        const clr = i === bestLag ? '#f59e0b' : Math.abs(r) > 0.4 ? '#22c55e' : '#334155';
        return <div key={i} style={{ width: 4, height: `${h}%`, background: clr, borderRadius: 1 }} />;
      })}
    </div>
  );
}

function LeadLagCard({ title, result }) {
  if (!result) return null;
  const { bestLag, bestR, correlations } = result;
  const dir = bestLag > 0 ? `leads by ${bestLag}d` : 'no lead';
  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, flex: '1 1 280px' }}>
      <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 8 }}>{title}</div>
      <div style={{ color: '#f8fafc', fontSize: 14, marginBottom: 4 }}>
        {dir} <span style={{ color: bestR > 0.5 ? '#22c55e' : '#f59e0b' }}>(r={bestR.toFixed(2)})</span>
      </div>
      <MiniBar correlations={correlations} bestLag={bestLag} />
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('6m');
  const [selectedYears, setSelectedYears] = useState([]);
  const [weekdayOnly, setWeekdayOnly] = useState(true);
  const [showDaily, setShowDaily] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    fetch('/api/unified')
      .then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const availableYears = useMemo(() => {
    if (!data?.daily?.length) return [];
    const years = new Set(data.daily.map(d => d.date.slice(0, 4)));
    return Array.from(years).sort();
  }, [data]);

  // Full-history series with MAs computed across the entire dataset so any
  // range view shows already-primed moving averages from its first day.
  const fullSeries = useMemo(() => {
    if (!data?.daily) return [];
    let rows = [...data.daily].sort((a, b) => a.date.localeCompare(b.date));
    if (weekdayOnly) rows = weekdaysOnly(rows);

    const quotes = rows.map(d => d.quotes_count || 0);
    const quotesDollars = rows.map(d => d.quotes_total || 0);
    const orders = rows.map(d => d.orders_count || 0);
    const ordersDollars = rows.map(d => d.orders_total || 0);
    const shipped = rows.map(d => d.shipped_count || 0);
    const shippedDollars = rows.map(d => d.shipped_total || 0);

    const qc30 = movingAverage(quotes, 30);
    const qc90 = movingAverage(quotes, 90);
    const qd30 = movingAverage(quotesDollars, 30);
    const qd90 = movingAverage(quotesDollars, 90);
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
    const captureRate = qd30.map((q, i) => (q == null || od30[i] == null || q === 0 ? null : od30[i] / q));
    const capt90 = qd90.map((q, i) => (q == null || od90[i] == null || q === 0 ? null : od90[i] / q));

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
    }));
  }, [data, weekdayOnly]);

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
    const totalQ = sumField('quotes_count');
    const totalO = sumField('orders_count');
    return {
      q30: last.q30, o30: last.o30, s30: last.s30,
      qc30: last.qc30, oc30: last.oc30, sc30: last.sc30,
      closeRate: last.closeRate,
      captureRate: last.captureRate,
      totalQuotesDollars: sumField('quotes_total'),
      totalOrdersDollars: sumField('orders_total'),
      totalShippedDollars: sumField('shipped_total'),
      totalQ, totalO,
    };
  }, [chartData]);

  const leadLagResults = useMemo(() => {
    if (chartData.length < 30) return {};
    const quotes = chartData.map(d => d.quotes_count || 0);
    const orders = chartData.map(d => d.orders_count || 0);
    const shipped = chartData.map(d => d.shipped_count || 0);
    return {
      quotesToOrders: leadLag(quotes, orders),
      ordersToShipped: leadLag(orders, shipped),
    };
  }, [chartData]);

  const handleRefresh = async (mode) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/refresh/netsuite?mode=${mode}`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setTimeout(() => { loadData(); setRefreshing(false); }, 500);
      } else {
        alert(`Refresh failed: ${json.error}`);
        setRefreshing(false);
      }
    } catch (e) {
      alert(`Refresh failed: ${e.message}`);
      setRefreshing(false);
    }
  };

  if (loading) return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui' }}>
      Loading data...
    </div>
  );

  if (error) return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', padding: 40, fontFamily: 'system-ui' }}>
      <h1 style={{ color: '#f59e0b' }}>RF Traffic Intelligence</h1>
      <p style={{ color: '#ef4444' }}>Error: {error}</p>
    </div>
  );

  return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <header style={{ padding: '16px 32px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            <span style={{ color: '#f59e0b' }}>RF</span> Traffic Intelligence
          </h1>
          <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>
            {data?.sources?.join(', ')} — {chartData.length} days
          </div>
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
          <button onClick={() => handleRefresh('incremental')} disabled={refreshing} style={{
            background: '#164e63', color: '#67e8f9', border: 'none', borderRadius: 4,
            padding: '5px 12px', cursor: 'pointer', fontSize: 11, marginLeft: 6, fontWeight: 600,
          }}>
            {refreshing ? 'Refreshing...' : '↻ Refresh'}
          </button>
          <button onClick={() => handleRefresh('full')} disabled={refreshing} style={{
            background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 4,
            padding: '5px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
          }}>
            Full Backfill
          </button>
        </div>
      </header>

      <main style={{ padding: '20px 32px', maxWidth: 1600, margin: '0 auto' }}>
        {/* Summary cards */}
        {summary && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Total Quote DMA" value={fmtMoney(summary.q30)} sub={`30 DMA avg daily`} small={`Period total: ${fmtMoney(summary.totalQuotesDollars)}`} />
            <StatCard label="Total Orders DMA" value={fmtMoney(summary.o30)} sub={`30 DMA avg daily`} small={`Period total: ${fmtMoney(summary.totalOrdersDollars)}`} />
            <StatCard label="Total Shipped DMA" value={fmtMoney(summary.s30)} sub={`30 DMA avg daily`} small={`Period total: ${fmtMoney(summary.totalShippedDollars)}`} />
            <StatCard label="Close Rate DMA" value={fmtPct(summary.closeRate)} sub="30 DMA orders/quotes (count)" />
            <StatCard label="Capture Rate DMA" value={fmtPct(summary.captureRate)} sub="30 DMA orders$/quotes$" />
          </div>
        )}

        {/* Dollar DMA Charts */}
        {chartData.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart
                title="Total Quote DMA (by quote creation date)" data={chartData}
                fieldRaw="quotesDollars" field30="q30" field90="q90"
                formatter={fmtMoney} showDaily={showDaily}
              />
              <DMALineChart
                title="Total Sales Order DMA (by date converted)" data={chartData}
                fieldRaw="ordersDollars" field30="o30" field90="o90"
                formatter={fmtMoney} showDaily={showDaily}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart
                title="Quote Count DMA" data={chartData}
                fieldRaw="quotes" field30="qc30" field90="qc90"
                formatter={fmtNum} showDaily={showDaily}
              />
              <DMALineChart
                title="Sales Order Count DMA" data={chartData}
                fieldRaw="orders" field30="oc30" field90="oc90"
                formatter={fmtNum} showDaily={showDaily}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart
                title="Total Shipped DMA (by actual ship date)" data={chartData}
                fieldRaw="shippedDollars" field30="s30" field90="s90"
                formatter={fmtMoney} showDaily={showDaily}
              />
              <DMALineChart
                title="Shipped Order Count DMA (by actual ship date)" data={chartData}
                fieldRaw="shipped" field30="sc30" field90="sc90"
                formatter={fmtNum} showDaily={showDaily}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart
                title="Close Rate DMA (count)" data={chartData}
                field30="closeRate" field90="cr90"
                formatter={fmtPct} showDaily={showDaily}
              />
              <DMALineChart
                title="Capture Rate DMA (sales order$ / quote$)" data={chartData}
                field30="captureRate" field90="capt90"
                formatter={fmtPct} showDaily={showDaily}
              />
            </div>
          </>
        )}

        {/* Lead-Lag */}
        {(leadLagResults.quotesToOrders || leadLagResults.ordersToShipped) && (
          <div style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>Lead-Lag Correlation</h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <LeadLagCard title="Quotes → Sales Orders" result={leadLagResults.quotesToOrders} />
              <LeadLagCard title="Orders → Shipped" result={leadLagResults.ordersToShipped} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
