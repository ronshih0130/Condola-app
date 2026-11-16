-- B-063 / VEN-14-AC1, AC3 (V-HOME, V-JOBS, V-RECV): the signed-in vendor's own linked jobs in ONE
-- organization, with the place name and the recorded amount still waiting. One NEW service-only read
-- gateway; no existing object, table grant, policy, flag seed or data change; no writes.
-- Admission is exactly app.b026_vendor_account_history's job read (20261106220000): the account-session
-- actor (app.b026_account_actor; a job token is never an account credential), the B-026 account and
-- contact predicates, app.b026_accounts_enabled, and only confirmed links to this actor (a tombstoned
-- link has user_id NULL and never matches). Plus: this one organization, and its own default-OFF
-- organizations.feature_flags.vendor_workbench (strict boolean true); OFF returns an empty list.
-- Amount waiting = the vendor's own reported cost on this job once the company confirmed it
-- (repair_vendor_jobs.confirmed_at; that confirmation posts the repair expense and sets the ticket's
-- final cost), minus the vendor's own B-025 received marks for this ticket and this contact's vendor
-- profile (marks are in whole currency units, the vendor document unit: cost / 100), or zero once an
-- issued receipt exists. A report the company has not confirmed is not a recorded amount owed: NULL.
-- There is no company-side "paid to vendor" field. Migration-owned, fixed search_path, every name
-- schema-qualified. Never returns a job token.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- VOLATILE: app.b026_account_actor takes FOR SHARE NOWAIT; never call in READ ONLY.
CREATE FUNCTION app.b063_vendor_workbench(p_session_hash text,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor uuid; result jsonb;
BEGIN
 actor:=app.b026_account_actor(p_session_hash);
 IF p_org IS NULL OR NOT coalesce((SELECT o.feature_flags->'vendor_workbench'='true'::jsonb
   FROM public.organizations o WHERE o.id=p_org),false) THEN RETURN '[]'::jsonb; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',j.id,'property',pr.name,
  'currency',btrim(coalesce(t.currency,pr.currency)),
  'waitingMinor',CASE WHEN j.confirmed_at IS NULL OR j.reported_at IS NULL OR j.reported_cost_minor IS NULL
    OR j.reported_cost_minor<=0 THEN NULL
   WHEN EXISTS(SELECT 1 FROM public.vendor_documents d WHERE d.org_id=t.org_id AND d.ticket_id=t.id
    AND d.vendor_profile_id=vp.id AND d.kind='receipt' AND d.status='issued') THEN '0'
   ELSE greatest(j.reported_cost_minor::numeric-100*coalesce(received.total,0),0)::text END,
  'openable',EXISTS(SELECT 1 FROM public.repair_vendor_secrets s WHERE s.job_id=j.id))
  ORDER BY j.created_at DESC,j.id),'[]'::jsonb) INTO result
 FROM app.b026_vendor_job_accounts l
 JOIN app.b026_vendor_accounts a ON a.org_id=l.org_id AND a.contact_id=l.contact_id AND a.user_id=l.user_id
 JOIN public.contacts c ON c.org_id=a.org_id AND c.id=a.contact_id
 JOIN public.repair_vendor_jobs j ON j.id=l.job_id AND j.org_id=l.org_id AND j.vendor_contact_id=l.contact_id
 JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id AND t.assigned_vendor_contact_id=l.contact_id
 JOIN public.properties pr ON pr.org_id=t.org_id AND pr.id=t.property_id
 LEFT JOIN public.vendor_profiles vp ON vp.org_id=l.org_id AND vp.contact_id=l.contact_id
 LEFT JOIN LATERAL (SELECT sum(m.amount_minor) AS total FROM app.b025_received_marks m
  WHERE m.org_id=t.org_id AND m.ticket_id=t.id AND m.vendor_profile_id=vp.id) received ON true
 WHERE l.user_id=actor AND c.is_vendor AND c.archived_at IS NULL AND (c.user_id IS NULL OR c.user_id=actor)
 AND app.b026_accounts_enabled(l.org_id) AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
 AND j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL
 AND l.org_id=p_org;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b063_vendor_workbench(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b063_vendor_workbench(text,uuid) TO service_role;
COMMIT;
