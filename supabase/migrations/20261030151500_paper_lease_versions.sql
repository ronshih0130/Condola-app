-- Additive paper lease history. Existing INSERTs remain valid.
ALTER TABLE lease_signed_pdfs
  ADD COLUMN uploaded_by uuid REFERENCES auth.users(id),
  ADD COLUMN replace_reason text,
  ADD COLUMN supersedes_id uuid,
  ADD CONSTRAINT lease_signed_pdfs_replace_reason_length
    CHECK (replace_reason IS NULL OR char_length(replace_reason) <= 500),
  ADD CONSTRAINT lease_signed_pdfs_supersedes_fk
    FOREIGN KEY (org_id, supersedes_id)
    REFERENCES lease_signed_pdfs(org_id, id);

CREATE INDEX lease_signed_pdfs_version_order_idx
  ON lease_signed_pdfs (org_id, lease_id, created_at DESC, id DESC);

-- Preserve existing RLS policies and grants, including the absence of UPDATE.
-- files.size_bytes and both source IDs remain available through the existing FK.
