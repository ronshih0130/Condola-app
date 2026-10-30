# B-013／B-021 DB handoff — PE 審核提案，尚未套用

狀態：**PROPOSED / NOT_APPLIED / NOT_FEATURE_COMPLETE**。依 Ron 本輪指示，只寫提案；Codex 沒有建立新 migration 檔、沒有在本機或 staging 套用下列 SQL，也沒有修改舊 migration。下列為「關閉中的私有基礎結構」分階段提案，**不是可以開啟核准／派工的完成版 migration**。PE 請先把接受的範圍與最終檔名寫進 staging plan；如只接受一次完整上線 migration，請暫緩這個基礎階段，待後述 gateway／guard 也完成後合併審核。

## 已確認的基線與本輪修正

- 工作分支 `mode-b-repair-override-prep`，候選 `f419aa6e454162b9bf48ebdfbe6a0b8c903441b9`。PE patch `e78dbdcb984d12f6185392a748240bf3e971842d0baeb63697772ef194888eef` 已以23f9193提交。
- PE patch 修正主租客綁定前提後，實跑另發現同一測試後段要求同公司「另一份租約」的帳單；選到只有一張帳單的公司會在237行失敗。f419aa6僅補 EXISTS 同公司／不同租約帳單條件與排序，原斷言全部保留；無產品／SQL變更。
- 定向測試1/1PASS；完整 clean exact-SHA gate **PASS**，unit599PASS，RLS357PASS／0FAIL／1已核准歷史SKIP。摘要：repo `e2e/results/gate-f419aa6e454162b9bf48ebdfbe6a0b8c903441b9.md`。這個 gate 只涵蓋當前93檔結構，**不驗證本提案**。
- 已讀同資料夾 `staging-db-plan.md`：PE core89／4e43104、29次套用與 QA staging-dev GO 有紀錄；仍有9個基礎檔等價性UNKNOWN、無正式 Supabase ledger 等限制。本提案不宣稱這些已解除，也不把 core89 的 QA 延用到新結構。
- staging目前紀錄只到100215；現有repo之100217 neutral source、100218 directory edit、100220 owner defaults、100221 override commands需PE按真實catalog／人工history核對。不能重跑已套用檔或臆造ledger。精確hash見下表。Codex不操作hosted DB，所有flag保持OFF。

## 為何需要新結構

現有 `maintenance_tickets.estimated_cost_minor` 與 `owner_approval` 是可變的舊欄位，無法保留「同一版估價、同一指定屋主、當時門檻」的不可變證據。100220／100221只做門檻設定，沒有版本估價、owner decision或dispatch enforcement。只用目前最新門檻重算舊估價，會違反 Ron 的「門檻變更只影響新版本」決定。

一次只由一位明確指定且目前仍有效的屋主決定；合法多屋主不要求全員核准。版本保存當時幣別、精度、金額、工作範圍、證據、指定ownership/principal與門檻來源；金額／範圍／證據／指定屋主改變建立新版本，不能沿用舊同意。等於門檻不需屋主決定；超過才待核准。「不需核准」不冒稱屋主已同意。

## 本次可供 PE 審核的階段

新增六張私有表與不可變 trigger：head/CAS、版本、單一terminal決定、獨立Admin緊急授權、hash-only命令結果、去重通知intent。RLS開啟，PUBLIC／anon／authenticated／service_role無表讀寫權；無新可執行gateway。emergency與通知intent只預留結構，沒有可用writer；必須另有審核過的冪等原子emergency＋intent命令擴充，不能假設目前submit/decision/close namespace已涵蓋。不改public工單／派工writer，不新增sender，無資料回填，未開旗標。沒有新的批准能被現行程式消費。所有ID／snapshot仍屬敏感營運資料，不是匿名資料。

選定actor/contact/ownership的歷史UUID刻意不設刪除cascade：它們是事件時身分，不能讓日後改綁把歷史改寫；**這不是跳過當下授權**，實際gateway必須重查。公開ticket/property/org的RESTRICT FK只會在未來有新資料後影響刪除；正式讓程式寫入前，PE必須核准reset／purge／保留方案，不能讓本階段默默改變現有刪除政策。8000/4000字與8張證據、scale0–4是提案技術界線，需PE確認，非新商業限額。

## SQL 提案（未執行、未經 DB 語法／相容性測試）

最終 unique timestamp/檔名由PE plan entry指定；不要把這段當成已批准的apply script。完整交易原子套用；任何物件衝突先停，不用IF NOT EXISTS掩蓋結構不符。

```sql
BEGIN;

-- PROPOSAL ONLY. PE must allocate the final filename and approve the entry.
-- This phase adds a CLOSED private foundation. It grants no application write
-- path and does not authorize dispatch/start/completion or turn any flag ON.

CREATE TABLE app.b013_estimate_heads (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  ticket_id uuid NOT NULL,
  current_version_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,ticket_id),
  FOREIGN KEY (org_id,ticket_id)
    REFERENCES public.maintenance_tickets(org_id,id) ON DELETE RESTRICT
);

CREATE TABLE app.b013_estimate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  live_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK(environment IN ('live','sandbox')),
  ticket_id uuid NOT NULL,
  property_id uuid NOT NULL,
  version_no bigint NOT NULL CHECK(version_no>0),
  currency char(3) NOT NULL REFERENCES public.currencies(code) ON DELETE RESTRICT,
  minor_unit smallint NOT NULL CHECK(minor_unit BETWEEN 0 AND 4),
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  work_scope text NOT NULL CHECK(length(btrim(work_scope)) BETWEEN 1 AND 8000),
  evidence_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK(jsonb_typeof(evidence_snapshot)='array'
          AND jsonb_array_length(evidence_snapshot)<=8),
  -- Captured event-time identities, not mutable/current authorization.
  designated_ownership_id uuid NOT NULL,
  designated_contact_id uuid NOT NULL,
  designated_principal_id uuid NOT NULL,
  captured_threshold_minor bigint NOT NULL CHECK(captured_threshold_minor>=0),
  threshold_source text NOT NULL
    CHECK(threshold_source IN ('property_override','owner_default','regional_default')),
  threshold_revision_id uuid,
  threshold_provenance_sha256 bytea NOT NULL
    CHECK(octet_length(threshold_provenance_sha256)=32),
  payload_sha256 bytea NOT NULL CHECK(octet_length(payload_sha256)=32),
  requires_owner_decision boolean GENERATED ALWAYS AS
    (amount_minor>captured_threshold_minor) STORED,
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,ticket_id,id),
  UNIQUE(org_id,ticket_id,id,designated_principal_id),
  UNIQUE(org_id,ticket_id,version_no),
  FOREIGN KEY(org_id,ticket_id)
    REFERENCES app.b013_estimate_heads(org_id,ticket_id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,property_id)
    REFERENCES public.properties(org_id,id) ON DELETE RESTRICT,
  CHECK((threshold_source='regional_default' AND threshold_revision_id IS NULL)
     OR (threshold_source<>'regional_default' AND threshold_revision_id IS NOT NULL))
);
-- New head and version must be inserted in one transaction with a server-minted
-- version UUID; this deferred FK avoids nullable or permanently empty heads.
ALTER TABLE app.b013_estimate_heads ADD CONSTRAINT b013_head_current_version_fk
  FOREIGN KEY(org_id,ticket_id,current_version_id)
  REFERENCES app.b013_estimate_versions(org_id,ticket_id,id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app.b013_estimate_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  version_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('approved','rejected','more_information')),
  decided_by uuid NOT NULL,
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 4000),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,version_id),
  UNIQUE(org_id,ticket_id,version_id,id),
  FOREIGN KEY(org_id,ticket_id,version_id)
    REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,ticket_id,version_id,decided_by)
    REFERENCES app.b013_estimate_versions(org_id,ticket_id,id,designated_principal_id)
    ON DELETE RESTRICT
);

-- Admin emergency authorization is separate from owner approval; never forge
-- an owner decision or reuse another version's override. RESERVED ONLY:
-- no emergency command/gateway is defined here; no usable emergency writer
-- until a separately reviewed atomic idempotent emergency+intent extension.
CREATE TABLE app.b013_repair_emergencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  version_id uuid NOT NULL,
  category text NOT NULL CHECK(category IN ('water','electricity','safety')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000),
  authorized_photo_snapshot jsonb NOT NULL
    CHECK(jsonb_typeof(authorized_photo_snapshot)='array'
          AND jsonb_array_length(authorized_photo_snapshot) BETWEEN 1 AND 8),
  authorized_by uuid NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,version_id),
  UNIQUE(org_id,ticket_id,version_id,id),
  FOREIGN KEY(org_id,ticket_id,version_id)
    REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT
);

-- Separate NEW estimate-operation namespace, shared across submit/decision/
-- close/status and all companies of the same actor. Existing20/21 settings
-- UUID namespace remains unchanged and cannot consume these outcomes.
CREATE TABLE app.b013_repair_commands (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  live_org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK(environment IN ('live','sandbox')),
  ticket_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK(operation_kind IN ('submit','decision','close')),
  original_kind text NOT NULL CHECK(original_kind IN ('submit','decision')),
  expected_head_id uuid,
  requested_version_id uuid,
  payload_sha256 bytea CHECK(payload_sha256 IS NULL OR octet_length(payload_sha256)=32),
  outcome text NOT NULL CHECK(outcome IN
    ('recorded','cancelled','rejected_conflict','rejected_disabled',
     'rejected_invalid','rejected_unavailable')),
  result_version_id uuid,
  result_decision_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,request_id),
  FOREIGN KEY(org_id,ticket_id)
    REFERENCES public.maintenance_tickets(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,ticket_id,result_version_id)
    REFERENCES app.b013_estimate_versions(org_id,ticket_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(org_id,ticket_id,requested_version_id,result_decision_id)
    REFERENCES app.b013_estimate_decisions(org_id,ticket_id,version_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(operation_kind='close' OR operation_kind=original_kind),
  CHECK((operation_kind='close')=(outcome='cancelled')),
  CHECK((original_kind='decision')=(requested_version_id IS NOT NULL)),
  CHECK((operation_kind='close' AND outcome='cancelled' AND payload_sha256 IS NULL
          AND result_version_id IS NULL AND result_decision_id IS NULL)
     OR (operation_kind<>'close' AND payload_sha256 IS NOT NULL)),
  CHECK(result_decision_id IS NULL OR original_kind='decision'),
  CHECK((outcome='recorded' AND
        ((original_kind='submit' AND result_version_id IS NOT NULL
                                AND result_decision_id IS NULL)
         OR (original_kind='decision' AND result_decision_id IS NOT NULL
             AND result_version_id IS NOT NULL
             AND result_version_id=requested_version_id)))
     OR (outcome<>'recorded' AND result_version_id IS NULL AND result_decision_id IS NULL))
);

-- These are LOCAL intent records only. No Email/LINE/center delivery authority.
CREATE TABLE app.b013_repair_notification_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  version_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('approval_reminder_24h','emergency_owner_notice')),
  emergency_id uuid,
  designated_principal_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,version_id,kind),
  FOREIGN KEY(org_id,ticket_id,version_id)
    REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,ticket_id,version_id,designated_principal_id)
    REFERENCES app.b013_estimate_versions(org_id,ticket_id,id,designated_principal_id)
    ON DELETE RESTRICT,
  FOREIGN KEY(org_id,ticket_id,version_id,emergency_id)
    REFERENCES app.b013_repair_emergencies(org_id,ticket_id,version_id,id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='emergency_owner_notice')=(emergency_id IS NOT NULL))
);

CREATE FUNCTION app.b013_estimate_immutable_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Immutable repair history' USING
    ERRCODE='23514',CONSTRAINT='b013_estimate_immutable';
END $$;
REVOKE ALL ON FUNCTION app.b013_estimate_immutable_row()
  FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'b013_estimate_versions','b013_estimate_decisions','b013_repair_emergencies',
    'b013_repair_commands','b013_repair_notification_intents'] LOOP
    EXECUTE format('CREATE TRIGGER b013_immutable_row BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.b013_estimate_immutable_row()',name);
    EXECUTE format('CREATE TRIGGER b013_immutable_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.b013_estimate_immutable_row()',name);
  END LOOP;
  FOREACH name IN ARRAY ARRAY[
    'b013_estimate_heads','b013_estimate_versions','b013_estimate_decisions',
    'b013_repair_emergencies','b013_repair_commands','b013_repair_notification_intents'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('REVOKE ALL ON TABLE app.%I FROM PUBLIC,anon,authenticated,service_role',name);
  END LOOP;
END $$;

COMMIT;
```

## 此階段不提供的權限與行為（後續同 B-013／B-021，需新的完整審核 entry）

1. 固定 service-only submit/decision/status/close/view gateway：current session／selected-live org／角色／consent、精確UUID+scope+payload綁定，server選的屋主與當下日期，完整policy來源／精度驗證；禁止偽造owner session。一次BEGIN→一項操作→ALL constraints→最後current auth→直接await COMMIT；未知結果保留原UUID。
2. 以當前head與單一決定推導授權；不把legacy mutable owner_approval當authority。過期／改綁／替換ownership／幣別精度漂移拒絕新決定；只有default數字變更不得重寫已送出門檻。historical status/close當下仍要有對應權限，但不要求舊版本仍為head。
3. 只要工單正式採用新流程，global/org OFF也不能讓舊API／token／直接SQL繞過pending approval；未採用工單的OFF舊流程相容性另驗。全writer與FK／trigger／鎖順序清單先審核；缺guard不能adopt。現有owner_view對property/contact會取寫鎖，與其他流程的實際衝突要測，不宣稱沒有跨公司成本。
4. 真實證據bytes/generation驗證：目前files.sha256可空、現行photo登記未寫hash，ticket_attachments.content註明不用。JSON快照CHECK不能代替安全photo來源或物件不可變性；需授權讀取、bytes digest／generation、刪除／過期處置後才能引用或顯示。緊急例外須實際Admin、水／電／安全原因及照片；不冒充owner決定。
5. 本提案沒有emergency命令／gateway；必須另外審核具原UUID／payload／scope綁定的原子冪等emergency＋intent命令擴充，才可啟用保留表寫入。不可用人工owner INSERT替代。24h提醒與緊急intent必須由各自可信固定gateway原子產生，驗證仍為同版pending；不回覆不核准。現階段intent不是B028實際source／送達證明；整合canonical中心或寄信前另審。沒有任何外部Email／LINE。
6. audit actor/value/time/source、private行不變性與有效state／cross-org約束、idempotency／samekey跨op、save-close競爭、自然session expiry、COMMIT ACK loss、trigger例外／rollback、完整reset與後續GC／retention仍要實作測試。空表DDL不代表功能或security gate完成。

## PE 審核／套用／回報要求

- entry列出接受的是「關閉的foundation」或「待完整gateway+guard後一次套用」。核對100217/218/220/221存在與hash、public FK keys、app schema owner、角色/BYPASSRLS/default ACL與PG16支援；不要因現有private owner可bypassRLS就讓應用取得owner身分。
- 本提案有循环FK，但head持有server預生成version UUID，FK延後到交易末；PE需在clone證明完整插入、失敗rollback、跨org/票/version拒絕與immutability。phase2前不授予任何表或gateway權限。
- 先備份與還原驗證、before counts／結構／grants snapshot，再非Mac staged apply；每步staging target guard，出錯即停。既有資料應零改寫、所有新表初始空；verify所有role無表權、無新RPC EXECUTE、flags OFF。
- 不提供自動down／DROP腳本。若需撤回，優先停用writer／code rollback；刪表／改歷史／purge必須單獨審核。head/version RESTRICT與immutable trigger意味著不能沿用未更新的demo seed／purge；這是phase2前的必要工作，不是准許disable trigger。
- 回報最終plan entry、實際file SHA、apply結果／catalog與counts／grants、對應QA exactSHA。Ron通知後Codex才接續需要結構的功能與測試。Mac不套用本提案、不碰prod、不改法律文案、不送外部訊息。

## 既有後續 migration hashes（只供核對，不代表可重跑）

- `20261031100217_b010_b028_source_foundation.sql` — SHA-256 `e43064d897f13eae1a30a96eff3d607cf9f0b59e53b6cc5f14ac4a692382540d`
- `20261031100218_b015_tenant_directory_edit.sql` — SHA-256 `6824dbaa1ff7a74a764676a8ca698bdc6dec3fdcda5d182161c999f38a020a3a`
- `20261031100220_b013_owner_repair_policy.sql` — SHA-256 `31c127e770d4d33ce42f7c83e724874d9f94c7cfc00950539ae7d0ed9b6cabc5`
- `20261031100221_b013_owner_repair_override.sql` — SHA-256 `b6145a0166051b35a943142bcc0a3c9a49b73bc15d44cd8acf262a9b00f7b54b`

## 獨立靜態審查修正紀錄

第一輪已修正 close/cancelled雙向約束、recorded decision result_version必須等於requested_version、emergency命令明確保留不用；也用複合FK把決定者及通知對象綁到版本保存的指定principal，沒有auth.users刪除cascade。只改這份未套用提案；第二輪已獲原生獨立靜態審查 PASS（僅 CLOSED_FOUNDATION_PE_REVIEW_PROPOSAL）。沒有語法／DB執行測試或PE批准。

第二輪核對的文件SHA-256為 `6d247ab6581da34ee4616cef6216b6b3261836a824bfeea3fe55e5f590f74131`；本段只補審查紀錄，SQL區塊沒有再改動。Reviewer model／effort 未由介面揭露，記為unknown。審查不是 apply approval、Claude Class B或B-013／B-021功能驗收。PE仍需在自己的驗證環境檢查語法、live keys/default ACL/roles、空表安裝與reset／retention，並決定是否接受分階段foundation。
