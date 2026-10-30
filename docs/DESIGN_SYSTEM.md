# Design system
Production baseline: `5d8b002`. Brand v2 is a candidate lane, not confirmed deployed.
Q8 identifies candidate `65a676c` with no deploy yet; do not describe its palette as production.
TODO(owner): confirm the deployed `BRAND_V2` state and current acceptance verdict.

## Token locations
- Production CSS: `src/app/tokens.css`, imported/mapped by `src/app/globals.css`.
- Shared production palette for email/PDF: `src/brand/tokens.json`.
- Brand-v2 source: `tokens.css`; fonts under `brand-v2/fonts/`.
- TODO(owner): confirm the full brand-v2 token path and inspect `guideline/index.html`.

## Production palette
| Role | Values |
| --- | --- |
| Primary / hover / pressed / soft | `#B4532A` / `#9C4522` / `#7F3819` / `#FBEDE5` |
| Accent / soft | `#F2B544` / `#FDF3DC` |
| Ink / secondary / muted | `#2E2622` / `#5C4F47` / `#7A6B61` |
| Background / surface / secondary surface | `#F7F1EA` / `#FFFFFF` / `#FBF7F2` |
| Border / strong | `#E8DED3` / `#CDBFB1` |
| Success / warning / danger / info | `#276B43` / `#8A5A12` / `#B42318` / `#2F5D8A` |

Production radii: 8/12/20px; focus ring: 3px with primary at .35 alpha.
Production font stack: system, PingFang TC, Noto Sans TC/CJK TC, Microsoft JhengHei, sans-serif.
TODO(owner): document production spacing and type scales from CSS.

## Brand-v2 tokens
| Role | Values |
| --- | --- |
| Primary / hover / pressed / soft | `#14325C` / `#0F2748` / `#0B1F3A` / `#E3EAF3` |
| Accent / tint / ink | `#2F6BFF` / `#E8EFFF` / `#1F4FD1` |
| Background / surfaces | `#F4F6F8` / `#FFFFFF` / `#EEF2F6` |
| Border / divider / strong | `#DDE3EA` / `#E8ECF1` / `#7F8B9C` |
| Text / secondary / muted | `#1B2533` / `#4A5668` / `#687384` |
| Success / warning / danger / info | `#2A7254` / `#935C0F` / `#B0413E` / `#23748A` |

V2 type size/line-height: display 34/40, h1 22/30, h2 17/24, body 15/22, small 13/19, caption 12/17px.
Weights: 400/500/700; wordmark 800. zh/en body line-height: 1.6/1.45.
Spacing: 4/8/12/16/20/24/32/40px. Radii: 6/10/14/999px.
Controls: 48px; tab bar: 64px; mobile width: 390px; desktop content: 960px.
Focus: 2px cobalt outline, 2px offset; white ring on navy.
Accent is sparse and never the primary button color; no cobalt text on navy.

## Fonts and logos
Self-host approved Inter and Plus Jakarta Sans variable Latin WOFF2 files; SIL OFL 1.1 notices accompany them.
Use `font-display: swap`; preload only Inter. Amounts use Inter tabular numerals.
P1 Chinese uses system CJK fonts; do not infer self-hosted Noto from the generic token stack.
TODO(owner): verify notices for all distributed fonts.
With v2 ON, use v2 icons/manifest only; OFF retains current assets.
Manifest: “Condola 租多啦” / “Condola”; theme `#14325C`, background `#F4F6F8`.
Stacked logo: `logo/A_roofc/lockup_stacked_{color,dark,mono}.svg`.
One bright point on the symbol; lettering navy/white. Login width: mobile 160px, desktop 200px.
Clear space above/below: at least half the symbol height; light background uses color, navy uses dark.

## Responsive behavior and copy
390px is evidenced in tokens; TODO(owner): substantiate the requested 1280px viewport/breakpoint.
Production manager tables become cards at content-container width ≤800px; document tables remain tables.
Use short, factual, active sentences; empty states guide; errors explain the next step without blame.
Use 屋主 and 租客/房客. No tenant-verification, money-handling, guaranteed-outcome or registered-company claims.
TODO(owner): reconcile legacy slogans, English proposals and copy-guard false positives with Q6.
Strings: `src/i18n/{zh-TW,en}.json`; design keys `s_*`, dynamic keys `i_*`.

Sources: `repo_README.md`; `brand_tokens_prod_5d8b002.json`; `tokens.css`; `flag-on-decisions.md`; `brand_strategy_head.md`; `decisions.md` Q6/Q8.
