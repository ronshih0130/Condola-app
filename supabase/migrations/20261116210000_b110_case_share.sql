-- B-110 CASE-SHARE (GS-32 ven-copy-link + share-expired; VEN-25, MGT-124-AC1…AC3, MGT-124-AC6 = GS-54, OWN-32).
-- One read-only share link per case (ticket). A vendor (B-105 case token, closed job with an issued or voided document)
-- or staff (admin / manager, closed case) gets or creates it; each 「複製連結」 restarts its 90 days on the same URL.
-- It expires 90 days after the later of the last copy and the last document issued or voided in the case; a reopen
-- alone changes nothing (GS-29). Staff revoke it; copying afterwards creates a new link and the old one stays revoked.
-- The public read shows only staff-approved photos and issued / voided documents, never internal notes, costs or
-- tenant / owner details. Gate: vendor_docs_v3 + effective brand_v3 + vendor_dispatch + vendor_link + vendor_documents.
-- Every write is audited; nothing here sends or queues a message.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE TABLE app.case_shares (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 ticket_id uuid NOT NULL,
 vendor_job_id uuid REFERENCES public.repair_vendor_jobs(id) ON DELETE SET NULL,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 -- The bearer link itself, so the same URL can be shown and copied again (like repair_vendor_secrets).
 token text NOT NULL CHECK (char_length(token) BETWEEN 43 AND 128),
 created_by_kind text NOT NULL CHECK (created_by_kind IN ('vendor','staff')),
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_copied_at timestamptz,
 revoked_at timestamptz,
 revoked_by uuid,
 FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE CASCADE,
 CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
-- At most one live (unrevoked) link per case.
CREATE UNIQUE INDEX case_shares_one_live ON app.case_shares(org_id, ticket_id) WHERE revoked_at IS NULL;
ALTER TABLE app.case_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.case_shares FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b110_enabled(p_org uuid,p_env_v2 boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_docs_v3'='true'::jsonb
  AND coalesce((SELECT f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
    AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    FROM public.platform_settings f WHERE f.key='vendor_docs_v3'),false)
  AND o.feature_flags->'brand_v3'='true'::jsonb
  AND (coalesce(p_env_v2,false) OR o.feature_flags->'brand_v2'='true'::jsonb)
  AND o.feature_flags->>'vendor_link'='true'
  AND coalesce((SELECT l.value->'enabled'='true'::jsonb AND jsonb_typeof(l.value->'allowed_org_ids')='array'
    AND l.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    FROM public.platform_settings l WHERE l.key='vendor_link'),false)
  AND coalesce(app.vendor_dispatch_enabled(o.id),false)
  AND coalesce(app.b025_flag_on(o.id),false)
  FROM public.organizations o WHERE o.id=p_org),false)
$$;
REVOKE ALL ON FUNCTION app.b110_enabled(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- MGT-124-AC6: greatest(last copy, last document issued or voided in the case) + 90 days; created_at when neither.
-- 90 days are exactly 2160 hours, so the answer never depends on the session time zone or a DST change.
CREATE FUNCTION app.b110_expires_at(p_share app.case_shares) RETURNS timestamptz
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(greatest(p_share.last_copied_at,
   (SELECT max(greatest(d.issued_at,coalesce(d.voided_at,d.issued_at))) FROM public.vendor_documents d
     WHERE d.org_id=p_share.org_id AND d.ticket_id=p_share.ticket_id AND d.status IN ('issued','voided'))),
   p_share.created_at) + interval '2160 hours'
$$;
REVOKE ALL ON FUNCTION app.b110_expires_at(app.case_shares) FROM PUBLIC,anon,authenticated,service_role;

-- Get or create the case's live link, then (p_copy) record a copy. Serialized per case. p_new_token is used only
-- when a link has to be created (none yet, or the last one was revoked).
CREATE FUNCTION app.b110_share_for(p_org uuid,p_ticket uuid,p_kind text,p_actor uuid,p_job uuid,p_new_token text,p_copy boolean)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s app.case_shares; created boolean:=false;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('b110/share/'||p_org::text||'/'||p_ticket::text,0));
 SELECT * INTO s FROM app.case_shares x WHERE x.org_id=p_org AND x.ticket_id=p_ticket AND x.revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  IF p_new_token IS NULL OR char_length(p_new_token) NOT BETWEEN 43 AND 128 OR p_new_token !~ '^[A-Za-z0-9_-]+$'
  THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
  INSERT INTO app.case_shares(org_id,ticket_id,vendor_job_id,token_hash,token,created_by_kind,created_by)
  VALUES (p_org,p_ticket,p_job,encode(sha256(convert_to(p_new_token,'UTF8')),'hex'),p_new_token,p_kind,p_actor)
  RETURNING * INTO s;
  created:=true;
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row)
  VALUES (p_org,p_actor,p_kind,'case_shares',s.id::text,'insert','case_share_created',
   jsonb_build_object('ticketId',p_ticket,'vendorJobId',p_job));
 END IF;
 IF p_copy THEN
  UPDATE app.case_shares SET last_copied_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row)
  VALUES (p_org,p_actor,p_kind,'case_shares',s.id::text,'update','case_share_copied',
   jsonb_build_object('ticketId',p_ticket,'lastCopiedAt',s.last_copied_at));
 END IF;
 RETURN jsonb_build_object('status','ready','token',s.token,'expiresAt',app.b110_expires_at(s),'created',created);
END $$;
REVOKE ALL ON FUNCTION app.b110_share_for(uuid,uuid,text,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Vendor (VEN-25): the B-105 case bearer only, on a closed case with an issued or voided document.
-- p_mode: 'check' (eligible? no write), 'open' (get or create the link, no copy), 'copy' (get or create, record a copy).
CREATE FUNCTION app.b110_vendor_share(p_token_hash text,p_env_v2 boolean,p_mode text,p_new_token text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.repair_vendor_jobs;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('check','open','copy') THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 j:=app.b105_read_job(p_token_hash,p_env_v2);
 IF j.id IS NULL OR NOT app.b110_enabled(j.org_id,p_env_v2) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_mode<>'check' THEN
  -- Writers lock the case row so a reopen cannot slip between the closed check and the write.
  PERFORM 1 FROM public.maintenance_tickets t WHERE t.org_id=j.org_id AND t.id=j.ticket_id FOR SHARE;
  j:=app.b105_read_job(p_token_hash,p_env_v2);
  IF j.id IS NULL OR NOT app.b110_enabled(j.org_id,p_env_v2) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.maintenance_tickets t WHERE t.org_id=j.org_id AND t.id=j.ticket_id AND t.status::text='closed')
  OR NOT EXISTS(SELECT 1 FROM public.vendor_documents d WHERE d.org_id=j.org_id AND d.ticket_id=j.ticket_id AND d.status IN ('issued','voided'))
 THEN
  IF p_mode='check' THEN RETURN '{"status":"not_eligible"}'::jsonb; END IF;
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 IF p_mode='check' THEN RETURN '{"status":"eligible"}'::jsonb; END IF;
 RETURN app.b110_share_for(j.org_id,j.ticket_id,'vendor',NULL,j.id,p_new_token,p_mode='copy');
END $$;
REVOKE ALL ON FUNCTION app.b110_vendor_share(text,boolean,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b110_vendor_share(text,boolean,text,text) TO service_role;

-- Staff (MGT-124-AC1): an admin or manager of the case's org, on a closed case. p_copy as above.
CREATE FUNCTION app.b110_staff_share(p_org uuid,p_live uuid,p_env text,p_session uuid,p_env_v2 boolean,
 p_ticket uuid,p_new_token text,p_copy boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid;
BEGIN
 actor:=app.b026_account_staff(p_org,p_live,p_env,p_session);
 IF NOT app.b110_enabled(p_org,p_env_v2) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.maintenance_tickets t WHERE t.org_id=p_org AND t.id=p_ticket AND t.status::text='closed' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 RETURN app.b110_share_for(p_org,p_ticket,'staff',actor,NULL,p_new_token,coalesce(p_copy,false));
END $$;
REVOKE ALL ON FUNCTION app.b110_staff_share(uuid,uuid,text,uuid,boolean,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b110_staff_share(uuid,uuid,text,uuid,boolean,uuid,text,boolean) TO service_role;

-- Staff revoke (MGT-124-AC3). Idempotent: nothing live answers 'none' with no write.
CREATE FUNCTION app.b110_staff_revoke(p_org uuid,p_live uuid,p_env text,p_session uuid,p_env_v2 boolean,p_ticket uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; s app.case_shares;
BEGIN
 actor:=app.b026_account_staff(p_org,p_live,p_env,p_session);
 IF NOT app.b110_enabled(p_org,p_env_v2) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b110/share/'||p_org::text||'/'||p_ticket::text,0));
 UPDATE app.case_shares SET revoked_at=clock_timestamp(),revoked_by=actor
  WHERE org_id=p_org AND ticket_id=p_ticket AND revoked_at IS NULL RETURNING * INTO s;
 IF NOT FOUND THEN RETURN '{"status":"none"}'::jsonb; END IF;
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row)
 VALUES (p_org,actor,'staff','case_shares',s.id::text,'update','case_share_revoked',jsonb_build_object('ticketId',p_ticket));
 RETURN '{"status":"revoked"}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION app.b110_staff_revoke(uuid,uuid,text,uuid,boolean,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b110_staff_revoke(uuid,uuid,text,uuid,boolean,uuid) TO service_role;

-- Public read by the share link. NULL: unknown link or the gate is off. Expired / revoked: the state and the company
-- name only. Otherwise the case title and state, the vendor name, staff-approved photos (id, file name) and the
-- issued / voided documents (kind, number, state, amount). Photos: the vendor's 處理後 uploads that staff approved for
-- sharing (repair_vendor_job_shared_photos); never the tenant's report photos or 處理前. No tenant, owner or buyer details, notes or costs.
CREATE FUNCTION app.b110_share_view(p_share_hash text,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s app.case_shares; t public.maintenance_tickets; company text; vendor text; currency text;
BEGIN
 IF p_share_hash IS NULL OR p_share_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO s FROM app.case_shares x WHERE x.token_hash=p_share_hash;
 IF NOT FOUND OR NOT app.b110_enabled(s.org_id,p_env_v2) THEN RETURN NULL; END IF;
 SELECT o.name INTO company FROM public.organizations o WHERE o.id=s.org_id;
 IF s.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('state','revoked','company',coalesce(company,'')); END IF;
 IF app.b110_expires_at(s)<=clock_timestamp() THEN RETURN jsonb_build_object('state','expired','company',coalesce(company,'')); END IF;
 SELECT * INTO t FROM public.maintenance_tickets x WHERE x.org_id=s.org_id AND x.id=s.ticket_id;
 SELECT btrim(coalesce(t.currency,p.currency)) INTO currency FROM public.properties p WHERE p.org_id=t.org_id AND p.id=t.property_id;
 SELECT j.vendor_name INTO vendor FROM public.repair_vendor_jobs j
  WHERE j.org_id=s.org_id AND j.ticket_id=s.ticket_id AND (s.vendor_job_id IS NULL OR j.id=s.vendor_job_id)
  ORDER BY (j.id=s.vendor_job_id) DESC NULLS LAST, j.created_at DESC LIMIT 1;
 RETURN jsonb_build_object('state','ok','company',coalesce(company,''),'title',t.title,'status',t.status::text,
  'vendor',vendor,'currency',currency,
  'photos',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',f.file_name) ORDER BY a.created_at,a.id)
    FROM public.ticket_attachments a JOIN public.files f ON f.id=a.file_id AND f.org_id=a.org_id
    WHERE a.org_id=s.org_id AND a.ticket_id=s.ticket_id AND NOT a.is_internal
      AND a.vendor_job_id IS NOT NULL AND (a.phase IS NULL OR a.phase='after')
      AND EXISTS(SELECT 1 FROM public.repair_vendor_job_shared_photos sp JOIN public.repair_vendor_jobs j ON j.id=sp.job_id AND j.org_id=sp.org_id
        WHERE sp.org_id=a.org_id AND sp.attachment_id=a.id AND j.ticket_id=s.ticket_id)),'[]'::jsonb),
  'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'docNo',d.doc_no,'status',d.status,
      'totalMinor',d.total_minor::text) ORDER BY (d.status='voided'),d.issued_at,d.id)
    FROM public.vendor_documents d WHERE d.org_id=s.org_id AND d.ticket_id=s.ticket_id AND d.status IN ('issued','voided')),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app.b110_share_view(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b110_share_view(text,boolean) TO service_role;

-- Public file reads through a live share: an approved photo's storage path, or a document's stored PDF bytes.
CREATE FUNCTION app.b110_share_file(p_share_hash text,p_env_v2 boolean,p_kind text,p_id uuid)
RETURNS TABLE(storage_path text,pdf bytea,file_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s app.case_shares;
BEGIN
 IF p_share_hash IS NULL OR p_share_hash !~ '^[0-9a-f]{64}$' OR p_id IS NULL OR p_kind NOT IN ('photo','document') THEN RETURN; END IF;
 SELECT * INTO s FROM app.case_shares x WHERE x.token_hash=p_share_hash;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR NOT app.b110_enabled(s.org_id,p_env_v2) OR app.b110_expires_at(s)<=clock_timestamp() THEN RETURN; END IF;
 IF p_kind='photo' THEN
  RETURN QUERY SELECT f.storage_path,NULL::bytea,f.file_name FROM public.ticket_attachments a
   JOIN public.files f ON f.id=a.file_id AND f.org_id=a.org_id
   WHERE a.id=p_id AND a.org_id=s.org_id AND a.ticket_id=s.ticket_id AND NOT a.is_internal AND f.storage_bucket='ticket-photos-private'
     AND a.vendor_job_id IS NOT NULL AND (a.phase IS NULL OR a.phase='after')
     AND EXISTS(SELECT 1 FROM public.repair_vendor_job_shared_photos sp JOIN public.repair_vendor_jobs j ON j.id=sp.job_id AND j.org_id=sp.org_id
       WHERE sp.org_id=a.org_id AND sp.attachment_id=a.id AND j.ticket_id=s.ticket_id);
 ELSE
  RETURN QUERY SELECT NULL::text,b.bytes,d.doc_no FROM public.vendor_documents d
   JOIN public.vendor_document_pdf_bytes b ON b.document_id=d.id AND b.org_id=d.org_id
   WHERE d.id=p_id AND d.org_id=s.org_id AND d.ticket_id=s.ticket_id AND d.status IN ('issued','voided');
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.b110_share_file(text,boolean,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b110_share_file(text,boolean,text,uuid) TO service_role;
COMMIT;
