-- Version 20261115190000.
-- PR-026 (a), Ron 2026-11-15 20:44 PT: revoke the Supabase default anon/PUBLIC table grants on nine tables.
-- Found on condola-staging (receipt receipts/brand3/b3/b3b-staging-prereqs.md): anon held SELECT/INSERT/UPDATE/
-- DELETE (and more) on these tables, which a database built from main never grants. RLS is already ON for all of
-- them with no anon/public policy, so effective access was denied; this restores the defense in depth main intends.
-- On a database built from main this is a no-op. The app never uses the anon role for these tables (tx() runs as
-- authenticated, svc() as service_role, query()/withClient() as the owner). authenticated/service_role grants are
-- out of scope (Ron: anon/public only). Prod is not touched by the Mac: box PE checks prod read-only and ships it
-- through the normal prod path.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

REVOKE ALL ON TABLE
  public.auth_challenges,
  public.auth_login_attempts,
  public.auth_password_resets,
  public.auth_sessions,
  public.lease_signed_pdfs,
  public.listing_terms,
  public.month_closes,
  public.sample_marks,
  public.user_mfa
FROM anon, PUBLIC;
