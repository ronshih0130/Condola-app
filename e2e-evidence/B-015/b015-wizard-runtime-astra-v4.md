# B-015 independent review of the v4 wizard runtime

**Desktop existing-tenant submission passed in both languages. Both 390 cases reached review but stopped before final submit. No core product blocker was established. The four-case diagnostic remains incomplete.**

## What the original captures show

In both 390×900 cases all seven Next controls received ordinary pointer input. On review, the long room name was wider than the card. The English card moved 196 px with a genuine horizontal wheel gesture. Its initial and panned views covered [0, 207.70] and [47.70, 377.38] px of the same rendered label. The Chinese card moved 158 px, covering [0, 245] and [47, 377.06] px. I read the full room names across the overlapping original screenshots. Tenant, rent and deposit were visible initially in both languages. The English final-button label extends off the viewport; the Chinese label fits. Neither mobile case performed the final enabled-state check, hit test, pointer click or lease readback. The one-view room-text rule stopped both cases.

## Desktop outcome and isolation

Both 1280×900 cases recorded a final pointer hit and one persisted lease linked to the same original Jamie Lin contact. Rent was NT$10,000, deposit two months, day 5, term 2094-01-01 through 2094-12-31. Each selected-org contact count stayed at 10. Both known firms retained their OFF fixture flag objects. No baseline IDs were missing, changed or added. Organization enabled and opt-in counts and the two named platform activation counts were zero. The seed originally had line_alerts true in both firms. The fixture intentionally left both OFF.

The clone and seed exited 0, browser and effective exits were 1, and the server exited 0 with no owned processes remaining. The receipt reported no cleanup error. No console, page, 5xx or external error was recorded. All 66 receipt artifact bindings, 1,006 before/after pins and both helper hashes matched. All 48 original PNG headers agree with the intended widths (26 mobile, 22 desktop). I visually inspected the six mobile review captures and both desktop submit captures. Desktop/mobile observations are Chromium viewport observations.

## Remaining local check

Run EN and zh-TW at 390×900 only on unchanged product code and a fresh owned fixture/evidence namespace. Keep unique displayed target selection, all seven natural Next clicks, and fully visible tenant/rent/deposit. For the one long room string allow contiguous coverage of the identical rendered text range across overlapping views after observed user scrolling. Require matching content and geometry, vertical visibility and original screenshots. On each locale record the final button before waiting or scrolling, then its enabled state, ancestor clips, hit-test points and a genuine pointer click. Verify one created lease for the exact room, primary original contact, unchanged org contact count, terms, no console/page/5xx/external errors and final controls. Preserve v4 as incomplete. No product edit or full gate is indicated by this evidence.

- `receipt.json` · 186027 bytes · `04cf09efd5d50942d22a5b0b10196d6bfec3e2fba26082b16ab44b5b366ce8d4`
- `browser-result.json` · 531 bytes · `7b6ff1f586e43128fb414bf725d5932717d813fc0b6a80cf347906ee7eb2c598`
- `source-lock-v4.json` · 88262 bytes · `d6857c408de4c3c9b644e57a7d1bf4064ff703ac33e9cb8b40611efd59c23fb8`
- `flags-seed.json` · 542 bytes · `555855bf1ab77509e27beb8cef48ba60d16030b3eb1c5b0b8fe59a892403095f`
- `flags-off.json` · 544 bytes · `35130523593e75e553aa8ac5859f5df3528432427a35397433f242b9ac39d7af`
- `flags-final.json` · 661 bytes · `48f9ef926d6c9a11cf94fdcc67e0fd9b6b791a1013be2136e64e8952262e6563`
- `en-390.json` · 130344 bytes · `c592a2324e82e59bd496f07fedfe7bbaaaafaca9f22ef84ef278ba056806f827`
- `zh-TW-390.json` · 130257 bytes · `541b2d7c6216936a177047f6f422260b429f0abd1ba279ac897ae4086099224f`
- `en-1280.json` · 84066 bytes · `4588c72f2564e13d1d616e1f4f7fcdb0b4a2496edde71dd1b60d1e37f8e2746a`
- `zh-TW-1280.json` · 83916 bytes · `7c9ea575a368c827dd9f0c53d7280aca3e4711f36f184694f950f43ee9e7de71`
