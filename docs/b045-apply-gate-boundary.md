# B-045 apply-gate boundary (design-note addendum)

Canonical copy also lives at `/workspace/e2e/results/b045-pricing-1111/design-note.md` (section “Apply-gate boundary addendum”).

## Apply-gate boundary addendum (2026-11-12, America/Los_Angeles / PST)

**Trigger:** QA r2 on exact SHA `ea743f3ffbd34e67116fed6f02221709465276aa` (merge GO, flags OFF). The apply gate used `isPricingInterimGloballyEnabled` (`enabled === true` only), so an internal-only ON (`enabled: true`, `allowed_org_ids` = the 4 internal orgs) would expose anonymous GET `/pricing/apply` and `actionSubmitPricingApply`. That is the hole this addendum closes.

**Citations:**
- Design-note §5: 匿名／無 org context 一律 OFF；公開頁 GO 為獨立判定。
- Design-note Q-C and §11 steps 5–6: 4-org GO first（用量卡＋申請表＋登入版新 `/pricing`）；另一次 GO 才讓匿名訪客看到新公開頁。
- C3 (hub `20-build/specs/B-045.md`, this note’s test-plan addendum): prod ships flags OFF, verified on internal orgs only; logged-out `/pricing` and `/apply` need a separate public GO with Ron’s own words.
- Stories: PLT-30-AC1 / PLT-30-AC2 (public apply form + submit), PLT-28-AC1 (paid CTA → apply), R11 (fail-closed 4-org admission).

**Rule (fail-closed), chosen implementation:**

Anonymous (logged-out / non-staff) GET `/pricing/apply` and `actionSubmitPricingApply` return **404** and never insert unless **public mode** is on.

Public mode is true only when `platform_settings.pricing_interim` is a plain object with **`enabled === true` AND `public === true`** (strict booleans). Missing, malformed, `"true"`, `1`, or `public` absent/false ⇒ not public. `enabled !== true` is a kill switch even if `public: true`.

Empty `allowed_org_ids` is **not** public mode. Reasons:
1. The default seed is `{enabled:false, allowed_org_ids:[]}` — treating an empty allowlist as public would be a footgun if `enabled` is flipped first.
2. `pricingInterimOn` (R11) requires the org ∈ allowlist. Clearing the allowlist to “go public” would drop internal-org admission (usage card, logged-in `/pricing`).
3. Public cutover is an independent GO (Q-C, C3, §11.6) and must be an explicit switch, not an implicit side effect of allowlist shape.

**Internal-only ON** (`enabled: true`, non-empty allowlist, `public` absent/false):
- Anonymous GET/POST → 404, no insert.
- Staff session whose `liveOrgId` is admitted by `pricingInterimOn` (enabled + org in allowlist + org `feature_flags.pricing_interim === true`) → intended apply form / submit path (PLT-30).
- Non-allowlisted staff, tenant/owner sessions, or missing session → 404.

**Public mode** (`enabled: true`, `public: true`): anonymous and authenticated GET/submit keep the current flag-ON public path (form renders; valid submit inserts). Per-org UI (`/pricing` dual-track, usage card) still uses `pricingInterimOn` until a separate public `/pricing` cutover.

**Activation:** Do not set `public: true` in any hosted environment until a public GO that includes Ron’s own words (C3). This addendum does not change prod flags, does not merge, and does not deploy.

**Field-name note for CEO:** `public` on the existing `pricing_interim` JSON is a PE implementation choice so public cutover stays independent of the 4-org allowlist. Setting it to true still requires Ron’s own-words GO (already ruled). No flag change ships in the apply-gate commit.

**CEO confirmation and fail-closed default (2026-11-12 05:26 PST):** CEO confirmed the field name `public` on `pricing_interim`. `public` defaults to false. A missing field, a non-boolean value (`"true"`, `1`, etc.), or a JSON parse failure of the setting is treated as `public=false`. Anonymous GET `/pricing/apply` and `actionSubmitPricingApply` then return 404 with no insert. Setting `public:true` still needs Ron’s own words plus a separate CEO GO and an audit reason; this change does not set it.
