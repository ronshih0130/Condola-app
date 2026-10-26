-- Version 20261026150000.
-- 20261025140000 is already applied and is left unchanged.
-- That file revoked PUBLIC and authenticated. This revokes anon.

REVOKE ALL ON public.id_upload_slots FROM anon;
