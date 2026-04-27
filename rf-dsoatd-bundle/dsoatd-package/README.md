# RF-DSOATD Brand Package v1.0

Daily Sales Order — Automated. Sister system to **RFRP Brand Package**;
same vintage surf-shop bones, with **hot pink-red (`#ff2d6f`) lining accents**
to flag the automated nature of the tooling.

## What's in the box

| File | What it is |
| --- | --- |
| `dsoatd-tokens.css` | CSS custom properties (palette + hot accent) |
| `dsoatd-ui.css` | Class utilities — frames with hot lining, hot buttons, data rows, "AUTOMATED" pulse tag, stat callouts |
| `dsoatd-logo.svg` | Standalone wordmark — pure SVG |
| `DSOATDLogo.jsx` | React component version |

## Install (Railway)

```
public/brand/dsoatd/
  ├── dsoatd-tokens.css
  ├── dsoatd-ui.css
  └── dsoatd-logo.svg
src/components/
  └── DSOATDLogo.jsx
```

```html
<link rel="stylesheet" href="/brand/dsoatd/dsoatd-tokens.css">
<link rel="stylesheet" href="/brand/dsoatd/dsoatd-ui.css">
<body class="dsoatd"> ... </body>
```

## What's different from RFRP

This package adds a hot-pink-red second accent layered on top of the sky-blue
base. Use it sparingly — for things that are **automated**, **live**, **time-
sensitive**, or **important to action**:

- Frame **inner** strokes (vs RFRP's both-strokes-blue)
- Live status pulse (`.dso-auto-tag`)
- Stat callouts left-rail (`.dso-stat`)
- Data-row left rails for flagged orders (`.dso-row--hot`)
- Solid CTA buttons (`.dso-btn--solid-hot`)

## Tokens worth knowing

```css
--dso-hot:        #ff2d6f;   /* primary hot pink-red */
--dso-hot-deep:   #d11854;   /* hover / pressed */
--dso-hot-soft:   #ffd9e5;   /* tints / backgrounds */
--dso-accent:     /* still sky blue — primary identity */
--dso-accent-hot: /* the hot lining accent */
```

## Utility classes

| Class | What it does |
| --- | --- |
| `.dsoatd` | Body baseline |
| `.dso-display` | Yellowtail cursive hero |
| `.dso-h1/h2/h3` | Oswald uppercase headers |
| `.dso-eyebrow` / `.dso-eyebrow--hot` | Small all-caps label |
| `.dso-frame` | Blue outer + **hot inner** double-stroke frame |
| `.dso-card` / `.dso-card--hot` | Surface card; hot variant has top stripe |
| `.dso-btn` / `.dso-btn--hot` / `.dso-btn--solid-hot` | Buttons |
| `.dso-hr` / `.dso-hr-hot` | Themed dividers |
| `.dso-chip` / `.dso-chip--hot` | Status pills |
| `.dso-row` / `.dso-row--hot` / `.dso-row--blue` | Spreadsheet rows w/ left rail |
| `.dso-auto-tag` | "AUTOMATED" pulse-dot status |
| `.dso-stat` / `.dso-stat-value` / `.dso-stat-label` | Numeric callout block |

## Pairing with RFRP

Both packages can coexist on the same page — the `--rfrp-*` and `--dso-*`
namespaces don't collide. Use RFRP for the brand chrome and DSOATD utilities
for the dashboard surface.

## Questions

- Need a Vue version of the logo? Ask.
- Need a wider hot-color ramp (50–950)? Ask.
- Need email-safe variant? Ask.
