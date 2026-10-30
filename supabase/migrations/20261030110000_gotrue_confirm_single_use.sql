-- Hash of a GoTrue implicit-flow access token already presented to
-- confirmSupabaseAccessToken. The JWT is not stored. GoTrue does not consume
-- that JWT on GET /auth/v1/user; this row makes the confirm single-use.
-- The app connects as a superuser, so RLS does not apply to that connection.
-- No policy is granted to anon or authenticated, and the Data API schemas
-- do not need this table. claimGotrueConfirmToken deletes rows older than
-- twice the GoTrue JWT lifetime (GOTRUE_JWT_EXPIRY_SECONDS * 2 = 7200s).

CREATE TABLE IF NOT EXISTS gotrue_confirm_uses (
  token_hash text PRIMARY KEY,
  used_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gotrue_confirm_uses ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE gotrue_confirm_uses FROM PUBLIC;
REVOKE ALL ON TABLE gotrue_confirm_uses FROM anon;
REVOKE ALL ON TABLE gotrue_confirm_uses FROM authenticated;
