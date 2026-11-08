import type { Client } from "pg";
import { tx } from "./db";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";
import { idSignGateFlagOn, resolveIdSignGate, signingRequiresIdentity } from "./id-sign-gate-rules";

/** Whether signing this organization's lease needs a ready ID check. Flag OFF (default) ⇒ legacy hard gate. */
export async function identityRequiredForSigning(client: Client, orgId: string): Promise<boolean> {
  const row = (await client.query<{ global: unknown; flags: unknown; settings: unknown }>(
    `SELECT (SELECT value FROM public.platform_settings WHERE key='id_sign_gate_v2') AS global, o.feature_flags AS flags, o.settings
       FROM public.organizations o WHERE o.id=$1`, [orgId],
  )).rows[0];
  if (!row) return true;
  return signingRequiresIdentity(idSignGateFlagOn(row.global, row.flags, orgId), resolveIdSignGate(row.settings));
}

/** Same policy for page rendering (e.g. the tenant ID banner). Flag OFF ⇒ true (unchanged). */
export async function identityRequiredForSigningFor(session: Session): Promise<boolean> {
  session = await guardEffectiveSession(session, null);
  try { return await tx(session.userId, (client) => identityRequiredForSigning(client, session.orgId), requireOrgScope(session)); }
  catch { return true; }
}
