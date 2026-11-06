/** SQL fragments for existing owner readers. Values remain bound by each caller.
 * RLS can also admit staff/tenant rows for multi-role users, so intersect it with
 * the selected owner persona's current property_owners authority explicitly.
 */
export function ownerPropertyScope(property: string) {
 return `EXISTS (SELECT 1 FROM property_owners b036_po
  JOIN contacts b036_c ON b036_c.id=b036_po.owner_contact_id AND b036_c.org_id=b036_po.org_id
  WHERE b036_po.property_id=${property} AND b036_c.user_id=auth.uid()
   AND b036_c.is_owner AND b036_c.archived_at IS NULL
   AND b036_po.effective_from<=current_date
   AND (b036_po.effective_to IS NULL OR b036_po.effective_to>current_date))`;
}
/** Do not disclose aggregate totals when any property line is no longer authorized. */
export const ownerStatementScope = `s.status='issued' AND c.user_id=auth.uid() AND c.is_owner AND c.archived_at IS NULL
 AND EXISTS (SELECT 1 FROM property_owners po WHERE po.org_id=s.org_id AND po.owner_contact_id=c.id
  AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>current_date))
 AND NOT EXISTS (SELECT 1 FROM owner_statement_lines sl WHERE sl.statement_id=s.id
  AND sl.property_id IS NOT NULL AND NOT ${ownerPropertyScope("sl.property_id")})`;
