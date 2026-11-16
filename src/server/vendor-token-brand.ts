import { svc } from "./db";
import { brandV3EnabledForOrg } from "./brand-v3";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";

export type VendorTokenBrand = { name: string; company: string; property: string; status: string };

/** Called only after loadVendorJob admitted this bearer. No member session or list reader. */
export async function vendorTokenBrand(token: string, sharingApproved: boolean): Promise<VendorTokenBrand | null> {
  if (!vendorTokenAcceptable(token)) return null;
  try {
    return await svc(null, async client => {
      const hash = hashVendorToken(token);
      // Same gateway as loadVendorJob: never derive the organization from a signed-in cookie.
      const { rows } = await client.query<{ job_id: string; org_id: string; ticket_id: string }>(
        "SELECT job_id::text, org_id::text, ticket_id::text FROM app.open_vendor_job($1)", [hash],
      );
      const job = rows[0];
      if (!job || !(await brandV3EnabledForOrg(job.org_id))) return null;
      // Re-admit the bearer at the metadata read, pin all joins to this job and org, and
      // respect the loader's sharing decision. Never select another job or its history.
      const context = await client.query<VendorTokenBrand>(
        `SELECT j.vendor_name AS name, o.name AS company,
                CASE WHEN $5::boolean THEN p.name ELSE '' END AS property, t.status::text AS status
           FROM app.open_vendor_job($1) j
           JOIN organizations o ON o.id = j.org_id
           JOIN maintenance_tickets t ON t.id = j.ticket_id AND t.org_id = j.org_id
           JOIN properties p ON p.id = t.property_id AND p.org_id = t.org_id
          WHERE j.job_id = $2 AND j.org_id = $3 AND j.ticket_id = $4`,
        [hash, job.job_id, job.org_id, job.ticket_id, sharingApproved],
      );
      return context.rows[0] ?? null;
    });
  } catch {
    // Presentation failure retains the admitted legacy page, like other v3 page flags.
    return null;
  }
}
