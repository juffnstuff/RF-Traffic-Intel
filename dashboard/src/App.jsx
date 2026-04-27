import React, { useState, useEffect, useCallback } from 'react';
import DashboardView from './DashboardView';
import FilteredPage from './FilteredPage';
import PartGroupAnalysisPage from './PartGroupAnalysisPage';
import GA4InsightsPage from './GA4InsightsPage';
import PaidKPIsPage from './PaidKPIsPage';
import SEOKPIsPage from './SEOKPIsPage';
import DSOATDLogo from './components/DSOATDLogo';

function OverviewPage() {
  const [data, setData] = useState(null);
  const [ga4, setGa4] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(() => {
    setLoading(true);
    // GA4 is optional — don't fail the page if it's not ready yet.
    Promise.all([
      fetch('/api/unified').then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }),
      fetch('/api/ga4').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([unified, ga4Resp]) => {
        setData(unified);
        setGa4(ga4Resp);
      })
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
      ga4Daily={ga4?.daily || []}
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
    background: 'transparent',
    color: active ? 'var(--dso-text)' : 'var(--dso-text-dim)',
    border: 'none',
    borderBottom: active ? '2px solid var(--dso-accent-hot)' : '2px solid transparent',
    padding: '10px 18px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
  });

  return (
    <div style={{
      background: 'var(--dso-bg)',
      color: 'var(--dso-text)',
      minHeight: '100vh',
      fontFamily: "var(--dso-font-body, system-ui, -apple-system, sans-serif)",
    }}>
      <header style={{ padding: '16px clamp(12px, 4vw, 32px) 0', borderBottom: '1px solid var(--dso-rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, paddingBottom: 12 }}>
          <DSOATDLogo
            size={26}
            color="var(--dso-accent)"
            hot="var(--dso-accent-hot)"
            showFrame={false}
            showTagline={false}
          />
          <span className="dso-auto-tag" style={{ fontSize: 11 }}>Traffic Intelligence · Live</span>
        </div>
        <nav style={{ display: 'flex', gap: 2, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          <button style={tabStyle(tab === 'overview')} onClick={() => setTab('overview')}>Overview</button>
          <button style={tabStyle(tab === 'filtered')} onClick={() => setTab('filtered')}>By Part Group / Rep</button>
          <button style={tabStyle(tab === 'pg-r')} onClick={() => setTab('pg-r')}>Part Group r-Analysis</button>
          <button style={tabStyle(tab === 'ga4')} onClick={() => setTab('ga4')}>GA4 Insights</button>
          <button style={tabStyle(tab === 'paid')} onClick={() => setTab('paid')}>Paid KPIs</button>
          <button style={tabStyle(tab === 'seo')} onClick={() => setTab('seo')}>SEO KPIs</button>
        </nav>
      </header>

      {tab === 'overview' && <OverviewPage />}
      {tab === 'filtered' && <FilteredPage />}
      {tab === 'pg-r' && <PartGroupAnalysisPage />}
      {tab === 'ga4' && <GA4InsightsPage />}
      {tab === 'paid' && <PaidKPIsPage />}
      {tab === 'seo' && <SEOKPIsPage />}
    </div>
  );
}
