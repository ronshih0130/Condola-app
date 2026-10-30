BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
INSERT INTO public.platform_settings(key,value,description)
VALUES ('billing_previews','{"enabled":false,"allowed_org_ids":[]}'::jsonb,
        'Amount previews require an enabled global setting, an allowed organization and its explicit opt-in.')
ON CONFLICT (key) DO NOTHING;
COMMIT;
