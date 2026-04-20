import React, { useState, useEffect, useRef } from 'react';

// Shared month ranges used by the range dropdown on every tab.
export const RELATIVE_RANGES = {
  '3m':  90,
  '6m':  180,
  '9m':  270,
  '12m': 365,
  '16m': 487,
  '20m': 609,
  '24m': 730,
};

// Persisted state backed by localStorage so filters survive tab switches and
// page reloads. JSON-encodes the value; falls back to `defaultValue` on error
// (e.g. privacy mode, quota exceeded, or a corrupted blob).
export function useLocalStorageState(key, defaultValue) {
  const storageKey = `rfti.${key}`;
  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch { /* ignore */ }
  }, [storageKey, state]);
  return [state, setState];
}

// Remove every rfti.* key so the "Clear filters" button wipes all persisted
// filter state. Returns a bumped counter the caller can use as a React `key`
// to force a remount of components with internal state.
export function clearAllFilters() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('rfti.')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

const SELECT_STYLE = {
  background: '#334155',
  color: '#e2e8f0',
  border: '1px solid #475569',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  appearance: 'auto',
};

/**
 * Range dropdown — relative month ranges plus "all". Disabled when the caller
 * has years selected (the range is ignored in that case anyway).
 */
export function RangeDropdown({ range, disabled, onChange }) {
  return (
    <select
      value={disabled ? '__years_active__' : range}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      style={{ ...SELECT_STYLE, opacity: disabled ? 0.5 : 1 }}
      title={disabled ? 'Years are selected — clear them to use a month range' : 'Time range'}
    >
      {disabled && <option value="__years_active__">Years active</option>}
      {Object.keys(RELATIVE_RANGES).map(r => <option key={r} value={r}>{r}</option>)}
      <option value="all">all</option>
    </select>
  );
}

/**
 * Multi-select years dropdown. Click to open a small panel of year checkboxes.
 * Selecting any year overrides the month range (the caller should branch on
 * `selected.length > 0`).
 */
export function YearsDropdown({ selected, available, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const label =
    selected.length === 0 ? 'Years: all' :
    selected.length <= 3   ? `Years: ${selected.join(', ')}` :
                             `Years: ${selected.length} selected`;

  const toggle = (y) =>
    onChange(selected.includes(y) ? selected.filter(v => v !== y) : [...selected, y].sort());

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          ...SELECT_STYLE,
          background: selected.length > 0 ? '#f59e0b' : '#334155',
          color: selected.length > 0 ? '#0f172a' : '#e2e8f0',
          border: selected.length > 0 ? 'none' : SELECT_STYLE.border,
        }}
      >
        {label} ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 140,
            background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
            padding: 4, zIndex: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {available.length === 0 && (
            <div style={{ padding: '6px 10px', color: '#64748b', fontSize: 11 }}>no data</div>
          )}
          {available.map(y => (
            <label
              key={y}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 10px', cursor: 'pointer', color: '#e2e8f0', fontSize: 12,
                borderRadius: 4,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#0f172a')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <input
                type="checkbox"
                checked={selected.includes(y)}
                onChange={() => toggle(y)}
              />
              {y}
            </label>
          ))}
          {selected.length > 0 && (
            <button
              onClick={() => onChange([])}
              style={{
                width: '100%', marginTop: 4, padding: '5px 10px', fontSize: 11,
                background: 'transparent', color: '#94a3b8',
                border: '1px solid #334155', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Generic multi-select dropdown with checkbox options.
 *
 * Props:
 *   label        — button label prefix (e.g. "Sales Rep")
 *   options      — [{ value, name?, count?, subtitle? }, ...]
 *   selected     — array of selected values
 *   onChange     — called with the new array when a checkbox toggles
 *   keyField     — which field on each option is the selected value (default: "value")
 *   nameField    — which field to display (default: keyField)
 *   countField   — optional field whose numeric value is shown as a subtle badge
 *   emptyHint    — rendered when options is empty
 *   searchable   — when true, add a small filter input at the top (helpful for long lists)
 *   maxHeight    — scroll panel height
 */
export function MultiSelectDropdown({
  label, options, selected, onChange,
  keyField = 'value', nameField, countField,
  emptyHint = 'no data', searchable = true, maxHeight = 280,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const nf = nameField || keyField;

  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedSet = new Set(selected.map(String));
  const filteredOptions = query.trim()
    ? options.filter(o => String(o[nf] ?? o[keyField] ?? '').toLowerCase().includes(query.toLowerCase()))
    : options;

  const labelText =
    selected.length === 0 ? `${label}: all`
    : selected.length <= 2
      ? `${label}: ${selected.map(v => {
          const opt = options.find(o => String(o[keyField]) === String(v));
          return opt ? (opt[nf] ?? opt[keyField]) : v;
        }).join(', ')}`
      : `${label}: ${selected.length} selected`;

  const toggle = (val) =>
    onChange(selectedSet.has(String(val))
      ? selected.filter(v => String(v) !== String(val))
      : [...selected, val]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: selected.length > 0 ? '#f59e0b' : '#334155',
          color: selected.length > 0 ? '#0f172a' : '#e2e8f0',
          border: selected.length > 0 ? 'none' : '1px solid #475569',
          borderRadius: 4, padding: '4px 10px',
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
          maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {labelText} ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, minWidth: 240,
            background: '#1e293b', border: '1px solid #334155', borderRadius: 6,
            padding: 4, zIndex: 10,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {searchable && options.length > 6 && (
            <input
              autoFocus
              type="text"
              placeholder="filter…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 4,
                padding: '5px 8px', fontSize: 12,
                background: '#0f172a', color: '#e2e8f0',
                border: '1px solid #334155', borderRadius: 4, outline: 'none',
              }}
            />
          )}
          <div style={{ maxHeight, overflowY: 'auto' }}>
            {filteredOptions.length === 0 && (
              <div style={{ padding: '6px 10px', color: '#64748b', fontSize: 11 }}>
                {options.length === 0 ? emptyHint : 'no matches'}
              </div>
            )}
            {filteredOptions.map(opt => {
              const key = opt[keyField];
              const name = opt[nf] ?? key;
              const active = selectedSet.has(String(key));
              return (
                <label
                  key={String(key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 10px', cursor: 'pointer', color: '#e2e8f0', fontSize: 12,
                    borderRadius: 4,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#0f172a')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggle(key)}
                  />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name || '(blank)'}
                  </span>
                  {countField && opt[countField] != null && (
                    <span style={{ color: '#64748b', fontSize: 10, marginLeft: 4, flexShrink: 0 }}>
                      {Number(opt[countField]).toLocaleString()}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {selected.length > 0 && (
            <button
              onClick={() => onChange([])}
              style={{
                width: '100%', marginTop: 4, padding: '5px 10px', fontSize: 11,
                background: 'transparent', color: '#94a3b8',
                border: '1px solid #334155', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
