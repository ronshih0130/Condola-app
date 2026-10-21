-- One active 租客 contact per email inside a firm.
-- Version 20261023100000 sorts after 20261023090000_lease_deposit_override_check.
--
-- The lease wizard can attach an existing contact instead of inserting another
-- row and another portal user. This index is the backstop: a second active
-- tenant contact with the same email in the same org is rejected.
-- Archived rows are excluded so a firm can add the person again after archive.
-- Emails may repeat across firms (the same person can be a 租客 in two orgs).
-- Null emails stay allowed (a new 租客 may have no email).
--
-- Seed and sandbox sample data already use a distinct tenant email per firm.
-- No backfill.

CREATE UNIQUE INDEX contacts_org_tenant_email_uniq
  ON contacts (org_id, email)
  WHERE is_tenant AND archived_at IS NULL AND email IS NOT NULL;
