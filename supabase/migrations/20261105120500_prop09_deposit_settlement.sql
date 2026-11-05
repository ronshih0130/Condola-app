-- 20261105120500_prop09_deposit_settlement.sql
-- PROP-09 L1-DEP deposit settlement data foundation. Additive, forward-only.
-- NO new flag seeded; tables are gated INERT via grants (service_role only, no public API).
-- Does NOT implement B-011 UI/flows. Does NOT move money. Settlement document != paid.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Layer 1: 結算單 header
CREATE TABLE app.deposit_settlement_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('move_out','mid_term','other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','void')),
  source_handover_record_id uuid,                       -- 可空：連既有 handover 退租紀錄
  deposit_held_minor bigint NOT NULL CHECK (deposit_held_minor >= 0),
  currency text NOT NULL,                               -- 走既有 currencies，不寫死 TWD
  confirmed_total_deduction_minor bigint CHECK (confirmed_total_deduction_minor >= 0), -- 最後確認「文件」金額，非付款
  confirmed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  UNIQUE (org_id, lease_id, basis),                     -- 本層 one-per-basis；版本化由 B-011 擴充
  FOREIGN KEY (org_id, lease_id) REFERENCES public.leases(org_id, id),
  FOREIGN KEY (org_id, lease_id, source_handover_record_id)
    REFERENCES app.handover_records(org_id, lease_id, id)   -- MATCH SIMPLE：NULL 時不強制
);

-- Layer 2: 逐項扣抵 line（金額、原因、佐證來源、更正保留原值）
CREATE TABLE app.deposit_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  item_key text NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 180),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) <= 4000),
  source_lease_charge_id uuid,                          -- 可空：連 lease_charges 同案來源
  prior_amount_minor bigint CHECK (prior_amount_minor >= 0), -- 更正時保留原值
  corrected_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  UNIQUE (settlement_id, seq),
  FOREIGN KEY (org_id, lease_id, settlement_id)
    REFERENCES app.deposit_settlement_records(org_id, lease_id, id),
  FOREIGN KEY (org_id, source_lease_charge_id)
    REFERENCES public.lease_charges(org_id, id)         -- lease_charges 有 UNIQUE(org_id,id)
);

-- Layer 3: 佐證（連 handover 附件 ID 或專屬結算上傳路徑；不展開完整 J4）
CREATE TABLE app.deposit_settlement_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  line_id uuid,                                         -- 可空：連特定扣抵列
  kind text NOT NULL CHECK (kind IN ('handover_attachment','settlement_upload')),
  handover_attachment_id uuid,                          -- kind='handover_attachment'
  storage_path text UNIQUE,                             -- kind='settlement_upload'（NULL 允多筆）
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime text CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  CHECK (
    (kind = 'handover_attachment' AND handover_attachment_id IS NOT NULL AND storage_path IS NULL)
    OR (kind = 'settlement_upload' AND storage_path IS NOT NULL AND handover_attachment_id IS NULL)
  ),
  FOREIGN KEY (org_id, lease_id, settlement_id)
    REFERENCES app.deposit_settlement_records(org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, line_id)
    REFERENCES app.deposit_settlement_lines(org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, handover_attachment_id)
    REFERENCES app.handover_attachments(org_id, lease_id, id)
);

-- 分核 A：各方確認／異議（與付款分離；一方確認不代表他方同意）
CREATE TABLE app.deposit_settlement_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  party_kind text NOT NULL CHECK (party_kind IN ('manager','tenant','owner')),
  party_user_id uuid,                                   -- 可空（portal/token 方）
  response text NOT NULL CHECK (response IN ('confirm','object')),
  objection_reason text CHECK (char_length(objection_reason) <= 2000),
  confirmed_amount_minor bigint CHECK (confirmed_amount_minor >= 0), -- 該方確認的「文件」金額
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  UNIQUE (settlement_id, party_kind, request_id),       -- 冪等；各方獨立列
  CHECK (response <> 'object' OR objection_reason IS NOT NULL),
  FOREIGN KEY (org_id, lease_id, settlement_id)
    REFERENCES app.deposit_settlement_records(org_id, lease_id, id)
);

-- 分核 B：實際退補款紀錄（結算文件 ≠ 已付款；Condola 只記錄付款依據，不經手款項）
CREATE TABLE app.deposit_settlement_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('refund','top_up')),  -- 退租客 / 租客補款
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  method text NOT NULL CHECK (method IN ('bank_transfer','cash','offset','other')),
  account_last5 text CHECK (account_last5 ~ '^[0-9]{4,5}$'),  -- 僅 last5，絕不存完整帳號
  payee_account_id uuid,                                -- 軟指標到 payee_account_numbers（另受 PAYEE flag 管），不設 FK 以免跨 flag 耦合
  external_ref text CHECK (char_length(external_ref) <= 180),
  reported_by uuid NOT NULL,                            -- 回報者；非 Condola 執行付款
  reported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, lease_id, id),
  FOREIGN KEY (org_id, lease_id, settlement_id)
    REFERENCES app.deposit_settlement_records(org_id, lease_id, id)
);

CREATE INDEX deposit_settlement_records_org_lease_idx
  ON app.deposit_settlement_records (org_id, lease_id);
CREATE INDEX deposit_settlement_lines_org_lease_settlement_idx
  ON app.deposit_settlement_lines (org_id, lease_id, settlement_id);
CREATE INDEX deposit_settlement_evidence_org_lease_settlement_idx
  ON app.deposit_settlement_evidence (org_id, lease_id, settlement_id);
CREATE INDEX deposit_settlement_evidence_handover_attachment_idx
  ON app.deposit_settlement_evidence (handover_attachment_id);
CREATE INDEX deposit_settlement_confirmations_settlement_idx
  ON app.deposit_settlement_confirmations (settlement_id);
CREATE INDEX deposit_settlement_payments_org_lease_settlement_idx
  ON app.deposit_settlement_payments (org_id, lease_id, settlement_id);

-- RLS + grants：service_role-first，與 handover／payee 同模式。Fail-closed。
ALTER TABLE app.deposit_settlement_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deposit_settlement_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deposit_settlement_evidence      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deposit_settlement_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deposit_settlement_payments      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON app.deposit_settlement_records, app.deposit_settlement_lines,
  app.deposit_settlement_evidence, app.deposit_settlement_confirmations,
  app.deposit_settlement_payments FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON app.deposit_settlement_records, app.deposit_settlement_lines,
  app.deposit_settlement_evidence, app.deposit_settlement_confirmations,
  app.deposit_settlement_payments TO service_role;
-- 只開必要欄位 UPDATE（append-only 傾向；無 DELETE grant，證據不可刪）
GRANT UPDATE (status, confirmed_total_deduction_minor, confirmed_at)
  ON app.deposit_settlement_records TO service_role;
GRANT UPDATE (amount_minor, prior_amount_minor, corrected_at, reason)
  ON app.deposit_settlement_lines TO service_role;   -- 更正需保留 prior 值

COMMIT;
