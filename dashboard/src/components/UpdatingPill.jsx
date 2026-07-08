import React from 'react';

/**
 * Subtle "Updating…" pill shown while a refetch is in flight and the page is
 * still displaying the previous (stale) data. Fixed top-right so it's visible
 * regardless of scroll position without shifting layout.
 */
export default function UpdatingPill({ show }) {
  if (!show) return null;
  return (
    <div style={{
      position: 'fixed',
      top: 72,
      right: 16,
      zIndex: 60,
      background: 'rgba(15, 23, 42, 0.92)',
      border: '1px solid #334155',
      color: '#94a3b8',
      borderRadius: 999,
      padding: '4px 12px',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      pointerEvents: 'none',
    }}>
      Updating…
    </div>
  );
}
