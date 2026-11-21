# Marketing site snapshot

Plain copy of `condola-site-v2` branch `feat/b045b-pricing-site` at

`940ad780710ce19a9600a52e0194b442b007ad1f`

into `site/`. The live production Worker remains `condola-site` on `condola.app` and is not deployed from this tree until a separate CEO exact-SHA GO (and a C3 public GO for logged-out `/pricing`).

- Source SHA tests, `npm run build`, and `npm run secret-scan` live in this directory.
- `npm run build` also emits `dist-prod/` (gitignored): `/pricing` and `/apply` are omitted so they 404, with `X-Robots-Tag: noindex, nofollow` on those paths. Trial-button copy stays in source `pricing.html` (Ron 23:37). Staging deploys use the source tree plus a staging-only noindex overlay, not `dist-prod/`.
