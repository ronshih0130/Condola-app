-- Keyset indexes for the admin 操作紀錄 screen.
-- Each page is an index seek (no OFFSET, no full-row JSON) so a free-plan
-- Worker can render one page inside its CPU budget.

CREATE INDEX IF NOT EXISTS audit_log_org_keyset_idx
  ON audit_log (org_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_log_actor_keyset_idx
  ON audit_log (org_id, actor_user_id, occurred_at DESC, id DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_record_keyset_idx
  ON audit_log (org_id, table_name, row_id, occurred_at DESC, id DESC);
