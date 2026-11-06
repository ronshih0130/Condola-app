# PROP-13 — Trusted owner-contact login linking (L2 design)

> Author: Claude (Mac Session 2, 2026-11-06 PT). Closes hub `BLK-MAC-04` (surfaced by B-022 QA r2 on #36).
> Stacked on #36 (`feat/b-022-owner-replies-title`). Build-only; new flag `owner_contact_linking` default OFF.

## Problem

`contacts.user_id` is the identity binding every owner-portal check trusts (`app.is_my_contact`, owner statements,
B-021 repair approvals, B-022 receipt title / replies). Staff (admin/manager/accountant) can UPDATE any contact column
through `contacts.team_update`, so a staff member could bind an owner contact to their own login (or to any existing
login) and act as that owner. B-022 added defense in depth (owner RPCs reject active staff of the org) but the root
cause is the unrestricted write.

## Design

1. **DB guard (always on, API role only).** `BEFORE INSERT OR UPDATE OF user_id, is_owner ON public.contacts`,
   effective only when `current_user` is `authenticated` or `anon` (the API role). Trusted server paths
   (`service_role`, SECURITY DEFINER functions, migrations/seeds) are unaffected. Rejected with `42501`:
   - changing or clearing an existing binding (`OLD.user_id IS NOT NULL` and value changes);
   - any binding on an owner contact (`is_owner`), or flipping `is_owner` to true on a bound contact;
   - binding to the caller (`auth.uid()`), to any user with an `org_members` row (any org, any status), or to a
     user already bound to another contact.
   Allowed: the existing tenant onboarding path (`createLease` / `attachPortalUser`) that binds a **freshly
   provisioned** portal login (`app.provision_portal_user`) to an unbound tenant contact.
2. **Trusted linking RPC (flag-gated).** `app.prop13_link_owner_contact(p_org, p_contact, p_email)`:
   SECURITY DEFINER, `search_path` pinned, EXECUTE for `authenticated` only. Lock order
   `platform_settings` (FOR SHARE) → `organizations` (FOR SHARE) → contact (FOR UPDATE). Requires the flag ON
   (global `enabled === true` + org in `allowed_org_ids` + org `feature_flags.owner_contact_linking === true`),
   caller `admin` of the org (pinned `app.has_role`), an active unbound owner contact. It provisions a **new**
   portal login and binds it atomically, so staff can never bind an existing account (their own included). The
   existing `trg_contacts_audit` records the change. Flag OFF ⇒ raises before any write.
3. **TS wrapper** `linkOwnerContactPortal(session, {contactId, email})` (admin only, maps errors). No UI in this
   PROP (build-only).

## Done means

- Staff direct API-role writes in every rejected shape fail with 42501 and change nothing.
- Tenant onboarding (fresh provisioned login on an unbound tenant contact) keeps working; full `test:rls` green.
- RPC: OFF ⇒ zero writes; ON ⇒ admin links a fresh login; manager/accountant/foreign org/tenant contact/already
  linked ⇒ denied.
- `check-fn-privs`, privilege catalog (definer, search_path, grants) asserted in tests.

## Out of scope

Owner self-claim with an emailed invitation code (needs approved copy + delivery), UI, and backfill/audit of
existing bindings (a read-only report can be produced on request).
