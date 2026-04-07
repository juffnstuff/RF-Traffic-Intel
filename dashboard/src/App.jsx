import React, { useState, useEffect, useMemo } from 'react';
import { movingAverage, normalize, leadLag, weekdaysOnly } from './utils/analytics';

const RANGES = { '1m': 30, '3m': 90, '6m': 180, '1y': 365, '2y': 730, all: Infinity };

function formatNum(n) {
  if (n == null) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{
      background: '#1e293b', borderRadius: 8, padding: '16px 20px',
      flex: '1 1 160px', minWidth: 160,
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

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('6m');
  const [weekdayOnly, setWeekdayOnly] = useState(false);
  const [showNormalized, setShowNormalized] = useState(false);
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

  const summary = useMemo(() => {
    if (filtered.length === 0) return null;
    const organic = filtered.reduce((s, d) => s + (d.gsc_clicks || 0), 0);
    const sessions = filtered.reduce((s, d) => s + (d.ga4_sessions || 0), 0);
    const quotes = filtered.reduce((s, d) => s + (d.ns_quotes || 0), 0);
    const orders = filtered.reduce((s, d) => s + (d.ns_orders || 0), 0);
    return { organic, sessions, quotes, orders };
  }, [filtered]);

  const leadLagResults = useMemo(() => {
    if (filtered.length < 30) return {};
    const clicks = filtered.map(d => d.gsc_clicks || 0);
    const quotes = filtered.map(d => d.ns_quotes || 0);
    const orders = filtered.map(d => d.ns_orders || 0);
    return {
      clicksToQuotes: leadLag(clicks, quotes),
      quotesToOrders: leadLag(quotes, orders),
    };
  }, [filtered]);

  const handleRefresh = async (endpoint) => {
    setRefreshing(true);
    try {
      await fetch(`/api/refresh/${endpoint}`, { method: 'POST' });
      // reload data after a short delay
      setTimeout(() => window.location.reload(), 2000);
    } catch {
      setRefreshing(false);
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
      <p style={{ color: '#94a3b8' }}>Make sure data has been fetched. Run: <code>node fetchers/fetch-all.js</code></p>
    </div>
  );

  return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <header style={{ padding: '20px 32px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
          <span style={{ color: '#f59e0b' }}>RF</span> Traffic Intelligence
        </h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Range selector */}
          {Object.keys(RANGES).map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              background: range === r ? '#f59e0b' : '#1e293b',
              color: range === r ? '#0f172a' : '#94a3b8',
              border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            }}>{r}</button>
          ))}
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <input type="checkbox" checked={weekdayOnly} onChange={e => setWeekdayOnly(e.target.checked)} />
            Weekdays
          </label>
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showNormalized} onChange={e => setShowNormalized(e.target.checked)} />
            Normalized
          </label>
          <button onClick={() => handleRefresh('netsuite')} disabled={refreshing} style={{
            background: '#164e63', color: '#67e8f9', border: 'none', borderRadius: 4,
            padding: '4px 12px', cursor: 'pointer', fontSize: 12, marginLeft: 8,
          }}>
            {refreshing ? 'Refreshing...' : 'Refresh NetSuite'}
          </button>
        </div>
      </header>

      <main style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
        {/* Summary Cards */}
        {summary && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="Organic Clicks" value={formatNum(summary.organic)} sub={`${filtered.length} days`} />
            <StatCard label="Total Sessions" value={formatNum(summary.sessions)} />
            <StatCard label="Quotes" value={formatNum(summary.quotes)} />
            <StatCard label="Sales Orders" value={formatNum(summary.orders)} />
          </div>
        )}

        {/* Lead-Lag Analysis */}
        {(leadLagResults.clicksToQuotes || leadLagResults.quotesToOrders) && (
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12, fontWeight: 600 }}>Lead-Lag Correlation</h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <LeadLagCard title="Organic Clicks → Quotes" result={leadLagResults.clicksToQuotes} />
              <LeadLagCard title="Quotes → Sales Orders" result={leadLagResults.quotesToOrders} />
            </div>
          </div>
        )}

        {/* Data Table */}
        <div style={{ overflowX: 'auto' }}>
          <h2 style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12, fontWeight: 600 }}>
            Daily Data ({filtered.length} rows)
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155' }}>
                {['Date', 'GSC Clicks', 'GSC Impressions', 'GA4 Sessions', 'Quotes', 'Orders'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(-60).reverse().map(d => (
                <tr key={d.date} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '6px 12px', color: '#cbd5e1' }}>{d.date}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.gsc_clicks)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.gsc_impressions)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.ga4_sessions)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.ns_quotes)}</td>
                  <td style={{ padding: '6px 12px' }}>{formatNum(d.ns_orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
