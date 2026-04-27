// DSOATDLogo.jsx — React component for the RF-DSOATD wordmark.
// Sister to RFRPLogo. Cursive "DSO" + hot-pink-red "ATD" stamp.
//
// Usage:
//   <DSOATDLogo size={64} />
//   <DSOATDLogo size={48} showFrame={false} showTagline={false} />

import React from 'react';

export default function DSOATDLogo({
  color = 'var(--dso-accent, #1a6b87)',
  hot = 'var(--dso-accent-hot, #ff2d6f)',
  size = 64,
  showFrame = true,
  showTagline = true,
  className = '',
  style = {},
}) {
  const fontSize = size * 1.4;
  const blockSize = size * 1.2;   // "RF—" block matches DSO height

  return (
    <div
      className={`dso-logo ${className}`}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: showFrame ? `${size * 0.4}px ${size * 0.6}px` : 0,
        ...style,
      }}
    >
      {showFrame && (
        <>
          <div style={{
            position: 'absolute', inset: 0,
            border: `2.5px solid ${color}`,
            borderRadius: 4,
          }} />
          <div style={{
            position: 'absolute', inset: size * 0.14,
            border: `2px solid ${hot}`,
            borderRadius: 2,
          }} />
        </>
      )}

      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        position: 'relative', zIndex: 1, gap: size * 0.18,
      }}>
        {/* BIG: RF-DSOATD wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.25 }}>
          {/* RF— block */}
          <div style={{
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700, fontSize: blockSize,
            letterSpacing: '0.04em', textTransform: 'uppercase',
            color, lineHeight: 1,
          }}>
            RF—
          </div>

          {/* DSO cursive */}
          <div style={{
            position: 'relative',
            width: fontSize * 1.55,
            height: fontSize * 1.1,
          }}>
            <div style={{
              position: 'absolute', left: 0, top: 0,
              fontFamily: "'Yellowtail', cursive",
              fontSize, lineHeight: 1, color,
              whiteSpace: 'nowrap',
              textShadow: `0.6px 0 0 ${color}, -0.6px 0 0 ${color}, 0 0.6px 0 ${color}, 0 -0.6px 0 ${color}, 0.6px 0.6px 0 ${color}, -0.6px -0.6px 0 ${color}`,
            }}>DSO</div>
            <svg
              viewBox="0 0 100 12"
              preserveAspectRatio="none"
              style={{
                position: 'absolute',
                top: fontSize * 0.45,
                left: fontSize * 0.18,
                width: fontSize * 1.3,
                height: fontSize * 0.16,
                overflow: 'visible',
              }}
            >
              <path
                d="M 0 6.5 Q 4 5.8, 8 6.0 Q 18 5.4, 28 5.6 Q 42 4.9, 56 5.2 Q 72 4.6, 88 4.7 L 100 4.4 L 100 5.0 Q 88 5.3, 72 5.4 Q 56 6.0, 42 5.8 Q 28 6.5, 18 6.4 Q 8 7.0, 4 7.0 Q 1 7.2, 0 7.2 Z"
                fill={color}
              />
            </svg>
          </div>

          {/* ATD hot stamp */}
          <div style={{
            border: `2.5px solid ${hot}`,
            padding: `${size * 0.12}px ${size * 0.22}px`,
            transform: 'rotate(-4deg)',
            fontFamily: "'Oswald', sans-serif",
            fontWeight: 700,
            fontSize: size * 0.85,
            letterSpacing: '0.08em',
            color: hot,
            lineHeight: 1,
          }}>
            ATD
          </div>
        </div>

        {showTagline && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 4, paddingTop: size * 0.14,
            borderTop: `1.5px solid ${hot}`,
            alignSelf: 'stretch',
          }}>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700, fontSize: size * 0.28,
              letterSpacing: '0.18em', textTransform: 'uppercase',
              color,
            }}>
              Daily Sales Order
            </div>
            <div style={{
              fontFamily: "'Oswald', sans-serif",
              fontWeight: 700, fontSize: size * 0.22,
              letterSpacing: '0.20em', textTransform: 'uppercase',
              color: hot,
            }}>
              · Automated ·
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
