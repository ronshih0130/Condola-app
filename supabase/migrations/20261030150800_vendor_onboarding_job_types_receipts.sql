-- Version 20261030150800. Vendor onboarding profiles, multi-job-type catalog, and vendor e-seal receipts / completion statements (Lane A step 1, Class B). Additive only, no backfill or data deletion. Down: DROP FUNCTION IF EXISTS app.next_vendor_document_seq(uuid, text); DROP TABLE IF EXISTS public.vendor_documents, public.vendor_document_sequences, public.vendor_onboarding_invites, public.vendor_profile_versions, public.vendor_profiles; ALTER TABLE public.contacts DROP COLUMN IF EXISTS receipt_title; ALTER TABLE public.ticket_attachments DROP COLUMN IF EXISTS phase; ALTER TABLE public.maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_job_type_code_fkey; DROP TABLE IF EXISTS public.job_types;

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Job types catalog and seed data
CREATE TABLE IF NOT EXISTS public.job_types (
  code                 text PRIMARY KEY CHECK (char_length(code) BETWEEN 1 AND 64),
  name_zh              text NOT NULL CHECK (char_length(name_zh) BETWEEN 1 AND 80),
  name_en              text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 80),
  required_fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_rules          jsonb NOT NULL,
  acceptance_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_modes        text[] NOT NULL DEFAULT '{}'::text[],
  sort                 integer NOT NULL DEFAULT 0,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.job_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_types FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.job_types FROM PUBLIC;
REVOKE ALL ON TABLE public.job_types FROM anon;
REVOKE ALL ON TABLE public.job_types FROM authenticated;
GRANT SELECT ON TABLE public.job_types TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.job_types TO service_role;

DROP POLICY IF EXISTS job_types_read ON public.job_types;
CREATE POLICY job_types_read ON public.job_types
  FOR SELECT TO authenticated
  USING (true);

INSERT INTO public.job_types (
  code, name_zh, name_en, required_fields, photo_rules, acceptance_checklist, pricing_modes, sort, active
) VALUES
  (
    'cleaning',
    '清潔',
    'Cleaning',
    '[{"key":"cleaning_scope","label_zh":"清潔範圍（室內／陽台／頂樓等）","label_en":"Cleaning Scope","type":"text","required":true},{"key":"area_ping_or_rooms","label_zh":"坪數或空間數","label_en":"Area (Ping) or Room Count","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":0},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"floor_clean","label_zh":"地面清潔完成","label_en":"Floor cleaned"},{"key":"kitchen_clean","label_zh":"廚房清潔完成","label_en":"Kitchen cleaned"},{"key":"bathroom_clean","label_zh":"衛浴清潔完成","label_en":"Bathroom cleaned"},{"key":"trash_removed","label_zh":"垃圾與雜物清運完成","label_en":"Trash and debris removed"}]'::jsonb,
    ARRAY['per_visit', 'per_ping', 'lump_sum']::text[],
    10,
    true
  ),
  (
    'plumbing',
    '水電',
    'Plumbing & Electrical',
    '[{"key":"fault_location","label_zh":"故障位置","label_en":"Fault Location","type":"text","required":true},{"key":"pipe_or_circuit_notes","label_zh":"管線或迴路說明","label_en":"Pipe or Circuit Description","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"water_flow","label_zh":"通水正常","label_en":"Water flow normal"},{"key":"power_supply","label_zh":"通電正常","label_en":"Power supply normal"},{"key":"no_leak","label_zh":"無漏水","label_en":"No water leakage"},{"key":"no_trip","label_zh":"無跳電","label_en":"No circuit tripping"},{"key":"switches_outlets","label_zh":"開關插座測試正常","label_en":"Switches and outlets tested"}]'::jsonb,
    ARRAY['per_hour', 'material_and_labor', 'lump_sum']::text[],
    20,
    true
  ),
  (
    'painting',
    '油漆',
    'Painting',
    '[{"key":"area_ping","label_zh":"施作面積（坪數）","label_en":"Painted Area (Ping)","type":"number","required":true},{"key":"wall_or_room_location","label_zh":"牆面或空間位置","label_en":"Wall or Room Location","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"even_color","label_zh":"無明顯色差","label_en":"No visible color mismatch"},{"key":"no_brush_marks","label_zh":"無刷痕流痕","label_en":"No brush or drip marks"},{"key":"no_odor","label_zh":"無異味殘留","label_en":"No residual odor"},{"key":"clean_edges","label_zh":"邊角收邊整齊","label_en":"Edges neatly finished"}]'::jsonb,
    ARRAY['per_ping', 'material_and_labor', 'lump_sum']::text[],
    30,
    true
  ),
  (
    'aircon',
    '冷氣',
    'Air Conditioning',
    '[{"key":"model_or_unit_count","label_zh":"機型或台數","label_en":"Model or Unit Count","type":"text","required":true},{"key":"service_or_repair_item","label_zh":"保養或維修項目","label_en":"Maintenance or Repair Item","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"operation_normal","label_zh":"運轉正常","label_en":"Normal operation"},{"key":"outlet_temp_normal","label_zh":"出風溫度正常","label_en":"Normal outlet temperature"},{"key":"filter_cleaned","label_zh":"濾網清潔完成","label_en":"Filter cleaned"},{"key":"no_condensate_leak","label_zh":"無漏水","label_en":"No condensate leakage"}]'::jsonb,
    ARRAY['per_item', 'per_visit', 'lump_sum']::text[],
    40,
    true
  ),
  (
    'moving',
    '搬家',
    'Moving',
    '[{"key":"item_list_or_count","label_zh":"搬運物件清單或件數","label_en":"Item List or Count","type":"text","required":true},{"key":"origin_destination","label_zh":"起訖地址","label_en":"Origin and Destination Addresses","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":0},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"item_count_verified","label_zh":"物件件數清點一致","label_en":"Item count verified"},{"key":"no_new_damage","label_zh":"外觀無新增損壞","label_en":"No new exterior damage"},{"key":"placed_as_requested","label_zh":"依指定位置擺放","label_en":"Placed at designated locations"}]'::jsonb,
    ARRAY['per_visit', 'per_item', 'lump_sum']::text[],
    50,
    true
  ),
  (
    'pest_control',
    '除蟲',
    'Pest Control',
    '[{"key":"pest_type","label_zh":"蟲害類型","label_en":"Pest Type","type":"text","required":true},{"key":"treatment_area","label_zh":"施作範圍","label_en":"Treatment Area","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"treatment_applied","label_zh":"藥劑施作完成","label_en":"Treatment applied"},{"key":"no_live_pests","label_zh":"現場無活體出現","label_en":"No live pests observed"},{"key":"safety_notice_posted","label_zh":"安全期標示張貼","label_en":"Safety notice posted"}]'::jsonb,
    ARRAY['per_visit', 'lump_sum']::text[],
    60,
    true
  ),
  (
    'locksmith',
    '鎖匠',
    'Locksmith',
    '[{"key":"lock_type","label_zh":"鎖具類型","label_en":"Lock Type","type":"text","required":true},{"key":"unlock_or_replace_reason","label_zh":"開鎖或更換原因","label_en":"Unlock or Replacement Reason","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":0},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"lock_operation_tested","label_zh":"鎖具開合測試正常","label_en":"Lock operation tested"},{"key":"keys_or_codes_delivered","label_zh":"鑰匙或密碼交付數量確認","label_en":"Keys or passcodes delivered"}]'::jsonb,
    ARRAY['per_item', 'per_visit', 'lump_sum']::text[],
    70,
    true
  ),
  (
    'masonry',
    '泥作',
    'Masonry',
    '[{"key":"area_ping","label_zh":"施作面積（坪數）","label_en":"Work Area (Ping)","type":"number","required":true},{"key":"work_items","label_zh":"施作項目（抹平、拆除、貼磁磚等）","label_en":"Work Items","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":true,"min":1,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"surface_flatness","label_zh":"表面平整度確認","label_en":"Surface flatness verified"},{"key":"no_hollow_tiles","label_zh":"敲擊無空心","label_en":"No hollow sound on tap"},{"key":"uniform_grout","label_zh":"接縫一致","label_en":"Uniform joints"},{"key":"curing_notice_posted","label_zh":"養護標示張貼","label_en":"Curing notice posted"}]'::jsonb,
    ARRAY['per_ping', 'quote_then_approve', 'lump_sum']::text[],
    80,
    true
  ),
  (
    'appliance_repair',
    '家電維修',
    'Appliance Repair',
    '[{"key":"appliance_category_model","label_zh":"家電品類與型號","label_en":"Appliance Category and Model","type":"text","required":true},{"key":"fault_symptom","label_zh":"故障現象","label_en":"Fault Symptom","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":false,"min":0,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"function_test_passed","label_zh":"功能測試通過","label_en":"Function test passed"},{"key":"noise_odor_resolved","label_zh":"異音或異味排除","label_en":"Noise or odor resolved"},{"key":"warranty_notes_recorded","label_zh":"保固或維修說明填寫完成","label_en":"Warranty or repair notes recorded"}]'::jsonb,
    ARRAY['per_item', 'material_and_labor', 'lump_sum']::text[],
    90,
    true
  ),
  (
    'leak_repair',
    '抓漏',
    'Leak Detection & Repair',
    '[{"key":"suspected_leak_location","label_zh":"疑似漏水位置","label_en":"Suspected Leak Location","type":"text","required":true},{"key":"floor_relative_position","label_zh":"樓層與相對位置說明","label_en":"Floor and Relative Position","type":"text","required":true}]'::jsonb,
    '{"before":{"required":true,"min":1,"max":5},"during":{"required":true,"min":1,"max":5},"after":{"required":true,"min":1,"max":5}}'::jsonb,
    '[{"key":"water_test_no_leak","label_zh":"試水無滲漏","label_en":"Water test passed with no seepage"},{"key":"leak_source_marked","label_zh":"抓漏位置標記","label_en":"Leak source marked"},{"key":"followup_days_noted","label_zh":"後續追蹤天數說明","label_en":"Follow-up observation days noted"}]'::jsonb,
    ARRAY['quote_then_approve', 'material_and_labor', 'lump_sum']::text[],
    100,
    true
  )
ON CONFLICT (code) DO NOTHING;

-- FK maintenance_tickets.job_type_code -> job_types(code) added NOT VALID then VALIDATE (no backfill)
ALTER TABLE public.maintenance_tickets
  ADD COLUMN IF NOT EXISTS job_type_code text NULL,
  ADD COLUMN IF NOT EXISTS type_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.maintenance_tickets
  DROP CONSTRAINT IF EXISTS maintenance_tickets_job_type_code_fkey;
ALTER TABLE public.maintenance_tickets
  ADD CONSTRAINT maintenance_tickets_job_type_code_fkey
  FOREIGN KEY (job_type_code) REFERENCES public.job_types(code) NOT VALID;
ALTER TABLE public.maintenance_tickets
  VALIDATE CONSTRAINT maintenance_tickets_job_type_code_fkey;

-- 2. ticket_attachments.phase (nullable; legacy rows stay NULL; 8-photo trigger unchanged)
ALTER TABLE public.ticket_attachments
  ADD COLUMN IF NOT EXISTS phase text NULL;

ALTER TABLE public.ticket_attachments
  DROP CONSTRAINT IF EXISTS ticket_attachments_phase_check;
ALTER TABLE public.ticket_attachments
  ADD CONSTRAINT ticket_attachments_phase_check
  CHECK (phase IS NULL OR phase IN ('before', 'during', 'after'));

-- 3. contacts.receipt_title (owner-supplied receipt buyer title)
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS receipt_title text NULL;

-- 4. vendor_profiles & vendor_profile_versions (org-scoped, no cross-org merge, no national ID column)
CREATE TABLE IF NOT EXISTS public.vendor_profiles (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id                 uuid NOT NULL,
  vendor_code                text NOT NULL CHECK (char_length(vendor_code) BETWEEN 1 AND 32),
  kind                       text NOT NULL CHECK (kind IN ('business', 'individual')),
  display_name               text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  business_name              text NULL,
  representative_name        text NULL,
  tax_id                     text NULL CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{8}$'),
  phone_e164                 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  address                    text NULL,
  service_job_types          text[] NOT NULL DEFAULT '{}'::text[],
  qualification_attested_at  timestamptz NULL,
  seal_file_id               uuid NULL,
  current_version            integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contact_id),
  UNIQUE (org_id, vendor_code),
  FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, seal_file_id) REFERENCES public.files(org_id, id),
  CHECK (
    (kind = 'business' AND tax_id IS NOT NULL AND business_name IS NOT NULL)
    OR (kind = 'individual' AND tax_id IS NULL)
  )
);

COMMENT ON TABLE public.vendor_profiles IS
  'Organization-scoped issuer profiles. Cross-org issuer identity reconciliation is pending a CEO/R&D decision; do not merge profiles or counters across organizations.';

CREATE INDEX IF NOT EXISTS vendor_profiles_org_idx
  ON public.vendor_profiles (org_id, created_at DESC);

ALTER TABLE public.vendor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_profiles FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_profiles FROM anon;
REVOKE ALL ON TABLE public.vendor_profiles FROM authenticated;
GRANT SELECT ON TABLE public.vendor_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_profiles TO service_role;

DROP POLICY IF EXISTS vendor_profiles_read ON public.vendor_profiles;
CREATE POLICY vendor_profiles_read ON public.vendor_profiles
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

CREATE TABLE IF NOT EXISTS public.vendor_profile_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_profile_id          uuid NOT NULL,
  version                    integer NOT NULL CHECK (version >= 1),
  kind                       text NOT NULL CHECK (kind IN ('business', 'individual')),
  display_name               text NOT NULL,
  business_name              text NULL,
  representative_name        text NULL,
  tax_id                     text NULL CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{8}$'),
  phone_e164                 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  address                    text NULL,
  service_job_types          text[] NOT NULL DEFAULT '{}'::text[],
  qualification_attested_at  timestamptz NULL,
  seal_file_id               uuid NULL,
  snapshot                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_profile_id, version),
  FOREIGN KEY (org_id, vendor_profile_id) REFERENCES public.vendor_profiles(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, seal_file_id) REFERENCES public.files(org_id, id)
);

CREATE INDEX IF NOT EXISTS vendor_profile_versions_org_idx
  ON public.vendor_profile_versions (org_id, vendor_profile_id, version DESC);

ALTER TABLE public.vendor_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_profile_versions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_profile_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_profile_versions FROM anon;
REVOKE ALL ON TABLE public.vendor_profile_versions FROM authenticated;
GRANT SELECT ON TABLE public.vendor_profile_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_profile_versions TO service_role;

DROP POLICY IF EXISTS vendor_profile_versions_read ON public.vendor_profile_versions;
CREATE POLICY vendor_profile_versions_read ON public.vendor_profile_versions
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

-- 5. vendor_onboarding_invites
CREATE TABLE IF NOT EXISTS public.vendor_onboarding_invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL,
  vendor_profile_id uuid NULL,
  token_hash        text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scope             text NOT NULL DEFAULT 'vendor_onboarding' CHECK (scope = 'vendor_onboarding'),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz NULL,
  revoked_at        timestamptz NULL,
  created_by        uuid NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, vendor_profile_id) REFERENCES public.vendor_profiles(org_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS vendor_onboarding_invites_org_idx
  ON public.vendor_onboarding_invites (org_id, created_at DESC);

ALTER TABLE public.vendor_onboarding_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_onboarding_invites FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_onboarding_invites FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_onboarding_invites FROM anon;
REVOKE ALL ON TABLE public.vendor_onboarding_invites FROM authenticated;
GRANT SELECT ON TABLE public.vendor_onboarding_invites TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_onboarding_invites TO service_role;

DROP POLICY IF EXISTS vendor_onboarding_invites_read ON public.vendor_onboarding_invites;
CREATE POLICY vendor_onboarding_invites_read ON public.vendor_onboarding_invites
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

-- 6. vendor_document_sequences, vendor_documents, and app.next_vendor_document_seq
CREATE TABLE IF NOT EXISTS public.vendor_document_sequences (
  vendor_profile_id uuid NOT NULL REFERENCES public.vendor_profiles(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('receipt', 'completion_statement')),
  next_seq          bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  PRIMARY KEY (vendor_profile_id, kind)
);

COMMENT ON TABLE public.vendor_document_sequences IS
  'Independent continuous counters per organization-scoped vendor profile and document kind. Cross-org issuer identity reconciliation awaits CEO/R&D; no cross-org merge.';

ALTER TABLE public.vendor_document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_document_sequences FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_document_sequences FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_document_sequences FROM anon;
REVOKE ALL ON TABLE public.vendor_document_sequences FROM authenticated;
GRANT SELECT ON TABLE public.vendor_document_sequences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_document_sequences TO service_role;

DROP POLICY IF EXISTS vendor_document_sequences_read ON public.vendor_document_sequences;
CREATE POLICY vendor_document_sequences_read ON public.vendor_document_sequences
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.vendor_profiles vp
       WHERE vp.id = vendor_document_sequences.vendor_profile_id
         AND app.is_member(vp.org_id)
    )
  );

CREATE TABLE IF NOT EXISTS public.vendor_documents (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_profile_id         uuid NOT NULL,
  vendor_profile_version_id uuid NULL,
  ticket_id                 uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('receipt', 'completion_statement')),
  seq                       bigint NOT NULL CHECK (seq >= 1),
  doc_no                    text NOT NULL CHECK (char_length(doc_no) BETWEEN 1 AND 64),
  buyer                     jsonb NOT NULL,
  items                     jsonb NOT NULL,
  total_minor               bigint NOT NULL CHECK (total_minor >= 0),
  issued_at                 timestamptz NOT NULL DEFAULT now(),
  pdf_sha256                text NULL CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
  file_id                   uuid NULL,
  status                    text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'voided')),
  voided_at                 timestamptz NULL,
  void_reason               text NULL,
  reissued_from             uuid NULL REFERENCES public.vendor_documents(id),
  idempotency_key           text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_profile_id, kind, seq),
  UNIQUE (vendor_profile_id, doc_no),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, vendor_profile_id) REFERENCES public.vendor_profiles(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, file_id) REFERENCES public.files(org_id, id),
  CHECK (
    (status = 'issued' AND voided_at IS NULL AND void_reason IS NULL)
    OR (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS vendor_documents_org_ticket_idx
  ON public.vendor_documents (org_id, ticket_id, created_at DESC);

ALTER TABLE public.vendor_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_documents FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.vendor_documents FROM PUBLIC;
REVOKE ALL ON TABLE public.vendor_documents FROM anon;
REVOKE ALL ON TABLE public.vendor_documents FROM authenticated;
GRANT SELECT ON TABLE public.vendor_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_documents TO service_role;

DROP POLICY IF EXISTS vendor_documents_read ON public.vendor_documents;
CREATE POLICY vendor_documents_read ON public.vendor_documents
  FOR SELECT TO authenticated
  USING (app.is_member(org_id));

CREATE OR REPLACE FUNCTION app.next_vendor_document_seq(vendor_profile uuid, document_kind text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_seq bigint;
BEGIN
  IF document_kind IS NULL OR document_kind NOT IN ('receipt', 'completion_statement') THEN
    RAISE EXCEPTION 'invalid document kind'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.vendor_document_sequences (vendor_profile_id, kind, next_seq)
  VALUES (vendor_profile, document_kind, 1)
  ON CONFLICT (vendor_profile_id, kind) DO NOTHING;

  UPDATE public.vendor_document_sequences
     SET next_seq = next_seq + 1
   WHERE vendor_profile_id = vendor_profile AND kind = document_kind
  RETURNING next_seq - 1 INTO v_seq;

  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'vendor_profile not found: %', vendor_profile
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN v_seq;
END;
$$;

REVOKE ALL ON FUNCTION app.next_vendor_document_seq(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.next_vendor_document_seq(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION app.next_vendor_document_seq(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.next_vendor_document_seq(uuid, text) TO service_role;

COMMIT;
