-- B-097 VEN-CLOSE (VEN-29-AC1…AC4, MGT-146-AC3/AC4; RV-DONE; GS-27, GS-51; LPQ-25 item 3) and
-- B-098 VEN-PHONE (VEN-27-AC3; RV-TIME 「打電話給租客」).
-- * 送出完工: the assigned vendor's B-105 case bearer closes the repair with at least one after-photo. Only the
--   explicit 處理後 set counts (ticket_attachments.phase='after' on this vendor job; a pre-B-105 NULL-phase upload does
--   not, LPQ-25 item 3). This supersedes the 11/12 「已回報，待公司核對」 step: the ticket goes straight to closed.
-- * 重開: admin / manager staff reopen a vendor-closed repair within 7 days (168 hours) with a reason; after that a
--   new repair is needed. GS-29: a reopen does not touch the share link.
-- * Tenant phone: the assigned vendor's live, accepted B-105 case bearer on an open case only. Never after close,
--   never for another vendor, a revoked or expired link, a document token or a share link (B-110 reads none of it).
-- Gate: the existing vendor_job_v3 gate (app.b105_enabled: own flag, brand_v3, vendor_link, vendor_dispatch). No new
-- flag. Two private tables (RLS on, no grants), four service-only SECURITY DEFINER gateways, no helpers. Writers take
-- every lock target (FK targets included) before the final admission decision and reserve every accepted request id.
-- 0 outbound: completion and reopen notices stay in-app (PR-022 keeps LINE OFF); nothing here sends or queues a message.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- One row per vendor completion. The live one (not reopened) is the repair's current close; a reopen keeps the row.
CREATE TABLE app.b097_completions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 ticket_id uuid NOT NULL,
 vendor_job_id uuid NOT NULL REFERENCES public.repair_vendor_jobs(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
 after_photo_ids uuid[] NOT NULL CHECK (cardinality(after_photo_ids) >= 1),
 from_status text NOT NULL,
 closed_at timestamptz NOT NULL,
 reopen_until timestamptz NOT NULL,
 reopened_at timestamptz,
 reopened_by uuid,
 reopen_reason text CHECK (reopen_reason IS NULL OR char_length(reopen_reason) BETWEEN 1 AND 500),
 reopen_request uuid,
 CHECK (reopen_until = closed_at + interval '168 hours'),
 CHECK ((reopened_at IS NULL) = (reopened_by IS NULL) AND (reopened_at IS NULL) = (reopen_reason IS NULL)
  AND (reopened_at IS NULL) = (reopen_request IS NULL)),
 CHECK (reopened_at IS NULL OR reopened_at < reopen_until),
 FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX b097_completions_live ON app.b097_completions(org_id, ticket_id) WHERE reopened_at IS NULL;
ALTER TABLE app.b097_completions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b097_completions FROM PUBLIC,anon,authenticated,service_role;

-- Idempotency ledger: every accepted request id (complete or reopen) with who asked, for which repair, what they sent
-- and the first answer. The same caller and payload replays that answer; anything else under the id is a conflict.
CREATE TABLE app.b097_requests (
 org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('complete','reopen')),
 actor_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 payload jsonb NOT NULL,
 answer jsonb NOT NULL CHECK (answer->>'status' IN ('recorded','reopened')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, request_id),
 FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE CASCADE
);
ALTER TABLE app.b097_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b097_requests FROM PUBLIC,anon,authenticated,service_role;

-- RV-DONE read: this bearer's case facts for 回報完工. NULL when OFF or not admitted (same as an unknown token).
-- afterPhotos lists only the explicit 處理後 set of this vendor job (the photos that count).
CREATE FUNCTION app.b097_vendor_done_view(p_token_hash text,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.repair_vendor_jobs; t public.maintenance_tickets; d app.b105_vendor_job_decisions;
 c app.b097_completions; company text; photos jsonb;
BEGIN
 j:=app.b105_read_job(p_token_hash,p_env_v2);
 IF j.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO t FROM public.maintenance_tickets WHERE org_id=j.org_id AND id=j.ticket_id;
 SELECT * INTO d FROM app.b105_vendor_job_decisions WHERE vendor_job_id=j.id AND org_id=j.org_id;
 SELECT * INTO c FROM app.b097_completions x WHERE x.org_id=j.org_id AND x.ticket_id=j.ticket_id AND x.reopened_at IS NULL;
 SELECT o.name INTO company FROM public.organizations o WHERE o.id=j.org_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',f.file_name) ORDER BY a.created_at,a.id),'[]'::jsonb) INTO photos
  FROM public.ticket_attachments a JOIN public.files f ON f.id=a.file_id AND f.org_id=a.org_id
  WHERE a.org_id=j.org_id AND a.ticket_id=j.ticket_id AND a.vendor_job_id=j.id AND a.phase='after' AND NOT a.is_internal;
 RETURN jsonb_build_object('company',coalesce(company,''),
  'closed',t.status::text NOT IN ('open','triaged','assigned','in_progress','on_hold','resolved'),
  'accepted',coalesce(d.decision='accepted',false),'afterPhotos',photos,
  'closedAt',c.closed_at,'reopenUntil',c.reopen_until,'closedByThisJob',c.vendor_job_id IS NOT DISTINCT FROM j.id AND c.id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION app.b097_vendor_done_view(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b097_vendor_done_view(text,boolean) TO service_role;

-- 送出完工. Lock order: the request key, the repair key, then (FOR SHARE unless noted) the two platform switch rows,
-- the organization, the ticket (FOR UPDATE), every job on it by id (FOR UPDATE; lockTicketThenJobs order), this job's
-- B-105 decision, this job's 處理後 attachments and the estimate head. The decision is made only on rows locked here:
-- the inserts' FK targets (organization, ticket, job) are held, audit_log has no FKs and ticket_comments is written
-- with no author, so nothing waits after the decision.
CREATE FUNCTION app.b097_vendor_complete(p_token_hash text,p_env_v2 boolean,p_request uuid,p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tgt record; locked_switches int; locked_org int; locked_jobs uuid[]; photo_ids uuid[];
 t public.maintenance_tickets; j public.repair_vendor_jobs; d app.b105_vendor_job_decisions;
 prior app.b097_requests; c app.b097_completions; note text; payload jsonb; answer jsonb; head uuid; now_at timestamptz;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 -- Lock target only; this lookup admits nothing.
 SELECT x.id,x.org_id,x.ticket_id INTO tgt FROM public.repair_vendor_jobs x WHERE x.token_hash=p_token_hash;
 IF tgt.id IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_request IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('b097/request/'||tgt.org_id::text||'/'||p_request::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b097/ticket/'||tgt.org_id::text||'/'||tgt.ticket_id::text,0));
 SELECT count(*) INTO locked_switches FROM (SELECT 1 FROM public.platform_settings f
  WHERE f.key IN ('vendor_job_v3','vendor_link') ORDER BY f.key FOR SHARE) x;
 SELECT count(*) INTO locked_org FROM (SELECT 1 FROM public.organizations o WHERE o.id=tgt.org_id FOR SHARE) x;
 SELECT * INTO t FROM public.maintenance_tickets x WHERE x.org_id=tgt.org_id AND x.id=tgt.ticket_id FOR UPDATE;
 SELECT coalesce(array_agg(x.id),'{}') INTO locked_jobs FROM (SELECT x.id FROM public.repair_vendor_jobs x
  WHERE x.org_id=tgt.org_id AND x.ticket_id=tgt.ticket_id ORDER BY x.id FOR UPDATE) x;
 SELECT * INTO d FROM app.b105_vendor_job_decisions x WHERE x.vendor_job_id=tgt.id AND x.org_id=tgt.org_id FOR SHARE;
 SELECT coalesce(array_agg(x.id ORDER BY x.id),'{}') INTO photo_ids FROM (SELECT a.id FROM public.ticket_attachments a
  WHERE a.org_id=tgt.org_id AND a.ticket_id=tgt.ticket_id AND a.vendor_job_id=tgt.id AND a.phase='after' AND NOT a.is_internal
  ORDER BY a.id FOR SHARE) x;
 PERFORM 1 FROM app.b013_estimate_heads h WHERE h.org_id=tgt.org_id AND h.ticket_id=tgt.ticket_id FOR SHARE;
 SELECT * INTO j FROM public.repair_vendor_jobs x WHERE x.id=tgt.id AND x.org_id=tgt.org_id AND x.ticket_id=tgt.ticket_id;
 -- The decision, on the locked rows only.
 IF locked_switches<>2 OR locked_org<>1 OR t.id IS NULL OR j.id IS NULL OR NOT (j.id=ANY(locked_jobs))
  OR j.token_hash IS DISTINCT FROM p_token_hash
  OR NOT EXISTS(SELECT 1 FROM app.open_vendor_job(p_token_hash) o WHERE o.job_id=j.id AND o.org_id=j.org_id AND o.ticket_id=j.ticket_id)
  OR NOT j.active OR j.revoked_at IS NOT NULL OR j.expires_at<=clock_timestamp()
  OR j.scope<>'case_collaboration' OR j.sharing_approved_at IS NULL OR j.vendor_contact_id IS NULL
  OR j.vendor_contact_id IS DISTINCT FROM t.assigned_vendor_contact_id
  OR d.vendor_job_id IS NULL OR d.decision<>'accepted'
  OR NOT app.b105_enabled(j.org_id,p_env_v2)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 note:=nullif(btrim(p_note),'');
 IF p_request IS NULL OR (note IS NOT NULL AND (char_length(note)>500 OR note ~ '[\x01-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]'))
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 payload:=jsonb_build_object('note',note);
 SELECT * INTO prior FROM app.b097_requests r WHERE r.org_id=j.org_id AND r.request_id=p_request;
 IF FOUND THEN
  IF prior.kind='complete' AND prior.actor_id=j.id AND prior.ticket_id=j.ticket_id AND prior.payload=payload THEN
   RETURN prior.answer||'{"replayed":true}'::jsonb; END IF;
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 IF t.status::text NOT IN ('open','triaged','assigned','in_progress','on_hold','resolved') THEN
  RETURN '{"status":"rejected_closed"}'::jsonb; END IF;
 -- VEN-29-AC4: no after-photo, refused (nothing reserved, so the same request can be sent again after an upload).
 IF cardinality(photo_ids)=0 THEN RETURN '{"status":"rejected_no_photo"}'::jsonb; END IF;
 -- The existing closure guard (b026 work guard): an estimate that does not allow the work cannot be closed.
 IF EXISTS(SELECT 1 FROM app.b026_vendor_estimates e WHERE e.org_id=j.org_id AND e.ticket_id=j.ticket_id) THEN
  SELECT h.current_version_id INTO head FROM app.b013_estimate_heads h WHERE h.org_id=j.org_id AND h.ticket_id=j.ticket_id;
  IF NOT coalesce(app.b013_dispatch_allowed(j.org_id,head),false) THEN RETURN '{"status":"rejected_state"}'::jsonb; END IF;
 END IF;
 now_at:=clock_timestamp();
 INSERT INTO app.b097_completions(org_id,ticket_id,vendor_job_id,request_id,note,after_photo_ids,from_status,closed_at,reopen_until)
 VALUES (j.org_id,j.ticket_id,j.id,p_request,note,photo_ids,t.status::text,now_at,now_at+interval '168 hours') RETURNING * INTO c;
 UPDATE public.maintenance_tickets SET status='closed'::public.ticket_status,
  completed_on=coalesce(completed_on,(now_at AT TIME ZONE 'Asia/Taipei')::date),
  resolved_at=coalesce(resolved_at,now_at),closed_at=now_at
  WHERE org_id=j.org_id AND id=j.ticket_id;
 INSERT INTO public.ticket_comments(org_id,ticket_id,author_user_id,status_from,status_to)
 VALUES (j.org_id,j.ticket_id,NULL,t.status,'closed'::public.ticket_status);
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row,request_id)
 VALUES (j.org_id,NULL,'vendor','maintenance_tickets',j.ticket_id::text,'update','vendor_completion_closed',
  jsonb_build_object('status',t.status::text),
  jsonb_build_object('status','closed','completionId',c.id,'vendorJobId',j.id,'afterPhotos',cardinality(photo_ids),
   'reopenUntil',c.reopen_until),p_request::text);
 answer:=jsonb_build_object('status','recorded','closedAt',c.closed_at,'reopenUntil',c.reopen_until,'replayed',false);
 INSERT INTO app.b097_requests(org_id,request_id,kind,actor_id,ticket_id,payload,answer)
 VALUES (j.org_id,p_request,'complete',j.id,j.ticket_id,payload,answer);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION app.b097_vendor_complete(text,boolean,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b097_vendor_complete(text,boolean,uuid,text) TO service_role;

-- 重開 (MGT-146-AC3, VEN-29-AC2): admin / manager staff (b026_account_staff; the caller also needs tickets.update),
-- within 7 days of the vendor's close, with a reason. Lock order: the request key, the repair key, the two platform
-- switch rows, the organization and the caller's auth.users row (ticket_comments.author FK) FOR SHARE / KEY SHARE,
-- the ticket and its jobs FOR UPDATE, the live completion FOR UPDATE and the estimate head; then the decision, whose
-- session and membership locks are NOWAIT (busy, never a wait).
CREATE FUNCTION app.b097_staff_reopen(p_org uuid,p_live uuid,p_env text,p_session uuid,p_env_v2 boolean,
 p_ticket uuid,p_request uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; locked_switches int; locked_org int; locked_user int; t public.maintenance_tickets;
 c app.b097_completions; actor uuid; reason text; payload jsonb; prior app.b097_requests; answer jsonb; head uuid;
BEGIN
 IF p_org IS NULL OR p_ticket IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 -- Lock target only: the signed-in caller of this service connection. b026_account_staff decides below.
 target:=auth.uid();
 IF target IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_request IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('b097/request/'||p_org::text||'/'||p_request::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b097/ticket/'||p_org::text||'/'||p_ticket::text,0));
 SELECT count(*) INTO locked_switches FROM (SELECT 1 FROM public.platform_settings f
  WHERE f.key IN ('vendor_job_v3','vendor_link') ORDER BY f.key FOR SHARE) x;
 SELECT count(*) INTO locked_org FROM (SELECT 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE) x;
 SELECT count(*) INTO locked_user FROM (SELECT 1 FROM auth.users u WHERE u.id=target FOR KEY SHARE) x;
 SELECT * INTO t FROM public.maintenance_tickets x WHERE x.org_id=p_org AND x.id=p_ticket FOR UPDATE;
 PERFORM 1 FROM public.repair_vendor_jobs x WHERE x.org_id=p_org AND x.ticket_id=p_ticket ORDER BY x.id FOR UPDATE;
 SELECT * INTO c FROM app.b097_completions x WHERE x.org_id=p_org AND x.ticket_id=p_ticket AND x.reopened_at IS NULL FOR UPDATE;
 PERFORM 1 FROM app.b013_estimate_heads h WHERE h.org_id=p_org AND h.ticket_id=p_ticket FOR SHARE;
 -- The decision.
 actor:=app.b026_account_staff(p_org,p_live,p_env,p_session);
 IF actor IS DISTINCT FROM target OR locked_switches<>2 OR locked_org<>1 OR locked_user<>1 OR t.id IS NULL
  OR NOT app.b105_enabled(p_org,p_env_v2)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 reason:=btrim(p_reason);
 IF p_request IS NULL OR reason IS NULL OR char_length(reason) NOT BETWEEN 1 AND 500
  OR reason ~ '[\x01-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]'
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 payload:=jsonb_build_object('reason',reason);
 SELECT * INTO prior FROM app.b097_requests r WHERE r.org_id=p_org AND r.request_id=p_request;
 IF FOUND THEN
  IF prior.kind='reopen' AND prior.actor_id=actor AND prior.ticket_id=p_ticket AND prior.payload=payload THEN
   RETURN prior.answer||'{"replayed":true}'::jsonb; END IF;
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 -- Only a repair the vendor closed (VEN-29) is reopened here; a staff close or a cancel is not.
 IF t.status::text<>'closed' OR c.id IS NULL THEN RETURN '{"status":"rejected_state"}'::jsonb; END IF;
 IF clock_timestamp()>=c.reopen_until THEN RETURN '{"status":"rejected_expired"}'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM app.b026_vendor_estimates e WHERE e.org_id=p_org AND e.ticket_id=p_ticket) THEN
  SELECT h.current_version_id INTO head FROM app.b013_estimate_heads h WHERE h.org_id=p_org AND h.ticket_id=p_ticket;
  IF NOT coalesce(app.b013_dispatch_allowed(p_org,head),false) THEN RETURN '{"status":"rejected_state"}'::jsonb; END IF;
 END IF;
 UPDATE app.b097_completions SET reopened_at=clock_timestamp(),reopened_by=actor,reopen_reason=reason,reopen_request=p_request
  WHERE id=c.id;
 UPDATE public.maintenance_tickets SET status='in_progress'::public.ticket_status,closed_at=NULL,resolved_at=NULL,completed_on=NULL
  WHERE org_id=p_org AND id=p_ticket;
 INSERT INTO public.ticket_comments(org_id,ticket_id,author_user_id,status_from,status_to)
 VALUES (p_org,p_ticket,actor,'closed'::public.ticket_status,'in_progress'::public.ticket_status);
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row,reason,request_id)
 VALUES (p_org,actor,'staff','maintenance_tickets',p_ticket::text,'update','repair_reopened',
  jsonb_build_object('status','closed','completionId',c.id),jsonb_build_object('status','in_progress'),reason,p_request::text);
 answer:=jsonb_build_object('status','reopened','replayed',false);
 INSERT INTO app.b097_requests(org_id,request_id,kind,actor_id,ticket_id,payload,answer)
 VALUES (p_org,p_request,'reopen',actor,p_ticket,payload,answer);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION app.b097_staff_reopen(uuid,uuid,text,uuid,boolean,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b097_staff_reopen(uuid,uuid,text,uuid,boolean,uuid,uuid,text) TO service_role;

-- B-098 (VEN-27-AC3): the tenant's phone for 「打電話給租客」. NULL unless this is the assigned vendor's live,
-- accepted B-105 case bearer on an open case. The phone is the reporting tenant's: the ticket's reporter contact,
-- a live tenant contact who is a primary / co-tenant / occupant party of the ticket's lease. Read only.
CREATE FUNCTION app.b098_vendor_tenant_phone(p_token_hash text,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.repair_vendor_jobs; t public.maintenance_tickets; phone text;
BEGIN
 j:=app.b105_read_job(p_token_hash,p_env_v2);
 IF j.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO t FROM public.maintenance_tickets WHERE org_id=j.org_id AND id=j.ticket_id;
 IF t.id IS NULL OR t.status::text NOT IN ('open','triaged','assigned','in_progress','on_hold','resolved')
  OR NOT EXISTS(SELECT 1 FROM app.b105_vendor_job_decisions d WHERE d.vendor_job_id=j.id AND d.org_id=j.org_id AND d.decision='accepted')
 THEN RETURN NULL; END IF;
 SELECT c.phone_e164 INTO phone FROM public.contacts c
  JOIN public.lease_parties lp ON lp.org_id=c.org_id AND lp.contact_id=c.id AND lp.lease_id=t.lease_id
   AND lp.role::text IN ('primary','co_tenant','occupant')
  WHERE c.org_id=t.org_id AND c.id=t.reported_by_contact_id AND c.is_tenant AND c.archived_at IS NULL
   AND c.phone_e164 IS NOT NULL LIMIT 1;
 RETURN jsonb_build_object('phone',phone);
END $$;
REVOKE ALL ON FUNCTION app.b098_vendor_tenant_phone(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b098_vendor_tenant_phone(text,boolean) TO service_role;
COMMIT;
