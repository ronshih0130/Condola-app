-- Version 20261113100000.
-- C4 billing change (Ron 2026-11-13 01:30 PT, hub 11-decisions/DECISIONS.md:
-- 「9全面改成5」): the free-unit allowance is 5 everywhere; only units above 5 are
-- billed, matching public /pricing. Code constants change in billing.ts
-- (FREE_UNITS) and sandbox-data.ts (FREE_ACTIVE_UNITS).
--
-- This migration only changes the column DEFAULT used when a new partner code is
-- inserted without an explicit free_units. It does not rewrite any existing
-- partner_codes or firm_partner_prices row: negotiated partner allowances already
-- issued (e.g. the seeded ANJU2026 code and any snapshot copied from it) keep
-- their stored value (hub 20-build/OPEN-QUESTIONS.md OQ-005 asks whether those
-- should also move to 5; until answered they are left as negotiated).
-- No privilege, RLS, policy, flag or data change. No outbound.

ALTER TABLE public.partner_codes ALTER COLUMN free_units SET DEFAULT 5;
