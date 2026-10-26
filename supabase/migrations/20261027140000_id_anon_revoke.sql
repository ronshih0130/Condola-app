-- Version 20261027140000.
-- Supabase grants anon every new table and function. The ID migrations revoked
-- PUBLIC and authenticated and left those anon grants in place.
-- RLS still applies, but anon must not hold the tables.
-- The app never calls these two functions as authenticated. Masking in the
-- request path is application code. dedupe_live_identity_documents runs only
-- as the migration role. service_role keeps EXECUTE.
-- authenticated keeps SELECT on identity_document_photos.

REVOKE ALL ON TABLE public.id_document_objects FROM anon;
REVOKE ALL ON TABLE public.identity_document_photos FROM anon;

REVOKE EXECUTE ON FUNCTION public.id_number_stored_mask(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dedupe_live_identity_documents() FROM anon, authenticated;
