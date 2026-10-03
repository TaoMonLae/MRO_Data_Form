# MRO Registry — Design System

Source of truth: `src/app.css` (single stylesheet, no CSS framework/Tailwind). Icons: `lucide-react`. Fonts: `Inter` with a system-ui fallback stack, no local `@font-face` — install/link Inter if pixel-perfect type is required. This document reflects the styles as implemented, so it can be handed to a new page/component and get a matching result on the first try.

The product has two visual worlds that share tokens but not layout:

1. **App (operations workspace)** — sidebar + topbar shell, data tables, drawers, forms, dashboards. Light-first, with a full dark mode.
2. **Public site** — marketing pages (home, about, FAQ). Bold red hero, editorial type, light only (dark mode is styled but treated as secondary).

---

## 1. Color tokens

All app colors are CSS custom properties on `:root`, overridden under `[data-theme="dark"]`. Never hardcode a hex value in a component — reference the variable.

### Light (default)

| Token | Value | Use |
|---|---|---|
| `--blue` | `#d9231e` | Primary brand red — primary buttons, links, active states (named `--blue` for historical reasons; it is red) |
| `--blue-dark` | `#b51b17` | Primary hover/active |
| `--blue-soft` | `#fff0ee` | Primary tint backgrounds (icon chips, active nav, hover fills) |
| `--navy` | `#172c38` | Headings, high-emphasis text, dark surfaces (sidebar, hero) |
| `--ink` | `#243b47` | Body text |
| `--muted` | `#667784` | Secondary/help text, labels |
| `--canvas` | `#f4f7f9` | Page background |
| `--surface` | `#ffffff` | Card/panel background |
| `--surface-muted` | `#f8fafb` | Recessed fill (search boxes, info callouts) |
| `--surface-hover` | `#fbfdfe` | Row hover |
| `--line` | `#dce4e9` | Default border/divider |
| `--line-strong` | `#c7d2da` | Emphasized border (inputs, selects) |
| `--green` | `#087a55` | Success text |
| `--green-soft` | `#e8f7f1` | Success background |
| `--amber` | `#a65c00` | Warning text |
| `--amber-soft` | `#fff3de` | Warning background |
| `--red` | `#a52a2a` | Destructive text (distinct from brand `--blue` red) |
| `--red-soft` | `#fff0f0` | Destructive background |
| `--sidebar` | `#172c38` | Sidebar background (= navy) |
| `--gold` | `#d7ae19` | Accent (progress bar segments, highlights) |
| `--gold-soft` | `#fff8d8` | Accent tint |

### Dark (`[data-theme="dark"]`)

| Token | Value |
|---|---|
| `--blue` | `#e14a44` |
| `--blue-dark` | `#ff746e` |
| `--blue-soft` | `#2b1718` |
| `--navy` | `#f7f8f8` |
| `--ink` | `#d0d6e0` |
| `--muted` | `#9299a3` |
| `--canvas` | `#08090a` |
| `--surface` | `#141516` |
| `--surface-muted` | `#1c1c1f` |
| `--surface-hover` | `#202124` |
| `--line` | `#2d2e31` |
| `--line-strong` | `#3e4045` |
| `--green` | `#5bd4a5` / soft `#102a22` |
| `--amber` | `#efb85a` / soft `#2d2413` |
| `--red` | `#ff7b76` / soft `#30191a` |
| `--sidebar` | `#0b0c0d` |
| `--gold-soft` | `#2a2512` |
| `--shadow` | `0 22px 60px rgba(0,0,0,.4)` |

Dark mode is driven by `document.documentElement.dataset.theme`, set from `localStorage['mro-theme']` (fallback: `prefers-color-scheme`) in an inline script in `index.html` to avoid a flash. `--navy` and `--ink`/`--muted` roughly invert (navy becomes near-white) — treat `--navy` as "max emphasis text," not literally navy.

### Public site tokens (separate, brand-locked — do not theme-swap)

```css
--public-red:      #d9231e;
--public-red-dark: #941310;
--public-gold:     #d7ae19;
--public-ink:      #172c38;
--public-muted:    #62717a;
```

The public site keeps MRO red as its only accent even in dark mode; only backgrounds/surfaces invert (`#08090a`, `#141516`, borders `#2d2e31`/`#34343a`).

### Status color pattern

Every status/semantic color follows **text token + `-soft` background token + no border, or a matching light border** — e.g. `.status-badge--success { color: var(--green); background: var(--green-soft); }`. Reuse this pair (never a bare background color) for any new status treatment.

---

## 2. Typography

- **Family:** `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- **Monospace:** `"SFMono-Regular", Consolas, monospace` — used for IDs, row indices, ledger row numbers (`.mono`, `.workflow-ledger__row > span`)
- **Base body:** `14px` / line-height `1.48`, color `--ink`
- **Headings:** `h1`–`h3` colored `--navy`, `text-wrap: balance`. No fixed `h1` app style (each hero sets its own); `h2` is `clamp(1.55rem, 2.5vw, 2.05rem)`, `line-height 1.15`, `letter-spacing -.035em`. `h3` is `1rem`.
- **Kicker/eyebrow:** `.kicker` — `.69rem`, weight `780`, `letter-spacing .12em`, uppercase, colored `--blue`. Used above every page title and section heading as a category label.
- **Muted text:** `.muted` — `--muted` color, used for descriptions/help text under a title.
- **Numeric emphasis:** large stat numbers use `font-variant-numeric: tabular-nums` and tight negative `letter-spacing` (e.g. `-.045em`) — always apply both together for KPI figures so digits don't jiggle and read dense.
- **Public site display type** is much larger and looser: hero `h1` is `clamp(3rem, 6.4vw, 6.8rem)`, weight `720`, `line-height .92`, `letter-spacing -.062em`, `text-wrap: balance`. Section headings `clamp(2rem, 4.2vw, 4.25rem)`.

General rule: as size increases, weight goes up modestly (~650–780) while `letter-spacing` goes more negative and `line-height` tightens toward 1. Small uppercase labels (`.kicker`, table headers, stat labels) always pair `letter-spacing: .06–.13em` with a heavier weight (700–780) to stay legible at tiny sizes.

---

## 3. Spacing, radius, elevation, motion

- **Corner radius:** `--radius: 8px` is the default for cards/panels/stat tiles. Inputs/buttons commonly use `6–8px`; pill shapes (badges, toggle track, avatar) use `999px`/`50%`. Modals use `12px`.
- **Shadow:** one elevation token, `--shadow: 0 18px 44px rgba(18,44,61,.08)` (dark: `rgba(0,0,0,.4)`), reserved for modal/floating surfaces. Flat cards use a `1px solid var(--line)` border instead of a shadow — shadows are not used for routine card elevation.
- **Motion tokens:**
  ```css
  --duration-fast: 120ms;
  --duration-default: 200ms;
  --duration-slow: 320ms;
  --ease-out: cubic-bezier(0, 0, .2, 1);
  --ease-in-out: cubic-bezier(.4, 0, .2, 1);
  ```
  Interactive color/border transitions use `--duration-fast`; reveal transitions (donut chart fill, accordion caret, coverage bar scale) use `--duration-slow`. Coverage bars use `transform: scaleX()` with a left origin to avoid animating layout. `prefers-reduced-motion: reduce` collapses all animation/transition durations to `.01ms` globally.
- **Focus ring:** universal, not per-component — `outline: 3px solid rgba(217,35,30,.28); outline-offset: 2px;` on `:focus-visible` for buttons, links, inputs, selects, textareas.

---

## 4. Layout shells

### App shell
- Fixed **sidebar**, `246px` wide, `--sidebar` background, full viewport height, `z-index: 30`.
  - Brand lockup (logo + name) at top, `78px` min-height header.
  - Nav grouped under uppercase `.nav-label`s; items are `42px` min-height rows, `7px` radius, active state = tinted background + `2px` inset left border in brand color.
  - Bottom section: a small "confidential/safety" note block, then a `.profile-chip` (avatar + name/role + menu button) pinned at the bottom.
- **Main column**: `margin-left: 246px`, containing a sticky **topbar** (`70px`, blurred translucent white, bottom border) and `.page-content` (max width `1440px`, centered, `28px` padding).
- **Below 850px**: sidebar becomes an off-canvas drawer (`translateX(-100%)` + scrim), topbar gains a hamburger, main column margin collapses to 0.

### Public site shell
- Sticky header (`76px`, blurred), full-bleed hero sections, then a series of full-width bands (`.public-intro`, `.public-proof`, `.workflow-ledger`, `.faq-list`) each constrained to `min(1240px, calc(100% - 44px))` and centered — never a fixed side-padding, always this clamp pattern so bands align across the page.
- Footer is a 3-column grid (`1.4fr .6fr .6fr`) on a very dark navy background with a legal note row.

### Breakpoints (max-width, mobile-first overrides)
| Breakpoint | Applies to |
|---|---|
| `1120px` | Stat grids → 2 columns, two-column content grids → 1 column |
| `980px` | Public nav collapses to a slide-down panel, admin/KPI strips → 2 columns |
| `850px` | App sidebar becomes off-canvas, login split-screen stacks |
| `680px` | Public hero/type scales down further, footer → 1 column |
| `620px` | App page padding shrinks, forms/drawers go full-width, stat grids → 2-up, everything stacks |

---

## 5. Core components

### Buttons
```css
.button            /* primary: white text on --blue, 40px min-height, 8px 15px padding, 700 weight, hover = darker + translateY(-1px) */
.button--secondary /* --navy text, --surface bg, --line-strong border; hover tints toward brand */
.button--danger    /* --red text, --surface bg, red-tinted border; hover fills solid red */
.button:disabled   /* opacity .55, cursor: wait */
.button.is-loading svg { animation: spin 900ms linear infinite; }
```
Buttons never grow past their content unless in a flexed toolbar (`.title-actions .button { flex: 1 }` on small screens). `.text-link` is the inline, non-boxed variant — brand-dark color, weight 700, underline on hover only.

Public site has its own button, **not** shared with the app: `.public-button` — `46px` min-height, 3 variants (`--light` white-on-red-bg, `--ghost` outlined, `--dark` on navy), `scale(.98)` on `:active`.

### Form fields
```css
.field { display: grid; gap: 7px; margin-bottom: 17px; }         /* label wrapper */
.field label { color: var(--navy); font-size: .82rem; font-weight: 700; }
.field input, .field select, .field textarea {
  min-height: 45px; padding: 10px 12px; border: 1px solid var(--line-strong);
  border-radius: 7px; background: var(--surface);
}
:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(217,35,30,.12); }
.field em { color: var(--red); font-style: normal; }              /* required-field asterisk */
.field > small { color: var(--muted); font-size: .66rem; }        /* helper text */
```
Two-column forms use `.form-grid { grid-template-columns: repeat(2, 1fr); gap: 0 14px; }` inside a `.form-section` (padded block with bottom divider, optional `h3` sub-heading). Disabled fields: muted text on `#f3f6f7`. Error/alert banner above a form: `.form-alert` (red, icon + text). Success banner: `.form-success` (green). Password strength/requirements list: `.password-rules`, each rule a row with a check icon that turns green + bold (`.is-valid`) once satisfied.

### Status badges
```css
.status-badge { pill, 4px 8px padding, .63rem, weight 780, default grey }
.status-badge--success / --warning / --error / --blue  /* pair text-color + soft-bg per §1 */
```

### Cards / panels
- `.panel`: `--surface` bg, `--line` border, `--radius`. `.panel-heading` is a `72px` min-height header row (title + optional action) with a bottom divider — this is the standard header for any bordered content block (tables, charts, lists).
- `.stat-card`: KPI tile — icon chip (`.stat-icon`, tinted square, 34px) top, big number (`1.8rem`, navy, tight tracking) + label beneath. Grouped 4-up in `.stat-grid`.
- `.admin-stat-strip` / `.kpi-ledger`: a denser, borderless "ledger" alternative to stat cards — 4 columns divided by internal `1px` rules instead of individual card borders, used on analytics/finance/HR dashboards. Numbers here are bigger and more condensed (`2rem`, tabular-nums). Use stat-grid for dashboard summaries with breathing room; use the ledger pattern for dense reporting screens.
- `.content-grid`: the standard 2-up dashboard layout, `minmax(0,1.4fr) minmax(320px,.8fr)` (main panel + side panel), collapsing to 1 column at 1120px.

### Data tables
```css
.records-panel .records-toolbar   /* search + filter + count row above the table */
.search-control                   /* icon+input pill, muted bg */
.filter-control                   /* bordered select-with-icon pill */
.data-table                       /* min-width 780px inside .table-scroll (horizontal scroll on overflow) */
th   /* uppercase, .62rem, weight 780, letter-spacing .07em, grey-on-off-white */
td   /* .75rem, --ink-ish grey, row divider, hover = surface-hover tint */
.member-cell                      /* avatar + name/subtext compound cell, clickable */
.row-actions button / .icon-action /* 31–34px circular/rounded icon buttons, hover = tinted, disabled = grey */
.empty-state / .loading-row       /* centered icon+copy block; loading uses a spinning icon */
.state-skeleton                   /* shimmering placeholder bars (skeleton-scan keyframe) for page-level loading */
```
Status/danger destructive icon actions get their own hover tint (`--red`/`--red-soft`) via `.icon-action--danger` / `.row-action--danger`.

### Drawers & modals
- **Drawer** (`.drawer`): right-side panel, `min(720px, 94vw)` wide, slides in (`slide-in` keyframe), full-height flex column: sticky header (title + close), scrollable `.drawer-form` body (reuses `.form-section`/`.form-grid`), sticky blurred footer `.drawer-actions` (right-aligned buttons, delete action pinned left via `.drawer-delete-action`). Scrim: `rgba(11,27,38,.46)` + 2px blur.
- **Modal** (`.modal-card`): centered, `min(460px, 100vw-28px)`, `12px` radius, uses `--shadow`. Header/footer follow the same title+close / right-aligned-actions convention as the drawer. `.modal-card--wide` (720px) and `.user-edit-dialog` (620px) are named width variants — prefer adding a new width variant over inlining a width.
- **Destructive confirmation** (`.destructive-dialog`): modal variant with a `3px` red top border, a red icon chip, and an "identity" block (`.destructive-dialog__identity`) restating what/who is being deleted before the confirm button.
- **Import review** (`.import-review`): a wide (1160px) modal for bulk-import flows — header, a summary chip row (ready/attention counts), a scrollable checkbox table, and a footer with pagination + confirm.

### Toasts
`.toast`: fixed bottom-right, green success default, `.toast--error` variant, icon + message + dismiss button, `box-shadow`, slides/sits above everything (`z-index: 100`).

### Navigation & identity chips
Reused "chip" shape across the app: an icon/avatar + two-line text (`strong` name, `small` meta) + optional trailing control — this exact grid shows up as `.member-cell`, `.attention-item`, `.presence-list > div`, `.user-edit-identity`, `.destructive-dialog__identity`, `.profile-chip`. When building a new list row that pairs an identity with metadata, reuse this compound-cell pattern rather than inventing a new one.

### Charts (hand-rolled SVG, no chart library)
- Line/trend: `.chart-line` (3px round-cap stroke in brand red), `.chart-dot`, grid lines in `--line`.
- Donut: `.donut-track` (grey) + `.donut-segment` (brand red, animated `stroke-dasharray`), rotated -90° with counter-rotated center label.
- Bars: `.breakdown-bars` — label/value row above a `5px` rounded track, filled bar colored by series (red primary, gold/muted for others).
- Horizontal coverage meter: `.coverage-chart` — label, `8px` track, filled `i` bar, value, one row per metric.
All charts are monochrome-brand by default (red = primary series); gold and muted grey are the only secondary series colors — don't introduce arbitrary chart colors.

---

## 6. Public site components (marketing)

- **Header/nav**: sticky, blurred; nav links get a soft grey hover pill; a single filled-red "Portal" CTA sits at the end of the nav, visually distinct from the plain text links.
- **Hero**: full-bleed red-gradient photo/graphic background (`.public-hero`), giant balanced-wrap headline, lead paragraph, button row, and a 4-up translucent **metric strip** anchored to the hero's bottom edge (`.public-metric-strip`, gold numbers + grey caption).
- **Editorial two-column bands** (`.public-intro`, `.public-about-band`, `.about-manifesto`, `.unhcr-context`): a narrow index/eyebrow column + a wide heading/copy column, `min(1240px, 100%-44px)` container, generous vertical padding (`clamp(78px,10vw,140px)`).
- **Ledger rows** (`.workflow-ledger__row`): numbered process steps as full-width table-like rows (index, label, description, icon), one row can be "focused" (inverted to solid red) to draw the eye.
- **Proof section** (`.public-proof`): dark navy band, big heading + a divided list of credibility stats/claims with gold check icons.
- **FAQ**: native `<details>/<summary>` accordions (`.faq-list`), rotating plus-icon on open, no JS state needed.
- **Footer**: 3-column dark navy grid + bottom legal row.

Public components are visually louder (bigger type, more color, more motion — `logo-motion` drift/orbit/sweep keyframes on the hero) than the app shell, which stays quiet and dense. Keep that contrast intentional: never bring `.public-*` styling into the operations app, or app density into the public site.

---

## 7. Icons

`lucide-react` throughout, sized to their context via `width`/`height` (no fixed icon-size token — common sizes observed: `15–20px` inline, `24–34px` inside chip backgrounds). Icon chips (`.stat-icon`, `.role-icon`, `.settings-ledger__number`, `.destructive-dialog__icon`) are always a tinted-square (`color` = brand/status color, `background` = matching `-soft` token, `radius` ~7–8px) — this is the standard way to present a single icon as a small badge anywhere in the app.

---

## 8. Interaction & accessibility conventions

- Every interactive element gets the shared focus ring (§3) — don't override `outline: none` without replacing it.
- Hover states are subtle color/background shifts (never scale/shadow pop in the app; the public site's `.public-button:active { scale(.98) }` is the one exception, reserved for marketing CTAs).
- Destructive actions always require a confirmation dialog that restates the target identity (`.destructive-dialog__identity`), and in the case of member deletion, requires re-typing an identifying number.
- Loading states: inline spinner (`.spin`, 900ms linear) on buttons/loading rows; full skeleton bars (`.state-skeleton`) for page-level loads; never a blank screen.
- `prefers-reduced-motion: reduce` is respected globally — any new animation must keep working (or become instant) under that query without extra code, since the blanket rule already zeroes durations.

---

## 9. Practical rules for extending this system

1. **Reuse a token, never a literal.** New colors should be one of the existing `--token`/`-soft` pairs; new radii should be `6–8px` (controls) or `999px`/`50%` (pills/avatars) or `12px` (modals) — don't introduce a fourth radius.
2. **Reuse a shape before inventing one.** Compound identity cells, status badges, icon chips, panel headers, and the drawer/modal action-footer are all established patterns — apply them rather than writing new one-off CSS.
3. **App vs. public are separate languages.** Check which shell a new screen belongs to and pull from the matching token set/component list — don't mix `--blue`/`.button` with `--public-red`/`.public-button`.
4. **Dark mode is additive.** Any new app component should be built with tokens so it inherits dark mode for free; only add an explicit `[data-theme="dark"] .my-class` override if a non-token value (e.g., a raw rgba shadow) needs adjusting, following the existing overrides in `app.css` as examples.
5. **Density signals hierarchy.** Dashboards/reporting use the tighter "ledger" pattern; day-to-day record management uses the airier `.stat-card`/`.panel` pattern. Pick based on how information-dense the screen needs to be, not by default.
