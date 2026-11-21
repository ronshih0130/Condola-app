-- B-065 phase B slice P1 (VEN-18-AC6, AC9 record, AC10 record; design note hub 20-build/specs/B-065-phase-b-design.md
-- sections 3-4): the data layer for the direction-1 receipt stamp and consent-before-first-receipt. Schema and
-- service-only gateways only; no route, page, generator or upload path (Ron PR-040: Q3 a, upload is a later slice).
--
-- Tables (RLS on, every privilege revoked from PUBLIC/anon/authenticated/service_role, append-only and immutable):
--  app.b065_stamp_versions  one immutable stamp art per version, contiguous per (org, vendor contact). Generated art is
--                           one canonical SVG (paths only) with its sha256, the printed inputs and their digest, the font
--                           and generator ids and the fallback code points. 'uploaded' (seal_id) is reserved for P3.
--  app.b065_stamp_consents  a consent references one version (composite FK pins the contact); one per version; only
--                           to the contact's latest version (guard trigger).
--  app.b065_stamp_requests  request ledger: every accepted request id with actor/via/grant, contact, op, the sha256 of
--                           the full semantic payload (incl. the server-recomputed art digest) and the first answer.
-- One input algorithm: app.b065_stamp_inputs(profile) is the only definition of the printed inputs, NFC-normalized and
-- trimmed, empty -> null; app.b065_inputs_sha256 hashes its jsonb text. Save, consent and readiness all use them.
-- Admission is a verified internal context: the B-026 account session hash (account) or the B-025 document token hash
-- (document_token), never a client claim. Gate: vendor_activation (platform switch seeded OFF in phase A + org flag);
-- account path also vendor_workbench, the B-026 account gate and effective brand_v3 (app.b065_enabled); token path
-- also the B-025 vendor_documents gate. Only a vendor whose latest declared issuer type is exempt_business is admitted.
-- Serialization (every stamp mutation, both paths), each lock taken in this order and waited on for at most 3s
-- (lock_timeout on the writer gateways; 55P03 maps to busy):
--  (1) pg_advisory_xact_lock(hashtextextended('b065/stamp-req/'||org||'/'||request,0))  request key
--  (2) pg_advisory_xact_lock(hashtextextended('b065/stamp-org/'||org,0))                 exclusive per-org stamp mutex
--  (3) pg_advisory_xact_lock_shared(hashtextextended('b065/issuer-org/'||org,0))         phase A's key, shared, so the
--      issuer type read by admission cannot change before commit (B-067 issuance takes (2) and (3) shared)
--  (4) row share-locks: account set = platform switches vendor_account, vendor_activation -> organization -> caller's
--      b026_vendor_accounts -> their contacts -> caller's org_members -> those contacts' vendor_profiles; grant set =
--      switches vendor_activation, vendor_documents -> organization -> the vendor_document_grants row -> the
--      vendor_profiles row -> its contact (no account row needed)
--  (5) admission decided only on locked rows, (6) shape check, ledger replay, then reads and writes. Nothing waits after
--      admission: every FK target of the inserts is already share-locked, versions are never updated, audit_log has no
--      FKs. Any failure returns before the first write or raises, so a refused request writes nothing.
-- 0 outbound.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Canonical art shape (no table access): an <svg> root in the SVG namespace holding only svg/g/rect/path elements, no
-- text nodes, entities, references, styles, scripts, event attributes, comments or processing instructions; at most
-- 512 KiB of UTF-8. Used by the version CHECK and by the writers before anything is reserved.
CREATE FUNCTION app.b065_svg_canonical(p_svg text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(octet_length(p_svg) BETWEEN 1 AND 524288
  AND p_svg ~ '^<svg xmlns="http://www\.w3\.org/2000/svg"[^<>]*>'
  AND p_svg ~ '</svg>$'
  AND p_svg !~ '<(?!/?(svg|g|rect|path)[\s/>])'
  AND p_svg !~ '>[^<]*[^\s<][^<]*<'
  AND p_svg !~* '&|href|url\s*\(|\son[a-z]+\s*=|style|script|<!|<\?|\\',false)
$$;
REVOKE ALL ON FUNCTION app.b065_svg_canonical(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE app.b065_stamp_versions (
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 contact_id uuid NOT NULL,
 vendor_profile_id uuid NOT NULL,
 version integer NOT NULL CHECK (version >= 1),
 request_id uuid NOT NULL,
 source text NOT NULL CHECK (source IN ('generated','uploaded')),
 svg text,
 seal_id uuid REFERENCES app.b025_profile_seals(id),
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 inputs jsonb NOT NULL CHECK (jsonb_typeof(inputs)='object'),
 inputs_sha256 text NOT NULL CHECK (inputs_sha256=encode(sha256(convert_to(inputs::text,'UTF8')),'hex')),
 font_id text CHECK (font_id ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$'),
 generator_version text CHECK (generator_version ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$'),
 fallback_codepoints integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(fallback_codepoints) <= 160),
 created_by uuid,
 created_via text NOT NULL CHECK (created_via IN ('account','document_token')),
 grant_id uuid REFERENCES public.vendor_document_grants(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, id),
 UNIQUE (org_id, contact_id, version),
 UNIQUE (org_id, id, contact_id),
 UNIQUE (org_id, request_id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id),
 FOREIGN KEY (org_id, vendor_profile_id) REFERENCES public.vendor_profiles(org_id, id),
 CHECK ((source='generated' AND seal_id IS NULL AND app.b065_svg_canonical(svg)
   AND sha256=encode(sha256(convert_to(svg,'UTF8')),'hex') AND font_id IS NOT NULL AND generator_version IS NOT NULL)
  OR (source='uploaded' AND svg IS NULL AND seal_id IS NOT NULL)),
 CHECK ((created_via='account' AND created_by IS NOT NULL AND grant_id IS NULL)
  OR (created_via='document_token' AND created_by IS NULL AND grant_id IS NOT NULL))
);
ALTER TABLE app.b065_stamp_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b065_stamp_versions FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE app.b065_stamp_consents (
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 request_id uuid NOT NULL,
 stamp_version_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('consented','adopted_upload')),
 consent_text text,
 consented_by uuid,
 via text NOT NULL CHECK (via IN ('account','document_token')),
 grant_id uuid REFERENCES public.vendor_document_grants(id),
 consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, request_id),
 UNIQUE (org_id, stamp_version_id),
 FOREIGN KEY (org_id, stamp_version_id, contact_id) REFERENCES app.b065_stamp_versions(org_id, id, contact_id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id),
 CHECK ((kind='consented' AND consent_text IS NOT DISTINCT FROM '我同意使用這枚印章開立收據')
  OR (kind='adopted_upload' AND consent_text IS NULL)),
 CHECK ((via='account' AND consented_by IS NOT NULL AND grant_id IS NULL)
  OR (via='document_token' AND consented_by IS NULL AND grant_id IS NOT NULL))
);
ALTER TABLE app.b065_stamp_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b065_stamp_consents FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE app.b065_stamp_requests (
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 request_id uuid NOT NULL,
 actor_id uuid,
 via text NOT NULL CHECK (via IN ('account','document_token')),
 grant_id uuid REFERENCES public.vendor_document_grants(id),
 contact_id uuid NOT NULL,
 op text NOT NULL CHECK (op IN ('save','consent')),
 payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
 answer jsonb NOT NULL CHECK (answer->>'status' IN ('recorded','unchanged','consented')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id, request_id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id),
 CHECK ((via='account' AND actor_id IS NOT NULL AND grant_id IS NULL)
  OR (via='document_token' AND actor_id IS NULL AND grant_id IS NOT NULL))
);
ALTER TABLE app.b065_stamp_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b065_stamp_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER b065_stamp_versions_no_change BEFORE UPDATE OR DELETE ON app.b065_stamp_versions
FOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b065_stamp_versions_no_truncate BEFORE TRUNCATE ON app.b065_stamp_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b065_stamp_consents_no_change BEFORE UPDATE OR DELETE ON app.b065_stamp_consents
FOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b065_stamp_consents_no_truncate BEFORE TRUNCATE ON app.b065_stamp_consents
FOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b065_stamp_requests_no_change BEFORE UPDATE OR DELETE ON app.b065_stamp_requests
FOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();
CREATE TRIGGER b065_stamp_requests_no_truncate BEFORE TRUNCATE ON app.b065_stamp_requests
FOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();

-- Insert guards (defence behind the gateways): contiguous versions; the profile, any seal and any grant belong to the
-- same org, contact and profile; a consent's kind matches its art's source and it targets the contact's latest version.
CREATE FUNCTION app.b065_stamp_version_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.version IS DISTINCT FROM 1+coalesce((SELECT max(v.version) FROM app.b065_stamp_versions v
   WHERE v.org_id=NEW.org_id AND v.contact_id=NEW.contact_id),0)
  OR NOT EXISTS(SELECT 1 FROM public.vendor_profiles p
   WHERE p.org_id=NEW.org_id AND p.id=NEW.vendor_profile_id AND p.contact_id=NEW.contact_id)
  OR (NEW.seal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.b025_profile_seals s
   WHERE s.id=NEW.seal_id AND s.org_id=NEW.org_id AND s.vendor_profile_id=NEW.vendor_profile_id AND s.sha256=NEW.sha256))
  OR (NEW.grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.vendor_document_grants g
   WHERE g.id=NEW.grant_id AND g.org_id=NEW.org_id AND g.vendor_profile_id=NEW.vendor_profile_id))
 THEN RAISE EXCEPTION 'b065 stamp version scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_version_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b065_stamp_versions_guard BEFORE INSERT ON app.b065_stamp_versions
FOR EACH ROW EXECUTE FUNCTION app.b065_stamp_version_guard();

CREATE FUNCTION app.b065_stamp_consent_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v app.b065_stamp_versions;
BEGIN
 SELECT * INTO v FROM app.b065_stamp_versions x WHERE x.org_id=NEW.org_id AND x.id=NEW.stamp_version_id;
 IF v.id IS NULL OR v.contact_id IS DISTINCT FROM NEW.contact_id
  OR (NEW.kind='consented') IS DISTINCT FROM (v.source='generated')
  OR EXISTS(SELECT 1 FROM app.b065_stamp_versions x WHERE x.org_id=v.org_id AND x.contact_id=v.contact_id AND x.version>v.version)
  OR (NEW.grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.vendor_document_grants g
   WHERE g.id=NEW.grant_id AND g.org_id=NEW.org_id AND g.vendor_profile_id=v.vendor_profile_id))
 THEN RAISE EXCEPTION 'b065 stamp consent scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_consent_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b065_stamp_consents_guard BEFORE INSERT ON app.b065_stamp_consents
FOR EACH ROW EXECUTE FUNCTION app.b065_stamp_consent_guard();

-- The one input algorithm (design note section 3): what the stamp prints, from the live profile row. NULL without a
-- profile. name = business_name, else display_name; each value NFC(btrim(v)), empty -> null.
CREATE FUNCTION app.b065_stamp_inputs(p public.vendor_profiles) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
  'name',coalesce(nullif(normalize(btrim(p.business_name),NFC),''),nullif(normalize(btrim(p.display_name),NFC),'')),
  'tax_id',nullif(normalize(btrim(p.tax_id),NFC),''),
  'representative',nullif(normalize(btrim(p.representative_name),NFC),''),
  'address',nullif(normalize(btrim(p.address),NFC),''),
  'phone_e164',nullif(normalize(btrim(p.phone_e164),NFC),'')) END
$$;
REVOKE ALL ON FUNCTION app.b065_stamp_inputs(public.vendor_profiles) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b065_inputs_sha256(p_inputs jsonb) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(p_inputs::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION app.b065_inputs_sha256(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Internal resource guard (design note section 2, A5; the visible per-row limits are P2's, Ron Q4 a): at most 160
-- characters in total and no control, separator or private-use characters.
CREATE FUNCTION app.b065_inputs_fit(p_inputs jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_inputs IS NOT NULL
  AND coalesce((SELECT sum(char_length(e.value)) FROM jsonb_each_text(p_inputs) e),0) <= 160
  AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(p_inputs) e
   WHERE e.value ~ '[\x01-\x1f\x7f-\x9f  -\U000F0000-\U0010FFFF]')
$$;
REVOKE ALL ON FUNCTION app.b065_inputs_fit(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Generator metadata shape: inputs digest, font and generator ids, and the fallback code points (ascending, distinct,
-- valid scalar values, at most 160).
CREATE FUNCTION app.b065_art_meta_ok(p_inputs_sha256 text,p_font text,p_generator text,p_fallback integer[]) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(p_inputs_sha256 ~ '^[0-9a-f]{64}$'
  AND p_font ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$'
  AND p_generator ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$'
  AND p_fallback IS NOT NULL AND coalesce(array_ndims(p_fallback),1)=1 AND cardinality(p_fallback) <= 160
  AND array_position(p_fallback,NULL) IS NULL
  AND NOT EXISTS(SELECT 1 FROM unnest(p_fallback) WITH ORDINALITY a(cp,i)
   WHERE a.cp NOT BETWEEN 0 AND 1114111 OR a.cp BETWEEN 55296 AND 57343
    OR (a.i>1 AND a.cp <= p_fallback[a.i-1+array_lower(p_fallback,1)-1])),false)
$$;
REVOKE ALL ON FUNCTION app.b065_art_meta_ok(text,text,text,integer[]) FROM PUBLIC,anon,authenticated,service_role;

-- Token-path gate: vendor_activation (platform switch + org flag) and the B-025 vendor_documents gate.
CREATE FUNCTION app.b065_grant_enabled(p_org uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((SELECT o.feature_flags->'vendor_activation'='true'::jsonb
  AND coalesce((SELECT f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
    AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    FROM public.platform_settings f WHERE f.key='vendor_activation'),false)
  FROM public.organizations o WHERE o.id=p_org),false) AND coalesce(app.b025_flag_on(p_org),false)
$$;
REVOKE ALL ON FUNCTION app.b065_grant_enabled(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Account admission (phase A's rule plus the profile lock and the type-2 check): live account session -> its vendor
-- account in this org -> that live vendor contact; the caller is not org staff; the latest declared issuer type is
-- exempt_business. 42501 otherwise. p_lock (writers): every row the decision reads is share-locked first in the
-- account-set order, and the decision admits only on locked rows (a binding, contact or profile that appeared during a
-- wait is not admitted), so nothing waits after it. profile is NULL when the contact has none (or none was locked).
CREATE FUNCTION app.b065_stamp_account(p_session_hash text,p_org uuid,p_env_v2 boolean,p_lock boolean,
 OUT actor uuid,OUT contact uuid,OUT profile public.vendor_profiles)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; locked_switches int; locked_org int; locked_accounts uuid[]; locked_contacts uuid[];
 locked_profiles uuid[]; issuer text;
BEGIN
 IF p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' OR p_org IS NULL
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_lock THEN
  SELECT s.user_id INTO target FROM public.auth_sessions s WHERE s.token_hash=p_session_hash;
  IF target IS NULL THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO locked_switches FROM (SELECT 1 FROM public.platform_settings f
   WHERE f.key IN ('vendor_account','vendor_activation') ORDER BY f.key FOR SHARE) x;
  SELECT count(*) INTO locked_org FROM (SELECT 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE) x;
  SELECT coalesce(array_agg(x.contact_id),'{}') INTO locked_accounts FROM (SELECT va.contact_id FROM app.b026_vendor_accounts va
   WHERE va.org_id=p_org AND va.user_id=target ORDER BY va.contact_id FOR SHARE) x;
  SELECT coalesce(array_agg(x.id),'{}') INTO locked_contacts FROM (SELECT c.id FROM public.contacts c
   WHERE c.org_id=p_org AND c.id=ANY(locked_accounts) ORDER BY c.id FOR SHARE) x;
  PERFORM 1 FROM public.org_members m WHERE m.org_id=p_org AND m.user_id=target ORDER BY m.id FOR SHARE;
  SELECT coalesce(array_agg(x.id),'{}') INTO locked_profiles FROM (SELECT p.id FROM public.vendor_profiles p
   WHERE p.org_id=p_org AND p.contact_id=ANY(locked_contacts) ORDER BY p.id FOR SHARE) x;
  IF locked_switches<>2 OR locked_org<>1 OR cardinality(locked_accounts)=0 OR cardinality(locked_contacts)=0
  THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 actor:=app.b026_account_actor(p_session_hash);
 IF (p_lock AND actor IS DISTINCT FROM target) OR NOT app.b065_enabled(p_org,p_env_v2)
  OR EXISTS(SELECT 1 FROM public.org_members m WHERE m.org_id=p_org AND m.user_id=actor AND m.status::text<>'removed')
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT va.contact_id INTO contact FROM app.b026_vendor_accounts va
  JOIN public.contacts c ON c.org_id=va.org_id AND c.id=va.contact_id AND c.is_vendor AND c.archived_at IS NULL
  WHERE va.org_id=p_org AND va.user_id=actor AND (NOT p_lock OR va.contact_id=ANY(locked_accounts)) ORDER BY va.contact_id LIMIT 1;
 IF contact IS NULL OR (p_lock AND NOT (contact=ANY(locked_accounts) AND contact=ANY(locked_contacts)))
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT t.issuer_type INTO issuer FROM app.b065_issuer_types t
  WHERE t.org_id=p_org AND t.contact_id=contact ORDER BY t.declared_at DESC, t.request_id DESC LIMIT 1;
 IF issuer IS DISTINCT FROM 'exempt_business' THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO profile FROM public.vendor_profiles p
  WHERE p.org_id=p_org AND p.contact_id=contact AND (NOT p_lock OR p.id=ANY(locked_profiles));
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_account(text,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Token admission: the server hands over the document token's hash (never a grant id or claim from the client). The
-- grant must be live (unrevoked, unexpired, scope vendor_document) for this org and profile, both gates on, the
-- profile's contact a live vendor whose latest declared type is exempt_business. 42501 otherwise. p_lock: the
-- grant-set rows are share-locked first and the decision uses only them.
CREATE FUNCTION app.b065_stamp_grant(p_token_hash text,p_org uuid,p_profile uuid,p_lock boolean,
 OUT grant_id uuid,OUT contact uuid,OUT profile public.vendor_profiles)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE locked_switches int; locked_org int; g public.vendor_document_grants; locked_profile uuid; locked_contact uuid;
 issuer text;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_org IS NULL OR p_profile IS NULL
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_lock THEN
  SELECT count(*) INTO locked_switches FROM (SELECT 1 FROM public.platform_settings f
   WHERE f.key IN ('vendor_activation','vendor_documents') ORDER BY f.key FOR SHARE) x;
  SELECT count(*) INTO locked_org FROM (SELECT 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE) x;
  SELECT * INTO g FROM public.vendor_document_grants x
   WHERE x.token_hash=p_token_hash AND x.org_id=p_org AND x.vendor_profile_id=p_profile FOR SHARE;
  SELECT p.id INTO locked_profile FROM public.vendor_profiles p WHERE p.org_id=p_org AND p.id=p_profile FOR SHARE;
  SELECT c.id INTO locked_contact FROM public.contacts c
   WHERE c.org_id=p_org AND c.id=(SELECT p.contact_id FROM public.vendor_profiles p WHERE p.org_id=p_org AND p.id=locked_profile)
   FOR SHARE;
  IF locked_switches<>2 OR locked_org<>1 OR g.id IS NULL OR locked_profile IS NULL OR locked_contact IS NULL
  THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT * INTO g FROM public.vendor_document_grants x
   WHERE x.token_hash=p_token_hash AND x.org_id=p_org AND x.vendor_profile_id=p_profile;
 END IF;
 IF g.id IS NULL OR g.scope<>'vendor_document' OR g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp()
  OR NOT app.b065_grant_enabled(p_org)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT p.* INTO profile FROM public.vendor_profiles p WHERE p.org_id=p_org AND p.id=p_profile;
 SELECT c.id INTO contact FROM public.contacts c
  WHERE c.org_id=p_org AND c.id=profile.contact_id AND c.is_vendor AND c.archived_at IS NULL;
 IF profile.id IS NULL OR contact IS NULL OR (p_lock AND contact IS DISTINCT FROM locked_contact)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT t.issuer_type INTO issuer FROM app.b065_issuer_types t
  WHERE t.org_id=p_org AND t.contact_id=contact ORDER BY t.declared_at DESC, t.request_id DESC LIMIT 1;
 IF issuer IS DISTINCT FROM 'exempt_business' THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 grant_id:=g.id;
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_grant(text,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Steps (1)-(3) of the lock order (header). The writer gateways carry lock_timeout=3s.
CREATE FUNCTION app.b065_stamp_locks(p_org uuid,p_request uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_org IS NULL THEN RETURN; END IF;
 IF p_request IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('b065/stamp-req/'||p_org::text||'/'||p_request::text,0));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b065/stamp-org/'||p_org::text,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('b065/issuer-org/'||p_org::text,0));
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_locks(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Readiness and state for an admitted vendor. status: needs_tax_id (no profile or no tax id) | needs_stamp (no
-- version) | stale (latest generated art printed other inputs, or another profile) | needs_consent | ready.
-- Advisory for UI routing only; B-067's freeze transaction re-evaluates it under its locks. p_detail selects the shape:
-- 'readiness' (no art), 'preview' (token holder: latest art, no history, no version ids), 'view' (account page).
CREATE FUNCTION app.b065_stamp_state(p_org uuid,p_contact uuid,p_profile public.vendor_profiles,p_detail text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE inputs jsonb; inputs_sha text; latest app.b065_stamp_versions; consent app.b065_stamp_consents; fresh boolean;
 status text; art jsonb;
BEGIN
 inputs:=app.b065_stamp_inputs(p_profile);
 inputs_sha:=CASE WHEN inputs IS NULL THEN NULL ELSE app.b065_inputs_sha256(inputs) END;
 SELECT * INTO latest FROM app.b065_stamp_versions v WHERE v.org_id=p_org AND v.contact_id=p_contact ORDER BY v.version DESC LIMIT 1;
 IF latest.id IS NOT NULL THEN
  SELECT * INTO consent FROM app.b065_stamp_consents c WHERE c.org_id=p_org AND c.stamp_version_id=latest.id;
 END IF;
 fresh:=latest.id IS NOT NULL AND latest.vendor_profile_id IS NOT DISTINCT FROM p_profile.id
  AND (latest.source='uploaded' OR latest.inputs_sha256 IS NOT DISTINCT FROM inputs_sha);
 status:=CASE WHEN p_profile.id IS NULL OR inputs->>'tax_id' IS NULL THEN 'needs_tax_id'
  WHEN latest.id IS NULL THEN 'needs_stamp' WHEN NOT fresh THEN 'stale'
  WHEN consent.request_id IS NULL THEN 'needs_consent' ELSE 'ready' END;
 IF p_detail='readiness' THEN
  RETURN jsonb_build_object('status',status,'inputsSha256',inputs_sha,'stamp',CASE WHEN latest.id IS NULL THEN NULL ELSE
   jsonb_build_object('versionId',latest.id,'version',latest.version,'source',latest.source,'sha256',latest.sha256,
    'consentRequestId',consent.request_id) END);
 END IF;
 art:=CASE WHEN latest.id IS NULL THEN NULL ELSE jsonb_build_object('version',latest.version,'source',latest.source,
  'sha256',latest.sha256,'svg',latest.svg,'sealId',latest.seal_id,'consented',consent.request_id IS NOT NULL,
  'createdAt',latest.created_at) END;
 IF p_detail='preview' THEN
  RETURN jsonb_build_object('status',status,'inputs',inputs,'inputsSha256',inputs_sha,
   'inputsFit',coalesce(app.b065_inputs_fit(inputs),false),'latest',art);
 END IF;
 RETURN jsonb_build_object('state',CASE WHEN latest.id IS NULL THEN 'none' WHEN NOT fresh THEN 'stale'
   WHEN consent.request_id IS NOT NULL THEN 'consented' ELSE 'generated' END,
  'status',status,'inputs',inputs,'inputsSha256',inputs_sha,'inputsFit',coalesce(app.b065_inputs_fit(inputs),false),
  'current',art,
  'consents',coalesce((SELECT jsonb_agg(jsonb_build_object('version',v.version,'source',v.source,'sha256',v.sha256,
    'kind',c.kind,'consentedAt',c.consented_at) ORDER BY v.version DESC)
   FROM app.b065_stamp_consents c JOIN app.b065_stamp_versions v ON v.org_id=c.org_id AND v.id=c.stamp_version_id
   WHERE c.org_id=p_org AND c.contact_id=p_contact),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_state(uuid,uuid,public.vendor_profiles,text) FROM PUBLIC,anon,authenticated,service_role;

-- The writer core, called only after admission with steps (1)-(5) held. op 'save' (「產生印章」/「重新產生」) appends
-- version n+1 without consent ('unchanged' when the latest version is the same art for the same inputs). op 'consent'
-- (「使用這枚印章並繼續」): the previewed sha256 must be the art's recomputed digest; the generated inputs must equal the
-- locked profile's; the latest version is consented, an older one is rejected_superseded, unknown art supplied with
-- current inputs is appended as n+1 and consented. Refusals return before any write and reserve nothing.
CREATE FUNCTION app.b065_stamp_write(p_op text,p_via text,p_actor uuid,p_grant uuid,p_org uuid,p_contact uuid,
 p_profile public.vendor_profiles,p_request uuid,p_svg text,p_previewed text,p_inputs_sha256 text,p_font text,
 p_generator text,p_fallback integer[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE art_sha text; payload text; prior app.b065_stamp_requests; inputs jsonb; current_sha text;
 latest app.b065_stamp_versions; target app.b065_stamp_versions; answer jsonb; audit_role text;
BEGIN
 audit_role:=CASE WHEN p_via='account' THEN 'vendor' ELSE 'vendor_document' END;
 -- Shape (rejected_invalid, nothing reserved).
 IF p_request IS NULL OR p_op NOT IN ('save','consent') THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 IF p_svg IS NOT NULL THEN
  IF NOT app.b065_svg_canonical(p_svg) OR NOT app.b065_art_meta_ok(p_inputs_sha256,p_font,p_generator,p_fallback)
  THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
  art_sha:=encode(sha256(convert_to(p_svg,'UTF8')),'hex');
 ELSIF p_inputs_sha256 IS NOT NULL OR p_font IS NOT NULL OR p_generator IS NOT NULL OR p_fallback IS NOT NULL THEN
  RETURN '{"status":"rejected_invalid"}'::jsonb;
 END IF;
 IF p_op='save' AND (p_svg IS NULL OR p_previewed IS NOT NULL) THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 IF p_op='consent' AND (p_previewed IS NULL OR p_previewed !~ '^[0-9a-f]{64}$' OR (art_sha IS NOT NULL AND art_sha<>p_previewed))
 THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
 -- Request identity: the full semantic payload, with the server-recomputed art digest.
 payload:=encode(sha256(convert_to(jsonb_build_object('op',p_op,'art_sha256',art_sha,'previewed_sha256',p_previewed,
  'inputs_sha256',p_inputs_sha256,'font_id',p_font,'generator_version',p_generator,'fallback',to_jsonb(p_fallback))::text,'UTF8')),'hex');
 SELECT * INTO prior FROM app.b065_stamp_requests r WHERE r.org_id=p_org AND r.request_id=p_request;
 IF FOUND THEN
  IF prior.via=p_via AND prior.actor_id IS NOT DISTINCT FROM p_actor AND prior.grant_id IS NOT DISTINCT FROM p_grant
   AND prior.contact_id=p_contact AND prior.op=p_op AND prior.payload_sha256=payload
  THEN RETURN prior.answer||'{"replayed":true}'::jsonb; END IF;
  RETURN '{"status":"rejected_conflict"}'::jsonb;
 END IF;
 -- Decision on the locked profile.
 IF p_profile.id IS NULL OR p_profile.tax_id IS NULL THEN RETURN '{"status":"rejected_invalid","reason":"needs_tax_id"}'::jsonb; END IF;
 inputs:=app.b065_stamp_inputs(p_profile);
 current_sha:=app.b065_inputs_sha256(inputs);
 SELECT * INTO latest FROM app.b065_stamp_versions v WHERE v.org_id=p_org AND v.contact_id=p_contact ORDER BY v.version DESC LIMIT 1;
 IF p_op='consent' AND latest.id IS NOT NULL AND latest.sha256=p_previewed THEN
  target:=latest;
  IF target.source<>'generated' THEN RETURN '{"status":"rejected_invalid"}'::jsonb; END IF;
  IF target.inputs_sha256<>current_sha OR target.vendor_profile_id<>p_profile.id
   OR (p_inputs_sha256 IS NOT NULL AND p_inputs_sha256<>current_sha)
  THEN RETURN '{"status":"rejected_stale"}'::jsonb; END IF;
 ELSIF p_op='consent' AND EXISTS(SELECT 1 FROM app.b065_stamp_versions v
   WHERE v.org_id=p_org AND v.contact_id=p_contact AND v.sha256=p_previewed) THEN
  RETURN '{"status":"rejected_superseded"}'::jsonb;
 ELSIF p_svg IS NULL THEN
  RETURN '{"status":"rejected_invalid"}'::jsonb;
 ELSE
  IF NOT app.b065_inputs_fit(inputs) THEN RETURN '{"status":"rejected_invalid","reason":"stamp_input_limit"}'::jsonb; END IF;
  IF p_inputs_sha256<>current_sha THEN RETURN '{"status":"rejected_stale"}'::jsonb; END IF;
  IF p_op='save' AND latest.id IS NOT NULL AND latest.source='generated' AND latest.sha256=art_sha
   AND latest.inputs_sha256=current_sha AND latest.vendor_profile_id=p_profile.id AND latest.font_id=p_font
   AND latest.generator_version=p_generator AND latest.fallback_codepoints=p_fallback THEN
   target:=latest;
   answer:=jsonb_build_object('status','unchanged','version',target.version,'sha256',target.sha256,'replayed',false);
  ELSE
   INSERT INTO app.b065_stamp_versions(org_id,contact_id,vendor_profile_id,version,request_id,source,svg,sha256,inputs,
    inputs_sha256,font_id,generator_version,fallback_codepoints,created_by,created_via,grant_id)
   VALUES (p_org,p_contact,p_profile.id,coalesce(latest.version,0)+1,p_request,'generated',p_svg,art_sha,inputs,
    current_sha,p_font,p_generator,p_fallback,p_actor,p_via,p_grant)
   RETURNING * INTO target;
   INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,request_id)
   VALUES (p_org,p_actor,audit_role,'contacts',p_contact::text,'insert','vendor_stamp_generated',
    jsonb_build_object('version',target.version,'sha256',target.sha256,'source',target.source),p_request::text);
   answer:=jsonb_build_object('status','recorded','version',target.version,'sha256',target.sha256,'replayed',false);
  END IF;
 END IF;
 IF p_op='consent' THEN
  IF EXISTS(SELECT 1 FROM app.b065_stamp_consents c WHERE c.org_id=p_org AND c.stamp_version_id=target.id) THEN
   answer:=jsonb_build_object('status','unchanged','version',target.version,'sha256',target.sha256,'replayed',false);
  ELSE
   INSERT INTO app.b065_stamp_consents(org_id,request_id,stamp_version_id,contact_id,kind,consent_text,consented_by,via,grant_id)
   VALUES (p_org,p_request,target.id,p_contact,'consented','我同意使用這枚印章開立收據',p_actor,p_via,p_grant);
   INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,request_id)
   VALUES (p_org,p_actor,audit_role,'contacts',p_contact::text,'insert','vendor_stamp_consented',
    jsonb_build_object('version',target.version,'sha256',target.sha256,'source',target.source),p_request::text);
   answer:=jsonb_build_object('status','consented','version',target.version,'sha256',target.sha256,'replayed',false);
  END IF;
 END IF;
 INSERT INTO app.b065_stamp_requests(org_id,request_id,actor_id,via,grant_id,contact_id,op,payload_sha256,answer)
 VALUES (p_org,p_request,p_actor,p_via,p_grant,p_contact,p_op,payload,answer);
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_write(text,text,uuid,uuid,uuid,uuid,public.vendor_profiles,uuid,text,text,text,text,text,integer[])
 FROM PUBLIC,anon,authenticated,service_role;

-- Gateways (service_role only). Account: ven-stamp state (login only). Token: B-067's grant-scoped preview read (S8).
CREATE FUNCTION app.b065_stamp_view(p_session_hash text,p_org uuid,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM app.b065_stamp_account(p_session_hash,p_org,p_env_v2,false);
 RETURN app.b065_stamp_state(p_org,a.contact,a.profile,'view');
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_view(text,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_stamp_view(text,uuid,boolean) TO service_role;

CREATE FUNCTION app.b065_stamp_preview_by_grant(p_token_hash text,p_org uuid,p_profile uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM app.b065_stamp_grant(p_token_hash,p_org,p_profile,false);
 RETURN app.b065_stamp_state(p_org,a.contact,a.profile,'preview');
END $$;
REVOKE ALL ON FUNCTION app.b065_stamp_preview_by_grant(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_stamp_preview_by_grant(text,uuid,uuid) TO service_role;

CREATE FUNCTION app.b065_receipt_stamp(p_session_hash text,p_org uuid,p_env_v2 boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM app.b065_stamp_account(p_session_hash,p_org,p_env_v2,false);
 RETURN app.b065_stamp_state(p_org,a.contact,a.profile,'readiness');
END $$;
REVOKE ALL ON FUNCTION app.b065_receipt_stamp(text,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_receipt_stamp(text,uuid,boolean) TO service_role;

CREATE FUNCTION app.b065_receipt_stamp_by_grant(p_token_hash text,p_org uuid,p_profile uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM app.b065_stamp_grant(p_token_hash,p_org,p_profile,false);
 RETURN app.b065_stamp_state(p_org,a.contact,a.profile,'readiness');
END $$;
REVOKE ALL ON FUNCTION app.b065_receipt_stamp_by_grant(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_receipt_stamp_by_grant(text,uuid,uuid) TO service_role;

CREATE FUNCTION app.b065_save_stamp(p_session_hash text,p_org uuid,p_env_v2 boolean,p_request uuid,p_svg text,
 p_inputs_sha256 text,p_font_id text,p_generator_version text,p_fallback integer[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='3s' AS $$
DECLARE a record;
BEGIN
 PERFORM app.b065_stamp_locks(p_org,p_request);
 SELECT * INTO a FROM app.b065_stamp_account(p_session_hash,p_org,p_env_v2,true);
 RETURN app.b065_stamp_write('save','account',a.actor,NULL,p_org,a.contact,a.profile,p_request,p_svg,NULL,
  p_inputs_sha256,p_font_id,p_generator_version,p_fallback);
END $$;
REVOKE ALL ON FUNCTION app.b065_save_stamp(text,uuid,boolean,uuid,text,text,text,text,integer[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_save_stamp(text,uuid,boolean,uuid,text,text,text,text,integer[]) TO service_role;

CREATE FUNCTION app.b065_save_stamp_by_grant(p_token_hash text,p_org uuid,p_profile uuid,p_request uuid,p_svg text,
 p_inputs_sha256 text,p_font_id text,p_generator_version text,p_fallback integer[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='3s' AS $$
DECLARE a record;
BEGIN
 PERFORM app.b065_stamp_locks(p_org,p_request);
 SELECT * INTO a FROM app.b065_stamp_grant(p_token_hash,p_org,p_profile,true);
 RETURN app.b065_stamp_write('save','document_token',NULL,a.grant_id,p_org,a.contact,a.profile,p_request,p_svg,NULL,
  p_inputs_sha256,p_font_id,p_generator_version,p_fallback);
END $$;
REVOKE ALL ON FUNCTION app.b065_save_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,integer[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_save_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,integer[]) TO service_role;

CREATE FUNCTION app.b065_consent_stamp(p_session_hash text,p_org uuid,p_env_v2 boolean,p_request uuid,
 p_previewed_sha256 text,p_svg text,p_inputs_sha256 text,p_font_id text,p_generator_version text,p_fallback integer[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='3s' AS $$
DECLARE a record;
BEGIN
 PERFORM app.b065_stamp_locks(p_org,p_request);
 SELECT * INTO a FROM app.b065_stamp_account(p_session_hash,p_org,p_env_v2,true);
 RETURN app.b065_stamp_write('consent','account',a.actor,NULL,p_org,a.contact,a.profile,p_request,p_svg,p_previewed_sha256,
  p_inputs_sha256,p_font_id,p_generator_version,p_fallback);
END $$;
REVOKE ALL ON FUNCTION app.b065_consent_stamp(text,uuid,boolean,uuid,text,text,text,text,text,integer[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_consent_stamp(text,uuid,boolean,uuid,text,text,text,text,text,integer[]) TO service_role;

CREATE FUNCTION app.b065_consent_stamp_by_grant(p_token_hash text,p_org uuid,p_profile uuid,p_request uuid,
 p_previewed_sha256 text,p_svg text,p_inputs_sha256 text,p_font_id text,p_generator_version text,p_fallback integer[]) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='3s' AS $$
DECLARE a record;
BEGIN
 PERFORM app.b065_stamp_locks(p_org,p_request);
 SELECT * INTO a FROM app.b065_stamp_grant(p_token_hash,p_org,p_profile,true);
 RETURN app.b065_stamp_write('consent','document_token',NULL,a.grant_id,p_org,a.contact,a.profile,p_request,p_svg,
  p_previewed_sha256,p_inputs_sha256,p_font_id,p_generator_version,p_fallback);
END $$;
REVOKE ALL ON FUNCTION app.b065_consent_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,text,integer[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b065_consent_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,text,integer[]) TO service_role;
COMMIT;
