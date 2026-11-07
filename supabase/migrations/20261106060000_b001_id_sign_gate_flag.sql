-- B-001 / PROP-US-v03-01 (CAP-P-28): default-OFF rollout flag for the two-level ID switches
-- (organizations.settings.collect_id default true, require_id_before_sign default false).
-- Flag OFF keeps the existing hard gate (ID required before signing). No table or function change.
BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO public.platform_settings(key,value)
VALUES ('id_sign_gate_v2','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
COMMIT;
