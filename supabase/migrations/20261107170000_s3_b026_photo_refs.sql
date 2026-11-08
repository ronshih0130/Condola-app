-- Version 20261107170000.
-- S3 cross-stack: B-026 vendor estimate evidence uses the B-028 package 4 photo rule.
--
-- B-028 package 4 (20261107120000) replaced the shape-only app.b013_photo_refs in the
-- B-013 session mutators with app.b028_repair_photo_refs: every ref must name a
-- ticket attachment of the same org and ticket, backed by a same-org file in the
-- private ticket-photo bucket, not internal, pinned FOR SHARE until commit.
-- app.b026_submit_vendor_estimate (20261106190000) still stored evidence after only
-- the shape check plus its vendor-job allowlist, which does not look at the file, so
-- an attachment whose file left the private bucket was recorded and its id exposed to
-- the owner (b013_owner_pending) and staff (b026_manager_estimates).
--
-- CREATE OR REPLACE of the current (only) definition; the single change is the
-- stored validation check: app.b013_photo_refs(p_evidence, 0) ->
-- app.b028_repair_photo_refs(p_org, p_ticket, p_evidence, 0). Unchanged: the
-- early shape precondition and the vendor-job allowlist (42501) before the head
-- check, so existing denials keep their precedence; a ref they accept but the
-- B-028 rule rejects is a stored rejected_invalid command with no domain write.
-- Same signature, owner, SECURITY DEFINER, search_path and grants (re-stated below).
-- The helper stays private (no API-role EXECUTE); this function's owner, which also
-- owns the helper, executes it as the definer. No table, column, flag or grant
-- widening; old Worker compatible (same signature and result shape).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.b026_submit_vendor_estimate(p_token_hash text,p_request uuid,
 p_expected_head uuid,p_amount_minor bigint,p_currency text,p_minor_unit smallint,
 p_work_scope text,p_evidence jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE j public.repair_vendor_jobs; t record; pr record; own record; region record; rev record;
 p_org uuid; p_ticket uuid; p_payload_sha256 bytea;
 head uuid; n bigint; version_id uuid := gen_random_uuid();
 lock_deadline timestamptz;
 threshold bigint; source text; revision_id uuid; scale smallint; input jsonb; result jsonb;
BEGIN
 -- OFF admission precedes replay and every domain/ledger write.
 SELECT * INTO j FROM public.repair_vendor_jobs WHERE token_hash=p_token_hash;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 p_org:=j.org_id; p_ticket:=j.ticket_id;
 IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
 j:=app.b026_estimate_job(p_token_hash);
 input:=jsonb_build_array('b026_vendor_estimate',j.id,p_expected_head,p_amount_minor::text,
  p_currency,p_minor_unit,p_work_scope,p_evidence);
 p_payload_sha256:=pg_catalog.sha256(convert_to(input::text,'UTF8'));
 -- The job UUID is the token principal, never the dispatching staff identity.
 -- b013_replay takes the advisory request lock before any row locks.
 result:=app.b013_replay(p_org,j.id,p_request,'submit',p_payload_sha256,input);
 -- All row locks are acquired in one exception subtransaction. A busy legacy
 -- appointment may own job -> ticket; never wait while holding the inverse.
 -- Retrying releases EVERY row lock (including flags), allowing flag-OFF to win.
 lock_deadline:=clock_timestamp()+interval '6 seconds';
 LOOP
  BEGIN
   PERFORM 1 FROM public.platform_settings
    WHERE key IN ('repair_approvals','vendor_estimates') ORDER BY key FOR SHARE NOWAIT;
   PERFORM 1 FROM public.organizations WHERE id=p_org ORDER BY id FOR SHARE NOWAIT;
   IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
   SELECT * INTO t FROM public.maintenance_tickets WHERE org_id=p_org AND id=p_ticket FOR UPDATE NOWAIT;
   PERFORM 1 FROM public.repair_vendor_jobs WHERE org_id=p_org AND ticket_id=p_ticket ORDER BY id FOR UPDATE NOWAIT;
   SELECT * INTO pr FROM public.properties WHERE org_id = p_org AND id = t.property_id AND archived_at IS NULL FOR SHARE NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
   SELECT po.*, c.user_id AS principal_id INTO own
   FROM public.property_owners po
   JOIN public.contacts c ON c.org_id = po.org_id AND c.id = po.owner_contact_id
   JOIN public.organizations o ON o.id = po.org_id
   WHERE po.org_id = p_org AND po.property_id = pr.id AND c.is_owner
    AND c.user_id IS NOT NULL AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
   ORDER BY po.id LIMIT 1 FOR SHARE OF po, c NOWAIT;
   IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE = '42501'; END IF;
   SELECT current_version_id INTO head FROM app.b013_estimate_heads WHERE org_id = p_org AND ticket_id = p_ticket FOR UPDATE NOWAIT;
   SELECT r.* INTO region FROM app.b013_regional_defaults r
   JOIN public.organizations o ON o.country_code::text = r.country_code
   WHERE o.id = p_org AND r.currency = pr.currency FOR SHARE OF r NOWAIT;
   SELECT r.* INTO rev FROM app.b013_default_roots root
   JOIN app.b013_default_revisions r ON r.org_id = root.org_id AND r.root_id = root.id
    AND r.id = root.current_revision AND r.revision_no = root.version
   WHERE root.org_id = p_org AND root.principal_id = own.principal_id AND root.currency = pr.currency
   FOR SHARE OF root NOWAIT;
   -- All flag/domain locks are now held through commit. Revalidate admission
   -- after waits, before replay, rejected-command persistence or domain writes.
   IF NOT app.b026_estimates_enabled(p_org) THEN RETURN '{"status":"rejected_disabled"}'; END IF;
   j:=app.b026_estimate_job(p_token_hash);
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   IF clock_timestamp()>=lock_deadline THEN
    RAISE EXCEPTION 'Estimate submission busy' USING ERRCODE='55P03';
   END IF;
   PERFORM pg_sleep(0.05);
  END;
 END LOOP;
 IF result IS NOT NULL THEN RETURN result; END IF;
 -- Optional evidence is an allowlist of existing uploads for this exact assignment.
 IF NOT app.b013_photo_refs(p_evidence,0) THEN RETURN '{"status":"rejected_invalid"}'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence) e WHERE
  e - 'id' <> '{}'::jsonb OR NOT EXISTS(SELECT 1 FROM public.ticket_attachments a
   WHERE a.id::text=e->>'id' AND a.org_id=p_org AND a.ticket_id=p_ticket
    AND a.vendor_job_id=j.id AND NOT a.is_internal)) THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 IF head IS DISTINCT FROM p_expected_head THEN
  RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_conflict"}');
 END IF;
 scale := coalesce(region.minor_unit, rev.minor_unit);
 IF own.repair_approval_threshold_minor IS NOT NULL THEN
  threshold := own.repair_approval_threshold_minor; source := 'property_override'; revision_id := own.id;
 ELSIF rev.mode = 'set' THEN
  threshold := rev.threshold_minor; source := 'owner_default'; revision_id := rev.id;
  scale := rev.minor_unit;
 ELSE
  threshold := region.threshold_minor; source := 'regional_default'; revision_id := NULL;
 END IF;
 IF threshold IS NULL OR scale IS NULL THEN
  RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_unavailable"}');
 END IF;
 IF p_amount_minor IS NULL OR p_amount_minor < 0 OR p_currency IS NULL
  OR p_currency !~ '^[A-Z]{3}$' OR p_currency IS DISTINCT FROM btrim(pr.currency::text)
  OR p_minor_unit IS NULL OR p_minor_unit NOT BETWEEN 0 AND 4 OR p_minor_unit <> scale
  OR (region.minor_unit IS NOT NULL AND p_minor_unit <> region.minor_unit)
  OR p_work_scope IS NULL OR length(btrim(p_work_scope)) NOT BETWEEN 1 AND 8000
  OR NOT app.b028_repair_photo_refs(p_org, p_ticket, p_evidence, 0) THEN
  RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
   NULL, p_payload_sha256, input, '{"status":"rejected_invalid"}');
 END IF;
 SELECT coalesce(max(version_no), 0) + 1 INTO n FROM app.b013_estimate_versions
 WHERE org_id = p_org AND ticket_id = p_ticket;
 INSERT INTO app.b013_estimate_heads(org_id, ticket_id, current_version_id)
 VALUES (p_org, p_ticket, version_id)
 ON CONFLICT (org_id, ticket_id) DO UPDATE
 SET current_version_id = EXCLUDED.current_version_id, updated_at = clock_timestamp();
 INSERT INTO app.b013_estimate_versions(
  id, org_id, ticket_id, property_id, version_no, currency, minor_unit, amount_minor,
  work_scope, evidence_snapshot, designated_ownership_id, designated_contact_id, designated_principal_id,
  captured_threshold_minor, threshold_source, threshold_revision_id, threshold_provenance_sha256, payload_sha256, submitted_by)
 VALUES (version_id, p_org, p_ticket, pr.id, n, p_currency, p_minor_unit, p_amount_minor,
  p_work_scope, p_evidence, own.id, own.owner_contact_id, own.principal_id,
  threshold, source, revision_id,
  pg_catalog.sha256(convert_to(jsonb_build_array(p_org, pr.id, own.id, own.owner_contact_id,
   own.principal_id, p_currency, scale, threshold::text, source, revision_id, region.revision)::text, 'UTF8')),
  p_payload_sha256, j.id);
 result := jsonb_build_object('status', 'recorded', 'version_id', version_id,
  'requires_owner_decision', p_amount_minor > threshold,
  'state', CASE WHEN p_amount_minor > threshold THEN 'pending_approval' ELSE 'policy_qualified' END);
 INSERT INTO app.b026_vendor_estimates(org_id,ticket_id,version_id,vendor_job_id)
 VALUES(p_org,p_ticket,version_id,j.id);
 PERFORM app.b026_estimate_job(p_token_hash);
 RETURN app.b013_store_result(p_org, j.id, p_request, p_ticket, 'submit', p_expected_head,
  NULL, p_payload_sha256, input, result);
END $$;
REVOKE ALL ON FUNCTION app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_submit_vendor_estimate(text,uuid,uuid,bigint,text,smallint,text,jsonb) TO service_role;

COMMIT;
