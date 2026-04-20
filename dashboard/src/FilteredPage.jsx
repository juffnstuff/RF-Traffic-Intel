import React, { useState, useEffect, useCallback, useMemo } from 'react';
import DashboardView from './DashboardView';
import { MultiSelectDropdown, useLocalStorageState, clearAllFilters } from './FilterControls';

function MultiSelectChips({ label, options, selected, onToggle, onClear, emptyHint, keyField = 'value', nameField = 'value' }) {
  const selectedSet = new Set(selected);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 600 }}>{label}</div>
        <div style={{ color: '#64748b', fontSize: 11 }}>
          {selected.length > 0 ? `${selected.length} selected` : 'all'}
        </div>
        {selected.length > 0 && (
          <button onClick={onClear} style={{
            background: 'transparent', color: '#94a3b8', border: '1px solid #334155',
            borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer',
          }}>clear</button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 110, overflowY: 'auto', paddingRight: 4 }}>
        {options.length === 0 && <div style={{ color: '#64748b', fontSize: 11 }}>{emptyHint}</div>}
        {options.map(opt => {
          const key = opt[keyField];
          const name = opt[nameField];
          const active = selectedSet.has(String(key));
          return (
            <button key={key} onClick={() => onToggle(String(key))} style={{
              background: active ? '#f59e0b' : '#1e293b',
              color: active ? '#0f172a' : '#e2e8f0',
              border: active ? 'none' : '1px solid #334155',
              borderRadius: 4, padding: '3px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
            }}>{name || '(blank)'}</button>
          );
        })}
      </div>
    </div>
  );
}

export default function FilteredPage() {
  const [filterOptions, setFilterOptions] = useState({ partGroups: [], salesReps: [] });
  const [ga4Campaigns, setGa4Campaigns] = useState([]);

  // Filter state persists across tab switches and page reloads.
  const [selectedPartGroups, setSelectedPartGroups] = useLocalStorageState('filter.partGroups', []);
  const [selectedSalesReps, setSelectedSalesReps]   = useLocalStorageState('filter.salesReps', []);
  const [selectedCampaigns, setSelectedCampaigns]   = useLocalStorageState('filter.campaigns', []);

  const [data, setData] = useState(null);
  const [ga4, setGa4] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetch('/api/filters')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`)))
      .then(setFilterOptions)
      .catch(e => console.error('filter options load failed:', e));
    fetch('/api/ga4-campaigns')
      .then(r => r.ok ? r.json() : null)
      .then(j => setGa4Campaigns(j?.campaigns || []))
      .catch(() => setGa4Campaigns([]));
  }, []);

  const loadData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedPartGroups.length) params.set('partGroups', selectedPartGroups.join(','));
    if (selectedSalesReps.length) params.set('salesReps', selectedSalesReps.join(','));
    const qs = params.toString();

    const ga4Url = selectedCampaigns.length
      ? `/api/ga4-by-campaign?campaigns=${encodeURIComponent(selectedCampaigns.join(','))}`
      : `/api/ga4`;

    Promise.all([
      fetch(`/api/unified-dim${qs ? '?' + qs : ''}`).then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); }),
      fetch(ga4Url).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([dimResp, ga4Resp]) => {
        setData(dimResp);
        setGa4(ga4Resp);
        setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedPartGroups, selectedSalesReps, selectedCampaigns]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRefresh = async (mode) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/refresh/netsuite-dim?mode=${mode}`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setTimeout(() => {
          loadData();
          fetch('/api/filters').then(r => r.json()).then(setFilterOptions).catch(() => {});
          fetch('/api/ga4-campaigns').then(r => r.ok ? r.json() : null).then(j => setGa4Campaigns(j?.campaigns || [])).catch(() => {});
          setRefreshing(false);
        }, 500);
      } else {
        alert(`Refresh failed: ${json.error}`);
        setRefreshing(false);
      }
    } catch (e) {
      alert(`Refresh failed: ${e.message}`);
      setRefreshing(false);
    }
  };

  const handleClearFilters = () => {
    setSelectedPartGroups([]);
    setSelectedSalesReps([]);
    setSelectedCampaigns([]);
    // DashboardView.clearAllFilters already wipes localStorage; its Clear
    // button resets the time-range state internally.
  };

  const toggle = (setter) => (val) =>
    setter(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val]);

  const filterPanel = useMemo(() => (
    <div style={{ padding: '14px clamp(12px, 4vw, 32px)', borderBottom: '1px solid #1e293b', background: '#0b1220' }}>
      <MultiSelectChips
        label="Part Group"
        options={filterOptions.partGroups}
        selected={selectedPartGroups}
        onToggle={toggle(setSelectedPartGroups)}
        onClear={() => setSelectedPartGroups([])}
        emptyHint="No part groups yet — run a dim fetch."
        keyField="value" nameField="value"
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
        <MultiSelectDropdown
          label="Sales Rep"
          options={filterOptions.salesReps}
          selected={selectedSalesReps}
          onChange={setSelectedSalesReps}
          keyField="id" nameField="name"
          emptyHint="No sales reps yet — run a dim fetch."
        />
        <MultiSelectDropdown
          label="SEM Campaign"
          options={ga4Campaigns}
          selected={selectedCampaigns}
          onChange={setSelectedCampaigns}
          keyField="value" nameField="value" countField="sessions"
          emptyHint="No active GA4 campaigns in the last 30 days."
        />
      </div>
    </div>
  ), [filterOptions, ga4Campaigns, selectedPartGroups, selectedSalesReps, selectedCampaigns]);

  if (loading && !data) {
    return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading filtered data...</div>;
  }
  if (error && !data) {
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 40px)' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>
          Tip: if this is the first time you're opening this page, trigger a dim refresh from the button below once data is available.
        </p>
        <button onClick={() => handleRefresh('full')} disabled={refreshing} style={{
          background: '#164e63', color: '#67e8f9', border: 'none', borderRadius: 4,
          padding: '6px 14px', cursor: 'pointer', fontSize: 12, marginTop: 8, fontWeight: 600,
        }}>
          {refreshing ? 'Fetching line-level data...' : 'Run Full Dim Backfill'}
        </button>
      </div>
    );
  }

  const summary =
    `${selectedPartGroups.length || 'all'} part groups · ` +
    `${selectedSalesReps.length || 'all'} reps · ` +
    `${selectedCampaigns.length || 'all'} campaigns`;

  return (
    <DashboardView
      daily={data?.daily || []}
      ga4Daily={ga4?.daily || []}
      headerExtras={filterPanel}
      subtitle={<>netsuite-dim — filtered: {summary}</>}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      sourceLabel="netsuite-dim"
      onClearFilters={handleClearFilters}
      aiContext={{
        page: 'filtered',
        filters: {
          part_groups: selectedPartGroups,
          sales_reps: selectedSalesReps.map(id => {
            const rep = filterOptions.salesReps.find(r => String(r.id) === String(id));
            return rep ? { id, name: rep.name } : { id };
          }),
          campaigns: selectedCampaigns,
        },
      }}
    />
  );
}
