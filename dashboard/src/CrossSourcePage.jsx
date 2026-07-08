import React, { useState, useEffect, useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { StatCard, fmtNum, fmtMoney, fmtPct, fmtRatio } from './DashboardView';
import {
  RELATIVE_RANGES, RangeDropdown, YearsDropdown,
  useLocalStorageState, clearAllFilters,
} from './FilterControls';
import { downloadCsv } from './utils/csv';
import UpdatingPill from './components/UpdatingPill';

// Small "Export CSV" button reused by the ROAS-tab tables. `rows` should be
// the currently-sorted/filtered rows, already mapped to flat objects.
function ExportButton({ filename, rows }) {
  if (!rows || rows.length === 0) return null;
  return (
    <button
      onClick={() => downloadCsv(filename, rows)}
      style={{
        background: 'transparent', border: '1px solid var(--dso-rule)',
        color: 'var(--dso-text-dim)', borderRadius: 3, padding: '3px 10px',
        fontSize: 11, cursor: 'pointer', flexShrink: 0,
      }}
    >Export CSV</button>
  );
}

function rangeCutoff(range, selectedYears) {
  if (selectedYears.length > 0) return null;
  if (range === 'all') return null;
  const days = RELATIVE_RANGES[range];
  if (!days) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function VisibilityBadge({ inAds, inGa4, inCallRail, inForms }) {
  // Visual diagnostic for tagging health. Show a chip only when a row
  // appears in just one source — that's the actionable case. Two-of-
  // four is common (e.g. an organic UTM with calls but no spend).
  const present = [inAds, inGa4, inCallRail, inForms].filter(Boolean).length;
  if (present >= 2) return null;
  let label, color;
  if (inAds)           { label = 'Ads only';   color = '#f59e0b'; }
  else if (inGa4)      { label = 'GA4 only';   color = '#94a3b8'; }
  else if (inCallRail) { label = 'Calls only'; color = '#a78bfa'; }
  else if (inForms)    { label = 'Forms only'; color = '#34d399'; }
  else return null;
  return (
    <span style={{
      fontSize: 9,
      color,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      fontWeight: 700,
      marginLeft: 6,
    }}>{label}</span>
  );
}

function CampaignRoiTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No joined data in the selected window. Either GA4 or Google Ads has no rows here.
    </div>;
  }
  const totals = rows.reduce((acc, r) => {
    acc.cost += r.cost;
    acc.ad_clicks += r.ad_clicks;
    acc.ad_impressions += r.ad_impressions;
    acc.ga4_sessions += r.ga4_sessions;
    acc.ga4_conversions += r.ga4_conversions;
    acc.ga4_revenue += r.ga4_revenue;
    acc.cr_calls    += r.cr_calls    || 0;
    acc.cr_answered += r.cr_answered || 0;
    acc.form_subs   += r.form_subs   || 0;
    return acc;
  }, { cost: 0, ad_clicks: 0, ad_impressions: 0, ga4_sessions: 0,
       ga4_conversions: 0, ga4_revenue: 0, cr_calls: 0, cr_answered: 0,
       form_subs: 0 });
  const totalCpa = totals.ga4_conversions > 0 ? totals.cost / totals.ga4_conversions : null;
  const totalCostPerCall = totals.cr_calls > 0 ? totals.cost / totals.cr_calls : null;
  const totalCostPerForm = totals.form_subs > 0 ? totals.cost / totals.form_subs : null;
  const totalAnsweredRate = totals.cr_calls > 0 ? totals.cr_answered / totals.cr_calls : null;
  const totalLeads = totals.cr_answered + totals.form_subs;
  const totalCostPerLead = totalLeads > 0 ? totals.cost / totalLeads : null;
  const anyCalls = totals.cr_calls > 0;
  const anyForms = totals.form_subs > 0;
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <ExportButton filename="campaign-roi.csv" rows={rows} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Campaign</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Cost</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Ad Clicks</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Sessions</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Sess/Click</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Conv.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}
              title="GA4-attributed revenue is ≈$0 for this site (no on-site sales) — real ROAS lives in the NetSuite-based tables above">GA4 Revenue</th>
            {anyCalls && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', borderLeft: '1px solid var(--dso-rule)', color: '#a78bfa' }}>Calls</th>}
            {anyCalls && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', color: '#a78bfa' }}>Answered</th>}
            {anyCalls && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', color: '#a78bfa' }}>$/Call</th>}
            {anyForms && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', borderLeft: '1px solid var(--dso-rule)', color: '#34d399' }}>Forms</th>}
            {anyForms && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', color: '#34d399' }}>$/Form</th>}
            {(anyCalls || anyForms) && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>$/Lead</th>}
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>CPA</th>
            {/* No ROAS column here on purpose: ga4_revenue/cost is ≈0 and reads
                as a fake "everything loses money" signal next to the real
                NetSuite-based ROAS tables. */}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.campaign_name + i} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.campaign_name}>
                {r.campaign_name || <span style={{ color: 'var(--dso-text-faint)' }}>(unnamed)</span>}
                <VisibilityBadge inAds={r.in_ads} inGa4={r.in_ga4} inCallRail={r.in_callrail} inForms={r.in_forms} />
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ad_clicks)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_sessions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.sessions_per_click != null ? fmtRatio(r.sessions_per_click) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_conversions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.ga4_revenue)}</td>
              {anyCalls && <td style={{ padding: '8px 10px', textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>{fmtNum(r.cr_calls)}</td>}
              {anyCalls && <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.answered_rate != null ? `${fmtNum(r.cr_answered)} (${fmtPct(r.answered_rate)})` : '—'}</td>}
              {anyCalls && <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.cost_per_call != null ? fmtMoney(r.cost_per_call) : '—'}</td>}
              {anyForms && <td style={{ padding: '8px 10px', textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>{fmtNum(r.form_subs)}</td>}
              {anyForms && <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.cost_per_form != null ? fmtMoney(r.cost_per_form) : '—'}</td>}
              {(anyCalls || anyForms) && <td style={{ padding: '8px 10px', textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>{r.cost_per_lead != null ? fmtMoney(r.cost_per_lead) : '—'}</td>}
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.cost_per_ga4_conv != null ? fmtMoney(r.cost_per_ga4_conv) : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--dso-rule)', fontWeight: 700 }}>
            <td style={{ padding: '10px', color: 'var(--dso-text-dim)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.cost)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ad_clicks)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ga4_sessions)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>—</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.ga4_conversions)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.ga4_revenue)}</td>
            {anyCalls && <td style={{ padding: '10px', textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>{fmtNum(totals.cr_calls)}</td>}
            {anyCalls && <td style={{ padding: '10px', textAlign: 'right' }}>{totalAnsweredRate != null ? `${fmtNum(totals.cr_answered)} (${fmtPct(totalAnsweredRate)})` : '—'}</td>}
            {anyCalls && <td style={{ padding: '10px', textAlign: 'right' }}>{totalCostPerCall != null ? fmtMoney(totalCostPerCall) : '—'}</td>}
            {anyForms && <td style={{ padding: '10px', textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>{fmtNum(totals.form_subs)}</td>}
            {anyForms && <td style={{ padding: '10px', textAlign: 'right' }}>{totalCostPerForm != null ? fmtMoney(totalCostPerForm) : '—'}</td>}
            {(anyCalls || anyForms) && <td style={{ padding: '10px', textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>{totalCostPerLead != null ? fmtMoney(totalCostPerLead) : '—'}</td>}
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalCpa != null ? fmtMoney(totalCpa) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// NetSuite revenue rolled up by HubSpot first-touch source. Two-lane join:
// primary = HubSpot's `netsuite_quote_number` ↔ NetSuite `tran_id`; fallback
// = email-normalized customer match for contacts the middleware hasn't tagged
// yet. Each row shows both lanes so the operator can see how much of the
// attribution is high- vs lower-confidence.
// First-touch vs latest-touch attribution toggle. Persists to localStorage
// via the parent's useLocalStorageState so the choice carries across reloads.
function AttrLensToggle({ value, onChange }) {
  const opt = (k, label, hint) => (
    <button
      type="button"
      onClick={() => onChange(k)}
      title={hint}
      style={{
        background: value === k ? 'var(--dso-accent-hot)' : 'transparent',
        color: value === k ? 'white' : 'var(--dso-text-dim)',
        border: `1px solid ${value === k ? 'var(--dso-accent-hot)' : 'var(--dso-rule)'}`,
        padding: '4px 10px',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        borderRadius: 3,
      }}
    >{label}</button>
  );
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {opt('first',  'First-touch', 'hs_analytics_source — original / first-touch (stable per contact)')}
      {opt('latest', 'Latest',      'hs_latest_source — most recent session source (overwrites on each new session)')}
      {opt('netsuite', 'NetSuite',  "Quote's NetSuite Customer Lead Source — works for the OFFLINE/integration base, but is rep-entered so treat as advisory")}
    </div>
  );
}

function HubSpotAttributionTable({ rows, lens }) {
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No HubSpot↔NetSuite attribution joined yet. Confirm `hubspot_netsuite_quotes`
      has rows (run a full HubSpot refresh) and that quote emails match contact emails.
    </div>;
  }
  const totals = rows.reduce((acc, r) => {
    acc.contacts             += r.contacts || 0;
    acc.quotes               += r.quotes   || 0;
    acc.quotes_unattributed  += r.quotes_unattributed || 0;
    acc.revenue              += r.revenue  || 0;
    acc.revenue_unattributed += r.revenue_unattributed || 0;
    acc.wins                 += r.wins     || 0;
    acc.revenue_won          += r.revenue_won || 0;
    return acc;
  }, { contacts: 0, quotes: 0, quotes_unattributed: 0, revenue: 0,
       revenue_unattributed: 0, wins: 0, revenue_won: 0 });
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        Revenue from `hubspot_netsuite_quotes` (NetSuite quote totals mirrored into HubSpot),
        bucketed by <strong>{lens === 'latest' ? "the contact's hs_latest_source" : lens === 'netsuite' ? "the quote's NetSuite lead source (ns_lead_source)" : "the contact's hs_analytics_source"}</strong>.
        Quotes whose email doesn't match any contact land in the (UNKNOWN) bucket — see Unattributed columns.
        "via domain" counts quotes matched through the corporate-domain fallback (quote email's company
        domain ↔ contact domain) rather than an exact email match — same company, lower confidence.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>HubSpot Source</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Contacts</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Quotes</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Unattributed</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Wins</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Win Revenue</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Total Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.hs_source + i} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px' }}>{r.hs_source || <span style={{ color: 'var(--dso-text-faint)' }}>(unknown)</span>}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.contacts)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {fmtNum(r.quotes)}
                {(r.quotes_domain_matched || 0) > 0 && (
                  <span style={{ color: 'var(--dso-text-faint)', fontSize: 10, marginLeft: 4 }}>
                    ({fmtNum(r.quotes_domain_matched)} via domain)
                  </span>
                )}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--dso-text-dim)', fontSize: 11 }}>
                {fmtNum(r.quotes_unattributed)} ({fmtMoney(r.revenue_unattributed)})
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.wins)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue_won)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.revenue)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--dso-rule)', fontWeight: 700 }}>
            <td style={{ padding: '10px', color: 'var(--dso-text-dim)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.contacts)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.quotes)}</td>
            <td style={{ padding: '10px', textAlign: 'right', color: 'var(--dso-text-dim)', fontSize: 11 }}>
              {fmtNum(totals.quotes_unattributed)} ({fmtMoney(totals.revenue_unattributed)})
            </td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.wins)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue_won)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// Per-quote drill-down — one row per quote, both attributions side-by-side.
// `latest_predates_quote` is TRUE when the contact's hs_latest_source_timestamp
// is on or before the quote date (latest is reliable for that quote); FALSE
// means the latest source was set in a session AFTER the quote was created,
// so first-touch is the more trustworthy lens for that row.
function QuoteAttributionTable({ rows }) {
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No quotes in window. Either `hubspot_netsuite_quotes` is empty or no quotes fall in the selected dates.
    </div>;
  }
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        Every quote with both original and latest attribution side-by-side. <strong>Latest pre-dates quote</strong> ✓
        means the contact's latest-source timestamp is older than the quote date — the latest source is the source-of-truth
        for that quote. ✗ means latest was overwritten by a later session, so use first-touch for that row.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Quote</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Date</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Contact</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Status</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Total</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Part Group</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Original (first-touch)</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Latest</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'center' }}>Latest&nbsp;pre-dates&nbsp;quote</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.quote_object_id} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)' }}>
                {r.quote_no || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}
              </td>
              <td style={{ padding: '8px 10px', color: 'var(--dso-text-dim)' }}>
                {r.created_at ? String(r.created_at).slice(0, 10) : '—'}
              </td>
              <td style={{ padding: '8px 10px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.email}>
                <div>{r.company || <span style={{ color: 'var(--dso-text-faint)' }}>(no company)</span>}</div>
                <div style={{ color: 'var(--dso-text-dim)', fontSize: 11 }}>{r.email}</div>
              </td>
              <td style={{ padding: '8px 10px' }}>{r.status || '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.total)}</td>
              <td style={{ padding: '8px 10px' }}>{r.parts_group || <span style={{ color: 'var(--dso-text-faint)' }}>(unmapped)</span>}</td>
              <td style={{ padding: '8px 10px' }}>
                <div>{r.original_source || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}</div>
                {r.original_campaign && <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.original_campaign}>{r.original_campaign}</div>}
              </td>
              <td style={{ padding: '8px 10px' }}>
                <div>{r.latest_source || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}</div>
                {r.latest_campaign && <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.latest_campaign}>{r.latest_campaign}</div>}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                {r.latest_predates_quote === true  ? <span style={{ color: '#34d399' }}>✓</span>
                : r.latest_predates_quote === false ? <span style={{ color: '#f87171' }}>✗</span>
                : <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Per-contact mismatches between HubSpot's first-touch analytics source and
// the customer's NetSuite `lead_source_name`. Each row is a candidate
// data-quality fix in one or the other system.
function LeadSourceReconciliationTable({ rows }) {
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No HubSpot↔NetSuite lead-source mismatches found. Either the integration
      is in agreement or no contacts have been bridged yet.
    </div>;
  }
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        {rows.length} contact{rows.length === 1 ? '' : 's'} where HubSpot's first-touch source
        differs from the matched NetSuite customer's `lead_source_name`. Pick a system of record
        and correct the other.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Contact</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>HubSpot Source</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>HubSpot Campaign</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>NetSuite Lead Source</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>NS Customer</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>NS Quote</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.contact_id} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.email}>
                <div>{[r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)'}</div>
                <div style={{ color: 'var(--dso-text-dim)', fontSize: 11 }}>{r.email}</div>
              </td>
              <td style={{ padding: '8px 10px' }}>{r.hs_source || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}</td>
              <td style={{ padding: '8px 10px', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.hs_campaign}>
                {r.hs_campaign || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}
              </td>
              <td style={{ padding: '8px 10px', color: '#f59e0b' }}>{r.ns_lead_source || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}</td>
              <td style={{ padding: '8px 10px' }}>{r.ns_entity || '—'}</td>
              <td style={{ padding: '8px 10px' }}>
                {r.latest_quote_no ? <span>{r.latest_quote_no} <span style={{ color: 'var(--dso-text-dim)', fontSize: 11 }}>({r.latest_quote_status})</span></span> : <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Shared click-to-sort helpers for the ROAS-tab tables. Nulls always sort
// last (so "—" ROAS rows sink); string columns use localeCompare.
function cmpSort(arr, getter, dir, isStr) {
  const d = dir === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    const av = getter(a), bv = getter(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return isStr ? d * String(av).localeCompare(String(bv)) : d * (av - bv);
  });
}
function SortTh({ id, label, align = 'right', sortKey, sortDir, onSort }) {
  const active = id === sortKey;
  return (
    <th onClick={() => onSort(id)} title="Sort"
      style={{ padding: '8px 10px', fontWeight: 600, textAlign: align, cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', color: active ? 'var(--dso-text)' : undefined }}>
      {label}{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
}
// Toggle helper: same key flips direction, new key resets (asc for strings, desc for numbers).
function useSort(defaultKey, defaultDir = 'desc') {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState(defaultDir);
  const onSort = (key, isStr = false) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(isStr ? 'asc' : 'desc'); }
  };
  return { sortKey, sortDir, onSort };
}

// Ads cost ÷ NetSuite revenue per part-group. Cost is allocated via the
// contact bridge (campaign → its leads → their quotes' record-level part
// groups) — no curated mappings. Surfaces part-groups that are either
// (a) over-invested (cost without revenue) or (b) revenue without spend
// (organic / non-Ads-driven part-groups).
const PG_GET = {
  part_group: r => (r.part_group || '').toLowerCase(),
  cost: r => r.cost || 0, quotes: r => r.quotes || 0, quotes_won: r => r.quotes_won || 0,
  revenue: r => r.revenue || 0, revenue_won: r => r.revenue_won || 0,
  revenue_paid: r => r.revenue_paid || 0, revenue_won_paid: r => r.revenue_won_paid || 0,
  roas: r => r.roas, roas_won: r => r.roas_won,
};
function PartGroupRoasTable({ rows }) {
  const { sortKey, sortDir, onSort } = useSort('revenue');
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No part-group ROAS yet. Needs Google Ads spend + quotes with part groups
      (cost is allocated to part groups via each campaign's own leads).
    </div>;
  }
  const sorted = cmpSort(rows, PG_GET[sortKey] || PG_GET.revenue, sortDir, sortKey === 'part_group');
  const totals = rows.reduce((acc, r) => {
    acc.cost             += r.cost || 0;
    acc.quotes           += r.quotes || 0;
    acc.quotes_won       += r.quotes_won || 0;
    acc.revenue          += r.revenue || 0;
    acc.revenue_won      += r.revenue_won || 0;
    acc.revenue_paid     += r.revenue_paid || 0;
    acc.revenue_won_paid += r.revenue_won_paid || 0;
    return acc;
  }, { cost: 0, quotes: 0, quotes_won: 0, revenue: 0, revenue_won: 0, revenue_paid: 0, revenue_won_paid: 0 });
  // Footer ROAS matches the row semantics — paid-attributed revenue ÷ cost.
  const totalRoas    = totals.cost > 0 ? totals.revenue_paid     / totals.cost : null;
  const totalRoasWon = totals.cost > 0 ? totals.revenue_won_paid / totals.cost : null;
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, flex: 1 }}>
          Revenue from `hubspot_netsuite_quotes.parts_group` (the record-level part group, direct from the quote).
          Cost is allocated via the contact bridge: each campaign's spend splits across the part groups its own leads' quotes fell under
          (by won-quote share; all-quote share when a campaign has no wins yet). Spend from campaigns whose leads have no quotes shows as <strong>(unattributed)</strong>.
          ROAS numerators are <strong>paid-attributed revenue only</strong> (Paid revenue ÷ cost, and paid won revenue ÷ cost) —
          "Revenue (all sources)" includes organic/direct/etc. and is context, not a return on the ad spend.
        </div>
        <ExportButton filename="part-group-roas.csv" rows={sorted.map(r => ({
          part_group: r.part_group, cost: r.cost, quotes: r.quotes, quotes_won: r.quotes_won,
          revenue_all_sources: r.revenue, revenue_won_all_sources: r.revenue_won,
          revenue_paid: r.revenue_paid, revenue_won_paid: r.revenue_won_paid,
          roas: r.roas, roas_won: r.roas_won,
        }))} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <SortTh id="part_group"       label="Part Group"           align="left" sortKey={sortKey} sortDir={sortDir} onSort={(k) => onSort(k, true)} />
            <SortTh id="cost"             label="Ad Cost"              sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="quotes"           label="Quotes"               sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="quotes_won"       label="Wins"                 sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue"          label="Revenue (all sources)" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue_won"      label="Revenue (won)"        sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue_paid"     label="Paid revenue"         sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue_won_paid" label="Paid won rev."        sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="roas"             label="ROAS"                 sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="roas_won"         label="ROAS (won)"           sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.part_group} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px' }}>{r.part_group || <span style={{ color: 'var(--dso-text-faint)' }}>(none)</span>}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.quotes)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.quotes_won)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue_won)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue_paid)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue_won_paid)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                {r.roas != null ? fmtRatio(r.roas) : '—'}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                {r.roas_won != null ? fmtRatio(r.roas_won) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--dso-rule)', fontWeight: 700 }}>
            <td style={{ padding: '10px', color: 'var(--dso-text-dim)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.cost)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.quotes)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.quotes_won)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue_won)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue_paid)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue_won_paid)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoas != null ? fmtRatio(totalRoas) : '—'}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoasWon != null ? fmtRatio(totalRoasWon) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// Campaign ROAS via the contact bridge: Google Ads spend per campaign vs the
// whole-order NetSuite revenue of the contacts that campaign acquired. Credits
// brand/catalog campaigns without splitting orders across part-groups.
const CAMP_GET = {
  campaign: r => (r.campaign || '').toLowerCase(),
  cost: r => r.cost || 0, leads: r => r.leads || 0, quotes: r => r.quotes || 0,
  revenue: r => r.revenue || 0, revenue_won: r => r.revenue_won || 0,
  roas: r => r.roas, roas_won: r => r.roas_won,
};
function CampaignRoasTable({ rows }) {
  const [q, setQ] = useState('');
  const [hideNoSpend, setHideNoSpend] = useState(false);
  const [hideNoRev, setHideNoRev] = useState(false);
  const { sortKey, sortDir, onSort } = useSort('cost');
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No campaign ROAS yet. Needs Google Ads spend + paid-search contacts with quotes.
    </div>;
  }
  const needle = q.trim().toLowerCase();
  const filtered = rows.filter(r =>
    (!needle || (r.campaign || '').toLowerCase().includes(needle)) &&
    (!hideNoSpend || (r.cost || 0) > 0) &&
    (!hideNoRev || (r.revenue || 0) > 0)
  );
  const sorted = cmpSort(filtered, CAMP_GET[sortKey] || CAMP_GET.cost, sortDir, sortKey === 'campaign');
  const totals = filtered.reduce((acc, r) => {
    acc.cost += r.cost || 0; acc.leads += r.leads || 0; acc.quotes += r.quotes || 0;
    acc.revenue += r.revenue || 0; acc.revenue_won += r.revenue_won || 0;
    return acc;
  }, { cost: 0, leads: 0, quotes: 0, revenue: 0, revenue_won: 0 });
  const totalRoas    = totals.cost > 0 ? totals.revenue     / totals.cost : null;
  const totalRoasWon = totals.cost > 0 ? totals.revenue_won / totals.cost : null;
  const inputStyle = { background: 'var(--dso-bg, #0f172a)', border: '1px solid var(--dso-rule)', borderRadius: 3, color: 'var(--dso-text)', fontSize: 12, padding: '4px 8px' };
  const chk = (checked, onChange, label) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--dso-text-dim)', fontSize: 11, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /> {label}
    </label>
  );
  return (
    <div style={{ background: 'var(--dso-surface)', borderRadius: 4, padding: '14px 16px', border: '1px solid var(--dso-rule)', overflowX: 'auto' }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        Google Ads spend per campaign vs the <strong>whole-order</strong> NetSuite revenue of the contacts that campaign acquired
        (paid-search contact's <code>hs_analytics_source_data_1</code> = campaign, contact → quotes by email). Orders aren't split across part-groups,
        so brand / catalog campaigns get credited for all the revenue their leads drove. Paid-search only, first-touch.
        The grey line under each campaign shows the record-level part groups (custbody4) those orders fell under, by revenue share — the campaign→part-group link, no order splitting.
        "via domain" counts quotes matched through the corporate-domain fallback (quote email's company domain ↔ contact domain)
        rather than an exact email match — same company, lower confidence.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter campaigns…" style={{ ...inputStyle, minWidth: 200 }} />
        {chk(hideNoSpend, setHideNoSpend, 'Hide $0 ad spend')}
        {chk(hideNoRev, setHideNoRev, 'Hide $0 revenue')}
        <span style={{ color: 'var(--dso-text-faint)', fontSize: 11 }}>{filtered.length} of {rows.length}</span>
        <ExportButton filename="campaign-roas.csv" rows={sorted.map(r => ({
          campaign: r.campaign, cost: r.cost, leads: r.leads, quotes: r.quotes,
          quotes_domain_matched: r.quotes_domain_matched,
          revenue: r.revenue, revenue_won: r.revenue_won, roas: r.roas, roas_won: r.roas_won,
        }))} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <SortTh id="campaign"    label="Campaign"      align="left" sortKey={sortKey} sortDir={sortDir} onSort={(k) => onSort(k, true)} />
            <SortTh id="cost"        label="Ad Cost"       sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="leads"       label="Leads"         sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="quotes"      label="Quotes"        sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue"     label="Revenue (all)" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue_won" label="Revenue (won)" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="roas"        label="ROAS"          sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="roas_won"    label="ROAS (won)"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            // Top record-level part groups this campaign's leads' orders fell
            // under (custbody4 / quote.parts_group) — the campaign→part-group
            // link, by revenue share. Shown as a compact caption, no order splitting.
            const pgTotal = (r.part_groups || []).reduce((s, g) => s + (g.revenue || 0), 0);
            const pgCaption = (r.part_groups || [])
              .slice(0, 4)
              .filter(g => g.revenue > 0)
              .map(g => `${g.part_group} ${pgTotal > 0 ? Math.round((g.revenue / pgTotal) * 100) : 0}%`)
              .join('  ·  ');
            return (
            <tr key={r.campaign} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 360 }} title={r.campaign}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.campaign}{r.no_ad_spend ? <span style={{ color: 'var(--dso-text-faint)' }}> (no ad spend)</span> : ''}
                </div>
                {pgCaption && (
                  <div style={{ color: 'var(--dso-text-faint)', fontSize: 10.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pgCaption}>
                    {pgCaption}
                  </div>
                )}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.leads)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {fmtNum(r.quotes)}
                {(r.quotes_domain_matched || 0) > 0 && (
                  <span style={{ color: 'var(--dso-text-faint)', fontSize: 10, marginLeft: 4 }}>
                    ({fmtNum(r.quotes_domain_matched)} via domain)
                  </span>
                )}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue_won)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.roas != null ? fmtRatio(r.roas) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.roas_won != null ? fmtRatio(r.roas_won) : '—'}</td>
            </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--dso-rule)', fontWeight: 700 }}>
            <td style={{ padding: '10px', color: 'var(--dso-text-dim)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.cost)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.leads)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtNum(totals.quotes)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue_won)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoas != null ? fmtRatio(totalRoas) : '—'}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoasWon != null ? fmtRatio(totalRoasWon) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// Cohort ROAS: spend in the window vs the LIFETIME revenue of the leads
// acquired in that window — spend and revenue belong to the same cohort,
// unlike the windowed campaign table where a quote can land in the window
// from a lead acquired long before it.
const COHORT_GET = {
  campaign: r => (r.campaign || '').toLowerCase(),
  cost: r => r.cost || 0, leads: r => r.leads || 0,
  converting_leads: r => r.converting_leads || 0, quotes: r => r.quotes || 0,
  revenue: r => r.revenue || 0, revenue_won: r => r.revenue_won || 0,
  roas: r => r.roas, roas_won: r => r.roas_won,
  cost_per_lead: r => r.cost_per_lead, avg_days_to_quote: r => r.avg_days_to_quote,
};
function CohortRoasTable({ rows }) {
  const { sortKey, sortDir, onSort } = useSort('cost');
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No cohort data in window. Needs Google Ads spend + paid-search leads created in the window.
    </div>;
  }
  const sorted = cmpSort(rows, COHORT_GET[sortKey] || COHORT_GET.cost, sortDir, sortKey === 'campaign');
  return (
    <div style={{ background: 'var(--dso-surface)', borderRadius: 4, padding: '14px 16px', border: '1px solid var(--dso-rule)', overflowX: 'auto' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, flex: 1 }}>
          Spend in window vs the <strong>lifetime</strong> revenue of leads acquired in that window — unlike the
          windowed table above, spend and revenue belong to the same cohort.
        </div>
        <ExportButton filename="cohort-roas.csv" rows={sorted.map(r => ({
          campaign: r.campaign, cost: r.cost, leads: r.leads, converting_leads: r.converting_leads,
          quotes: r.quotes, revenue: r.revenue, revenue_won: r.revenue_won,
          roas: r.roas, roas_won: r.roas_won, cost_per_lead: r.cost_per_lead,
          avg_days_to_quote: r.avg_days_to_quote,
        }))} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <SortTh id="campaign"          label="Campaign"     align="left" sortKey={sortKey} sortDir={sortDir} onSort={(k) => onSort(k, true)} />
            <SortTh id="cost"              label="Cost"         sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="leads"             label="Leads"        sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="converting_leads"  label="Conv. leads"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="quotes"            label="Quotes"       sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue"           label="Revenue"      sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="revenue_won"       label="Won revenue"  sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="roas"              label="ROAS"         sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="roas_won"          label="Won ROAS"     sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="cost_per_lead"     label="Cost/lead"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortTh id="avg_days_to_quote" label="Avg days→quote" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.campaign} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.campaign}>{r.campaign}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.leads)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.converting_leads)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.quotes)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue_won)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.roas != null ? fmtRatio(r.roas) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.roas_won != null ? fmtRatio(r.roas_won) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.cost_per_lead != null ? fmtMoney(r.cost_per_lead) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.avg_days_to_quote != null ? Math.round(r.avg_days_to_quote) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LagHistogramTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{
      background: '#0f172a', border: '1px solid #64748b', borderRadius: 6,
      padding: '6px 10px', fontSize: 11, color: '#f8fafc', lineHeight: 1.5,
    }}>
      <div><strong>{p.bucket}</strong></div>
      <div>{fmtNum(p.quotes)} quotes · {fmtMoney(p.revenue)}</div>
    </div>
  );
}

// Lead→quote lag distribution. Shows how long paid (or all) leads take to
// produce a quote — the reason windowed ROAS understates recent spend.
function QuoteLagHistogram({ data, paidOnly, onPaidOnlyChange }) {
  const buckets = [...(data?.buckets || [])].sort((a, b) => (a.bucket_order ?? 0) - (b.bucket_order ?? 0));
  return (
    <div style={{ background: 'var(--dso-surface)', borderRadius: 4, padding: '14px 16px', border: '1px solid var(--dso-rule)', marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, flex: 1 }}>
          Lead-to-quote lag distribution
          {data?.quotes != null && <> — {fmtNum(data.quotes)} quotes</>}
          {data?.median_days != null && <>, median <strong>{Math.round(data.median_days)}d</strong></>}
          {data?.avg_days != null && <>, avg <strong>{Math.round(data.avg_days)}d</strong></>}.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--dso-text-dim)', fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={paidOnly} onChange={e => onPaidOnlyChange(e.target.checked)} /> Paid leads only
        </label>
      </div>
      {buckets.length === 0 ? (
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '10px 0' }}>No lag data in window.</div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={buckets} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--dso-rule)" strokeOpacity={0.5} vertical={false} />
            <XAxis dataKey="bucket" tick={{ fill: 'var(--dso-text-dim)', fontSize: 10 }}
              axisLine={{ stroke: 'var(--dso-rule)' }} tickLine={false} interval={0} />
            <YAxis tickFormatter={fmtNum} tick={{ fill: 'var(--dso-text-dim)', fontSize: 10 }}
              axisLine={false} tickLine={false} width={45} />
            <Tooltip content={<LagHistogramTooltip />} cursor={{ fill: '#0f172a', opacity: 0.3 }} />
            <Bar dataKey="quotes" fill="#a8d8e8" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function PagePerformanceTable({ rows, windowEnd }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No GSC page snapshot yet. Run a GSC fetch first.
    </div>;
  }
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        Latest GSC snapshot (window ending {windowEnd}) joined to GA4 over the same 28 days.
        Engagement gap = high CTR + low engagement → SERP click bait.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Page</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GSC Clicks</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Impr.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>CTR</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Avg Pos</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Sessions</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Engagement</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Conv.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.path + i} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.full_url}>
                {r.path || '/'}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.gsc_clicks)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.gsc_impressions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.gsc_ctr != null ? fmtPct(r.gsc_ctr) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.gsc_position != null ? r.gsc_position.toFixed(1) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_sessions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{r.ga4_engagement_rate != null ? fmtPct(r.ga4_engagement_rate) : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.ga4_conversions)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.ga4_revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Default open/closed per section. Primary ROAS views open; secondary
// drill-downs collapsed so the (long) tab lands compact.
const SECTION_DEFAULTS = {
  'rev-source':     true,
  'partgroup-roas': true,
  'campaign-roas':  true,
  'cohort-roas':    true,
  'quote-attr':     false,
  'lead-recon':     false,
  'campaign-roi':   false,
  'page-perf':      false,
  'cr-trackers':    false,
  'cr-texts':       false,
};

// A section with a clickable header that collapses its body. `open`/`onToggle`
// are lifted to the parent so Expand-all / Collapse-all can drive every one.
function CollapsibleSection({ title, open, onToggle, headerExtra = null, children }) {
  return (
    <section style={{ marginBottom: open ? 28 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: open ? 10 : 0, flexWrap: 'wrap' }}>
        <button
          onClick={onToggle}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
        >
          <span style={{ fontSize: 10, color: 'var(--dso-text-faint)', width: 10, display: 'inline-block' }}>{open ? '▾' : '▸'}</span>
          <h3 style={{
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 14, fontWeight: 600, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--dso-text-dim)', margin: 0,
          }}>{title}</h3>
        </button>
        {open && headerExtra}
      </div>
      {open && children}
    </section>
  );
}

export default function CrossSourcePage() {
  const [range, setRange] = useLocalStorageState('range', '6m');
  const [selectedYears, setSelectedYears] = useLocalStorageState('years', []);
  const [campaigns, setCampaigns] = useState(null);
  const [pages, setPages] = useState(null);
  const [pageWindowEnd, setPageWindowEnd] = useState(null);
  const [trackers, setTrackers] = useState(null);
  const [texts, setTexts] = useState(null);
  const [hsAttribution, setHsAttribution] = useState(null);
  const [leadReconciliation, setLeadReconciliation] = useState(null);
  const [partGroupRoas, setPartGroupRoas] = useState(null);
  const [campaignRoas, setCampaignRoas] = useState(null);
  const [cohortRoas, setCohortRoas] = useState(null);
  const [lagHist, setLagHist] = useState(null);
  const [lagPaidOnly, setLagPaidOnly] = useState(false);
  const [quoteAttribution, setQuoteAttribution] = useState(null);
  // 'first' = hs_analytics_source (original / first-touch).
  // 'latest' = hs_latest_source (most recent session source, may post-date quote).
  const [attrLens, setAttrLens] = useLocalStorageState('attrLens', 'first');
  // Per-section collapse state (persisted). Only user overrides are stored;
  // anything absent falls back to SECTION_DEFAULTS.
  const [secOpen, setSecOpen] = useLocalStorageState('roasSections', {});
  const isOpen = (id) => secOpen[id] ?? SECTION_DEFAULTS[id] ?? true;
  const toggleSec = (id) => setSecOpen({ ...secOpen, [id]: !isOpen(id) });
  const setAllSections = (v) => setSecOpen(Object.fromEntries(Object.keys(SECTION_DEFAULTS).map(k => [k, v])));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Years available depend on Ads + GA4 data extents — fetch a probe call
  // first so we can populate the YearsDropdown with real options.
  const [availableYears, setAvailableYears] = useState([]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    const qs = params.toString();
    // Build the attribution endpoint with the chosen lens. Quote drill-down
    // doesn't take a lens because each row carries both sources.
    const hsParams = new URLSearchParams(params);
    hsParams.set('lens', ['latest', 'netsuite'].includes(attrLens) ? attrLens : 'first');
    const hsQs = hsParams.toString();
    const qaParams = new URLSearchParams(params);
    qaParams.set('limit', '500');
    Promise.all([
      fetch(`/api/insights/campaign-roi${qs ? '?' + qs : ''}`, { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/insights/page-performance?limit=100', { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      // Trackers + texts are not date-windowed — fetch once on mount and
      // re-fetch when the window changes is unnecessary, but Promise.all
      // here keeps the loading state coherent and the cost is trivial.
      fetch('/api/callrail-trackers', { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/callrail-text-messages?limit=50', { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      // HubSpot → NetSuite attribution lanes — date-windowed alongside Ads/GA4.
      fetch(`/api/insights/hubspot-netsuite-attribution?${hsQs}`, { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/insights/lead-source-reconciliation?limit=100', { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/insights/part-group-roas${qs ? '?' + qs : ''}`, { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/insights/quote-attribution?${qaParams.toString()}`, { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/insights/campaign-roas${qs ? '?' + qs : ''}`, { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/insights/campaign-roas-cohort${qs ? '?' + qs : ''}`, { signal: ac.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([c, p, t, m, hs, rec, pg, qa, cr, coh]) => {
        if (ac.signal.aborted) return;
        setCampaigns(c?.campaigns || []);
        setPages(p?.pages || []);
        setPageWindowEnd(p?.pages?.[0]?.window_end_date || null);
        setTrackers(t?.trackers || []);
        setTexts(m?.messages || []);
        setHsAttribution(hs?.sources || []);
        setLeadReconciliation(rec?.mismatches || []);
        setPartGroupRoas(pg?.part_groups || []);
        setQuoteAttribution(qa?.quotes || []);
        setCampaignRoas(cr?.campaigns || []);
        setCohortRoas(coh?.campaigns || []);
        if (!c && !p) setError('Cross-source endpoints returned no data. Are GA4 and Ads/GSC backfilled?');
        else setError(null);
      })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [cutoff, selectedYears, attrLens]);

  // Lead→quote lag histogram — separate effect because the paid-only toggle
  // refetches it without touching everything else.
  useEffect(() => {
    const ac = new AbortController();
    const params = new URLSearchParams();
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    if (lagPaidOnly) params.set('paid_only', 'true');
    fetch(`/api/insights/quote-lag-histogram?${params.toString()}`, { signal: ac.signal })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!ac.signal.aborted) setLagHist(j); })
      .catch(() => {});
    return () => ac.abort();
  }, [cutoff, selectedYears, lagPaidOnly]);

  // Year options come from the real data extents; fall back to the last five
  // calendar years if the meta endpoint isn't available.
  useEffect(() => {
    fetch('/api/meta/date-range')
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const min = Number(String(j?.min_date || '').slice(0, 4));
        const max = Number(String(j?.max_date || '').slice(0, 4));
        if (!min || !max || min > max) throw new Error('no date range');
        const years = [];
        for (let y = min; y <= max; y++) years.push(String(y));
        setAvailableYears(years);
      })
      .catch(() => {
        const now = new Date().getFullYear();
        setAvailableYears([now - 4, now - 3, now - 2, now - 1, now].map(String));
      });
  }, []);

  // Exec one-glance rollup of the campaign-ROAS response (item tiles below
  // the header). Same cohort semantics as the campaign table.
  const execSummary = useMemo(() => {
    if (!campaignRoas || campaignRoas.length === 0) return null;
    const t = campaignRoas.reduce((acc, r) => {
      acc.cost += r.cost || 0;
      acc.revenue += r.revenue || 0;
      acc.revenueWon += r.revenue_won || 0;
      acc.quotes += r.quotes || 0;
      acc.domainMatched += r.quotes_domain_matched || 0;
      if ((r.quotes || 0) === 0) acc.unattributedSpend += r.cost || 0;
      return acc;
    }, { cost: 0, revenue: 0, revenueWon: 0, quotes: 0, domainMatched: 0, unattributedSpend: 0 });
    return {
      ...t,
      roasWon: t.cost > 0 ? t.revenueWon / t.cost : null,
      roasAll: t.cost > 0 ? t.revenue / t.cost : null,
      pctDomainMatched: t.quotes > 0 ? t.domainMatched / t.quotes : null,
    };
  }, [campaignRoas]);

  const hasAnyData = campaigns != null || campaignRoas != null;

  return (
    <div style={{ padding: '20px 24px', color: 'var(--dso-text)' }}>
      <UpdatingPill show={loading && hasAnyData} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{
            color: 'var(--dso-text-dim)',
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}>Attribution &amp; ROAS</div>
          <div style={{
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
          }}>NetSuite revenue by lead source + part-group ROAS</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <RangeDropdown range={range} onChange={setRange} disabled={selectedYears.length > 0} />
          <YearsDropdown available={availableYears} selected={selectedYears} onChange={setSelectedYears} />
          {(selectedYears.length > 0 || range !== '6m') && (
            <button
              onClick={() => { setRange('6m'); setSelectedYears([]); clearAllFilters(); }}
              style={{
                background: 'transparent',
                border: '1px solid var(--dso-rule)',
                color: 'var(--dso-text-dim)',
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
                borderRadius: 3,
              }}
            >Clear</button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ color: '#f87171', fontSize: 13, marginBottom: 16 }}>Error: {error}</div>
      )}
      {loading && !hasAnyData && (
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, marginBottom: 16 }}>Loading…</div>
      )}

      {/* Exec one-glance rollup of the campaign-ROAS response. */}
      {execSummary && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <StatCard label="Total spend" value={fmtMoney(execSummary.cost)} sub="Google Ads, in window" />
          <StatCard label="Paid-attributed revenue" value={fmtMoney(execSummary.revenue)} sub="all quotes of paid leads" />
          <StatCard label="Won revenue" value={fmtMoney(execSummary.revenueWon)} sub="closed-won quotes" />
          <StatCard label="Blended ROAS (won)" value={execSummary.roasWon != null ? fmtRatio(execSummary.roasWon) : '—'}
            sub={`all-quote: ${execSummary.roasAll != null ? fmtRatio(execSummary.roasAll) : '—'}`} />
          <StatCard label="Unattributed spend" value={fmtMoney(execSummary.unattributedSpend)} sub="campaigns with 0 quotes" />
          <StatCard label="Quotes domain-matched" value={execSummary.pctDomainMatched != null ? fmtPct(execSummary.pctDomainMatched) : '—'}
            sub={`${fmtNum(execSummary.domainMatched)} of ${fmtNum(execSummary.quotes)} quotes`} />
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, marginBottom: 12 }}>
        <button onClick={() => setAllSections(true)} style={{ background: 'none', border: 'none', color: 'var(--dso-text-dim)', fontSize: 11, cursor: 'pointer', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Expand all</button>
        <button onClick={() => setAllSections(false)} style={{ background: 'none', border: 'none', color: 'var(--dso-text-dim)', fontSize: 11, cursor: 'pointer', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Collapse all</button>
      </div>

      <CollapsibleSection title="NetSuite Revenue by HubSpot Traffic Source" open={isOpen('rev-source')} onToggle={() => toggleSec('rev-source')}
        headerExtra={<AttrLensToggle value={attrLens} onChange={setAttrLens} />}>
        <HubSpotAttributionTable rows={hsAttribution} lens={attrLens} />
      </CollapsibleSection>

      <CollapsibleSection title="Part-Group ROAS — Ads Cost ÷ NetSuite Revenue (via HubSpot)" open={isOpen('partgroup-roas')} onToggle={() => toggleSec('partgroup-roas')}>
        <PartGroupRoasTable rows={partGroupRoas} />
      </CollapsibleSection>

      <CollapsibleSection title="Campaign ROAS — Ads Cost ÷ Revenue of the Campaign's Leads" open={isOpen('campaign-roas')} onToggle={() => toggleSec('campaign-roas')}>
        <CampaignRoasTable rows={campaignRoas} />
      </CollapsibleSection>

      <CollapsibleSection title="Cohort ROAS (lead-month cohorts)" open={isOpen('cohort-roas')} onToggle={() => toggleSec('cohort-roas')}>
        <CohortRoasTable rows={cohortRoas} />
        <QuoteLagHistogram data={lagHist} paidOnly={lagPaidOnly} onPaidOnlyChange={setLagPaidOnly} />
      </CollapsibleSection>

      <CollapsibleSection title="Per-Quote Attribution Drill-Down" open={isOpen('quote-attr')} onToggle={() => toggleSec('quote-attr')}>
        <QuoteAttributionTable rows={quoteAttribution} />
      </CollapsibleSection>

      <CollapsibleSection title="Lead-Source Reconciliation — HubSpot vs NetSuite" open={isOpen('lead-recon')} onToggle={() => toggleSec('lead-recon')}>
        <LeadSourceReconciliationTable rows={leadReconciliation} />
      </CollapsibleSection>

      <CollapsibleSection title="Campaign ROI — Google Ads × GA4" open={isOpen('campaign-roi')} onToggle={() => toggleSec('campaign-roi')}>
        <CampaignRoiTable rows={campaigns} />
      </CollapsibleSection>

      <CollapsibleSection title="Page Performance — GSC × GA4" open={isOpen('page-perf')} onToggle={() => toggleSec('page-perf')}>
        <PagePerformanceTable rows={pages} windowEnd={pageWindowEnd} />
      </CollapsibleSection>

      {trackers && trackers.length > 0 && (
        <CollapsibleSection title="CallRail Trackers" open={isOpen('cr-trackers')} onToggle={() => toggleSec('cr-trackers')}>
          <TrackersTable rows={trackers} />
        </CollapsibleSection>
      )}

      {texts && texts.length > 0 && (
        <CollapsibleSection title="Recent Text Conversations" open={isOpen('cr-texts')} onToggle={() => toggleSec('cr-texts')}>
          <TextsTable rows={texts} />
        </CollapsibleSection>
      )}

    </div>
  );
}

// CallRail trackers — config showing which tracking number routes which
// campaign. Useful diagnostic for "is this number set up correctly?"
// Status of 'disabled' is rendered dimmed.
function TrackersTable({ rows }) {
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        {rows.length} tracker{rows.length === 1 ? '' : 's'} configured. Tracking numbers come from CallRail; campaign attribution is set per-tracker in the CallRail UI.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Name</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Type</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Status</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Source</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Campaign</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Tracking #</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Forwards to</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const numbers = Array.isArray(t.tracking_numbers) ? t.tracking_numbers : [];
            const dim = t.status && t.status !== 'active';
            return (
              <tr key={t.id} style={{ borderTop: '1px solid var(--dso-rule)', opacity: dim ? 0.55 : 1 }}>
                <td style={{ padding: '8px 10px', fontWeight: 600, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>{t.name || <span style={{ color: 'var(--dso-text-faint)' }}>(unnamed)</span>}</td>
                <td style={{ padding: '8px 10px', color: 'var(--dso-text-dim)' }}>{t.type || '—'}</td>
                <td style={{ padding: '8px 10px' }}>{t.status || '—'}</td>
                <td style={{ padding: '8px 10px', color: 'var(--dso-text-dim)' }}>{t.source_name || t.source || '—'}</td>
                <td style={{ padding: '8px 10px' }}>{t.campaign_name || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)' }}>{numbers.length > 0 ? numbers.join(', ') : '—'}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)', color: 'var(--dso-text-dim)' }}>{t.destination_number || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Recent text-message conversations. CallRail surfaces one row per
// conversation (the underlying messages live in raw on the server).
function TextsTable({ rows }) {
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        {rows.length} most-recent conversation{rows.length === 1 ? '' : 's'}.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Last activity</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Customer</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Phone</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Tracking #</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>State</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Lead Status</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Source</th>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Campaign</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const ts = m.last_message_time
              ? new Date(m.last_message_time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
              : '—';
            return (
              <tr key={m.id} style={{ borderTop: '1px solid var(--dso-rule)' }}>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--dso-text-dim)' }}>{ts}</td>
                <td style={{ padding: '8px 10px' }}>{m.customer_name || <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)' }}>{m.customer_phone_number || '—'}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)', color: 'var(--dso-text-dim)' }}>{m.tracking_phone_number || '—'}</td>
                <td style={{ padding: '8px 10px' }}>{m.state || '—'}</td>
                <td style={{ padding: '8px 10px' }}>{m.lead_status || '—'}</td>
                <td style={{ padding: '8px 10px', color: 'var(--dso-text-dim)' }}>{m.source || '—'}</td>
                <td style={{ padding: '8px 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.campaign}>{m.campaign || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
