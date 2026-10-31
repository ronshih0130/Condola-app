import { tx } from './db';
import { billingPreviewAuthorityOn } from './billing-preview-authority';
import { monthlyBounds, type LeaseSource, type RentSource } from './monthly-billing-rules';
import { planMonthlyRentOperation, type MonthlyRentParty } from './monthly-rent-operation-plan';
import type { Session } from './types';
import { isUuid } from './repair-rules';

const CAP=2000;
/** Server-loaded session only. Snapshot estimate; no issuance or reservation. */
export async function monthlyRentPreview(session:Session,leaseId:string,month:string) {
  if (!isUuid(leaseId)) return null;
  let period:ReturnType<typeof monthlyBounds>;
  try { period=monthlyBounds(month); } catch (error) { if (error instanceof TypeError) return null; throw error; }
  return tx(session.userId,async client=>{
    if (!(await billingPreviewAuthorityOn(client,session))) return null;
    const lease=(await client.query<LeaseSource & {status:string;property_currency:string}>(`SELECT x.id::text,x.status::text,x.property_id::text,p.name AS property_name,p.currency::text AS property_currency,u.label AS unit_label,
      x.start_date::text,x.end_date::text,x.terminated_on::text,x.moved_out_on::text,x.currency::text,
      CASE WHEN c.code IS NULL THEN NULL ELSE jsonb_build_object('minorUnit',c.minor_unit,'displayDecimals',c.display_decimals) END AS currency_config,
      x.rent_amount_minor::text AS rent,x.rent_frequency::text AS frequency,x.due_day
      FROM leases x JOIN properties p ON p.org_id=x.org_id AND p.id=x.property_id
      JOIN units u ON u.org_id=x.org_id AND u.id=x.unit_id LEFT JOIN currencies c ON c.code=x.currency
      WHERE x.org_id=$1 AND x.id=$2`,[session.orgId,leaseId])).rows[0];
    if (!lease) return null;
    const parties=(await client.query<MonthlyRentParty>(`SELECT lp.id::text AS "partyId",lp.contact_id::text AS "contactId",c.org_id::text AS "contactOrgId",
      c.display_name AS "payerName",c.is_tenant AS "isTenant",c.archived_at::text AS "archivedAt",lp.rent_share_bp AS "rentShareBp"
      FROM lease_parties lp LEFT JOIN contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
      WHERE lp.org_id=$1 AND lp.lease_id=$2 AND lp.role='primary' ORDER BY lp.id LIMIT $3`,[session.orgId,leaseId,CAP+1])).rows;
    const rent=(await client.query<RentSource>(`SELECT i.lease_id::text,i.id::text AS invoice_id,i.invoice_number,l.id::text AS line_id,
      i.status::text,i.source,l.service_period::text AS period,l.amount_minor::text AS amount,i.currency::text AS currency,
      coalesce(l.service_period && daterange($3::date,($4::date+1),'[)'),false) AS overlaps,
      coalesce(l.service_period=daterange($3::date,($4::date+1),'[)'),false) AS exact
      FROM invoices i JOIN invoice_lines l ON l.org_id=i.org_id AND l.invoice_id=i.id
      WHERE i.org_id=$1 AND i.lease_id=$2 AND l.charge_type='rent'
        AND (l.service_period IS NULL OR isempty(l.service_period) OR l.service_period && daterange($3::date,($4::date+1),'[)'))
      ORDER BY i.id,l.id LIMIT $5`,[session.orgId,leaseId,period.start,period.end,CAP+1])).rows;
    const asOf=(await client.query<{value:string}>(`SELECT transaction_timestamp()::text AS value`)).rows[0].value;
    const result=planMonthlyRentOperation({orgId:session.orgId,environment:session.environment,month,lease,parties,rent,capped:parties.length>CAP||rent.length>CAP});
    if (!(await billingPreviewAuthorityOn(client,session))) return null;
    return {...result,month,asOf};
  },{orgId:session.orgId,environment:session.environment},{isolation:'repeatable read',readOnly:true});
}
export type MonthlyRentPreview=NonNullable<Awaited<ReturnType<typeof monthlyRentPreview>>>;
