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
