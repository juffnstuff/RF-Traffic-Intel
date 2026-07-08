import React, { useState, useEffect, useCallback } from 'react';
import DashboardView from './DashboardView';
import FilteredPage from './FilteredPage';
import PartGroupAnalysisPage from './PartGroupAnalysisPage';
import GA4InsightsPage from './GA4InsightsPage';
import PaidKPIsPage from './PaidKPIsPage';
import SEOKPIsPage from './SEOKPIsPage';
import CrossSourcePage from './CrossSourcePage';
import RFTILogo from './components/RFTILogo';
import { PinProvider, PinPanel } from './utils/pins';
import { waitForRefreshLocks } from './utils/refresh';

function OverviewPage() {
  const [data, setData] = useState(null);
  const [ga4, setGa4] = useState(null);
  // GSC daily clicks/impressions and per-channel sessions feed the upstream
  // lead-lag panel — both are optional and degrade quietly if missing.
  const [gscDaily, setGscDaily] = useState(null);
  const [channelsDaily, setChannelsDaily] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  const loadData = useCallback(() => {
    setLoading(true);
    // GA4 / GSC / channel-daily are optional — don't fail the page if any are
    // not ready yet (each integration backfills independently).
    Promise.all([
      fetch('/api/unified').then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }),
      fetch('/api/ga4').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/gsc').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ga4-channels-daily').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([unified, ga4Resp, gscResp, channelsResp]) => {
        setData(unified);
        setGa4(ga4Resp);
        setGscDaily(gscResp);
        setChannelsDaily(channelsResp);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRefresh = async (mode) => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/refresh/netsuite?mode=${mode}`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || `API ${res.status}`);
      // A backfill can take minutes — poll the lock instead of a fixed delay.
      const done = await waitForRefreshLocks(['netsuite-header']);
      if (!done) setRefreshError('Refresh still running after 15 min — reloaded what was available.');
      loadData();
    } catch (e) {
      setRefreshError(`Refresh failed: ${e.message}`);
    } finally {
      setRefreshing(false);
    }
  };

  if (loading && !data) return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading data...</div>;
  if (error && !data) return <p style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#ef4444' }}>Error: {error}</p>;

  return (
    <DashboardView
      daily={data?.daily || []}
      ga4Daily={ga4?.daily || []}
      gscDaily={gscDaily?.daily || []}
      channelsDaily={channelsDaily?.daily || []}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      refreshError={refreshError}
      sourceLabel={data?.sources?.join(', ') || ''}
      aiContext={{ page: 'overview' }}
    />
  );
}

// Thin data-freshness warning strip below the tab bar. Only renders when a
// source is stale or errored; dismissible for the session.
function FetchHealthStrip() {
  const [health, setHealth] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/fetch-health')
      .then(r => r.ok ? r.json() : null)
      .then(setHealth)
      .catch(() => {});
  }, []);

  if (dismissed) return null;
  const problems = (health?.sources || []).filter(s => s.stale || s.status === 'error');
  if (problems.length === 0) return null;

  const ago = (iso) => {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'recently';
    const h = Math.floor(ms / 3600000);
    if (h < 1) return '<1h ago';
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '5px clamp(12px, 4vw, 32px)',
      background: 'rgba(127, 29, 29, 0.25)',
      borderBottom: '1px solid #7f1d1d',
      color: '#fca5a5', fontSize: 11,
    }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        ⚠ Data freshness: {problems.map(s =>
          `${s.source} last synced ${ago(s.finished_at || s.started_at)}${s.status === 'error' && s.error ? ` (error: ${s.error})` : ''}`
        ).join(' · ')}
      </span>
      <button
        onClick={() => setDismissed(true)}
        style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
        title="Dismiss for this session"
      >×</button>
    </div>
  );
}

// Shareable-link tab ids ↔ internal tab state values.
const HASH_TO_TAB = {
  overview: 'overview', filtered: 'filtered', partgroups: 'pg-r',
  ga4: 'ga4', paid: 'paid', seo: 'seo', roas: 'cross',
};
const TAB_TO_HASH = Object.fromEntries(Object.entries(HASH_TO_TAB).map(([h, t]) => [t, h]));
const tabFromHash = () => HASH_TO_TAB[window.location.hash.replace(/^#/, '')] || 'overview';

export default function App() {
  const [tab, setTab] = useState(tabFromHash);

  // Back/forward and pasted #hash links select the matching tab.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectTab = (t) => {
    setTab(t);
    // replaceState so tab clicks don't spam the history stack.
    history.replaceState(null, '', `#${TAB_TO_HASH[t] || t}`);
  };

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
    <PinProvider>
      <div style={{
        background: 'var(--dso-bg)',
        color: 'var(--dso-text)',
        minHeight: '100vh',
        fontFamily: "var(--dso-font-body, system-ui, -apple-system, sans-serif)",
      }}>
        <PinPanel />
        <header style={{ padding: '16px clamp(12px, 4vw, 32px) 0', borderBottom: '1px solid var(--dso-rule)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, paddingBottom: 12 }}>
            <RFTILogo
              size={22}
              color="var(--dso-sky-bright, #a8d8e8)"
              hot="var(--dso-accent-hot)"
              showFrame={false}
              showTagline={false}
            />
            <span className="dso-auto-tag" style={{ fontSize: 11 }}>Traffic Intelligence · Live</span>
          </div>
          <nav style={{ display: 'flex', gap: 2, overflowX: 'auto', whiteSpace: 'nowrap' }}>
            <button style={tabStyle(tab === 'overview')} onClick={() => selectTab('overview')}>Overview</button>
            <button style={tabStyle(tab === 'filtered')} onClick={() => selectTab('filtered')}>By Part Group / Rep</button>
            <button style={tabStyle(tab === 'pg-r')} onClick={() => selectTab('pg-r')}>Part Group r-Analysis</button>
            <button style={tabStyle(tab === 'ga4')} onClick={() => selectTab('ga4')}>GA4 Insights</button>
            <button style={tabStyle(tab === 'paid')} onClick={() => selectTab('paid')}>Paid KPIs</button>
            <button style={tabStyle(tab === 'seo')} onClick={() => selectTab('seo')}>SEO KPIs</button>
            <button style={tabStyle(tab === 'cross')} onClick={() => selectTab('cross')}>ROAS</button>
          </nav>
        </header>

        <FetchHealthStrip />

        {tab === 'overview' && <OverviewPage />}
        {tab === 'filtered' && <FilteredPage />}
        {tab === 'pg-r' && <PartGroupAnalysisPage />}
        {tab === 'ga4' && <GA4InsightsPage />}
        {tab === 'paid' && <PaidKPIsPage />}
        {tab === 'seo' && <SEOKPIsPage />}
        {tab === 'cross' && <CrossSourcePage />}
      </div>
    </PinProvider>
  );
}
