/**
 * pins.jsx — global "pinned date" state shared across every page.
 *
 * UX: clicking a date on any DMA chart toggles a pin. Up to two pins exist
 * at once. When two are set, charts render both reference lines and a
 * compact "A → B (Δ)" readout. Single click on an already-pinned date
 * removes it. Clicking a third date drops the older pin (FIFO).
 *
 * Pin colors deliberately differ from the existing line palette so a
 * pinned reference line can't be confused with a 30/90 DMA trace:
 *   Pin A → amber, Pin B → cyan.
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export const PIN_COLORS = ['#f59e0b', '#22d3ee']; // A=amber, B=cyan
const PIN_LABELS = ['A', 'B'];
const MAX_PINS = 2;

const PinContext = createContext({
  pins: [],
  togglePin: () => {},
  clearPins: () => {},
});

export function PinProvider({ children }) {
  const [pins, setPins] = useState([]); // [{date, color, label}]

  const togglePin = useCallback((date) => {
    if (!date || typeof date !== 'string') return;
    setPins(prev => {
      const idx = prev.findIndex(p => p.date === date);
      if (idx >= 0) {
        // Remove this pin and re-label the survivors so A is always first.
        const next = prev.filter((_, i) => i !== idx);
        return next.map((p, i) => ({ ...p, color: PIN_COLORS[i], label: PIN_LABELS[i] }));
      }
      // Add. If already at max, drop the oldest (FIFO).
      const trimmed = prev.length >= MAX_PINS ? prev.slice(1) : prev;
      const next = [...trimmed, { date, color: '', label: '' }];
      return next.map((p, i) => ({ ...p, color: PIN_COLORS[i], label: PIN_LABELS[i] }));
    });
  }, []);

  const clearPins = useCallback(() => setPins([]), []);

  const value = useMemo(() => ({ pins, togglePin, clearPins }), [pins, togglePin, clearPins]);
  return <PinContext.Provider value={value}>{children}</PinContext.Provider>;
}

export function usePins() {
  return useContext(PinContext);
}

/** Floating panel showing currently-pinned dates + days between + clear button. */
export function PinPanel() {
  const { pins, clearPins, togglePin } = usePins();
  if (pins.length === 0) return null;

  const daysBetween = pins.length === 2
    ? Math.round((new Date(pins[1].date) - new Date(pins[0].date)) / 86400000)
    : null;

  return (
    <div style={{
      position: 'fixed',
      top: 110,
      right: 16,
      zIndex: 50,
      background: 'rgba(15, 23, 42, 0.95)',
      border: '1px solid var(--dso-rule, #334155)',
      borderRadius: 6,
      padding: '8px 12px',
      boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
      fontSize: 11,
      color: '#cbd5e1',
      fontFamily: "var(--dso-font-mono, ui-monospace, Menlo, monospace)",
      minWidth: 200,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 6,
        gap: 12,
      }}>
        <span style={{
          fontFamily: "var(--dso-font-heading, 'Oswald', sans-serif)",
          letterSpacing: '0.18em',
          fontSize: 10,
          color: '#94a3b8',
          fontWeight: 600,
          textTransform: 'uppercase',
        }}>Pinned</span>
        <button
          onClick={clearPins}
          style={{
            background: 'transparent',
            border: '1px solid #475569',
            color: '#94a3b8',
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 3,
            cursor: 'pointer',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
          title="Clear all pins"
        >Clear</button>
      </div>
      {pins.map(p => (
        <div
          key={p.date}
          onClick={() => togglePin(p.date)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '2px 0',
            cursor: 'pointer',
          }}
          title="Click to remove this pin"
        >
          <span style={{
            display: 'inline-block',
            width: 10, height: 10,
            background: p.color,
            borderRadius: 2,
          }} />
          <span style={{ fontWeight: 700, color: p.color }}>Pin {p.label}</span>
          <span>{p.date}</span>
        </div>
      ))}
      {daysBetween !== null && (
        <div style={{
          marginTop: 6,
          paddingTop: 6,
          borderTop: '1px solid #334155',
          color: '#cbd5e1',
        }}>
          <span style={{ color: '#94a3b8' }}>Δ: </span>
          <span style={{ fontWeight: 700 }}>{Math.abs(daysBetween)} day{Math.abs(daysBetween) === 1 ? '' : 's'}</span>
          {daysBetween !== 0 && (
            <span style={{ color: '#64748b' }}> ({daysBetween > 0 ? 'B is later' : 'A is later'})</span>
          )}
        </div>
      )}
      <div style={{
        marginTop: 6,
        fontSize: 9,
        color: '#64748b',
        letterSpacing: '0.04em',
        lineHeight: 1.3,
      }}>
        Click any chart to pin · click pin to remove
      </div>
    </div>
  );
}

/** Return today's date in local timezone as YYYY-MM-DD. */
export function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Drop trailing rows whose date >= today. Today's row reflects an
 * incomplete day (quoting / shipping still in progress) and skews the
 * trailing tail of every DMA curve downward.
 *
 * Assumes rows are sorted ascending by date. Works on whatever
 * dateField the chart uses (default "date").
 */
export function trimToYesterday(rows, dateField = 'date') {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const today = todayLocalISO();
  // Fast path: most arrays only need 0-1 rows trimmed from the tail.
  let end = rows.length;
  while (end > 0 && rows[end - 1]?.[dateField] >= today) end--;
  return end === rows.length ? rows : rows.slice(0, end);
}
