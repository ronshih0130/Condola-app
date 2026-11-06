import { channelOn, consentNextOn, lineTransaction, sessionOn } from "./login-link";
import { portalPath, rejectLine, type LinePersona } from "./login-token";

/** Preferences select an existing authority; they never create one. No job token authentication. */
export async function selectLinePortal(token: string | undefined, scope: { orgId: string; persona: LinePersona }) {
 return lineTransaction(async c => {
  if (!(await c.query("SELECT app.b033_portal_enabled($1,$2) enabled", [scope.orgId, scope.persona])).rows[0].enabled) rejectLine(404, "not_found");
  const session = await sessionOn(c, token);
  if (!session) rejectLine(401, "reauth_required");
  const permitted = (await c.query(`SELECT 1 FROM contacts c WHERE c.org_id=$1
   AND app.b033_contact_user(c.org_id,c.id,$2)=$3 LIMIT 1`, [scope.orgId, scope.persona, session.user_id])).rows[0];
  if (!permitted) rejectLine(404, "not_found");
  await channelOn(c, scope.orgId, scope.persona);
  return { next: await consentNextOn(c, session.user_id, { persona: scope.persona, return_path: portalPath(scope.persona) }) };
 });
}

/** Read-only choices; POST rechecks each role/company again at selection time. */
export async function linePortalChoices(token?: string) {
 return lineTransaction(async c => {
  const session = await sessionOn(c, token);
  if (!session) return [];
  return (await c.query<{ orgId: string; name: string; persona: LinePersona }>(`SELECT DISTINCT c.org_id AS "orgId",o.name,p.persona
   FROM contacts c JOIN organizations o ON o.id=c.org_id
   CROSS JOIN (VALUES ('owner'),('tenant'),('vendor')) p(persona)
   WHERE app.b033_contact_user(c.org_id,c.id,p.persona)=$1
    AND app.b033_portal_enabled(c.org_id,p.persona)
   ORDER BY o.name,p.persona`, [session.user_id])).rows;
 });
}
