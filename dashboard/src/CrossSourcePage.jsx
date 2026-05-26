import React, { useState, useEffect, useMemo } from 'react';
import { fmtNum, fmtMoney, fmtPct, fmtRatio } from './DashboardView';
import {
  RELATIVE_RANGES, RangeDropdown, YearsDropdown,
  useLocalStorageState, clearAllFilters,
} from './FilterControls';

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
  const totalRoas = totals.cost > 0 ? totals.ga4_revenue / totals.cost : null;
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
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Campaign</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Cost</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Ad Clicks</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Sessions</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Sess/Click</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Conv.</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>GA4 Revenue</th>
            {anyCalls && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', borderLeft: '1px solid var(--dso-rule)', color: '#a78bfa' }}>Calls</th>}
            {anyCalls && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', color: '#a78bfa' }}>Answered</th>}
            {anyCalls && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', color: '#a78bfa' }}>$/Call</th>}
            {anyForms && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', borderLeft: '1px solid var(--dso-rule)', color: '#34d399' }}>Forms</th>}
            {anyForms && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', color: '#34d399' }}>$/Form</th>}
            {(anyCalls || anyForms) && <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right', borderLeft: '1px solid var(--dso-rule)' }}>$/Lead</th>}
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>CPA</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>ROAS</th>
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
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{r.roas != null ? fmtRatio(r.roas) : '—'}</td>
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
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoas != null ? fmtRatio(totalRoas) : '—'}</td>
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
function HubSpotAttributionTable({ rows }) {
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No HubSpot↔NetSuite attribution joined yet. Confirm `hubspot_contacts` has rows and
      either `netsuite_quote_number` or `email_normalized` matches a NetSuite record.
    </div>;
  }
  const totals = rows.reduce((acc, r) => {
    acc.contacts        += r.contacts || 0;
    acc.quotes          += r.quotes   || 0;
    acc.quotes_primary  += r.quotes_primary  || 0;
    acc.quotes_fallback += r.quotes_fallback || 0;
    acc.revenue         += r.revenue  || 0;
    acc.revenue_primary += r.revenue_primary  || 0;
    acc.revenue_fallback+= r.revenue_fallback || 0;
    acc.wins            += r.wins     || 0;
    acc.revenue_won     += r.revenue_won || 0;
    return acc;
  }, { contacts: 0, quotes: 0, quotes_primary: 0, quotes_fallback: 0, revenue: 0,
       revenue_primary: 0, revenue_fallback: 0, wins: 0, revenue_won: 0 });
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        NetSuite quote totals attributed to HubSpot's `hs_analytics_source` first-touch bucket.
        Primary lane joins on quote_number; fallback uses email-normalized customer match.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>HubSpot Source</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Contacts</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Quotes</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Primary / Fallback</th>
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
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtNum(r.quotes)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--dso-text-dim)', fontSize: 11 }}>
                {fmtNum(r.quotes_primary)} / {fmtNum(r.quotes_fallback)}
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
              {fmtNum(totals.quotes_primary)} / {fmtNum(totals.quotes_fallback)}
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
                {r.netsuite_quote_number ? <span>{r.netsuite_quote_number} <span style={{ color: 'var(--dso-text-dim)', fontSize: 11 }}>({r.netsuite_quote_status})</span></span> : <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Ads cost ÷ NetSuite revenue per part-group, attributed via HubSpot's
// first-touch campaign + the curated campaign→part_group mappings. Surfaces
// part-groups that are either (a) over-invested (cost without revenue) or
// (b) revenue without spend (organic / non-Ads-driven part-groups).
function PartGroupRoasTable({ rows }) {
  if (!rows) return null;
  if (rows.length === 0) {
    return <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, padding: '20px 0' }}>
      No part-group ROAS yet. Add some campaign→part-group mappings in the
      Part-Group Mappings section below to populate this table.
    </div>;
  }
  const totals = rows.reduce((acc, r) => {
    acc.cost              += r.cost || 0;
    acc.revenue           += r.revenue || 0;
    acc.revenue_primary   += r.revenue_primary || 0;
    acc.revenue_fallback  += r.revenue_fallback || 0;
    acc.quotes_primary    += r.quotes_primary || 0;
    acc.quotes_fallback   += r.quotes_fallback || 0;
    return acc;
  }, { cost: 0, revenue: 0, revenue_primary: 0, revenue_fallback: 0, quotes_primary: 0, quotes_fallback: 0 });
  const totalRoas = totals.cost > 0 ? totals.revenue / totals.cost : null;
  return (
    <div style={{
      background: 'var(--dso-surface)',
      borderRadius: 4,
      padding: '14px 16px',
      border: '1px solid var(--dso-rule)',
      overflowX: 'auto',
    }}>
      <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 8 }}>
        Cost from Google Ads. Revenue is the contact's NetSuite quote totals, joined via
        HubSpot's first-touch campaign → curated `part_group_mappings`. ROAS is unitless ratio.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
        <thead>
          <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            <th style={{ padding: '8px 10px', fontWeight: 600 }}>Part Group</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Ad Cost</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Quotes (P / F)</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Revenue</th>
            <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.part_group} style={{ borderTop: '1px solid var(--dso-rule)' }}>
              <td style={{ padding: '8px 10px' }}>{r.part_group || <span style={{ color: 'var(--dso-text-faint)' }}>(unmapped)</span>}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.cost)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--dso-text-dim)', fontSize: 11 }}>
                {fmtNum(r.quotes_primary)} / {fmtNum(r.quotes_fallback)}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(r.revenue)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                {r.roas != null ? fmtRatio(r.roas) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--dso-rule)', fontWeight: 700 }}>
            <td style={{ padding: '10px', color: 'var(--dso-text-dim)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Total</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.cost)}</td>
            <td style={{ padding: '10px', textAlign: 'right', color: 'var(--dso-text-dim)', fontSize: 11 }}>
              {fmtNum(totals.quotes_primary)} / {fmtNum(totals.quotes_fallback)}
            </td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{fmtMoney(totals.revenue)}</td>
            <td style={{ padding: '10px', textAlign: 'right' }}>{totalRoas != null ? fmtRatio(totalRoas) : '—'}</td>
          </tr>
        </tfoot>
      </table>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumped after any mapping mutation so both the suggester and the
  // editable mappings table re-fetch.
  const [mappingsVersion, setMappingsVersion] = useState(0);

  // Years available depend on Ads + GA4 data extents — fetch a probe call
  // first so we can populate the YearsDropdown with real options.
  const [availableYears, setAvailableYears] = useState([]);

  const cutoff = useMemo(() => rangeCutoff(range, selectedYears), [range, selectedYears]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedYears.length > 0) {
      params.set('since', `${selectedYears[0]}-01-01`);
      params.set('until', `${selectedYears[selectedYears.length - 1]}-12-31`);
    } else if (cutoff) {
      params.set('since', cutoff);
    }
    const qs = params.toString();
    Promise.all([
      fetch(`/api/insights/campaign-roi${qs ? '?' + qs : ''}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/insights/page-performance?limit=100').then(r => r.ok ? r.json() : null).catch(() => null),
      // Trackers + texts are not date-windowed — fetch once on mount and
      // re-fetch when the window changes is unnecessary, but Promise.all
      // here keeps the loading state coherent and the cost is trivial.
      fetch('/api/callrail-trackers').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/callrail-text-messages?limit=50').then(r => r.ok ? r.json() : null).catch(() => null),
      // HubSpot → NetSuite attribution lanes — date-windowed alongside Ads/GA4.
      fetch(`/api/insights/hubspot-netsuite-attribution${qs ? '?' + qs : ''}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/insights/lead-source-reconciliation?limit=100').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/insights/part-group-roas${qs ? '?' + qs : ''}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([c, p, t, m, hs, rec, pg]) => {
        setCampaigns(c?.campaigns || []);
        setPages(p?.pages || []);
        setPageWindowEnd(p?.pages?.[0]?.window_end_date || null);
        setTrackers(t?.trackers || []);
        setTexts(m?.messages || []);
        setHsAttribution(hs?.sources || []);
        setLeadReconciliation(rec?.mismatches || []);
        setPartGroupRoas(pg?.part_groups || []);
        if (!c && !p) setError('Cross-source endpoints returned no data. Are GA4 and Ads/GSC backfilled?');
        else setError(null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [cutoff, selectedYears]);

  // Probe years from the campaign rows once we have any.
  useEffect(() => {
    if (!campaigns) return;
    // Campaign-level rows are aggregated and don't have date — just fall back
    // to the last few years as filter options. Better than nothing; can wire
    // up a dedicated /api/insights/years endpoint later if useful.
    const now = new Date().getFullYear();
    setAvailableYears([now - 4, now - 3, now - 2, now - 1, now].map(String));
  }, [campaigns]);

  return (
    <div style={{ padding: '20px 24px', color: 'var(--dso-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{
            color: 'var(--dso-text-dim)',
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}>Cross-Source Insights</div>
          <div style={{
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: '-0.01em',
          }}>Where the data lines up</div>
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
      {loading && (
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, marginBottom: 16 }}>Loading…</div>
      )}

      <section style={{ marginBottom: 28 }}>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>NetSuite Revenue by HubSpot Lead Source</h3>
        <HubSpotAttributionTable rows={hsAttribution} />
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>Part-Group ROAS — Ads Cost ÷ NetSuite Revenue (via HubSpot)</h3>
        <PartGroupRoasTable rows={partGroupRoas} />
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>Lead-Source Reconciliation — HubSpot vs NetSuite</h3>
        <LeadSourceReconciliationTable rows={leadReconciliation} />
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>Campaign ROI — Google Ads × GA4</h3>
        <CampaignRoiTable rows={campaigns} />
      </section>

      <section style={{ marginBottom: 28 }}>
        <h3 style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--dso-text-dim)',
          marginBottom: 10,
        }}>Page Performance — GSC × GA4</h3>
        <PagePerformanceTable rows={pages} windowEnd={pageWindowEnd} />
      </section>

      {trackers && trackers.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h3 style={{
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--dso-text-dim)',
            marginBottom: 10,
          }}>CallRail Trackers</h3>
          <TrackersTable rows={trackers} />
        </section>
      )}

      {texts && texts.length > 0 && (
        <section style={{ marginBottom: 28 }}>
          <h3 style={{
            fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--dso-text-dim)',
            marginBottom: 10,
          }}>Recent Text Conversations</h3>
          <TextsTable rows={texts} />
        </section>
      )}

      <CampaignMappingSuggester
        version={mappingsVersion}
        onChange={() => setMappingsVersion(v => v + 1)}
      />
      <PartGroupMappingsAdmin reloadKey={mappingsVersion} />
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

// ─── Part-group mapping admin ───────────────────────────────────────
//
// Curated table linking campaign names / GSC queries / page URLs to a
// part_group. Surfaces nothing on its own — a downstream attribution
// view (TBD) will use these rules to roll up campaign spend, search
// impressions, and page traffic to part-group level.

const MATCH_TYPE_LABELS = {
  campaign: 'Google Ads / GA4 campaign name',
  query:    'GSC search query',
  url:      'Page URL path',
};

const MATCH_KIND_LABELS = {
  exact:    'exact match',
  contains: 'contains substring',
  prefix:   'starts with',
};

function PartGroupMappingsAdmin({ reloadKey = 0 } = {}) {
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ part_group: '', match_type: 'campaign', match_kind: 'contains', pattern: '', notes: '' });
  // Autocomplete suggestion lists from the server. Each list is capped
  // server-side; empty arrays are fine — datalists just suggest nothing.
  const [options, setOptions] = useState({ part_groups: [], campaign_names: [], queries: [], urls: [] });

  const reload = () => {
    setLoading(true);
    fetch('/api/mappings')
      .then(r => r.json())
      .then(d => setMappings(d.mappings || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(reload, [reloadKey]);

  // Options change rarely (only when fetchers run) — fetch once on mount.
  // If a new campaign/query/URL shows up after a fetch, the operator can
  // still type it in; the datalist is suggest-only, not strict.
  useEffect(() => {
    fetch('/api/mappings/options')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOptions(d); })
      .catch(() => { /* options are an enhancement — silent fail is fine */ });
  }, []);

  // Which suggestion list applies to the pattern field depends on match_type.
  const patternSuggestions = form.match_type === 'campaign' ? options.campaign_names
                           : form.match_type === 'query'    ? options.queries
                           : form.match_type === 'url'      ? options.urls
                           : [];

  const resetForm = () => {
    setForm({ part_group: '', match_type: 'campaign', match_kind: 'contains', pattern: '', notes: '' });
    setEditingId(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const url = editingId ? `/api/mappings/${editingId}` : '/api/mappings';
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      resetForm();
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  const startEdit = (m) => {
    setEditingId(m.id);
    setForm({
      part_group: m.part_group,
      match_type: m.match_type,
      match_kind: m.match_kind,
      pattern: m.pattern,
      notes: m.notes || '',
    });
  };

  const remove = async (id) => {
    if (!confirm('Delete this mapping?')) return;
    setError(null);
    try {
      const res = await fetch(`/api/mappings/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      if (editingId === id) resetForm();
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  const inputStyle = {
    background: 'var(--dso-bg)',
    color: 'var(--dso-text)',
    border: '1px solid var(--dso-rule)',
    borderRadius: 3,
    padding: '6px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
  };

  return (
    <section>
      <h3 style={{
        fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
        fontSize: 14,
        fontWeight: 600,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--dso-text-dim)',
        marginBottom: 10,
      }}>Part-Group Mappings</h3>
      <div style={{
        background: 'var(--dso-surface)',
        borderRadius: 4,
        padding: '14px 16px',
        border: '1px solid var(--dso-rule)',
      }}>
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 12, lineHeight: 1.5 }}>
          Curated rules linking campaign names, search queries, and page URLs to part groups.
          Used for downstream attribution — pure config, fetchers don't write here.
        </div>

        <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.4fr 1.2fr 2fr 1.5fr auto', gap: 8, marginBottom: 14, alignItems: 'end' }}>
          <label style={{ fontSize: 10, color: 'var(--dso-text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Part Group
            <input
              required
              type="text"
              list="pg-mapping-part-groups"
              autoComplete="off"
              value={form.part_group}
              onChange={e => setForm({ ...form, part_group: e.target.value })}
              placeholder="Gaskets"
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            />
            <datalist id="pg-mapping-part-groups">
              {options.part_groups.map(pg => <option key={pg} value={pg} />)}
            </datalist>
          </label>
          <label style={{ fontSize: 10, color: 'var(--dso-text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Match Type
            <select
              value={form.match_type}
              onChange={e => setForm({ ...form, match_type: e.target.value })}
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            >
              {Object.entries(MATCH_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 10, color: 'var(--dso-text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Match Kind
            <select
              value={form.match_kind}
              onChange={e => setForm({ ...form, match_kind: e.target.value })}
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            >
              {Object.entries(MATCH_KIND_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 10, color: 'var(--dso-text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Pattern
            <input
              required
              type="text"
              list="pg-mapping-patterns"
              autoComplete="off"
              value={form.pattern}
              onChange={e => setForm({ ...form, pattern: e.target.value })}
              placeholder={
                form.match_type === 'campaign' ? 'gasket'
                : form.match_type === 'query'  ? 'rubber gasket'
                : form.match_type === 'url'    ? '/products/gaskets'
                : ''
              }
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            />
            <datalist id="pg-mapping-patterns">
              {patternSuggestions.map(s => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label style={{ fontSize: 10, color: 'var(--dso-text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Notes (optional)
            <input
              type="text"
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              style={{ ...inputStyle, width: '100%', marginTop: 4 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="submit" style={{
              background: 'var(--dso-accent-hot)',
              color: 'white',
              border: 'none',
              padding: '7px 14px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              borderRadius: 3,
            }}>{editingId ? 'Save' : 'Add'}</button>
            {editingId && (
              <button type="button" onClick={resetForm} style={{
                background: 'transparent',
                color: 'var(--dso-text-dim)',
                border: '1px solid var(--dso-rule)',
                padding: '7px 14px',
                fontSize: 11,
                cursor: 'pointer',
                borderRadius: 3,
              }}>Cancel</button>
            )}
          </div>
        </form>

        {error && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 10 }}>Error: {error}</div>}
        {loading && <div style={{ color: 'var(--dso-text-dim)', fontSize: 12, marginBottom: 10 }}>Loading…</div>}

        {mappings.length === 0 && !loading ? (
          <div style={{ color: 'var(--dso-text-faint)', fontSize: 12, padding: '12px 0' }}>
            No mappings yet. Add a row above to start linking campaigns / queries / pages to part groups.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
            <thead>
              <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                <th style={{ padding: '8px 10px', fontWeight: 600 }}>Part Group</th>
                <th style={{ padding: '8px 10px', fontWeight: 600 }}>Type</th>
                <th style={{ padding: '8px 10px', fontWeight: 600 }}>Kind</th>
                <th style={{ padding: '8px 10px', fontWeight: 600 }}>Pattern</th>
                <th style={{ padding: '8px 10px', fontWeight: 600 }}>Notes</th>
                <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map(m => (
                <tr key={m.id} style={{ borderTop: '1px solid var(--dso-rule)', background: editingId === m.id ? 'var(--dso-bg)' : 'transparent' }}>
                  <td style={{ padding: '8px 10px', fontWeight: 600 }}>{m.part_group}</td>
                  <td style={{ padding: '8px 10px' }}>{m.match_type}</td>
                  <td style={{ padding: '8px 10px' }}>{m.match_kind}</td>
                  <td style={{ padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)' }}>{m.pattern}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--dso-text-dim)' }}>{m.notes || ''}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <button onClick={() => startEdit(m)} style={{
                      background: 'transparent',
                      border: '1px solid var(--dso-rule)',
                      color: 'var(--dso-text-dim)',
                      padding: '3px 8px',
                      fontSize: 10,
                      cursor: 'pointer',
                      borderRadius: 3,
                      marginRight: 4,
                    }}>Edit</button>
                    <button onClick={() => remove(m.id)} style={{
                      background: 'transparent',
                      border: '1px solid #b91c1c',
                      color: '#f87171',
                      padding: '3px 8px',
                      fontSize: 10,
                      cursor: 'pointer',
                      borderRadius: 3,
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// ─── Campaign → part-group mapping suggester ───────────────────────
//
// Surfaces every distinct Ads / GA4 campaign name with the top 3 ranked
// part-group candidates derived from token overlap (server-side). One
// click on a candidate chip POSTs to /api/mappings — which means the new
// row drops straight into the editable table below where it can be
// tweaked (match_kind switched to 'contains', pattern shortened, etc.)
// or deleted if the suggester guessed wrong.
function CampaignMappingSuggester({ version = 0, onChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('unmapped');
  const [busy, setBusy] = useState(new Set());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch('/api/mappings/suggest-campaigns')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => setData(j))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [version]);

  const accept = async (campaignName, partGroup) => {
    setBusy(prev => new Set([...prev, campaignName]));
    setError(null);
    try {
      const res = await fetch('/api/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          part_group: partGroup,
          match_type: 'campaign',
          match_kind: 'exact',
          pattern: campaignName,
          notes: 'Auto-suggested',
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(campaignName); return n; });
    }
  };

  const filtered = (data?.suggestions || []).filter(s => {
    if (filter === 'unmapped') return !s.existing_mapping;
    if (filter === 'mapped')   return !!s.existing_mapping;
    return true;
  });
  const visible = showAll ? filtered : filtered.slice(0, 100);

  const counts = useMemo(() => {
    const all = data?.suggestions || [];
    const mapped = all.filter(s => s.existing_mapping).length;
    return { all: all.length, mapped, unmapped: all.length - mapped };
  }, [data]);

  const filterBtn = (key, label, n) => (
    <button
      type="button"
      onClick={() => { setFilter(key); setShowAll(false); }}
      style={{
        background: filter === key ? 'var(--dso-accent-hot)' : 'transparent',
        color: filter === key ? 'white' : 'var(--dso-text-dim)',
        border: `1px solid ${filter === key ? 'var(--dso-accent-hot)' : 'var(--dso-rule)'}`,
        padding: '5px 12px',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        borderRadius: 3,
      }}
    >
      {label} <span style={{ opacity: 0.7, marginLeft: 4 }}>{n}</span>
    </button>
  );

  return (
    <section style={{ marginBottom: 20 }}>
      <h3 style={{
        fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
        fontSize: 14,
        fontWeight: 600,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--dso-text-dim)',
        marginBottom: 10,
      }}>Campaign → Part-Group Suggestions</h3>

      <div style={{
        background: 'var(--dso-surface)',
        borderRadius: 4,
        padding: '14px 16px',
        border: '1px solid var(--dso-rule)',
      }}>
        <div style={{ color: 'var(--dso-text-dim)', fontSize: 11, marginBottom: 12, lineHeight: 1.5 }}>
          Every distinct campaign across Google Ads + GA4, ranked against your NetSuite part groups by name-token overlap.
          Click a candidate chip to auto-create a mapping — it lands in the editable table below where you can fine-tune match kind, pattern, or notes.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          {filterBtn('unmapped', 'Unmapped', counts.unmapped)}
          {filterBtn('mapped',   'Mapped',   counts.mapped)}
          {filterBtn('all',      'All',      counts.all)}
          {data && (
            <span style={{ color: 'var(--dso-text-faint)', fontSize: 10, marginLeft: 'auto' }}>
              {data.part_group_count} part groups · refreshed {new Date(data.generated).toLocaleTimeString()}
            </span>
          )}
        </div>

        {error  && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 10 }}>Error: {error}</div>}
        {loading && <div style={{ color: 'var(--dso-text-dim)', fontSize: 12 }}>Loading suggestions…</div>}

        {!loading && filtered.length === 0 && (
          <div style={{ color: 'var(--dso-text-faint)', fontSize: 12, padding: '12px 0' }}>
            {filter === 'unmapped' && counts.all > 0 && counts.mapped === counts.all
              ? 'All campaigns are mapped. Switch to "Mapped" or "All" to review.'
              : 'No campaigns to suggest. Make sure Google Ads and GA4 fetchers have run.'}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, color: 'var(--dso-text)' }}>
              <thead>
                <tr style={{ color: 'var(--dso-text-dim)', fontSize: 10, textAlign: 'left', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Campaign</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Spend</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Sessions</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: 'right' }}>Conv.</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Last seen</th>
                  <th style={{ padding: '8px 10px', fontWeight: 600 }}>Candidates</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s, i) => {
                  const isBusy = busy.has(s.campaign_name);
                  return (
                    <tr key={s.campaign_name} style={{ borderTop: i === 0 ? '1px solid var(--dso-rule)' : '1px solid var(--dso-rule)' }}>
                      <td style={{
                        padding: '8px 10px', fontFamily: 'var(--dso-font-mono, monospace)',
                        maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={s.campaign_name}>
                        {s.campaign_name}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFeatureSettings: '"tnum"' }}>
                        {s.total_cost > 0 ? fmtMoney(s.total_cost) : <span style={{ color: 'var(--dso-text-faint)' }}>—</span>}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFeatureSettings: '"tnum"' }}>
                        {fmtNum(s.total_sessions)}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFeatureSettings: '"tnum"' }}>
                        {fmtNum(s.total_conversions)}
                      </td>
                      <td style={{ padding: '8px 10px', color: 'var(--dso-text-dim)' }}>
                        {s.last_seen || '—'}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {s.existing_mapping ? (
                          <span style={{ color: '#34d399', fontSize: 11 }}>
                            ✓ Mapped to <strong>{s.existing_mapping.part_group}</strong>
                            <span style={{ color: 'var(--dso-text-faint)', marginLeft: 6 }}>
                              ({s.existing_mapping.match_kind}: {s.existing_mapping.pattern})
                            </span>
                          </span>
                        ) : s.candidates.length === 0 ? (
                          <select
                            disabled={isBusy}
                            value=""
                            onChange={e => {
                              const pg = e.target.value;
                              if (pg) accept(s.campaign_name, pg);
                            }}
                            style={{
                              background: 'var(--dso-bg)',
                              color: 'var(--dso-text-dim)',
                              border: '1px dashed var(--dso-rule)',
                              borderRadius: 3,
                              padding: '4px 8px',
                              fontSize: 11,
                              fontFamily: 'inherit',
                              cursor: isBusy ? 'wait' : 'pointer',
                              maxWidth: 280,
                              opacity: isBusy ? 0.5 : 1,
                            }}
                            title="Pick a part group to map this campaign to"
                          >
                            <option value="" disabled>No keyword match — pick a part group…</option>
                            {(data?.part_groups || []).map(pg => (
                              <option key={pg} value={pg}>{pg}</option>
                            ))}
                          </select>
                        ) : (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {s.candidates.map((c, ci) => {
                              const isStrong = c.score >= 1.0;
                              const isMid    = c.score >= 0.5 && c.score < 1.0;
                              const color = isStrong ? '#34d399' : isMid ? '#fbbf24' : '#94a3b8';
                              return (
                                <button
                                  key={c.part_group}
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => accept(s.campaign_name, c.part_group)}
                                  title={`Accept · score ${c.score.toFixed(2)} · ${c.reason}`}
                                  style={{
                                    background: ci === 0 ? color : 'transparent',
                                    color: ci === 0 ? '#0f172a' : color,
                                    border: `1px solid ${color}`,
                                    padding: '3px 9px',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    cursor: isBusy ? 'wait' : 'pointer',
                                    borderRadius: 3,
                                    opacity: isBusy ? 0.5 : 1,
                                  }}
                                >
                                  {c.part_group}
                                  <span style={{ opacity: 0.7, marginLeft: 5, fontSize: 9 }}>
                                    {c.score.toFixed(2)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length > visible.length && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                style={{
                  marginTop: 10,
                  background: 'transparent',
                  color: 'var(--dso-text-dim)',
                  border: '1px solid var(--dso-rule)',
                  padding: '6px 14px',
                  fontSize: 11,
                  cursor: 'pointer',
                  borderRadius: 3,
                }}
              >
                Show all {filtered.length} →
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
