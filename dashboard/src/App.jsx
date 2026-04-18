import React, { useState, useEffect, useCallback } from 'react';
import DashboardView from './DashboardView';
import FilteredPage from './FilteredPage';
import PartGroupAnalysisPage from './PartGroupAnalysisPage';

function OverviewPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
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

  if (loading && !data) return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading data...</div>;
  if (error && !data) return <p style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#ef4444' }}>Error: {error}</p>;

  return (
    <DashboardView
      daily={data?.daily || []}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      sourceLabel={data?.sources?.join(', ') || ''}
      aiContext={{ page: 'overview' }}
    />
  );
}

export default function App() {
  const [tab, setTab] = useState('overview');

  const tabStyle = (active) => ({
    background: active ? '#0f172a' : 'transparent',
    color: active ? '#f8fafc' : '#94a3b8',
    border: 'none',
    borderBottom: active ? '2px solid #f59e0b' : '2px solid transparent',
    padding: '10px 18px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: 0.2,
  });

  return (
    <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{ padding: '16px clamp(12px, 4vw, 32px) 0', borderBottom: '1px solid #1e293b' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, paddingBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            <span style={{ color: '#f59e0b' }}>RF</span> Traffic Intelligence
          </h1>
        </div>
        <nav style={{ display: 'flex', gap: 2, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          <button style={tabStyle(tab === 'overview')} onClick={() => setTab('overview')}>Overview</button>
          <button style={tabStyle(tab === 'filtered')} onClick={() => setTab('filtered')}>By Part Group / Rep</button>
          <button style={tabStyle(tab === 'pg-r')} onClick={() => setTab('pg-r')}>Part Group r-Analysis</button>
        </nav>
      </header>

      {tab === 'overview' && <OverviewPage />}
      {tab === 'filtered' && <FilteredPage />}
      {tab === 'pg-r' && <PartGroupAnalysisPage />}
    </div>
  );
}
