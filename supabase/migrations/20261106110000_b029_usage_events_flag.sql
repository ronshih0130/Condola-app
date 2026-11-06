-- B-029 hooks use the PROP-07 store. Default OFF; preserve existing configuration.
BEGIN;
INSERT INTO platform_settings(key,value)
VALUES ('usage_events','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
COMMIT;
