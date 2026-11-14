import { requireStaffInviteUnit } from "./b040-staff-ui";
import { NextResponse } from "next/server";
import { FlowError } from "./errors";
import type { Session } from "./types";
import {
  currentInvite,
  issueInvite,
  rotateInvite,
  listBindings,
  acceptBindExisting,
  hashInviteToken,
  INVITE_TOKEN_RE,
} from "./unit-line-invite";
import { svc } from "./db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: privateHeaders });
}

function statusFor(key: string): number {
  if (key === "errors.forbidden") return 403;
  if (key === "errors.notFound") return 404;
  return 400;
}

function fail(err: unknown): NextResponse {
  if (err instanceof FlowError) {
    return json({ ok: false, error: err.key }, statusFor(err.key));
  }
  return json({ ok: false, error: "errors.generic" }, 400);
}

function emptySession(): NextResponse {
  return json({ ok: false, error: "errors.forbidden" }, 401);
}

function badId(): NextResponse {
  return json({ ok: false, error: "errors.notFound" }, 404);
}

export async function handleStaffLive(
  session: Session | null,
  unitId: string,
): Promise<NextResponse> {
  if (!session) return emptySession();
  if (!UUID_RE.test(unitId)) return badId();
  try {
    await requireStaffInviteUnit(session, unitId);
    const cur = await currentInvite(session, unitId);
    const rows = await listBindings(session, unitId);
    const filtered = rows.filter(
      (row) => row.status === "pending" || row.status === "lease_linked",
    );
    const mapped = filtered.map((row) => ({
      display_name: String(row.display_name ?? ""),
      bound_at:
        row.bound_at instanceof Date
          ? row.bound_at.toISOString()
          : String(row.bound_at ?? ""),
    }));
    return json(
      {
        ok: true,
        bound: cur?.bound ?? filtered.length,
        cap: 4,
        expires_at: cur?.expires_at
          ? new Date(cur.expires_at).toISOString()
          : null,
        bindings: mapped,
      },
      200,
    );
  } catch (err) {
    return fail(err);
  }
}

export async function handleStaffIssue(
  session: Session | null,
  unitId: string,
): Promise<NextResponse> {
  if (!session) return emptySession();
  if (!UUID_RE.test(unitId)) return badId();
  try {
    await requireStaffInviteUnit(session, unitId);
    const cur = await currentInvite(session, unitId);
    if (cur) {
      return json(
        {
          ok: true,
          result: {
            token: cur.token,
            path: cur.path,
            expires_at: new Date(cur.expires_at).toISOString(),
            bound: cur.bound,
            cap: cur.cap,
          },
        },
        200,
      );
    }
    const issued = await issueInvite(session, unitId);
    const after = await currentInvite(session, unitId);
    return json(
      {
        ok: true,
        result: {
          token: issued.token,
          path: issued.path,
          expires_at: after ? new Date(after.expires_at).toISOString() : null,
          bound: after?.bound ?? 0,
          cap: 4,
        },
      },
      200,
    );
  } catch (err) {
    return fail(err);
  }
}

export async function handleStaffRotate(
  session: Session | null,
  unitId: string,
): Promise<NextResponse> {
  if (!session) return emptySession();
  if (!UUID_RE.test(unitId)) return badId();
  try {
    await requireStaffInviteUnit(session, unitId);
    const rotated = await rotateInvite(session, unitId);
    const after = await currentInvite(session, unitId);
    return json(
      {
        ok: true,
        result: {
          token: rotated.token,
          path: rotated.path,
          expires_at: after ? new Date(after.expires_at).toISOString() : null,
          bound: after?.bound ?? 0,
          cap: 4,
        },
      },
      200,
    );
  } catch (err) {
    return fail(err);
  }
}

export async function handleAcceptExisting(
  session: Session | null,
  input: { token?: string; orgId?: string; unitId?: string },
  ip?: string,
): Promise<NextResponse> {
  if (!session) return emptySession();
  const token = input.token;
  if (typeof token !== "string" || !INVITE_TOKEN_RE.test(token)) {
    return json({ ok: false, error: "errors.invalid" }, 400);
  }
  let orgId: string | undefined =
    input.orgId && UUID_RE.test(input.orgId) ? input.orgId : undefined;
  let unitId: string | undefined =
    input.unitId && UUID_RE.test(input.unitId) ? input.unitId : undefined;
  const tokenHash = hashInviteToken(token);
  const looked = await svc(session.userId, async (client) => {
    const res = await client.query(
      "SELECT org_id::text, unit_id::text FROM app.unit_invite_secrets WHERE token_hash = $1 ORDER BY created_at DESC LIMIT 1",
      [tokenHash],
    );
    return res.rows[0] as
      | { org_id: string; unit_id: string }
      | undefined;
  });
  if (looked) {
    if (orgId && unitId) {
      if (orgId !== looked.org_id || unitId !== looked.unit_id) {
        return json({ ok: false, error: "errors.notFound" }, 404);
      }
    } else {
      orgId = looked.org_id;
      unitId = looked.unit_id;
    }
  } else if (!orgId || !unitId) {
    return json({ ok: false, error: "errors.notFound" }, 404);
  }
  try {
    const bound = await acceptBindExisting({
      orgId: orgId!,
      unitId: unitId!,
      token,
      userId: session.userId,
      ip,
    });
    return json(
      {
        ok: true,
        result: { bindingId: bound.bindingId, userId: bound.userId },
      },
      200,
    );
  } catch (err) {
    return fail(err);
  }
}
