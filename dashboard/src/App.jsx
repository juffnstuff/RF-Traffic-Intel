import React, { useState, useEffect, useMemo } from 'react';
import { movingAverage, leadLag, weekdaysOnly } from './utils/analytics';

const RANGES = { '1m': 30, '3m': 90, '6m': 180, '1y': 365, '2y': 730, all: Infinity };

function formatNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function formatPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{
      background: '#1e293b', borderRadius: 8, padding: '16px 20px',
      flex: '1 1 180px', minWidth: 180,
    }}>
      <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#f8fafc', fontSize: 24, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function MiniBar({ correlations, bestLag }) {
  const maxAbs = Math.max(...correlations.map(Math.abs), 0.01);
  return (
    <div style={{ display: 'flex', gap: 1, height: 40, alignItems: 'flex-end' }}>
      {correlations.map((r, i) => {
        const h = (Math.abs(r) / maxAbs) * 100;
        const color = i === bestLag ? '#f59e0b' : Math.abs(r) > 0.4 ? '#22c55e' : '#334155';
        return <div key={i} style={{ width: 4, height: `${h}%`, background: color, borderRadius: 1 }} />;
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

function TimeSeriesChart({ data, color, dma30, dma90, height = 120 }) {
  const allVals = [
    ...data.filter(v => v != null && !Number.isNaN(v)),
    ...(dma30 || []).filter(v => v != null && !Number.isNaN(v)),
    ...(dma90 || []).filter(v => v != null && !Number.isNaN(v)),
  ];
  const max = Math.max(...allVals, 0.001);

  return (
    <div style={{ position: 'relative', height, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
      {data.map((v, i) => {
        const barH = v != null && !Number.isNaN(v) ? (v / max) * height : 0;
        const d30 = dma30?.[i];
        const d90 = dma90?.[i];
        return (
          <div key={i} style={{ flex: '1 1 0', position: 'relative', height: '100%', display: 'flex', alignItems: 'flex-end' }}>
            <div style={{
              width: '100%', height: barH, background: color, opacity: 0.35, borderRadius: '1px 1px 0 0',
            }} />
            {d30 != null && !Number.isNaN(d30) && (
              <div style={{
                position: 'absolute', bottom: (d30 / max) * height - 2,
                left: '50%', transform: 'translateX(-50%)',
                width: 4, height: 4, borderRadius: '50%', background: '#f59e0b',
              }} />
            )}
            {d90 != null && !Number.isNaN(d90) && (
              <div style={{
                position: 'absolute', bottom: (d90 / max) * height - 2,
                left: '50%', transform: 'translateX(-50%)',
                width: 4, height: 4, borderRadius: '50%', background: '#06b6d4',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DMAChart({ title, daily, values, color, formatter = formatNum }) {
  const dma30 = movingAverage(values, 30);
  const dma90 = movingAverage(values, 90);

  const latest30 = [...dma30].reverse().find(v => v != null);
  const latest90 = [...dma90].reverse().find(v => v != null);
  const latestRaw = values[values.length - 1];

  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, flex: '1 1 400px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ color: '#f8fafc', fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ display: 'flex', gap: 14, fontSize: 11 }}>
          <span style={{ color }}>Today: {formatter(latestRaw)}</span>
          <span style={{ color: '#f59e0b' }}>30 DMA: {formatter(latest30)}</span>
          <span style={{ color: '#06b6d4' }}>90 DMA: {formatter(latest90)}</span>
        </div>
      </div>
      <TimeSeriesChart data={values} color={color} dma30={dma30} dma90={dma90} height={110} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 10, color: '#64748b' }}>
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('6m');
  const [weekdayOnly, setWeekdayOnly] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetch('/api/unified')
      .then(r => {
        if (!r.ok) throw new Error(`API returned ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!data?.daily) return [];
    let rows = [...data.daily].sort((a, b) => a.date.localeCompare(b.date));
    const days = RANGES[range];
    if (days < Infinity) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutStr = cutoff.toISOString().slice(0, 10);
      rows = rows.filter(d => d.date >= cutStr);
    }
    if (weekdayOnly) rows = weekdaysOnly(rows);
    return rows;
  }, [data, range, weekdayOnly]);

  const series = useMemo(() => {
    const quotes = filtered.map(d => d.quotes_count || 0);
    const quotesDollars = filtered.map(d => d.quotes_total || 0);
    const orders = filtered.map(d => d.orders_count || 0);
    const ordersDollars = filtered.map(d => d.orders_total || 0);
    const shipped = filtered.map(d => d.shipped_count || 0);
    const shippedDollars = filtered.map(d => d.shipped_total || 0);

    // Close rate = orders / quotes, computed on 30-day rolling basis to smooth noise
    const q30 = movingAverage(quotes, 30);
    const o30 = movingAverage(orders, 30);
    const closeRate = q30.map((q, i) => {
      if (q == null || o30[i] == null || q === 0) return null;
      return o30[i] / q;
    });

    return { quotes, quotesDollars, orders, ordersDollars, shipped, shippedDollars, closeRate };
  }, [filtered]);

  const summary = useMemo(() => {
    if (filtered.length === 0) return null;
    const sumField = (f) => filtered.reduce((s, d) => s + (d[f] || 0), 0);
    const totalQuotes = sumField('quotes_count');
    const totalOrders = sumField('orders_count');
    return {
      quotes: totalQuotes,
      orders: totalOrders,
      shipped: sumField('shipped_count'),
      quotesDollars: sumField('quotes_total'),
      ordersDollars: sumField('orders_total'),
      shippedDollars: sumField('shipped_total'),
      closeRate: totalQuotes > 0 ? totalOrders / totalQuotes : null,
    };
  }, [filtered]);

  const leadLagResults = useMemo(() => {
    if (filtered.length < 30) return {};
    return {
      quotesToOrders: leadLag(series.quotes, series.orders),
      ordersToShipped: leadLag(series.orders, series.shipped),
    };
  }, [filtered, series]);

  const handleRefresh = async (endpoint) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/refresh/${endpoint}`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setTimeout(() => window.location.reload(), 500);
      } else {
        setRefreshing(false);
        alert(`Refresh failed: ${json.error || 'Unknown error'}`);
      }
    } catch (e) {
      setRefreshing(false);
      alert(`Refresh failed: ${e.message}`);
    }
  };

  if (loading) return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div>Loading data...</div>
    </div>
  );

  if (error) return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', padding: 40 }}>
      <h1 style={{ color: '#f59e0b' }}>RF Traffic Intelligence</h1>
      <p style={{ color: '#ef4444' }}>Error: {error}</p>
      <p style={{ color: '#94a3b8' }}>
        Set NetSuite credentials in environment, then POST to <code>/api/refresh/netsuite</code>.
      </p>
    </div>
  );

  return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            <span style={{ color: '#f59e0b' }}>RF</span> Traffic Intelligence
          </h1>
          {data?.generated && (
            <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>
              Data as of {new Date(data.generated).toLocaleString()}
              {data.sources && ` — ${data.sources.join(', ')}`}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {Object.keys(RANGES).map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              background: range === r ? '#f59e0b' : '#1e293b',
              color: range === r ? '#0f172a' : '#94a3b8',
              border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>{r}</button>
          ))}
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <input type="checkbox" checked={weekdayOnly} onChange={e => setWeekdayOnly(e.target.checked)} />
            Weekdays only
          </label>
          <button onClick={() => handleRefresh('netsuite')} disabled={refreshing} style={{
            background: '#164e63', color: '#67e8f9', border: 'none', borderRadius: 4,
            padding: '6px 14px', cursor: 'pointer', fontSize: 12, marginLeft: 8, fontWeight: 600,
          }}>
            {refreshing ? 'Refreshing...' : '↻ Refresh NetSuite'}
          </button>
        </div>
      </header>

      <main style={{ padding: '24px 32px', maxWidth: 1600, margin: '0 auto' }}>
        {summary && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="Quotes" value={formatNum(summary.quotes)} sub={formatMoney(summary.quotesDollars)} />
            <StatCard label="Sales Orders" value={formatNum(summary.orders)} sub={formatMoney(summary.ordersDollars)} />
            <StatCard label="Shipped Sales" value={formatNum(summary.shipped)} sub={formatMoney(summary.shippedDollars)} />
            <StatCard label="Close Rate" value={formatPct(summary.closeRate)} sub={`${filtered.length} days`} />
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 14, color: '#94a3b8', margin: 0, fontWeight: 600 }}>
                NetSuite Activity — 30 &amp; 90 Day Moving Averages
              </h2>
              <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#64748b' }}>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', marginRight: 4 }} />30 DMA</span>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#06b6d4', marginRight: 4 }} />90 DMA</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <DMAChart title="Quotes (count)" daily={filtered} values={series.quotes} color="#a78bfa" />
              <DMAChart title="Sales Orders (count)" daily={filtered} values={series.orders} color="#34d399" />
              <DMAChart title="Shipped Sales (count)" daily={filtered} values={series.shipped} color="#60a5fa" />
              <DMAChart title="Close Rate (orders / quotes, rolling)" daily={filtered} values={series.closeRate.map(v => v || 0)} color="#f472b6" formatter={formatPct} />
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12, fontWeight: 600 }}>Dollar Volume — 30 &amp; 90 Day Moving Averages</h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <DMAChart title="Quotes ($)" daily={filtered} values={series.quotesDollars} color="#a78bfa" formatter={formatMoney} />
              <DMAChart title="Sales Orders ($)" daily={filtered} values={series.ordersDollars} color="#34d399" formatter={formatMoney} />
              <DMAChart title="Shipped Sales ($)" daily={filtered} values={series.shippedDollars} color="#60a5fa" formatter={formatMoney} />
            </div>
          </div>
        )}

        {(leadLagResults.quotesToOrders || leadLagResults.ordersToShipped) && (
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12, fontWeight: 600 }}>Lead-Lag Correlation</h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <LeadLagCard title="Quotes → Sales Orders" result={leadLagResults.quotesToOrders} />
              <LeadLagCard title="Orders → Shipped Sales" result={leadLagResults.ordersToShipped} />
            </div>
          </div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <h2 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12, fontWeight: 600 }}>
            Daily Data ({filtered.length} rows — last 60)
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155' }}>
                {['Date', 'Quotes', '$ Quotes', 'Orders', '$ Orders', 'Shipped', '$ Shipped'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(-60).reverse().map(d => (
                <tr key={d.date} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '6px 12px', color: '#cbd5e1' }}>{d.date}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.quotes_count)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatMoney(d.quotes_total)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.orders_count)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatMoney(d.orders_total)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.shipped_count)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatMoney(d.shipped_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
