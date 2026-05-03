import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';
import {
  DMALineChart, StatCard, fmtNum, fmtMoney, fmtPct, fmtRatio, fmtDate, fmtAxisDate,
} from './DashboardView';
import {
  RELATIVE_RANGES, RangeDropdown, YearsDropdown,
  useLocalStorageState, clearAllFilters,
} from './FilterControls';
import { movingAverage, slopeLastN, weekdaysOnly } from './utils/analytics';

// Seconds → "1m 23s" or "45s". Used for avg session duration KPI.
function fmtDuration(secs) {
  if (secs == null || Number.isNaN(secs)) return '—';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r.toString().padStart(2, '0')}s`;
}

// Palette for the stacked channel-mix chart. Picked to be distinguishable on
// the dark background and degrade gracefully when "Other" catches the long tail.
const CHANNEL_COLORS = [
  '#f59e0b', '#22d3ee', '#a78bfa', '#4ade80',
  '#f472b6', '#60a5fa', '#fbbf24', '#e879f9',
  '#94a3b8',
];

function rangeCutoff(range, selectedYears) {
  if (selectedYears.length > 0) return null;
  if (range === 'all') return null;
  const days = RELATIVE_RANGES[range];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function inRange(row, cutoff, selectedYears) {
  if (selectedYears.length > 0) return selectedYears.includes(row.date.slice(0, 4));
  if (!cutoff) return true;
  return row.date >= cutoff;
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

function StackedChannelChart({ data, channels, formatter = fmtNum }) {
  const monthTicks = useMemo(() => {
    const starts = [];
    let prev = null;
    for (const row of data) {
      const m = row.date?.slice(0, 7);
      if (m && m !== prev) { starts.push(row.date); prev = m; }
    }
    const step = Math.max(1, Math.ceil(starts.length / 18));
    return starts.filter((_, i) => i % step === 0);
  }, [data]);

  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0,
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 4 }}>
        Sessions by channel (stacked daily)
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} syncId="rf-dashboard-charts" syncMethod="value"
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
          {channels.map((ch, i) => (
            <Area
              key={ch} type="monotone" dataKey={ch} name={ch}
              stackId="1"
              stroke={CHANNEL_COLORS[i % CHANNEL_COLORS.length]}
              fill={CHANNEL_COLORS[i % CHANNEL_COLORS.length]}
              fillOpacity={0.7} strokeWidth={1}
              isAnimationActive={false}
            />
          ))}
          <Legend wrapperStyle={{ fontSize: 10, color: '#cbd5e1', paddingTop: 8 }} iconType="square" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Generic table for any list-of-rows funnel breakdown. Columns are passed
// as { key, label, align, format } objects so each section can shape the
// columns it needs without duplicating the table boilerplate.
// Core Web Vitals panel — three p75 metrics from CrUX with threshold-colored
// tiles and a 25-period mini-trend each. Thresholds are Google's published
// "good / needs improvement / poor" cutoffs (web.dev/vitals).
//
// LCP — Largest Contentful Paint (ms). Good < 2500.
// INP — Interaction to Next Paint (ms). Good < 200.
// CLS — Cumulative Layout Shift (unitless). Good < 0.1.
function ratingForMetric(metric, v) {
  if (v == null) return { rating: '—', color: '#475569' };
  if (metric === 'lcp') {
    if (v <= 2500) return { rating: 'GOOD', color: '#22c55e' };
    if (v <= 4000) return { rating: 'NEEDS WORK', color: '#fbbf24' };
    return { rating: 'POOR', color: '#ef4444' };
  }
  if (metric === 'inp') {
    if (v <= 200) return { rating: 'GOOD', color: '#22c55e' };
    if (v <= 500) return { rating: 'NEEDS WORK', color: '#fbbf24' };
    return { rating: 'POOR', color: '#ef4444' };
  }
  if (metric === 'cls') {
    if (v <= 0.1)  return { rating: 'GOOD', color: '#22c55e' };
    if (v <= 0.25) return { rating: 'NEEDS WORK', color: '#fbbf24' };
    return { rating: 'POOR', color: '#ef4444' };
  }
  return { rating: '—', color: '#475569' };
}

// Top movers table — the cheapest leading indicator we have for organic
// click loss. A query's position slipping from 4 to 9 will lose ~70% of
// clicks before sessions reflects it, often 2–6 weeks ahead.
function QueryMoversPanel({ data, onPick, selected }) {
  if (!data || !data.movers || data.movers.length === 0) return null;
  return (
    <div style={{
      background: '#1e293b', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 700, marginBottom: 2 }}>
        Top movers — {data.latest} vs {data.prior}
      </div>
      <div style={{ color: '#64748b', fontSize: 10, marginBottom: 8 }}>
        Click a query to chart its rank trend over every snapshot we've stored.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Query</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Pos. (prior → latest)</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Δ pos.</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Clicks (prior → latest)</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Δ clicks</th>
          </tr>
        </thead>
        <tbody>
          {data.movers.map((m, i) => {
            const isSelected = selected === m.query;
            // position_delta = prior - latest. Positive means rank improved
            // (smaller number is better in GSC), negative means rank lost.
            const improved = m.position_delta > 0;
            return (
              <tr
                key={m.query}
                onClick={() => onPick(isSelected ? null : m.query)}
                style={{
                  borderTop: i === 0 ? 'none' : '1px solid #334155',
                  background: isSelected ? '#334155' : undefined,
                  cursor: 'pointer',
                }}
              >
                <td style={{ padding: '6px 8px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.query}>
                  {m.query}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#cbd5e1', fontFeatureSettings: '"tnum"' }}>
                  {Number(m.prior_position).toFixed(1)} → {Number(m.latest_position).toFixed(1)}
                </td>
                <td style={{
                  padding: '6px 8px', textAlign: 'right', fontWeight: 600,
                  color: improved ? '#22c55e' : '#ef4444',
                  fontFeatureSettings: '"tnum"',
                }}>
                  {improved ? '↑' : '↓'} {Math.abs(Number(m.position_delta)).toFixed(1)}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', color: '#cbd5e1', fontFeatureSettings: '"tnum"' }}>
                  {fmtNum(m.prior_clicks ?? 0)} → {fmtNum(m.latest_clicks ?? 0)}
                </td>
                <td style={{
                  padding: '6px 8px', textAlign: 'right', fontWeight: 600,
                  color: m.click_delta >= 0 ? '#22c55e' : '#ef4444',
                  fontFeatureSettings: '"tnum"',
                }}>
                  {m.click_delta >= 0 ? '+' : ''}{fmtNum(m.click_delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QueryRankTrendChart({ query, history, onClose }) {
  if (!query) return null;
  if (!history || !history.history || history.history.length < 2) {
    return (
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 14, marginTop: 8 }}>
        <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
          <span>Rank trend — <em>{query}</em></span>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #475569', borderRadius: 4, padding: '2px 8px', fontSize: 10, color: '#94a3b8', cursor: 'pointer' }}>close</button>
        </div>
        <div style={{ color: '#64748b', fontSize: 11 }}>
          Not enough history yet — need at least two GSC snapshots for this query. (We're storing one per fetch; check back after another nightly run.)
        </div>
      </div>
    );
  }
  const data = history.history.map(r => ({
    date: r.date,
    position: Number(r.position),
    clicks: Number(r.clicks) || 0,
  }));
  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 14, marginTop: 8 }}>
      <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
        <span>Rank trend — <em>{query}</em></span>
        <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #475569', borderRadius: 4, padding: '2px 8px', fontSize: 10, color: '#94a3b8', cursor: 'pointer' }}>close</button>
      </div>
      <div style={{ color: '#64748b', fontSize: 10, marginBottom: 8 }}>
        Avg position over time (lower is better) — Y axis inverted. Bars show daily clicks.
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 6, left: 6, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" strokeOpacity={0.5} />
          <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={{ stroke: '#475569' }} />
          <YAxis
            reversed
            tick={{ fill: '#94a3b8', fontSize: 10 }}
            axisLine={false} tickLine={false}
            domain={['dataMin - 1', 'dataMax + 1']}
          />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #475569', borderRadius: 4, fontSize: 11 }}
            labelStyle={{ color: '#cbd5e1' }}
          />
          <Line
            type="monotone" dataKey="position" name="Avg position"
            stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 3, fill: '#f59e0b' }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CoreWebVitalsPanel({ data, latestByFf }) {
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  const last = data[data.length - 1];

  const FormFactorPill = ({ label, ff, metric, fmt }) => {
    const reading = latestByFf?.[ff];
    const v = reading?.[`${metric}_p75`];
    const { color } = ratingForMetric(metric, v);
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 999,
        background: '#0f172a', border: `1px solid ${color}`,
        fontSize: 10, fontFeatureSettings: '"tnum"',
      }} title={`${label} p75`}>
        <span style={{ color: '#94a3b8' }}>{label}</span>
        <span style={{ color }}>{v != null ? fmt(v) : '—'}</span>
      </span>
    );
  };

  const Card = ({ label, metric, value, fmt }) => {
    const { rating, color } = ratingForMetric(metric, value);
    return (
      <div style={{
        flex: '1 1 240px', minWidth: 220,
        background: '#1e293b', borderRadius: 8, padding: 14,
        borderLeft: `3px solid ${color}`,
      }}>
        <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          {label}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ color: '#f8fafc', fontSize: 26, fontWeight: 700, fontFeatureSettings: '"tnum"' }}>
            {value != null ? fmt(value) : '—'}
          </div>
          <div style={{ color, fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>
            {rating}
          </div>
        </div>
        <div style={{ color: '#64748b', fontSize: 10, marginTop: 2, marginBottom: 6 }}>blended p75 · CrUX history</div>
        {latestByFf && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
            <FormFactorPill label="phone"   ff="PHONE"   metric={metric} fmt={fmt} />
            <FormFactorPill label="desktop" ff="DESKTOP" metric={metric} fmt={fmt} />
          </div>
        )}
        <ResponsiveContainer width="100%" height={50}>
          <LineChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide />
            <Line
              type="monotone" dataKey={`${metric}_p75`}
              stroke={color} strokeWidth={2} dot={false} isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Card label="LCP (largest contentful paint)" metric="lcp"
        value={last.lcp_p75} fmt={v => `${(v / 1000).toFixed(2)}s`} />
      <Card label="INP (interaction to next paint)" metric="inp"
        value={last.inp_p75} fmt={v => `${Math.round(v)}ms`} />
      <Card label="CLS (cumulative layout shift)" metric="cls"
        value={last.cls_p75} fmt={v => Number(v).toFixed(3)} />
    </div>
  );
}

// Per-page CWV table — pivots the (page, form_factor) rows so each page is
// one line with mobile + desktop side by side. PageSpeed Insights deep-link
// in the last column gets the operator straight to the diagnostic for the
// specific URL.
function CoreWebVitalsByPagePanel({ rows, origin }) {
  if (!rows || rows.length === 0) return null;
  // Pivot (page, form_factor) → page → { PHONE: {...}, DESKTOP: {...} }
  const byPage = new Map();
  for (const r of rows) {
    if (!byPage.has(r.page)) byPage.set(r.page, { page: r.page });
    byPage.get(r.page)[r.form_factor] = r;
  }
  const pages = [...byPage.values()];
  // Sort by worst LCP (mobile preferred) so the most-broken pages float up.
  pages.sort((a, b) => {
    const av = (a.PHONE?.lcp_p75 ?? a.DESKTOP?.lcp_p75 ?? 0);
    const bv = (b.PHONE?.lcp_p75 ?? b.DESKTOP?.lcp_p75 ?? 0);
    return bv - av;
  });

  const Cell = ({ reading, metric, fmt }) => {
    if (!reading) return <span style={{ color: '#475569' }}>—</span>;
    const v = reading[`${metric}_p75`];
    const { color } = ratingForMetric(metric, v);
    return (
      <span style={{ color, fontFeatureSettings: '"tnum"' }} title={`p75 ${metric.toUpperCase()}`}>
        {v != null ? fmt(v) : '—'}
      </span>
    );
  };

  const fmtLcp = v => `${(v / 1000).toFixed(2)}s`;
  const fmtInp = v => `${Math.round(v)}ms`;
  const fmtCls = v => Number(v).toFixed(3);

  return (
    <div style={{
      background: '#1e293b', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 700, marginBottom: 2 }}>
        Per-page Core Web Vitals — sorted by worst mobile LCP
      </div>
      <div style={{ color: '#64748b', fontSize: 10, marginBottom: 8 }}>
        Pages without enough Chrome traffic to qualify for CrUX coverage are skipped silently.
        Click "PSI" on any row to jump straight into PageSpeed Insights for the full diagnostic + fix recommendations.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0', minWidth: 880 }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th rowSpan={2} style={{ padding: '6px 8px', fontWeight: 500, verticalAlign: 'bottom' }}>Page</th>
            <th colSpan={3} style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'center', borderLeft: '1px solid #334155' }}>Mobile (p75)</th>
            <th colSpan={3} style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'center', borderLeft: '1px solid #334155' }}>Desktop (p75)</th>
            <th rowSpan={2} style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right', verticalAlign: 'bottom', borderLeft: '1px solid #334155' }}>Diagnose</th>
          </tr>
          <tr style={{ color: '#64748b', fontSize: 10 }}>
            <th style={{ padding: '2px 8px', fontWeight: 400, textAlign: 'right', borderLeft: '1px solid #334155' }}>LCP</th>
            <th style={{ padding: '2px 8px', fontWeight: 400, textAlign: 'right' }}>INP</th>
            <th style={{ padding: '2px 8px', fontWeight: 400, textAlign: 'right' }}>CLS</th>
            <th style={{ padding: '2px 8px', fontWeight: 400, textAlign: 'right', borderLeft: '1px solid #334155' }}>LCP</th>
            <th style={{ padding: '2px 8px', fontWeight: 400, textAlign: 'right' }}>INP</th>
            <th style={{ padding: '2px 8px', fontWeight: 400, textAlign: 'right' }}>CLS</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p, i) => {
            const fullUrl = origin ? `${origin}${p.page.startsWith('/') ? p.page : `/${p.page}`}` : null;
            const psi = fullUrl ? `https://pagespeed.web.dev/?url=${encodeURIComponent(fullUrl)}` : null;
            return (
              <tr key={p.page} style={{ borderTop: i === 0 ? 'none' : '1px solid #334155' }}>
                <td style={{ padding: '6px 8px', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.page}>
                  {p.page}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', borderLeft: '1px solid #334155' }}>
                  <Cell reading={p.PHONE} metric="lcp" fmt={fmtLcp} />
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}><Cell reading={p.PHONE} metric="inp" fmt={fmtInp} /></td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}><Cell reading={p.PHONE} metric="cls" fmt={fmtCls} /></td>
                <td style={{ padding: '6px 8px', textAlign: 'right', borderLeft: '1px solid #334155' }}>
                  <Cell reading={p.DESKTOP} metric="lcp" fmt={fmtLcp} />
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}><Cell reading={p.DESKTOP} metric="inp" fmt={fmtInp} /></td>
                <td style={{ padding: '6px 8px', textAlign: 'right' }}><Cell reading={p.DESKTOP} metric="cls" fmt={fmtCls} /></td>
                <td style={{ padding: '6px 8px', textAlign: 'right', borderLeft: '1px solid #334155' }}>
                  {psi ? (
                    <a href={psi} target="_blank" rel="noreferrer" style={{
                      color: 'var(--dso-accent)', fontWeight: 600, textDecoration: 'none',
                      border: '1px solid var(--dso-accent)', borderRadius: 4, padding: '2px 8px', fontSize: 11,
                    }}>PSI ↗</a>
                  ) : <span style={{ color: '#64748b' }}>—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FunnelTable({ title, subtitle, rows, columns, emptyMessage = 'No data in the current range.' }) {
  return (
    <div style={{
      background: '#1e293b', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      {subtitle && <div style={{ color: '#64748b', fontSize: 10, marginBottom: 8 }}>{subtitle}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            {columns.map(c => (
              <th key={c.key} style={{ padding: '6px 8px', fontWeight: 500, textAlign: c.align || 'left' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((r, i) => (
            <tr key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid #334155' }}>
              {columns.map(c => {
                const v = r[c.key];
                const formatted = c.format ? c.format(v, r) : v;
                return (
                  <td key={c.key} style={{
                    padding: '6px 8px',
                    textAlign: c.align || 'left',
                    fontFeatureSettings: c.align === 'right' ? '"tnum"' : 'normal',
                    color: c.dim ? '#94a3b8' : '#e2e8f0',
                    maxWidth: c.maxWidth, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: c.maxWidth ? 'nowrap' : 'normal',
                  }} title={c.maxWidth ? String(v ?? '') : undefined}>
                    {formatted}
                  </td>
                );
              })}
            </tr>
          ))}
          {(!rows || rows.length === 0) && (
            <tr><td colSpan={columns.length} style={{ padding: '10px 8px', color: '#64748b' }}>
              {emptyMessage}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function BrandedSharePanel({ data }) {
  if (!data || !data.branded || !data.non_branded) return null;
  const totalClicks = (data.branded.clicks || 0) + (data.non_branded.clicks || 0);
  const totalImpressions = (data.branded.impressions || 0) + (data.non_branded.impressions || 0);
  if (totalClicks === 0 && totalImpressions === 0) return null;
  const brandedClickShare = totalClicks > 0 ? data.branded.clicks / totalClicks : null;
  const brandedImprShare  = totalImpressions > 0 ? data.branded.impressions / totalImpressions : null;

  const Pile = ({ title, color, summary, top }) => (
    <div style={{
      flex: '1 1 360px', minWidth: 0,
      background: '#1e293b', borderRadius: 8, padding: 14,
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Clicks</div>
          <div style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700, fontFeatureSettings: '"tnum"' }}>
            {fmtNum(summary.clicks)}
          </div>
        </div>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Impr.</div>
          <div style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700, fontFeatureSettings: '"tnum"' }}>
            {fmtNum(summary.impressions)}
          </div>
        </div>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>CTR</div>
          <div style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700, fontFeatureSettings: '"tnum"' }}>
            {summary.ctr != null ? fmtPct(summary.ctr) : '—'}
          </div>
        </div>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Avg pos.</div>
          <div style={{ color: '#f8fafc', fontSize: 18, fontWeight: 700, fontFeatureSettings: '"tnum"' }}>
            {summary.avg_position != null ? summary.avg_position.toFixed(1) : '—'}
          </div>
        </div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 10, textAlign: 'left' }}>
            <th style={{ padding: '4px 6px', fontWeight: 500 }}>Query</th>
            <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Clicks</th>
            <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Impr.</th>
            <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Pos.</th>
          </tr>
        </thead>
        <tbody>
          {top.slice(0, 12).map((q, i) => (
            <tr key={`${q.dimension}-${i}`} style={{ borderTop: i === 0 ? 'none' : '1px solid #334155' }}>
              <td style={{ padding: '4px 6px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={q.dimension}>
                {q.dimension}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFeatureSettings: '"tnum"' }}>{fmtNum(q.clicks)}</td>
              <td style={{ padding: '4px 6px', textAlign: 'right', color: '#94a3b8', fontFeatureSettings: '"tnum"' }}>{fmtNum(q.impressions)}</td>
              <td style={{ padding: '4px 6px', textAlign: 'right', color: '#94a3b8', fontFeatureSettings: '"tnum"' }}>
                {q.position != null ? Number(q.position).toFixed(1) : '—'}
              </td>
            </tr>
          ))}
          {top.length === 0 && (
            <tr><td colSpan={4} style={{ padding: '8px 6px', color: '#64748b' }}>No queries in this bucket.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 10, color: '#64748b', marginBottom: 8 }}>
        Brand pattern: <code style={{ color: '#94a3b8' }}>{data.regex}</code>
        {' '}— set <code style={{ color: '#94a3b8' }}>BRAND_QUERY_REGEX</code> env to customize.
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{
          flex: '1 1 220px', minWidth: 200,
          background: '#1e293b', borderRadius: 8, padding: 14,
          borderLeft: '3px solid var(--dso-accent-hot)',
        }}>
          <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Branded click share
          </div>
          <div style={{ color: '#f8fafc', fontSize: 26, fontWeight: 700 }}>
            {brandedClickShare != null ? fmtPct(brandedClickShare) : '—'}
          </div>
          <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
            of organic clicks come from brand-name searches
          </div>
        </div>
        <div style={{
          flex: '1 1 220px', minWidth: 200,
          background: '#1e293b', borderRadius: 8, padding: 14,
          borderLeft: '3px solid #a8d8e8',
        }}>
          <div style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
            Branded impression share
          </div>
          <div style={{ color: '#f8fafc', fontSize: 26, fontWeight: 700 }}>
            {brandedImprShare != null ? fmtPct(brandedImprShare) : '—'}
          </div>
          <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 4 }}>
            of search impressions are brand-name searches
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Pile title="BRANDED — demand capture" color="var(--dso-accent-hot)" summary={data.branded} top={data.branded.top} />
        <Pile title="NON-BRANDED — demand creation" color="#a8d8e8" summary={data.non_branded} top={data.non_branded.top} />
      </div>
    </div>
  );
}

function ChannelTable({ rows }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 480px', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 8 }}>
        Per-channel quality (visible range)
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Channel</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Sessions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>New users</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conversions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conv / session</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Engaged %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.channel} style={{ borderTop: i === 0 ? 'none' : '1px solid #475569' }}>
              <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.channel}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.sessions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.new_users)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.conversions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtRatio(r.conversion_rate)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.engagement_rate)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} style={{ padding: '10px 8px', color: '#64748b' }}>No channel data in the current range.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CampaignTable({ rows }) {
  return (
    <div style={{
      background: '#334155', borderRadius: 8, padding: '14px 16px',
      flex: '1 1 100%', minWidth: 0, overflowX: 'auto',
    }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 8 }}>
        Campaigns in the visible range — sorted by sessions
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: '#e2e8f0' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 11, textAlign: 'left' }}>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Campaign</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Sessions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Users</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>New users</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conversions</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Conv / session</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Engaged %</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Revenue</th>
            <th style={{ padding: '6px 8px', fontWeight: 500, textAlign: 'right' }}>Active days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.campaign_name} style={{ borderTop: i === 0 ? 'none' : '1px solid #475569' }}>
              <td style={{ padding: '6px 8px', fontWeight: 600, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.campaign_name}>
                {r.campaign_name}
              </td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.sessions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.total_users)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.new_users)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtNum(r.conversions)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtRatio(r.conversion_rate)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtPct(r.engagement_rate)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmtMoney(r.total_revenue)}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right', color: '#94a3b8' }}>{r.active_days}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={9} style={{ padding: '10px 8px', color: '#64748b' }}>
              No campaigns with sessions in the current range. "(not set)" and "(direct)" are excluded.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function GA4InsightsPage() {
  // Share filter state with the other tabs via the same localStorage keys, so
  // switching tabs preserves the user's time selection.
  const [range, setRange] = useLocalStorageState('range', '6m');
  const [selectedYears, setSelectedYears] = useLocalStorageState('years', []);
  const [weekdayOnly, setWeekdayOnly] = useLocalStorageState('weekdayOnly', false);
  const [showDaily, setShowDaily] = useLocalStorageState('showDaily', false);

  const [aggregate, setAggregate] = useState(null);
  const [channelsDaily, setChannelsDaily] = useState(null);
  const [campaignStats, setCampaignStats] = useState(null);
  const [gsc, setGsc] = useState(null);
  const [crux, setCrux] = useState(null);
  const [cruxPages, setCruxPages] = useState(null);
  const [brandedShare, setBrandedShare] = useState(null);
  const [queryMovers, setQueryMovers] = useState(null);
  const [trendQuery, setTrendQuery] = useState(null);
  const [trendData, setTrendData] = useState(null);
  // Window-aggregated dim breakdowns; refetched on range change.
  const [landingPages, setLandingPages] = useState(null);
  const [sourceMedium, setSourceMedium] = useState(null);
  const [firstTouch, setFirstTouch] = useState(null);
  const [devices, setDevices] = useState(null);
  const [countries, setCountries] = useState(null);
  const [events, setEvents] = useState(null);
  const [newVsReturning, setNewVsReturning] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Aggregate + per-channel daily + GSC daily + branded share are
  // range-independent; fetch once. Each integration degrades quietly if
  // not configured — rendering should still work on a GA4-only environment.
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/ga4').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/ga4-channels-daily').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/gsc').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/gsc-branded-share').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/crux').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/crux-by-page').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/gsc-query-movers').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([agg, chans, gscResp, brandResp, cruxResp, cruxPagesResp, moversResp]) => {
        setAggregate(agg);
        setChannelsDaily(chans);
        setGsc(gscResp);
        setBrandedShare(brandResp);
        setCrux(cruxResp);
        setCruxPages(cruxPagesResp);
        setQueryMovers(moversResp);
        if (!agg || (agg.daily || []).length === 0) {
          setError('No GA4 data yet. Run a GA4 fetch first.');
        } else {
          setError(null);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Lazy-fetch query rank history when the user picks a query in the movers
  // table. Cleared when the user dismisses the trend.
  useEffect(() => {
    if (!trendQuery) { setTrendData(null); return; }
    fetch(`/api/gsc-query-history?q=${encodeURIComponent(trendQuery)}`)
      .then(r => r.ok ? r.json() : null)
      .then(setTrendData)
      .catch(() => setTrendData(null));
  }, [trendQuery]);

  const availableYears = useMemo(() => {
    const rows = aggregate?.daily || [];
    if (!rows.length) return [];
    return Array.from(new Set(rows.map(d => d.date.slice(0, 4)))).sort();
  }, [aggregate]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  // Campaign + every dim breakdown refetches on range change — the server
  // aggregates over [since, until] so we can't filter client-side without
  // per-day data. Fire them in parallel; each is independently optional so
  // the page still renders if some endpoints aren't yet populated.
  useEffect(() => {
    const rows = aggregate?.daily || [];
    if (!rows.length) return;
    const last = rows[rows.length - 1].date;
    const params = new URLSearchParams({ until: last });
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    const qs = params.toString();
    const fetchOpt = (url, setter) => {
      const sep = url.includes('?') ? '&' : '?';
      fetch(`${url}${sep}${qs}`).then(r => r.ok ? r.json() : null)
        .then(j => setter(j))
        .catch(() => setter(null));
    };
    fetchOpt('/api/ga4-campaign-stats',           setCampaignStats);
    fetchOpt('/api/ga4-landing-pages',            setLandingPages);
    fetchOpt('/api/ga4-source-medium',            setSourceMedium);
    fetchOpt('/api/ga4-first-touch',              setFirstTouch);
    fetchOpt('/api/ga4-devices',                  setDevices);
    fetchOpt('/api/ga4-countries',                setCountries);
    fetchOpt('/api/ga4-events?conversionsOnly=1', setEvents);
    fetchOpt('/api/ga4-new-vs-returning',         setNewVsReturning);
  }, [aggregate, cutoff, selectedYears]);

  // Build the main daily series with DMAs + a derived pages/session and
  // engaged-sessions/user. GSC clicks/impressions/CTR/position are folded in
  // when present so the SEO funnel sits next to the GA4 numbers — same date
  // spine, NULL-safe for days without GSC coverage.
  const fullSeries = useMemo(() => {
    const rows = aggregate?.daily || [];
    if (!rows.length) return [];
    let ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    if (weekdayOnly) ordered = weekdaysOnly(ordered);

    const sessions  = ordered.map(d => Number(d.sessions) || 0);
    const users     = ordered.map(d => Number(d.total_users) || 0);
    const newUsers  = ordered.map(d => Number(d.new_users) || 0);
    const engaged   = ordered.map(d => Number(d.engaged_sessions) || 0);
    const pageviews = ordered.map(d => Number(d.screen_page_views) || 0);
    const conv      = ordered.map(d => Number(d.conversions) || 0);
    const duration  = ordered.map(d => Number(d.avg_session_duration) || 0);
    const revenue   = ordered.map(d => Number(d.total_revenue) || 0);
    const pagesPerSession = ordered.map((_, i) => sessions[i] > 0 ? pageviews[i] / sessions[i] : 0);
    const convRate  = ordered.map((_, i) => sessions[i] > 0 ? conv[i] / sessions[i] : 0);
    const engRate   = ordered.map((_, i) => sessions[i] > 0 ? engaged[i] / sessions[i] : 0);
    // Engaged sessions / user — modern replacement for bounce rate. Tells you
    // how often the average user has a session that actually counts.
    const engPerUser = ordered.map((_, i) => users[i] > 0 ? engaged[i] / users[i] : 0);

    // GSC daily aligned to GA4 dates. CTR and position are weighted means in
    // GSC's own response, so we keep them as-is per day rather than re-deriving.
    const gscByDate = new Map((gsc?.daily || []).map(d => [d.date, d]));
    const gscClicks      = ordered.map(d => Number(gscByDate.get(d.date)?.clicks)      || 0);
    const gscImpressions = ordered.map(d => Number(gscByDate.get(d.date)?.impressions) || 0);
    const gscCtr         = ordered.map(d => {
      const r = gscByDate.get(d.date);
      return r ? Number(r.ctr) || 0 : null;
    });
    const gscPosition    = ordered.map(d => {
      const r = gscByDate.get(d.date);
      return r ? Number(r.position) || null : null;
    });

    const mmm = (xs) => [movingAverage(xs, 30), movingAverage(xs, 90)];
    const [sess30, sess90] = mmm(sessions);
    const [u30,    u90]    = mmm(users);
    const [nu30,   nu90]   = mmm(newUsers);
    const [eng30,  eng90]  = mmm(engaged);
    const [pv30,   pv90]   = mmm(pageviews);
    const [conv30, conv90] = mmm(conv);
    const [d30,    d90]    = mmm(duration);
    const [rev30,  rev90]  = mmm(revenue);
    const [pps30,  pps90]  = mmm(pagesPerSession);
    const [cr30,   cr90]   = mmm(convRate);
    const [er30,   er90]   = mmm(engRate);
    const [epu30,  epu90]  = mmm(engPerUser);
    const [gc30,   gc90]   = mmm(gscClicks);
    const [gi30,   gi90]   = mmm(gscImpressions);
    const [gctr30, gctr90] = mmm(gscCtr.map(v => v ?? 0));
    const [gpos30, gpos90] = mmm(gscPosition.map(v => v ?? 0));

    return ordered.map((d, i) => ({
      date: d.date,
      sessions: sessions[i], sess30: sess30[i], sess90: sess90[i],
      totalUsers: users[i], u30: u30[i], u90: u90[i],
      newUsers: newUsers[i], nu30: nu30[i], nu90: nu90[i],
      engagedSessions: engaged[i], eng30: eng30[i], eng90: eng90[i],
      pageviews: pageviews[i], pv30: pv30[i], pv90: pv90[i],
      conversions: conv[i], conv30: conv30[i], conv90: conv90[i],
      avgSessionDuration: duration[i], d30: d30[i], d90: d90[i],
      totalRevenue: revenue[i], rev30: rev30[i], rev90: rev90[i],
      pagesPerSession: pagesPerSession[i], pps30: pps30[i], pps90: pps90[i],
      conversionRate: convRate[i], cr30: cr30[i], cr90: cr90[i],
      engagementRate: engRate[i], er30: er30[i], er90: er90[i],
      engPerUser: engPerUser[i], epu30: epu30[i], epu90: epu90[i],
      // GSC raw + DMAs (zero where GSC has no row for the date)
      gscClicks: gscClicks[i], gc30: gc30[i], gc90: gc90[i],
      gscImpressions: gscImpressions[i], gi30: gi30[i], gi90: gi90[i],
      gscCtr: gscCtr[i], gctr30: gctr30[i], gctr90: gctr90[i],
      gscPosition: gscPosition[i], gpos30: gpos30[i], gpos90: gpos90[i],
    }));
  }, [aggregate, weekdayOnly, gsc]);

  const chartData = useMemo(() => {
    if (!fullSeries.length) return [];
    return fullSeries.filter(d => inRange(d, cutoff, selectedYears));
  }, [fullSeries, cutoff, selectedYears]);

  // Weighted aggregates over the visible window (KPI tiles). Bounce rate and
  // avg session duration are re-weighted by sessions so a sparse high-bounce
  // day can't distort the headline number.
  const kpi = useMemo(() => {
    if (chartData.length === 0) return null;
    const sum = (f) => chartData.reduce((s, r) => s + (r[f] || 0), 0);
    const weighted = (f, weightField = 'sessions') => {
      let num = 0, denom = 0;
      for (const r of chartData) {
        const w = r[weightField] || 0;
        if (w > 0 && r[f] != null) { num += r[f] * w; denom += w; }
      }
      return denom > 0 ? num / denom : null;
    };
    const totalSessions = sum('sessions');
    const totalUsers = sum('totalUsers');
    const totalConv = sum('conversions');
    const totalEngaged = sum('engagedSessions');
    const totalPageviews = sum('pageviews');
    const totalRevenue = sum('totalRevenue');
    const totalGscClicks = sum('gscClicks');
    const totalGscImpressions = sum('gscImpressions');
    // Latest 30/90 DMAs and 7-day slopes drive the trend arrows. The
    // StatCard's growth/contracting rule is uniform "30 > 90 = GROWING" —
    // for avg position (lower is better) the badge will read inverted, the
    // caller accepts that.
    const last = chartData[chartData.length - 1];
    const slopeOf = (f) => slopeLastN(chartData.map(d => d[f]), 7);
    return {
      // Volume
      sessions: totalSessions,
      users: totalUsers,
      newUsers: sum('newUsers'),
      engagedSessions: totalEngaged,
      conversions: totalConv,
      totalRevenue,
      // Quality
      conversionRate: totalSessions > 0 ? totalConv / totalSessions : null,
      engagementRate: totalSessions > 0 ? totalEngaged / totalSessions : null,
      // Modern replacement for bounce rate — engaged sessions per user.
      engPerUser: totalUsers > 0 ? totalEngaged / totalUsers : null,
      avgSessionDuration: weighted('avgSessionDuration'),
      pagesPerSession: totalSessions > 0 ? totalPageviews / totalSessions : null,
      // GSC
      gscClicks: totalGscClicks,
      gscImpressions: totalGscImpressions,
      gscCtr: totalGscImpressions > 0 ? totalGscClicks / totalGscImpressions : null,
      // GSC position is a weighted-by-impressions average over the window.
      gscPosition: weighted('gscPosition', 'gscImpressions'),
      // 30/90 latest values + 7d slopes
      sess30: last.sess30, sess90: last.sess90, sess30Slope: slopeOf('sess30'), sess90Slope: slopeOf('sess90'),
      u30:    last.u30,    u90:    last.u90,    u30Slope:    slopeOf('u30'),    u90Slope:    slopeOf('u90'),
      nu30:   last.nu30,   nu90:   last.nu90,   nu30Slope:   slopeOf('nu30'),   nu90Slope:   slopeOf('nu90'),
      eng30:  last.eng30,  eng90:  last.eng90,  eng30Slope:  slopeOf('eng30'),  eng90Slope:  slopeOf('eng90'),
      conv30: last.conv30, conv90: last.conv90, conv30Slope: slopeOf('conv30'), conv90Slope: slopeOf('conv90'),
      rev30:  last.rev30,  rev90:  last.rev90,  rev30Slope:  slopeOf('rev30'),  rev90Slope:  slopeOf('rev90'),
      cr30:   last.cr30,   cr90:   last.cr90,   cr30Slope:   slopeOf('cr30'),   cr90Slope:   slopeOf('cr90'),
      er30:   last.er30,   er90:   last.er90,   er30Slope:   slopeOf('er30'),   er90Slope:   slopeOf('er90'),
      epu30:  last.epu30,  epu90:  last.epu90,  epu30Slope:  slopeOf('epu30'),  epu90Slope:  slopeOf('epu90'),
      d30:    last.d30,    d90:    last.d90,    d30Slope:    slopeOf('d30'),    d90Slope:    slopeOf('d90'),
      pps30:  last.pps30,  pps90:  last.pps90,  pps30Slope:  slopeOf('pps30'),  pps90Slope:  slopeOf('pps90'),
      gc30:   last.gc30,   gc90:   last.gc90,   gc30Slope:   slopeOf('gc30'),   gc90Slope:   slopeOf('gc90'),
      gi30:   last.gi30,   gi90:   last.gi90,   gi30Slope:   slopeOf('gi30'),   gi90Slope:   slopeOf('gi90'),
      gctr30: last.gctr30, gctr90: last.gctr90, gctr30Slope: slopeOf('gctr30'), gctr90Slope: slopeOf('gctr90'),
      gpos30: last.gpos30, gpos90: last.gpos90, gpos30Slope: slopeOf('gpos30'), gpos90Slope: slopeOf('gpos90'),
    };
  }, [chartData]);

  // Pivot per-(date, channel) rows into one row per date with columns per
  // channel, keeping only the top-N channels by sessions in the visible range
  // and folding the rest into "Other" so the stacked chart stays readable.
  const channelPivot = useMemo(() => {
    const rows = channelsDaily?.daily || [];
    if (rows.length === 0) return { data: [], channels: [], totals: [] };
    const visible = rows.filter(r => inRange(r, cutoff, selectedYears));
    if (visible.length === 0) return { data: [], channels: [], totals: [] };

    // Rank channels by sessions in the window.
    const totalByChannel = new Map();
    for (const r of visible) {
      totalByChannel.set(r.channel, (totalByChannel.get(r.channel) || 0) + (r.sessions || 0));
    }
    const ranked = [...totalByChannel.entries()].sort((a, b) => b[1] - a[1]);
    const topN = 6;
    const top = ranked.slice(0, topN).map(([c]) => c);
    const topSet = new Set(top);
    const channels = [...top, ranked.length > topN ? 'Other' : null].filter(Boolean);

    // Per-channel totals including the engagement/conversion ratios for the
    // side table. Re-derived from the daily rows rather than reusing
    // channelOptions so it honors the visible-range filter.
    const totals = channels.map(ch => {
      const keep = ch === 'Other'
        ? visible.filter(r => !topSet.has(r.channel))
        : visible.filter(r => r.channel === ch);
      const sessions = keep.reduce((s, r) => s + (r.sessions || 0), 0);
      const newUsers = keep.reduce((s, r) => s + (r.new_users || 0), 0);
      const engaged = keep.reduce((s, r) => s + (r.engaged_sessions || 0), 0);
      const conv = keep.reduce((s, r) => s + (r.conversions || 0), 0);
      return {
        channel: ch,
        sessions, new_users: newUsers, conversions: conv,
        conversion_rate: sessions > 0 ? conv / sessions : null,
        engagement_rate: sessions > 0 ? engaged / sessions : null,
      };
    }).filter(r => r.sessions > 0);

    // Pivot for the stacked chart. Use the filtered aggregate series as the
    // date spine so the chart x-axis matches everything else on the page.
    const byDate = new Map();
    for (const r of visible) {
      const bucket = topSet.has(r.channel) ? r.channel : 'Other';
      if (!byDate.has(r.date)) byDate.set(r.date, {});
      byDate.get(r.date)[bucket] = (byDate.get(r.date)[bucket] || 0) + (r.sessions || 0);
    }
    const data = chartData.map(cd => {
      const row = { date: cd.date };
      for (const ch of channels) row[ch] = 0;
      const src = byDate.get(cd.date);
      if (src) for (const ch of channels) if (src[ch] != null) row[ch] = src[ch];
      return row;
    });
    return { data, channels, totals };
  }, [channelsDaily, cutoff, selectedYears, chartData]);

  const handleClear = useCallback(() => {
    setRange('6m');
    setSelectedYears([]);
    setWeekdayOnly(false);
    setShowDaily(false);
    clearAllFilters();
  }, [setRange, setSelectedYears, setWeekdayOnly, setShowDaily]);

  const subtitle = `GA4 property · ${chartData.length} days visible`;

  if (loading && !aggregate) {
    return <div style={{ padding: 'clamp(16px, 4vw, 40px)', color: '#94a3b8' }}>Loading GA4 data...</div>;
  }
  if (error && (!aggregate || (aggregate.daily || []).length === 0)) {
    return (
      <div style={{ padding: 'clamp(16px, 4vw, 40px)' }}>
        <p style={{ color: '#ef4444' }}>Error: {error}</p>
        <p style={{ color: '#94a3b8', fontSize: 12 }}>
          Tip: GA4 credentials may not be configured, or the backfill hasn't run yet.
          Trigger a refresh from the Overview tab once GA4 is connected.
        </p>
      </div>
    );
  }

  return (
    <>
      <div style={{
        padding: '12px clamp(12px, 4vw, 32px)', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ color: '#64748b', fontSize: 11 }}>{subtitle}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <RangeDropdown
            range={range}
            disabled={selectedYears.length > 0}
            onChange={r => { setSelectedYears([]); setRange(r); }}
          />
          <YearsDropdown
            selected={selectedYears}
            available={availableYears}
            onChange={setSelectedYears}
          />
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 6 }}>
            <input type="checkbox" checked={weekdayOnly} onChange={e => setWeekdayOnly(e.target.checked)} />
            Weekdays
          </label>
          <label style={{ color: '#94a3b8', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showDaily} onChange={e => setShowDaily(e.target.checked)} />
            Show Daily
          </label>
          {(range !== '6m' || selectedYears.length > 0 || weekdayOnly || showDaily) && (
            <button
              onClick={handleClear}
              title="Reset range, year toggles, weekday filter"
              style={{
                background: '#7f1d1d', color: '#fecaca', border: 'none', borderRadius: 4,
                padding: '5px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 600,
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <main style={{ padding: '16px clamp(12px, 4vw, 32px)', maxWidth: 1600, margin: '0 auto' }}>
        {kpi && (
          <>
          <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
            Web traffic &amp; conversions
          </h2>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <StatCard label="Sessions" value={fmtNum(kpi.sessions)} sub="in range"
              ma30={kpi.sess30} ma90={kpi.sess90} slope30={kpi.sess30Slope} slope90={kpi.sess90Slope} formatter={fmtNum} />
            <StatCard label="Engaged sessions" value={fmtNum(kpi.engagedSessions)} sub="bots/bounces stripped"
              ma30={kpi.eng30} ma90={kpi.eng90} slope30={kpi.eng30Slope} slope90={kpi.eng90Slope} formatter={fmtNum} />
            <StatCard label="Users" value={fmtNum(kpi.users)} sub="in range"
              ma30={kpi.u30} ma90={kpi.u90} slope30={kpi.u30Slope} slope90={kpi.u90Slope} formatter={fmtNum} />
            <StatCard label="New users" value={fmtNum(kpi.newUsers)} sub={
              kpi.users > 0 ? `${Math.round(kpi.newUsers / kpi.users * 100)}% of users` : null
            }
              ma30={kpi.nu30} ma90={kpi.nu90} slope30={kpi.nu30Slope} slope90={kpi.nu90Slope} formatter={fmtNum} />
            <StatCard label="Conversions" value={fmtNum(kpi.conversions)} sub="in range"
              ma30={kpi.conv30} ma90={kpi.conv90} slope30={kpi.conv30Slope} slope90={kpi.conv90Slope} formatter={fmtNum} />
            <StatCard label="Total revenue" value={fmtMoney(kpi.totalRevenue)} sub="GA4 attributed in range"
              ma30={kpi.rev30} ma90={kpi.rev90} slope30={kpi.rev30Slope} slope90={kpi.rev90Slope} formatter={fmtMoney} />
            <StatCard label="Conv / session" value={fmtRatio(kpi.conversionRate)} sub="events per session — can exceed 1"
              ma30={kpi.cr30} ma90={kpi.cr90} slope30={kpi.cr30Slope} slope90={kpi.cr90Slope} formatter={fmtRatio} />
            <StatCard label="Engagement rate" value={fmtPct(kpi.engagementRate)} sub="engaged / sessions"
              ma30={kpi.er30} ma90={kpi.er90} slope30={kpi.er30Slope} slope90={kpi.er90Slope} formatter={fmtPct} />
            <StatCard label="Engaged / user" value={fmtRatio(kpi.engPerUser)} sub="modern replacement for bounce rate"
              ma30={kpi.epu30} ma90={kpi.epu90} slope30={kpi.epu30Slope} slope90={kpi.epu90Slope} formatter={fmtRatio} />
            <StatCard label="Avg session" value={fmtDuration(kpi.avgSessionDuration)} sub="weighted by sessions"
              ma30={kpi.d30} ma90={kpi.d90} slope30={kpi.d30Slope} slope90={kpi.d90Slope} formatter={fmtDuration} />
            <StatCard label="Pages / session" value={kpi.pagesPerSession != null ? kpi.pagesPerSession.toFixed(2) : '—'} sub="pageviews / sessions"
              ma30={kpi.pps30} ma90={kpi.pps90} slope30={kpi.pps30Slope} slope90={kpi.pps90Slope}
              formatter={(v) => v == null ? '—' : v.toFixed(2)} />
          </div>

          {(gsc?.daily?.length ?? 0) > 0 && (
            <>
              <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                Search Console (organic search funnel)
              </h2>
              <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                <StatCard label="GSC clicks" value={fmtNum(kpi.gscClicks)} sub="organic clicks in range"
                  ma30={kpi.gc30} ma90={kpi.gc90} slope30={kpi.gc30Slope} slope90={kpi.gc90Slope} formatter={fmtNum} />
                <StatCard label="GSC impressions" value={fmtNum(kpi.gscImpressions)} sub="search appearances in range"
                  ma30={kpi.gi30} ma90={kpi.gi90} slope30={kpi.gi30Slope} slope90={kpi.gi90Slope} formatter={fmtNum} />
                <StatCard label="GSC CTR" value={fmtPct(kpi.gscCtr)} sub="clicks / impressions"
                  ma30={kpi.gctr30} ma90={kpi.gctr90} slope30={kpi.gctr30Slope} slope90={kpi.gctr90Slope} formatter={fmtPct} />
                <StatCard label="GSC avg position"
                  value={kpi.gscPosition != null ? kpi.gscPosition.toFixed(1) : '—'}
                  sub="weighted by impressions — lower is better"
                  ma30={kpi.gpos30} ma90={kpi.gpos90} slope30={kpi.gpos30Slope} slope90={kpi.gpos90Slope}
                  formatter={(v) => v == null ? '—' : v.toFixed(1)} />
              </div>
            </>
          )}
          </>
        )}

        {chartData.length > 0 && (
          <>
            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Traffic &amp; revenue trend
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Sessions DMA" data={chartData}
                fieldRaw="sessions" field30="sess30" field90="sess90"
                formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Engaged sessions DMA (bots/bounces stripped)" data={chartData}
                fieldRaw="engagedSessions" field30="eng30" field90="eng90"
                formatter={fmtNum} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="New users DMA" data={chartData}
                fieldRaw="newUsers" field30="nu30" field90="nu90"
                formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Total revenue DMA (GA4 attributed)" data={chartData}
                fieldRaw="totalRevenue" field30="rev30" field90="rev90"
                formatter={fmtMoney} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="Conversions DMA" data={chartData}
                fieldRaw="conversions" field30="conv30" field90="conv90"
                formatter={fmtNum} showDaily={showDaily} />
              <DMALineChart title="Conv / session DMA (GA4 key events)" data={chartData}
                fieldRaw="conversionRate" field30="cr30" field90="cr90"
                formatter={fmtRatio} showDaily={showDaily} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Engagement quality
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <DMALineChart title="Engagement rate DMA (engaged / sessions)" data={chartData}
                fieldRaw="engagementRate" field30="er30" field90="er90"
                formatter={fmtPct} showDaily={showDaily} />
              <DMALineChart title="Engaged / user DMA (modern bounce-rate replacement)" data={chartData}
                fieldRaw="engPerUser" field30="epu30" field90="epu90"
                formatter={fmtRatio} showDaily={showDaily} />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <DMALineChart title="Avg session duration DMA (seconds)" data={chartData}
                fieldRaw="avgSessionDuration" field30="d30" field90="d90"
                formatter={(v) => v == null ? '—' : fmtDuration(v)} showDaily={showDaily} />
              <DMALineChart title="Pages per session DMA" data={chartData}
                fieldRaw="pagesPerSession" field30="pps30" field90="pps90"
                formatter={(v) => v == null ? '—' : v.toFixed(2)} showDaily={showDaily} />
            </div>

            {(gsc?.daily?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  Search Console trend
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                  <DMALineChart title="GSC clicks DMA (organic Google clicks)" data={chartData}
                    fieldRaw="gscClicks" field30="gc30" field90="gc90"
                    formatter={fmtNum} showDaily={showDaily} />
                  <DMALineChart title="GSC impressions DMA (search appearances)" data={chartData}
                    fieldRaw="gscImpressions" field30="gi30" field90="gi90"
                    formatter={fmtNum} showDaily={showDaily} />
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  <DMALineChart title="GSC CTR DMA (clicks / impressions)" data={chartData}
                    fieldRaw="gscCtr" field30="gctr30" field90="gctr90"
                    formatter={fmtPct} showDaily={showDaily} />
                  <DMALineChart title="GSC avg position DMA (lower is better)" data={chartData}
                    fieldRaw="gscPosition" field30="gpos30" field90="gpos90"
                    formatter={(v) => v == null ? '—' : v.toFixed(1)} showDaily={showDaily} />
                </div>
              </>
            )}

            {brandedShare && (brandedShare.branded || brandedShare.non_branded) && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontWeight: 600 }}>
                  Branded vs non-branded organic
                </h2>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                  Branded queries are <em>demand capture</em> — searchers already knew you. Non-branded are{' '}
                  <em>demand creation</em> — your SEO content earned a click from someone who didn't.
                  Latest GSC top-queries snapshot ({brandedShare.window_end || '—'}, 28-day window).
                </div>
                <div style={{ marginBottom: 20 }}>
                  <BrandedSharePanel data={brandedShare} />
                </div>
              </>
            )}

            {(queryMovers?.movers?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontWeight: 600 }}>
                  GSC query rank movers
                </h2>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                  Position changes between the most recent two GSC snapshots. A query slipping
                  from rank 4 to 9 loses ~70% of clicks — this surfaces those slips weeks before
                  the session counts catch up. Click any row to chart its full snapshot history.
                </div>
                <div style={{ marginBottom: 8 }}>
                  <QueryMoversPanel data={queryMovers} onPick={setTrendQuery} selected={trendQuery} />
                </div>
                <QueryRankTrendChart
                  query={trendQuery}
                  history={trendData}
                  onClose={() => setTrendQuery(null)}
                />
                <div style={{ marginBottom: 20 }} />
              </>
            )}

            {(crux?.daily?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontWeight: 600 }}>
                  Core Web Vitals (page experience)
                </h2>
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                  Direct Google ranking factor — when these degrade, organic clicks follow within weeks.
                  Real-user p75 from the Chrome User Experience Report (last 25 collection periods).
                  Each tile shows the blended ALL-form-factor reading with a <em>phone</em> / <em>desktop</em>{' '}
                  pill below — mobile is usually worse and is the form factor most B2B sites should optimize for.
                  Thresholds per <a href="https://web.dev/vitals/" target="_blank" rel="noreferrer" style={{ color: '#94a3b8' }}>web.dev/vitals</a>.
                </div>
                <div style={{ marginBottom: 14 }}>
                  <CoreWebVitalsPanel
                    data={crux.daily}
                    latestByFf={crux.latest_by_form_factor}
                  />
                </div>
                {(cruxPages?.pages?.length ?? 0) > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <CoreWebVitalsByPagePanel
                      rows={cruxPages.pages}
                      origin={crux.origin || ''}
                    />
                  </div>
                )}
              </>
            )}

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Channel mix
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <StackedChannelChart
                data={channelPivot.data}
                channels={channelPivot.channels}
                formatter={fmtNum}
              />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <ChannelTable rows={channelPivot.totals} />
            </div>

            <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
              Campaign performance
            </h2>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <CampaignTable rows={campaignStats?.campaigns || []} />
            </div>

            {(landingPages?.landing_pages?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  Top landing pages
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  <FunnelTable
                    title="Top landing pages by sessions in range"
                    subtitle="The single most useful SEO read — which pages earn their keep, and which drop off."
                    rows={landingPages.landing_pages}
                    columns={[
                      { key: 'landing_page', label: 'Landing page', maxWidth: 360 },
                      { key: 'sessions', label: 'Sessions', align: 'right', format: fmtNum },
                      { key: 'engaged_sessions', label: 'Engaged', align: 'right', format: fmtNum },
                      { key: 'engagement_rate', label: 'Eng %', align: 'right', format: v => v != null ? fmtPct(v) : '—' },
                      { key: 'conversions', label: 'Conv.', align: 'right', format: fmtNum },
                      { key: 'conversion_rate', label: 'Conv / sess', align: 'right', format: v => v != null ? fmtRatio(v) : '—' },
                      { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                      { key: 'active_days', label: 'Active days', align: 'right', dim: true, format: v => v ?? '—' },
                    ]}
                  />
                </div>
              </>
            )}

            {(sourceMedium?.source_medium?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  Source / Medium (granular attribution)
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  <FunnelTable
                    title="Source / Medium — top combinations by sessions"
                    subtitle="Channel groups roll these up; this is the granular view (google/organic vs google/cpc, reddit/referral, etc.)."
                    rows={sourceMedium.source_medium}
                    columns={[
                      { key: 'source', label: 'Source', maxWidth: 200 },
                      { key: 'medium', label: 'Medium', maxWidth: 140 },
                      { key: 'sessions', label: 'Sessions', align: 'right', format: fmtNum },
                      { key: 'engaged_sessions', label: 'Engaged', align: 'right', format: fmtNum },
                      { key: 'new_users', label: 'New users', align: 'right', format: fmtNum },
                      { key: 'conversions', label: 'Conv.', align: 'right', format: fmtNum },
                      { key: 'conversion_rate', label: 'Conv / sess', align: 'right', format: v => v != null ? fmtRatio(v) : '—' },
                      { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                    ]}
                  />
                </div>
              </>
            )}

            {((devices?.devices?.length ?? 0) > 0 || (countries?.countries?.length ?? 0) > 0) && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  Device &amp; geo split
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  {(devices?.devices?.length ?? 0) > 0 && (
                    <div style={{ flex: '1 1 360px', minWidth: 0 }}>
                      <FunnelTable
                        title="Device"
                        subtitle="Mobile vs desktop conv-rate delta surfaces UX leaks."
                        rows={devices.devices}
                        columns={[
                          { key: 'device', label: 'Device' },
                          { key: 'sessions', label: 'Sessions', align: 'right', format: fmtNum },
                          { key: 'engagement_rate', label: 'Eng %', align: 'right', format: v => v != null ? fmtPct(v) : '—' },
                          { key: 'conversions', label: 'Conv.', align: 'right', format: fmtNum },
                          { key: 'conversion_rate', label: 'Conv / sess', align: 'right', format: v => v != null ? fmtRatio(v) : '—' },
                          { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                        ]}
                      />
                    </div>
                  )}
                  {(countries?.countries?.length ?? 0) > 0 && (
                    <div style={{ flex: '1 1 480px', minWidth: 0 }}>
                      <FunnelTable
                        title="Country"
                        subtitle="Top 25 by sessions in range."
                        rows={countries.countries}
                        columns={[
                          { key: 'country', label: 'Country', maxWidth: 180 },
                          { key: 'sessions', label: 'Sessions', align: 'right', format: fmtNum },
                          { key: 'new_users', label: 'New users', align: 'right', format: fmtNum },
                          { key: 'conversions', label: 'Conv.', align: 'right', format: fmtNum },
                          { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                        ]}
                      />
                    </div>
                  )}
                </div>
              </>
            )}

            {(events?.events?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  Conversion events
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                  {events.events.slice(0, 8).map(ev => (
                    <StatCard
                      key={ev.event_name}
                      label={ev.event_name}
                      value={fmtNum(ev.conversions)}
                      sub={`${fmtNum(ev.event_count)} fires${ev.total_revenue ? ` · ${fmtMoney(ev.total_revenue)} revenue` : ''}`}
                      small={ev.active_days != null ? `${ev.active_days} active days` : null}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  <FunnelTable
                    title="All conversion events in range"
                    rows={events.events}
                    columns={[
                      { key: 'event_name', label: 'Event' },
                      { key: 'conversions', label: 'Conversions', align: 'right', format: fmtNum },
                      { key: 'event_count', label: 'Total fires', align: 'right', format: fmtNum },
                      { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                      { key: 'active_days', label: 'Active days', align: 'right', dim: true, format: v => v ?? '—' },
                    ]}
                  />
                </div>
              </>
            )}

            {(newVsReturning?.visitor_types?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  New vs returning
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  <FunnelTable
                    title="Top vs bottom funnel proxy"
                    subtitle="New visitors are upper funnel; returning are closer to converting. Mixing them blurs lag analysis."
                    rows={newVsReturning.visitor_types}
                    columns={[
                      { key: 'visitor_type', label: 'Visitor type' },
                      { key: 'sessions', label: 'Sessions', align: 'right', format: fmtNum },
                      { key: 'engagement_rate', label: 'Eng %', align: 'right', format: v => v != null ? fmtPct(v) : '—' },
                      { key: 'conversions', label: 'Conv.', align: 'right', format: fmtNum },
                      { key: 'conversion_rate', label: 'Conv / sess', align: 'right', format: v => v != null ? fmtRatio(v) : '—' },
                      { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                    ]}
                  />
                </div>
              </>
            )}

            {(firstTouch?.first_touch?.length ?? 0) > 0 && (
              <>
                <h2 style={{ fontSize: 13, color: '#94a3b8', marginBottom: 10, fontWeight: 600 }}>
                  First-touch attribution
                </h2>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
                  <FunnelTable
                    title="First-touch source / medium"
                    subtitle="Where the user first found you, not where they were when they came back to convert. For 30–90d B2B cycles this often tells a different story than session-source."
                    rows={firstTouch.first_touch}
                    columns={[
                      { key: 'first_source', label: 'First source', maxWidth: 200 },
                      { key: 'first_medium', label: 'First medium', maxWidth: 140 },
                      { key: 'sessions', label: 'Sessions', align: 'right', format: fmtNum },
                      { key: 'new_users', label: 'New users', align: 'right', format: fmtNum },
                      { key: 'conversions', label: 'Conv.', align: 'right', format: fmtNum },
                      { key: 'conversion_rate', label: 'Conv / sess', align: 'right', format: v => v != null ? fmtRatio(v) : '—' },
                      { key: 'total_revenue', label: 'Revenue', align: 'right', format: fmtMoney },
                    ]}
                  />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
