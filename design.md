# Design: mbg-supply-ledger

The locked system. Every Hallmark run reads this first and pages share it. Change it on purpose; the file is the rule.

## System
- Genre: modern-minimal
- Shape of the first page: app screen
- Theme: custom (vibe: "clinical Preline operational ledger with crisp hairlines")
- Axes: light/grotesk-sans/neutral · posture: settled

## Tokens
`src/app/tokens.css` is the source of truth. The roles:
```css
:root {
  --color-paper: #f2f4f7;  --color-surface: #ffffff;  --color-paper-2: #f8f9fa;  --color-paper-3: #eeeeee;  --color-group: #e9edf2;
  --color-ink: #0a0a0a;  --color-ink-2: #3d3d3d;  --color-muted: #6b6b6b;  --color-muted-2: #8a8a8a;
  --color-rule: #e6e6e6;  --color-rule-2: #f0f0f0;  --color-control: #d4d4d4;
  --color-accent: #141414;  --color-accent-hover: #262626;  --color-accent-ink: #ffffff;  --color-focus: #141414;  --color-signal: #1d5fbf;
  --color-success: #2e7d32;  --color-success-bg: #dcfae5;  --color-success-border: #b7ebd0;  --color-success-ink: #04250e;
  --color-warning: #92400e;  --color-warning-bg: #fffbeb;  --color-warning-border: #fde68a;
  --color-error: #c4242a;  --color-error-bg: #ffedea;  --color-error-border: #f5c2c0;  --color-error-ink: #831c1e;
  --font-display: "Geist", Inter, system-ui, -apple-system, sans-serif;
  --font-body: "Geist", Inter, system-ui, -apple-system, sans-serif;
  --font-outlier: "Geist Mono", ui-monospace, SFMono-Regular, monospace;
  --radius-card: 8px;  --radius-control: 6px;  --radius-pill: 999px;  --rule-hair: 1px;  --shadow-card: none;
}
```
The spacing scale, the type scale, the easings and the durations are the scaffold's and live in `src/app/tokens.css`.

## Controls
- Primary: `var(--color-accent)` fill (`#141414`) · `6px` radius · `40px` min-height
- Secondary: `1px solid var(--color-control)` outline on `var(--color-surface)` · same `6px` radius and `40px` min-height

## Motion
- Character: still; `transform` and `opacity` only (`120ms–220ms`); under reduced motion everything ends at once.

## Exports
`src/app/tokens.css` and `tailwind.config.js` in this project. DTCG or shadcn blocks are added here on request, per `export-formats.md`.
