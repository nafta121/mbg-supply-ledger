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
  --color-paper: #f7f5f0;  --color-surface: #ffffff;  --color-paper-2: #f4f1ea;  --color-paper-3: #efece6;  --color-group: #eae5dc;
  --color-ink: #141413;  --color-ink-2: #3f3c39;  --color-muted: #57534e;  --color-muted-2: #78716c;
  --color-rule: #e5e0d8;  --color-rule-2: #ede9e1;  --color-control: #d6d0c4;
  --color-accent: #14532d;  --color-accent-hover: #166534;  --color-accent-ink: #ffffff;  --color-focus: #14532d;  --color-signal: #14532d;
  --color-success: #15803d;  --color-success-bg: #dcfce7;  --color-success-border: #86efac;  --color-success-ink: #14532d;
  --color-warning: #92400e;  --color-warning-bg: #fef3c7;  --color-warning-border: #fcd34d;
  --color-error: #b91c1c;  --color-error-bg: #fee2e2;  --color-error-border: #fca5a5;  --color-error-ink: #7f1d1d;
  --color-error-hover: rgba(252, 165, 165, 0.35);  --color-scrim: rgba(20, 20, 19, 0.45);
  --font-display: "Geist", Inter, system-ui, -apple-system, sans-serif;
  --font-body: "Geist", Inter, system-ui, -apple-system, sans-serif;
  --font-outlier: "Geist Mono", ui-monospace, SFMono-Regular, monospace;
  --radius-card: 8px;  --radius-control: 6px;  --radius-pill: 999px;  --rule-hair: 1px;  --shadow-card: none;
}
```
The spacing scale, the type scale, the easings and the durations are the scaffold's and live in `src/app/tokens.css`.

## Controls
- Primary: `var(--color-accent)` fill (`#14532d`) · `6px` radius · `40px` min-height
- Secondary: `1px solid var(--color-control)` outline on `var(--color-surface)` · same `6px` radius and `40px` min-height

## Motion
- Character: still; `transform` and `opacity` only (`120ms–220ms`); under reduced motion everything ends at once.

## Exports
`src/app/tokens.css` and `tailwind.config.js` in this project. DTCG or shadcn blocks are added here on request, per `export-formats.md`.
