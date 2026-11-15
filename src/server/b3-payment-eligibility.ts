/** 3a P1, shared by 今天 and the month readers. Alias p; $1 is the pinned org. */
export const PENDING_TENANT_REPORT_SQL = "p.org_id = $1 AND p.source = 'tenant_portal' AND p.status = 'submitted'";
