import { sameOriginMutation } from "./request-origin";
import { FlowError } from "./errors";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { makeT } from "../i18n";
import type { Session } from "./types";
import { staffCanManage } from "./unit-line-invite";
import { mutateStaffInvite, requireStaffInviteUnit, staffInvitePage, staffInviteLive, staffInvitePath, type StaffInviteCommand } from "./b040-staff-ui";
import { staffInviteHeaders } from "../lib/staff-invite";

function failure(error: unknown, session: Session) {
  const status = error instanceof FlowError && error.key === "errors.forbidden" ? 403
    : error instanceof FlowError && error.key === "errors.notFound" ? 404 : 400;
  // No error object, SQL message, token, or submitted input is logged/reflected.
  return Response.json({ error: makeT(session.locale)("errors.generic") }, { status, headers: staffInviteHeaders });
}

/** no-referrer makes native form navigations serialize Origin as null. Only
 * browser-controlled Fetch Metadata proving a same-origin document navigation
 * may supply that missing origin; the existing Host consistency check still runs.
 * Cross-site, same-site, opaque/sandbox and metadata-less requests fail closed.
 */
export function staffInviteMutationAllowed(request: Request): boolean {
  if (sameOriginMutation(request)) return true;
  if (request.headers.get("origin") !== "null" || request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("sec-fetch-mode") !== "navigate" || request.headers.get("sec-fetch-dest") !== "document") return false;
  const headers = new Headers(request.headers);
  headers.set("origin", new URL(request.url).origin);
  return sameOriginMutation(new Request(request.url, { method: "POST", headers }));
}

/** Consent is enforced by the two HTTP adapters before entering this handler. */
export async function serveStaffInvite(session: Session, unitId: string, view: string[], request: Request): Promise<Response> {
  try {
    if (!staffCanManage(session)) throw new FlowError("errors.forbidden");
    session = await guardEffectiveSession(session, "leases.edit");
    await requireStaffInviteUnit(session, unitId);
    const base = staffInvitePath(unitId);
    if (request.method === "POST") {
      if (view.length || !staffInviteMutationAllowed(request) ||
          !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new FlowError("errors.forbidden");
      const body = await request.text();
      if (body.length > 4096) throw new FlowError("errors.invalid");
      const form = new URLSearchParams(body);
      const action = form.get("action");
      if (!["issue", "rotate", "remove", "include"].includes(action ?? "")) throw new FlowError("errors.invalid");
      const input: StaffInviteCommand = { action: action as StaffInviteCommand["action"],
        bindingId: form.get("bindingId") ?? undefined, leaseId: form.get("leaseId") ?? undefined, bindingIds: form.getAll("bindingIds") };
      await mutateStaffInvite(session, unitId, input);
      const suffix = action === "rotate" ? "/rotated" : action === "remove" ? "/removed" : action === "include" ? "/saved" : "";
      if (request.headers.get("accept") === "application/json") return Response.json({ location: base + suffix }, { headers: staffInviteHeaders });
      return new Response(null, { status: 303, headers: { ...staffInviteHeaders, Location: base + suffix } });
    }
    if (request.method !== "GET") throw new FlowError("errors.invalid");
    if (view.length === 1 && view[0] === "live") {
      const live = await staffInviteLive(session, unitId);
      return Response.json({ ...live, bindings: live.bindings.map(b => ({ id: b.id, displayName: b.displayName, joinedAt: b.joinedAt })) },
        { headers: { ...staffInviteHeaders, "Content-Type": "application/json" } });
    }
    return Response.json(await staffInvitePage(session, unitId, view), { headers: staffInviteHeaders });
  } catch (error) { return failure(error, session); }
}
