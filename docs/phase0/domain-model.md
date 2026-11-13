# Phase 0 — Domain model (current, with gaps; proposed target for plans/trials only)

| | |
|---|---|
| App SHA | `1e0a8ab` (GitHub `main`) |
| Date | 2026-11-13 PT |
| Author | Mac Claude (Phase 0 draft, Fable) |
| Status | **DRAFT for CEO review.** The "Proposed target" in §11 **needs CEO review** and decides no product question |
| Requirement | hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2.2; hub `20-build/specs/B-056.md` |

**Evidence rules**

- All table, column, constraint, trigger and policy statements are **from migrations/docs, not a live schema dump** (160 files in `supabase/migrations` at `1e0a8ab`).
- "Enforced where" uses four labels: **DB** (constraint / trigger / exclusion), **RLS** (policy, effective only on the `tx()` path — see `architecture-map.md` §4), **Server** (TypeScript in `src/server`), **None found** (grep found no enforcement; not proof of absence).
- Do not build anything listed in hub `INDEX.md` § "Do NOT build" (`INDEX.md#do-not-build`). Linked, not copied.
- Terms follow hub `GLOSSARY.md`.

**Shared patterns across domains**

| Pattern | How it is done | Where |
|---|---|---|
| Org scoping | almost every domain table carries `org_id`; children use composite FKs `(org_id, parent_id) → parent(org_id, id)` so a row cannot point across orgs | DB, `20261018120000_schema.sql` |
| Live vs sandbox | `organizations.environment` ∈ `live`/`sandbox`; a sandbox org references its live org (`organizations_environment_shape` CHECK) | DB, `20261020180000_sandbox.sql`; RLS via `app.env` pin |
| Row audit | trigger `fn_audit` on 35 core tables writes `audit_log` with `app.change_reason` / `app.request_id` | DB, schema lines 1600-1613 |
| Append-only | trigger `fn_append_only` on `ledger_transactions`, `ledger_entries`, `audit_log`, `lease_signature_events`, `meter_readings`, `identity_document_access_log` | DB, schema lines 1567-1572 |
| Money | integer minor units (`*_minor bigint`), `currency char(3)` FK to `currencies` | DB |
| B-series tables | feature tables live in schema `app`, prefixed by B 項 number; most are reachable only via `SECURITY DEFINER` functions or `service_role` | DB |

---

## 1. Org and membership

**Entities.** `organizations` (name, country, timezone default `Asia/Taipei`, `plan_tier`, `feature_flags` jsonb, `settings` jsonb, `environment`, `live_org_id`, `live_enabled`), `org_members` (`role`, `status`, `is_billing_owner`), `invitations`, `profiles`, `platform_settings`; custom roles in `app.b017_roles`, `app.b017_role_revisions`, `app.b017_assignments`.

| Invariant | Enforced where |
|---|---|
| One membership per user per org (`UNIQUE (org_id, user_id)`) | DB |
| Role ∈ `admin`, `manager`, `accountant`, `maintenance`; status ∈ `invited`, `active`, `suspended`, `removed` | DB enums |
| The billing owner is always an admin (`CHECK (NOT is_billing_owner OR role = 'admin')`) | DB |
| Sandbox org must point at a different, live org | DB CHECK |
| Only `active` members resolve an org; a user with only `suspended` memberships is refused at sign-in | Server (`org-scope.ts:108`, `auth.ts:226-235`) |
| Page/API permission by role | Server (`perms.ts` `PERMS`, `permForPath`, `assertPerm`); RLS helpers `app.is_member`, `app.has_role` on the `tx()` path |
| Seat cap: Free 1, Standard 5, otherwise unlimited; counts active members + pending team invites; serialized by `SELECT … FOR UPDATE` on the org | Server (`billing.ts:44-48`, `seats.ts`) |

**Gaps.**
- "At most one billing owner per org" — **None found** as a DB constraint (unverified).
- Seat tier comes from `settings.plan.tier`, falling back to `plan_tier` (`sandbox-data.ts:177-183`). An org on enum value `beta` with no `settings.plan.tier` gets **no seat cap** (`seatLimit` returns `null` for anything but `free`/`standard`).
- `suspended` is used today for manual deactivation (`auth.ts:851`). It carries no reason, so "paused by plan" and "deactivated by Admin" are indistinguishable (matters for B-056, §11).

## 2. Property, unit, room

**Entities.** `properties`, `units` (`rental_mode` ∈ `whole_unit`/`by_room`, `archived_at`), `rooms`, `meters`, `meter_readings`; unit invites in `app.unit_bindings`, `app.unit_invite_secrets`, `app.unit_invite_attempts`, `app.unit_invite_display`; B-005 QR tables `app.b005_unit_qr_*` (feature must stay OFF — see "Do NOT build").

| Invariant | Enforced where |
|---|---|
| Unit label unique per property; room label unique per unit | DB UNIQUE |
| Unit/room belong to the same org as their parent | DB composite FK |
| Changes to `units.rental_mode` are guarded | DB trigger `trg_unit_mode_guard` (rule body not re-read) |
| At most one live invite secret per unit; 4-seat cap per unit binding even on direct writes | DB unique index `unit_invite_secrets_one_live_per_unit` + BEFORE trigger (`20261110110000_unit_line_invite_seat_cap.sql`) |
| Invite tables deny direct access (RLS enabled **and forced**) | DB |

**Gaps.**
- No per-unit "read-only" or "editable" state exists. Edits are gated only by role permissions. B-056 read-only units need a new server-side decision point (§11).
- Archive is a timestamp (`archived_at`); no hard delete path is documented here. Permanent deletion needs Ron's words (P56).

## 3. Lease, tenant, contact

**Entities.** `leases` (`status`, `esign_status`, `start_date`, `end_date`, generated `term`, `target_unit_id` xor `target_room_id`, `signed_at`), `lease_parties`, `contacts` (`is_owner`/`is_tenant`/`is_vendor`, optional `user_id`), `contact_channels`, `lease_charges`, `lease_templates`/`lease_template_versions`, `lease_signatures`, `lease_signature_events`, `lease_signed_pdfs`; e-sign `esign_cases`, `esign_versions`, `esign_signers`, `esign_signature_images`, `esign_audit_events`, `esign_disposals`, `esign_retention_extensions`; paper lease versions (`20261030151500_paper_lease_versions.sql`; table names not re-read); tenant directory edits `app.b015_edit_commands`; move-in/out and handover `app.handover_*`.

| Invariant | Enforced where |
|---|---|
| A lease targets exactly one of unit or room (`num_nonnulls(...) = 1`) | DB CHECK |
| **No double-booking:** `pending_signature`/`active` leases on the same unit or room cannot overlap in time | DB `EXCLUDE USING gist` (two constraints on `leases`) |
| `end_date >= start_date`; renewal chain cannot self-reference | DB CHECK |
| Lease target consistency on change | DB trigger `trg_lease_target_guard` |
| Deposit vs rent rule check | DB trigger `trg_lease_deposit_check` |
| One party row per contact per lease | DB UNIQUE |
| Template versions immutable; signature events append-only | DB triggers |
| E-sign tables: RLS forced, no DELETE/TRUNCATE, `service_role` insert/select only | DB (`20261030150900_esign_core.sql`) |
| "Billable active lease" = `status = 'active' AND (signed_at IS NOT NULL OR esign_status = 'imported')` | Server constant `BILLABLE_ACTIVE_LEASE` (`billing.ts:12`) |
| Tenant sees only own leases | RLS helpers `app.is_lease_tenant`, `app.my_tenant_leases()`; view `tenant_lease_picker` (`security_invoker`) |

**Gaps.**
- `esign_status` gained the value `imported` after the initial schema (`20261026130000_bulk_import.sql:20`); imported paper leases are `active` with `signed_at` NULL and still count as billable.
- "Billable unit" is defined in SQL fragments inside server code (e.g. `partners.ts:309-314` counts `DISTINCT coalesce(target_room_id, target_unit_id)`), not in one shared DB function. B-056 needs a single definition for "the 5 earliest-lease-start units".
- E-sign remainder (B-001) is box-PE-owned; `ESIGN_ENABLED` and `id_sign_gate_v2` stay OFF.

## 4. Owner

**Entities.** `property_owners` (`ownership_bp`, `can_view_tenant_phone`, `effective_from`/`effective_to`), owner contacts (`contacts.is_owner`), `management_agreements`, `owner_statements`, `owner_statement_lines`, `app.b014_statement_versions`, `app.b014_report_delivery_events`, `app.b022_*` (receipt title, report replies), owner repair policy `app.b013_*`.

| Invariant | Enforced where |
|---|---|
| Ownership share 1–10000 basis points per row | DB CHECK |
| One row per (property, owner, effective_from) | DB UNIQUE |
| Owner reads only own properties | RLS helper `app.is_property_owner` |
| Owner sees tenant phone only when `can_view_tenant_phone` (or caller is a member) | DB — `app.owner_lease_tenants()` (`SECURITY DEFINER`), view `owner_lease_tenants` (INC-RLS-1112) |
| Owners never see ID documents | DB/RLS + Server (comment on `property_owners`, ID modules) |

**Gaps.**
- Shares across co-owners summing to 100% — **None found** in DB (unverified).
- The legal lock on custodian override (MGT-83-AC6) stays until legal review + Ron (handoff R14).

## 5. Vendor and work order

**Entities.** `maintenance_tickets` (`status`, `priority`, `category`, `cost_bearer`, `owner_approval`), `ticket_comments`, `ticket_attachments`, `repair_vendor_jobs`, `repair_vendor_secrets`, `repair_vendor_job_shared_photos`, `repair_vendor_sharing_history`, `job_types`, `vendor_profiles`, `vendor_profile_versions`, `vendor_issuers`, `vendor_documents`, `vendor_document_grants`, `vendor_document_pdf_bytes`, `vendor_onboarding_invites`; document gate `app.b025_*`; accounts/estimates `app.b026_*`; repair commands/events `app.b013_repair_*`; costs `app.repair_cost_*`; dispatch `app.b039_dispatch_events`, `app.b030_vendor_assignments`.

| Invariant | Enforced where |
|---|---|
| Ticket number unique per org | DB UNIQUE |
| Ticket's unit/room/lease/assignee belong to the same org | DB composite FK |
| Vendor tables deny direct access (RLS forced) | DB |
| Vendor token access by hashed secret; no login | Server (`vendor-job.ts`, `vendor-link-rules.ts`) |
| Vendor sharing requires sandbox or `plan_tier = 'beta'` | DB function + Server (`20261030150200_vendor_repair.sql:134`, `repair-approval.ts:341`) |
| Ticket photo access is a separate permission from ticket text (ADR-010) | Server (`perms.ts:195-198` `canTicketPhotos`) |

**Gaps.**
- Vendor dispatch reads `plan_tier = 'beta'` directly. Any change to plan vocabulary (§11) touches this gate.
- VEN-14/15 are release-blocked on V-12/V-13 (B-026) per handoff; not Mac work in Phase 0.

## 6. Money flow

**Entities.** `invoices`, `invoice_lines`, `payments`, `payment_allocations`, `ledger_transactions`, `ledger_entries`, `fee_rules`, `expenses`, `bank_accounts`, `bank_statement_imports`, `bank_transactions`, `bank_match_suggestions`, `month_closes`, `utility_bills`, `utility_allocation_runs`/`_lines`, `payee_account_numbers`; B-series: `app.b008_monthly_rent_*`, `app.b009_*` (bank match decisions), `app.b010_payment_*`, `app.tenant_period_due_components`, `app.deposit_settlement_*`, source events `app.b017_occurrences` / `app.b017_old_source_transactions`; owner net ledger and transfers (`20261106030000_b014_owner_net_ledger.sql`; table names not re-read).

| Invariant | Enforced where |
|---|---|
| **Ledger transactions balance:** ≥ 2 entries, sum 0, single currency | DB deferred constraint trigger `trg_ledger_balanced` |
| Ledger is append-only; corrections are reversals | DB trigger `fn_append_only` |
| Invoice totals recomputed from lines and allocations | DB triggers `trg_invoice_lines_recalc`, `trg_payment_alloc_recalc`, `trg_payment_status_recalc` |
| Payment allocations are guarded on insert/update | DB trigger `trg_payment_alloc_guard` (rule body not re-read) |
| Confirmed payment needs `confirmed_by` + `confirmed_at`; rejected needs a reason | DB CHECK |
| Utility rate caps | DB triggers `trg_allocation_rate_cap`, `trg_allocation_line_cap` |
| Idempotent commands (monthly rent, payments, bank decisions) | DB unique keys in `app.b008_*`, `app.b009_*`, `app.b010_*` + Server |
| A tenant report is not a confirmed payment | DB status model (`submitted` → `confirmed`) + copy guard |

**Gaps.**
- `deposit_settlement` stays OFF; custodian override is legally locked (handoff §2.2).
- Condola's own subscription billing (what a 管理方 pays Condola) is **not** in this ledger; it is the Plans domain (§8).

## 7. Notifications and LINE

**Entities.** `notifications` (`dedupe_key` unique per org), `deliveries`, `reminder_rules`, `message_threads`, `messages`, `thread_participants`, `email_log`, `line_channels`, `line_account_links`, `line_push_usage`; notification center `app.b028_*` (events, recipients, claims, delivery attempts, read markers); LINE platform `app.b033_*` (identities, sessions, push reservations, budgets, quota alerts, webhook events), `app.b037_*`, `app.b038_*`, `app.b039_*`.

| Invariant | Enforced where |
|---|---|
| One notification per dedupe key per org | DB UNIQUE |
| A delivery belongs to exactly one of notification or message | DB CHECK |
| Recipient claims and push reservations are idempotent | DB unique keys in `app.b028_*`, `app.b033_*` |
| Sandbox orgs never send | Server (`outbound.ts` `canSendReal`) |
| LINE push needs platform env switch + quota guard + flags | Server (`line/config.ts`) |
| Shared LINE account scope and 180/month switch to email (ADR-021) | Server (`line/quota.ts`, `LINE_PUSH_MONTHLY_LIMIT`) — rule-to-code mapping unverified |

**Gaps.**
- Two generations coexist (`notifications`/`deliveries` and `app.b028_*`), each behind `*_v2` flags.
- In-app banners with per-threshold dismissal (B-056 MGT-98) have no existing entity confirmed here; whether `app.b028_*` can carry them is OPEN (§11).

## 8. Plans, usage and trials (current)

**Entities and code — four overlapping mechanisms.**

| # | Mechanism | Where | State |
|---|---|---|---|
| A | Column `organizations.plan_tier`, enum `beta`/`free`/`pro`/`business`, default `beta` | `20261018120000_schema.sql:86,165` | read as fallback tier; read directly by vendor gates |
| B | JSON `organizations.settings.plan = { tier, trialUntil }` | signup writes `{tier:"free", trialUntil:null}` (`signup.ts:653`); `requestUpgrade` writes `{tier, trialUntil: now() + N months}` (`partners.ts:293-324`) | the de-facto plan + trial record |
| C | Partner pricing: `partner_codes` (`free_units` default 4, `trial_months` default 3, `price_lock_months`), `firm_partner_prices` (per-org snapshot), `firm_price_overrides`, `upgrade_requests`; partner overrides `app.b027_partner_overrides` | `20261022120000_self_serve_signup.sql`, `partners.ts`, `partner-controls*.ts` | live; the seven INC-RLS-1112 tables include these |
| D | B-030 usage subscriptions: `app.b030_plan_versions` (only seed row `unconfigured`, prices constrained NULL), `app.b030_subscriptions` (one row per org; state ∈ `trialing`/`active`/`grace`/`restricted`/`canceled`), `app.b030_provider_events`; `app.usage_events` (dimensions `units`, `signatures`, `stored_bytes`, `notifications`, `vendor_jobs`) | `20261107070000_b030_usage_subscription_state.sql`, `usage-subscriptions.ts`, `b030-subscription-rules.ts` | flag `usage_subscriptions` OFF; mock provider only |
| E | B-045 interim pricing (display only): `INTERIM_FREE_UNITS=5`, `INTERIM_LIST_STANDARD=39`, `INTERIM_LIST_PREMIUM=59`; apply queue `pricing_apply_requests` (`plan` ∈ `standard`/`pro`/`unsure`, `paid_received_on`) | `b045-pricing-interim-rules.ts`, `20261112010000_b045_pricing_interim.sql` | flag `pricing_interim`; "MUST NOT invoice" per file header |

Billing constants: `LIST_STANDARD=30`, `LIST_PRO=40`, `FREE_UNITS=4` (`billing.ts:4-6`); `FREE_ACTIVE_UNITS=4` (`sandbox-data.ts:5`); yearly = 11 × monthly.

| Invariant | Enforced where |
|---|---|
| Only an Admin can request an upgrade | Server (`partners.ts:294` `assertStaff(session, ["admin"])`) |
| Partner code format, use count, expiry | DB CHECKs + Server |
| B-030 state transitions (e.g. `trialing` → `active`/`grace`/`canceled`), unique provider sequence per org, immutable events | DB function + triggers |
| B-030 tables unreachable by `anon`/`authenticated`/`service_role` directly | DB REVOKE + `SECURITY DEFINER` |
| Interim pricing admission is fail-closed (strict booleans, clean allowlist) | Server (`pricingInterimOn`) |
| Public `/pricing` / `/apply` need `public === true` | Server (`pricing-interim.ts`); `public:true` needs Ron's words + CEO GO (C3) |

**Gaps (all verified by reading code at `1e0a8ab` unless marked).**

1. **No one-trial-per-org guard.** `requestUpgrade` overwrites `settings.plan.trialUntil` on every call; nothing records "trial ever used".
2. **Trial length is rolling, not Asia/Taipei calendar.** `now() + make_interval(months => N)` in the DB session timezone; N comes from the partner snapshot, default 3 — the same length for both tiers.
3. **No automatic expiry.** `hasPlanOrTrial` compares `trialUntil` to "now" at read time, but it also returns `true` for any tier of `standard`/`pro`/`business` regardless of the date, and `requestUpgrade` sets the paid tier immediately. Nothing returns the org to Free.
4. **No server-side unit cap is enforced.** `overFree()` has no non-test caller; the error key `errors.planLimit` is defined but never thrown (grep over `src`, tests excluded).
5. **Three "free units" numbers:** 4 (`FREE_UNITS`), 4 (`FREE_ACTIVE_UNITS`, `partner_codes.free_units` default), 5 (`INTERIM_FREE_UNITS`, Ron's wording).
6. **Vocabulary conflict:** enum has `pro`/`business` and no `standard`; code tiers are `standard`/`pro`; B-045/B-056 copy says Standard/Premium with internal key `pro` for Premium (B-056 OPEN Q-H).
7. **`?trial=` is not consumed.** `trialCtaHref` builds `/signup?trial=…` and `/m/settings?trial=…` (`b045-pricing-interim-rules.ts:276-283`), but no reader of that parameter was found under `src/app/signup` or `src/app/m/settings`. Until B-056, staff activate trials manually (C1 revised).
8. **ADR-025** says "Trial is three calendar months" with rationale TODO; B-056 defines 3 (Standard) and 6 (Premium).
9. **Pay-then-activate clock** (`pricing_apply_requests.paid_received_on`) exists as a date set by an internal admin; no "開通到期" computation or business-day calendar was found.

## 9. Audit and consent

**Entities.** `audit_log` (append-only; written by `fn_audit` and by server `audit-write.ts`), `consents` (terms/privacy version, source ∈ `signup`/`reconsent`/`invite`/`portal`), `partner_agreement_consents` (document SHA-256, attested authority), PROP-04 consent records (`20261106080000_prop04_consent_records.sql`), ID-consent notice versions (`20261025…`–`20261029…` migrations), `app.payee_access_log`, `app.b017_governance_receipts`.

| Invariant | Enforced where |
|---|---|
| Audit log cannot be updated or deleted | DB trigger |
| Flag/production changes carry an audit reason (`app.change_reason`) | DB (`fn_audit` reads the setting) + release process |
| Consent rows carry non-empty versions and a document hash | DB CHECKs |
| Privacy / terms / consent / ID-notice text is immutable for agents | Process (QA-STANDARD "Copy and content checks") |

**Gaps.**
- Server-written audit rows on the owner path (`writeAudit` after `COMMIT`, e.g. `partners.ts:332`) are not atomic with the change they describe.
- B-047 deletion-complete is legally blocked (handoff R14); no deletion flow may be marked "completed".

## 10. ID documents

**Entities.** `identity_documents` (`doc_type`, `encryption_key_ref`, `expires_on`), `identity_document_photos`, `id_document_objects`, `id_document_wm_objects`, `id_upload_slots`, `identity_document_access_log`; ID sign gate `id-sign-gate*.ts` (`id_sign_gate_v2` OFF).

| Invariant | Enforced where |
|---|---|
| Access log append-only | DB trigger |
| Org retention days ≤ platform maximum | DB triggers `trg_org_retention_guard`, `trg_platform_retention_clamp` |
| Originals encrypted; served copies watermarked; signed, short-lived photo URLs | Server (`id-crypto.ts`, `id-watermark-image.ts`, `id-docs.ts`) |
| Upload size limits before the body is read | Server (`middleware.ts`, `id-upload-guard.ts`) |
| Purge runs only in mode `dry_run`/`on`, read fresh each run; restricted to the private bucket | Server (`id-purge-guard.ts`) + `platform_settings` |
| Owners never see ID documents; never attach ID photos to model tasks | RLS/Server + RULES |

**Gaps.**
- `ID_PURGE` stays OFF; retention is therefore not being executed (by decision). ADR-024 still carries a reconcile TODO.
- Bucket inventory beyond `id-documents-private` is **unverified**.

---

## 11. Proposed target — Plans, usage and trials (needs CEO review)

> Scope: responsibilities and reconciliation only. **No table, column, flag-key or function names are proposed** — naming is OPEN and belongs to the P37 design note. Nothing here changes code; `FREE_UNITS` stays 4 and plan tiers stay unchanged until a billing-change GO (handoff §5, C4). All behaviour sits behind a `pricing_trial*` flag, default OFF. Source: B-056 scope items 1–6 and ACs MGT-96…MGT-99.

### 11.1 Responsibilities the target must cover

| # | Responsibility | B-056 rule | Today |
|---|---|---|---|
| R1 | **Trial entitlement record per org**: ever-used marker, which plan was trialled, start, end, presentation state | One trial per org **across all plans combined**; includes expired trials and trials converted to paid (MGT-96-AC4) | none (§8 gap 1) |
| R2 | **Start decision on the server**: Admin only; server decides allowance; `?trial=` only selects which trial; takes effect immediately; no payment data | MGT-96-AC1…AC4 | `requestUpgrade` (Admin-only) writes JSON; parameter unread |
| R3 | **End date rule**: Standard +3 / Premium +6 **Asia/Taipei calendar months**; expiry instant is **00:00 Asia/Taipei** | scope 1–2 | rolling months from `now()` |
| R4 | **Automatic expiry job**: returns the org to Free with no paid activation; deletes nothing; same handling for both plans; idempotent and safe to re-run | MGT-99-AC1 | none; nearest crons are 09:00 and 03:00 Asia/Taipei |
| R5 | **Effective-plan resolution in one place**: Free / trial (with the paid plan's rules) / paid — used by seat cap, unit cap, usage card, banners | MGT-97-AC1/AC2, MGT-98-AC3 | spread over `planSnapshot`, `hasPlanOrTrial`, `seatLimit`, `upgradeGate` |
| R6 | **Server-side read-only above the Free unit count**: the 5 units with the earliest lease start stay editable; others view/export only; no edit, no new lease; enforced in server code and/or DB, not by hiding buttons | MGT-99-AC2 | no per-unit editability; no cap enforced |
| R7 | **Tenant app unaffected** for read-only units (view lease, report payment, report repair) | MGT-99-AC3 | n/a |
| R8 | **Pause extra managers**: accounts kept; back-office access paused for all but the original Admin; resumes on upgrade | MGT-99-AC5 | `org_members.status='suspended'` exists but has no cause |
| R9 | **In-app reminders at 14 / 3 / 1 days**: dismissible banner on `/m`; each threshold dismissed once; expired banner once; stop when paid | MGT-98-AC1/AC3, MGT-99-AC4 | none |
| R10 | **0 outbound**: no email / SMS / LINE from any trial path | MGT-98-AC2, P56 | real mail path exists in the app; must not be called |
| R11 | **Pay-then-activate**: paid plan activates after payment, within 1 business day of 入帳 (Asia/Taipei, Mon–Fri excluding national holidays); ops queue shows 入帳 date + 開通到期 | scope 6, PLT-41-AC5 | `paid_received_on` date only |
| R12 | **Audit**: every start, expiry, pause/resume and plan change leaves an audit row, atomic with the change | Class B + security review | `writeAudit` after commit |

### 11.2 Existing pieces that must be reconciled (not decided here)

| Piece | Conflict with the target | Options to weigh in the design note |
|---|---|---|
| `FREE_UNITS=4` (`billing.ts`), `FREE_ACTIVE_UNITS=4` (`sandbox-data.ts`), `partner_codes.free_units` default 4 vs `INTERIM_FREE_UNITS=5` and B-056 "5 units" | Read-only threshold (5) would differ from the invoicing allowance (4) | keep invoicing at 4 until the billing GO and use 5 only for the trial/read-only rule; or change all together under one GO. Partner snapshots with their own `free_units` need a stated precedence |
| `plan_tier` enum (`beta`,`free`,`pro`,`business`) vs seat tiers `standard`/`pro` vs copy Standard/Premium | No `standard` in the enum; `pro` means the top paid tier in code but "Premium" in copy; `beta` currently means "uncapped" and gates vendor sharing | leave the enum untouched and resolve the effective plan elsewhere; or migrate the enum (schema ADR + CEO GO). "Don't change plan tiers" (handoff §5) applies |
| `organizations.settings.plan.trialUntil` (+ `.tier`) | Untyped JSON, no history, overwritten on each upgrade request, read by seat and plan logic | keep as a derived/compat field written by the engine; or stop reading it after a cut-over. Existing non-null values need a counted (aggregate-only) inventory first |
| `partner_codes.trial_months` / `firm_partner_prices.trial_months` (default 3) | A second source of trial length; could grant a trial outside the one-per-org rule | does a partner trial count as "the" trial? does partner length override 3/6? |
| B-030 `app.b030_subscriptions` state `trialing` (+ `grace`, `restricted`) | A second trial/plan state machine, per org, provider-driven, currently mock-only and OFF; `restricted` overlaps with "read-only" | make B-056 independent of B-030; or make B-030 the future home and B-056 a first writer. B-030 is listed as a B-056 dependency |
| ADR-025 "Trial is three calendar months" | Now 3 (Standard) / 6 (Premium) | supersede with the Trial engine ADR; do not edit ADR-025 in place |
| `requestUpgrade` (sets paid tier + trial immediately, offline note) | Contradicts pay-then-activate and one-trial | retire, gate behind the old path only, or rewrite under the flag |
| `org_members.status = 'suspended'` | Candidate mechanism for paused managers, but indistinguishable from manual deactivation, so "resume on upgrade" could re-enable people an Admin disabled on purpose | reuse with a recorded cause; or compute access from effective plan without mutating membership |
| Crons `0 1 * * *`, `0 19 * * *` | Neither is 00:00 Asia/Taipei (16:00 UTC) | third cron trigger; or evaluate expiry lazily at read time and use a job only for banners/state; plan cron limits are unverified |

### 11.3 OPEN questions (decision owner in brackets)

| # | Question | Owner |
|---|---|---|
| O1 | Billing-change GO: does the invoicing allowance move 4 → 5, when, and with what impact scope? (C4 / R7) | Ron, via CEO |
| O2 | Exact flag key(s) under `pricing_trial*` | CEO, in the design-note review |
| O3 | Names of any new tables/columns/functions for trial state | CEO review of the design note (PE proposes) |
| O4 | Expiry mechanism: scheduled Worker cron, lazy evaluation, or both | CEO (technical), informed by Cloudflare plan limits (unverified) |
| O5 | Internal plan key for Premium: keep `pro`? (Q-H) | CEO |
| O6 | Is a further CEO↔Ron P52 confirmation needed before front-end work, or does mockup `b73680e` suffice? | CEO / Ron |
| O7 | Who is "the original Admin" that keeps access on expiry — the `is_billing_owner` member, the earliest-created admin, or the Admin who started the trial? What if there are several admins? | Ron, via CEO |
| O8 | "Earliest lease start" tie-break (same start date), and whether by-room leases count per room or per unit (today's billable count is per room-or-unit) | Ron, via CEO |
| O9 | Does the editable set of 5 get fixed at expiry, or recomputed as leases start/end? | Ron, via CEO |
| O10 | Do existing orgs with a non-null `trialUntil`, a redeemed partner code, or a manually activated trial count as "already trialled"? | Ron, via CEO |
| O11 | Do `beta` and sandbox orgs get trials, caps, or neither? | Ron, via CEO |
| O12 | Day counting for 14/3/1 and "試用還有 {d} 天": calendar days in Asia/Taipei, inclusive or exclusive of the end date? | CEO (copy source: approved mockup) |
| O13 | National-holiday calendar source for the 1-business-day rule, and who maintains it | Ron, via CEO |
| O14 | Relationship to B-030: dependency only, or shared state? | CEO |
| O15 | What exactly "read-only" blocks on a unit beyond edit and new lease (payments confirmation? repair dispatch? bank matching for that unit's leases?) | Ron, via CEO |

### 11.4 Guardrails for the design note

- Class B with security review; schema/RLS change needs non-author QA **and** a CEO exact-SHA GO before any staging apply.
- New tables follow the post-INC-RLS-1112 default: `ENABLE RLS`, `REVOKE` from `anon`/`authenticated`, decide `FORCE` explicitly, never restore grants (`architecture-map.md` §5).
- Decide the data-access helper per call (`tx` vs `svc` vs owner path) and state it; read-only enforcement must hold on every write path, including `svc()` and owner-path writes that RLS does not cover.
- Concurrency and idempotency tests are required: two Admins starting a trial at once; expiry job run twice; expiry racing a paid activation; a lease starting during expiry.
- Flag OFF must leave today's behaviour byte-for-byte unchanged; first ON is Ron's 4 internal orgs only, after QA and a CEO exact-SHA GO.

---

*Docs only. This file proposes; it authorizes nothing.*
