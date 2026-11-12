BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
INSERT INTO public.platform_settings(key, value, description)
VALUES ('move_out_notice', '{"enabled":false,"allowed_org_ids":[]}'::jsonb, 'Move-out notice per-org admission (B-002). Effective only with Worker MOVE_OUT_NOTICE_ENABLED=true AND this allowlist AND organizations.feature_flags.move_out_notice=true. Default OFF.')
ON CONFLICT (key) DO NOTHING;
COMMIT;
