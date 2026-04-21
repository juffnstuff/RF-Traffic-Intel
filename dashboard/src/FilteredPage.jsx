import React, { useState, useEffect, useCallback, useMemo } from 'react';
import DashboardView from './DashboardView';
import { MultiSelectDropdown, useLocalStorageState } from './FilterControls';

export default function FilteredPage() {
  const [filterOptions, setFilterOptions] = useState({ partGroups: [], salesReps: [] });
  const [ga4Campaigns, setGa4Campaigns] = useState([]);
  const [ga4Channels, setGa4Channels] = useState([]);
  const [sizeBuckets, setSizeBuckets] = useState([]);

  // Filter state persists across tab switches and page reloads.
  const [selectedPartGroups, setSelectedPartGroups] = useLocalStorageState('filter.partGroups', []);
  const [selectedSalesReps, setSelectedSalesReps]   = useLocalStorageState('filter.salesReps', []);
  const [selectedCampaigns, setSelectedCampaigns]   = useLocalStorageState('filter.campaigns', []);
  const [selectedChannels, setSelectedChannels]     = useLocalStorageState('filter.channels', []);
  const [customerType, setCustomerType]             = useLocalStorageState('filter.customerType', 'all');
  // Size bucket is single-select (a quote is in exactly one bucket); null = "All sizes".
  const [sizeBucket, setSizeBucket]                 = useLocalStorageState('filter.sizeBucket', null);

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
    fetch('/api/ga4-channels')
      .then(r => r.ok ? r.json() : null)
      .then(j => setGa4Channels(j?.channels || []))
      .catch(() => setGa4Channels([]));
    fetch('/api/size-buckets')
      .then(r => r.ok ? r.json() : null)
      .then(j => setSizeBuckets(j?.buckets || []))
      .catch(() => setSizeBuckets([]));
  }, []);

  const loadData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedPartGroups.length) params.set('partGroups', selectedPartGroups.join(','));
    if (selectedSalesReps.length)  params.set('salesReps',  selectedSalesReps.join(','));
    if (customerType !== 'all')    params.set('customerType', customerType);
    if (sizeBucket)                params.set('sizeBucket', sizeBucket);
    const qs = params.toString();

    // GA4 precedence: campaign filter wins over channel filter (campaigns are
    // more specific); fall back to aggregate when neither is active.
    let ga4Url;
    if (selectedCampaigns.length) {
      ga4Url = `/api/ga4-by-campaign?campaigns=${encodeURIComponent(selectedCampaigns.join(','))}`;
    } else if (selectedChannels.length) {
      ga4Url = `/api/ga4-by-channel?channels=${encodeURIComponent(selectedChannels.join(','))}`;
    } else {
      ga4Url = `/api/ga4`;
    }

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
  }, [selectedPartGroups, selectedSalesReps, selectedCampaigns, selectedChannels, customerType, sizeBucket]);

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
          fetch('/api/size-buckets').then(r => r.ok ? r.json() : null).then(j => setSizeBuckets(j?.buckets || [])).catch(() => {});
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
    setSelectedChannels([]);
    setCustomerType('all');
    setSizeBucket(null);
  };

  const filterPanel = useMemo(() => (
    <div style={{ padding: '14px clamp(12px, 4vw, 32px)', borderBottom: '1px solid #1e293b', background: '#0b1220' }}>
      {/* Quote-size bucket — single-select chips, matches the Part Group
          r-Analysis UI so the user has one consistent control. */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10,
      }}>
        <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 600, marginRight: 4 }}>
          Quote size:
        </div>
        <button
          onClick={() => setSizeBucket(null)}
          style={{
            background: sizeBucket === null ? '#f59e0b' : '#334155',
            color: sizeBucket === null ? '#0f172a' : '#e2e8f0',
            border: 'none', borderRadius: 4, padding: '5px 12px',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}
        >All sizes</button>
        {sizeBuckets.map(b => {
          const active = sizeBucket === b.bucket;
          return (
            <button
              key={b.bucket}
              onClick={() => setSizeBucket(b.bucket)}
              title={`${b.quote_count.toLocaleString()} quotes · $${(b.quote_total / 1e6).toFixed(1)}M total`}
              style={{
                background: active ? '#f59e0b' : '#334155',
                color: active ? '#0f172a' : '#e2e8f0',
                border: 'none', borderRadius: 4, padding: '5px 12px',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}
            >
              {b.bucket}
              <span style={{ opacity: 0.7, fontSize: 10, marginLeft: 6, fontWeight: 500 }}>
                {b.quote_count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {/* All other filters on one row: Part Group, Sales Rep, SEM Campaign,
          Traffic Channel, Customer Type. Part Group now lives in a dropdown
          too, matching the other pickers. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <MultiSelectDropdown
          label="Part Group"
          options={filterOptions.partGroups}
          selected={selectedPartGroups}
          onChange={setSelectedPartGroups}
          keyField="value" nameField="value"
          emptyHint="No part groups yet — run a dim fetch."
        />
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
        <MultiSelectDropdown
          label="Traffic Channel"
          options={ga4Channels}
          selected={selectedChannels}
          onChange={setSelectedChannels}
          keyField="value" nameField="value" countField="sessions"
          emptyHint="No GA4 channels yet — waiting for GA4 fetch."
        />

        {/* Customer Type — segmented control. 'new' isolates first-time
            quote/order activity (custbody_rf_firstquote / firstorder), so
            repeat business doesn't wash out the GA4→quote leading signal. */}
        <div style={{ display: 'inline-flex', background: '#334155', borderRadius: 4, overflow: 'hidden', border: '1px solid #475569' }}>
          <span style={{ color: '#94a3b8', fontSize: 11, padding: '4px 10px', borderRight: '1px solid #475569', alignSelf: 'center' }}>
            Customer
          </span>
          {[
            { key: 'all', label: 'All' },
            { key: 'new', label: 'New only' },
            { key: 'repeat', label: 'Repeat' },
          ].map(opt => {
            const active = customerType === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setCustomerType(opt.key)}
                title={
                  opt.key === 'new'    ? 'First quote or first order per customer (custbody_rf_firstquote/firstorder)' :
                  opt.key === 'repeat' ? 'Existing-customer activity (not flagged first)' :
                                          'All activity'
                }
                style={{
                  background: active ? '#f59e0b' : 'transparent',
                  color: active ? '#0f172a' : '#e2e8f0',
                  border: 'none', padding: '4px 10px', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600,
                  borderLeft: '1px solid #475569',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  ), [filterOptions, ga4Campaigns, ga4Channels, sizeBuckets, selectedPartGroups, selectedSalesReps, selectedCampaigns, selectedChannels, customerType, sizeBucket]);

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
    `${customerType === 'all' ? 'all customers' : customerType === 'new' ? 'new customers only' : 'repeat only'} · ` +
    `${sizeBucket || 'all sizes'} · ` +
    `${selectedPartGroups.length || 'all'} part groups · ` +
    `${selectedSalesReps.length || 'all'} reps · ` +
    `${selectedCampaigns.length || 'all'} campaigns · ` +
    `${selectedChannels.length || 'all'} channels`;

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
          customer_type: customerType,
          size_bucket: sizeBucket,
          part_groups: selectedPartGroups,
          sales_reps: selectedSalesReps.map(id => {
            const rep = filterOptions.salesReps.find(r => String(r.id) === String(id));
            return rep ? { id, name: rep.name } : { id };
          }),
          campaigns: selectedCampaigns,
          channels: selectedChannels,
        },
      }}
    />
  );
}
