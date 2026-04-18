import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { movingAverage, leadLag, weekdaysOnly } from './utils/analytics';

const RELATIVE_RANGES = { '3m': 90, '6m': 180 };
const MIN_DAYS_FOR_R = 60;  // hide a row's r if it has fewer days than this

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function strengthColor(absR) {
  if (absR == null) return '#475569';
  if (absR >= 0.7) return '#22c55e';
  if (absR >= 0.4) return '#fbbf24';
  return '#94a3b8';
}

function RCell({ result }) {
  if (!result) {
    return <span style={{ color: '#475569' }}>—</span>;
  }
  const { bestLag, bestR } = result;
  const absR = Math.abs(bestR);
  const color = strengthColor(absR);
  const inverse = bestR < 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span style={{
        width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block',
      }} />
      <span style={{ color: '#cbd5e1', fontFeatureSettings: '"tnum"' }}>{bestLag}d</span>
      <span style={{ color: '#f8fafc', fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
        {inverse ? '−' : ''}{Math.abs(bestR).toFixed(2)}
      </span>
    </span>
  );
}

function HeaderCell({ label, sortKey, currentSort, onSort, align = 'left', tip }) {
  const active = currentSort.key === sortKey;
  return (
    <th
      title={tip}
      onClick={() => onSort(sortKey)}
      style={{
        textAlign: align, padding: '8px 10px', fontSize: 11, fontWeight: 600,
        color: active ? '#f8fafc' : '#94a3b8', background: '#1e293b', borderBottom: '1px solid #334155',
        cursor: 'pointer', userSelect: 'none', position: 'sticky', top: 0, zIndex: 1,
      }}
    >
      {label} {active && (currentSort.dir === 'desc' ? '↓' : '↑')}
    </th>
  );
}

export default function PartGroupAnalysisPage() {
  const [groups, setGroups] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState('6m');
  const [selectedYears, setSelectedYears] = useState([]);
  const [weekdayOnly, setWeekdayOnly] = useState(true);
  const [sort, setSort] = useState({ key: 'total_dollars', dir: 'desc' });

  const loadData = useCallback(() => {
    setLoading(true);
    fetch('/api/by-part-group')
      .then(r => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json(); })
      .then(json => { setGroups(json.groups); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // All years that show up across any part group
  const availableYears = useMemo(() => {
    if (!groups) return [];
    const ys = new Set();
    for (const g of groups) for (const r of g.daily) ys.add(r.date.slice(0, 4));
    return Array.from(ys).sort();
  }, [groups]);

  // Slice each group's daily array down to the visible window, then compute r values.
  const rows = useMemo(() => {
    if (!groups) return [];
    const filterToWindow = (daily) => {
      let rows = [...daily].sort((a, b) => a.date.localeCompare(b.date));
      if (weekdayOnly) rows = weekdaysOnly(rows);
      if (selectedYears.length > 0) {
        const ySet = new Set(selectedYears);
        rows = rows.filter(d => ySet.has(d.date.slice(0, 4)));
      } else if (range !== 'all' && RELATIVE_RANGES[range]) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - RELATIVE_RANGES[range]);
        const cutStr = cutoff.toISOString().slice(0, 10);
        rows = rows.filter(d => d.date >= cutStr);
      }
      return rows;
    };

    return groups.map(g => {
      const slice = filterToWindow(g.daily);
      const days = slice.length;

      const quotes = slice.map(d => d.quotes_count || 0);
      const orders = slice.map(d => d.orders_count || 0);
      const shipped = slice.map(d => d.shipped_count || 0);
      const quotes_d = slice.map(d => d.quotes_total || 0);
      const orders_d = slice.map(d => d.orders_total || 0);
      const shipped_d = slice.map(d => d.shipped_total || 0);

      // Smooth before correlating — same approach as the main dashboard.
      const qc30 = movingAverage(quotes, 30);
      const oc30 = movingAverage(orders, 30);
      const sc30 = movingAverage(shipped, 30);
      const q30  = movingAverage(quotes_d, 30);
      const o30  = movingAverage(orders_d, 30);
      const s30  = movingAverage(shipped_d, 30);

      const enough = days >= MIN_DAYS_FOR_R;
      const totals = {
        quotes_total: quotes_d.reduce((a, b) => a + b, 0),
        orders_total: orders_d.reduce((a, b) => a + b, 0),
        shipped_total: shipped_d.reduce((a, b) => a + b, 0),
        orders_count: orders.reduce((a, b) => a + b, 0),
      };

      return {
        part_group: g.part_group,
        days,
        total_dollars: totals.quotes_total,
        period_orders_dollars: totals.orders_total,
        qto_count:    enough ? leadLag(qc30, oc30) : null,
        qto_dollars:  enough ? leadLag(q30,  o30)  : null,
        ots_count:    enough ? leadLag(oc30, sc30) : null,
        ots_dollars:  enough ? leadLag(o30,  s30)  : null,
      };
    });
  }, [groups, range, selectedYears, weekdayOnly]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const dir = sort.dir === 'desc' ? -1 : 1;
    copy.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
    return copy;
  }, [rows, sort]);

  const handleSort = (key) => {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'part_group' ? 'asc' : 'desc' });
  };

  if (loading && !groups) {
    return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading per-part-group analysis...</div>;
  }
  if (error && !groups) {
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 40px)' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>
          This view needs the dim (line-level) data. Open the "By Part Group / Rep" tab and run a dim backfill first.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Filter bar — same time controls as the other tabs */}
      <div style={{
        padding: '12px clamp(12px, 4vw, 32px)', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ color: '#64748b', fontSize: 11 }}>
          {sortedRows.length} part groups · 30 DMA-smoothed correlation, lag 0–45 days
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
        </div>
      </div>

      <main style={{ padding: '20px clamp(12px, 4vw, 32px)', maxWidth: 1600, margin: '0 auto' }}>
        <div style={{ background: '#1e293b', borderRadius: 8, padding: 14, marginBottom: 14 }}>
          <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Per-part-group lead-lag r
          </div>
          <div style={{ color: '#94a3b8', fontSize: 11, lineHeight: 1.5 }}>
            Each row is one part group, computed independently on its own 30 DMA-smoothed series.
            "Lag" is the day-offset where the correlation peaks; "r" is the correlation strength
            at that lag. <span style={{ color: '#22c55e' }}>●</span> = strong (≥0.7),
            <span style={{ color: '#fbbf24' }}> ●</span> = moderate (0.4–0.7),
            <span style={{ color: '#94a3b8' }}> ●</span> = weak/noisy (&lt;0.4).
            Rows with fewer than {MIN_DAYS_FOR_R} days of activity show "—" because r isn't reliable on small samples.
          </div>
        </div>

        <div style={{ overflowX: 'auto', background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 760 }}>
            <thead>
              <tr>
                <HeaderCell label="Part Group" sortKey="part_group" currentSort={sort} onSort={handleSort} />
                <HeaderCell label="Q→O (count)" sortKey="qto_count" currentSort={sort} onSort={handleSort} align="left"
                  tip="Quote count → Order count: lag (days) and r" />
                <HeaderCell label="Q→O ($)" sortKey="qto_dollars" currentSort={sort} onSort={handleSort} align="left"
                  tip="Quote $ → Order $: lag (days) and r — primary forecasting signal" />
                <HeaderCell label="O→S (count)" sortKey="ots_count" currentSort={sort} onSort={handleSort} align="left"
                  tip="Order count → Shipped count: lag (days) and r" />
                <HeaderCell label="O→S ($)" sortKey="ots_dollars" currentSort={sort} onSort={handleSort} align="left"
                  tip="Order $ → Shipped $: lag (days) and r" />
                <HeaderCell label="Days" sortKey="days" currentSort={sort} onSort={handleSort} align="right"
                  tip="Days of activity in the visible window" />
                <HeaderCell label="Quote $" sortKey="total_dollars" currentSort={sort} onSort={handleSort} align="right"
                  tip="Total quote $ in the visible window" />
                <HeaderCell label="Order $" sortKey="period_orders_dollars" currentSort={sort} onSort={handleSort} align="right"
                  tip="Total order $ in the visible window" />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(r => (
                <tr key={r.part_group} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '8px 10px', color: '#f8fafc', fontWeight: 600 }}>{r.part_group}</td>
                  <td style={{ padding: '8px 10px' }}><RCell result={r.qto_count} /></td>
                  <td style={{ padding: '8px 10px' }}><RCell result={r.qto_dollars} /></td>
                  <td style={{ padding: '8px 10px' }}><RCell result={r.ots_count} /></td>
                  <td style={{ padding: '8px 10px' }}><RCell result={r.ots_dollars} /></td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: '#94a3b8', fontFeatureSettings: '"tnum"' }}>{r.days}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: '#cbd5e1', fontFeatureSettings: '"tnum"' }}>{fmtMoney(r.total_dollars)}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: '#cbd5e1', fontFeatureSettings: '"tnum"' }}>{fmtMoney(r.period_orders_dollars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

// Map sort key → comparable value for a row
function sortValue(row, key) {
  switch (key) {
    case 'part_group': return row.part_group.toLowerCase();
    case 'days': return row.days;
    case 'total_dollars': return row.total_dollars;
    case 'period_orders_dollars': return row.period_orders_dollars;
    case 'qto_count':   return row.qto_count   ? Math.abs(row.qto_count.bestR)   : null;
    case 'qto_dollars': return row.qto_dollars ? Math.abs(row.qto_dollars.bestR) : null;
    case 'ots_count':   return row.ots_count   ? Math.abs(row.ots_count.bestR)   : null;
    case 'ots_dollars': return row.ots_dollars ? Math.abs(row.ots_dollars.bestR) : null;
    default: return null;
  }
}
