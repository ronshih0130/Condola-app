import { requireCurrentConsent } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { logServerError } from "@/server/errors";

// Constraint: AGENTS.md §7, REVIEW-CHECKLIST 13; LPQ-28 (404-before-401) is a later, separately approved behaviour change — do not change the order here.

/**
 * Non-enumerable marker attached to every withFlagGate-wrapped route handler so
 * tests can discover the flag registry key statically. `Symbol.for` keeps the
 * key stable across module instances (test harness re-compiles this file).
 */
export const FLAG_GATE: unique symbol = Symbol.for("condola.flag-gate");

const DEFAULT_HEADERS: Record<string, string> = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/** The resolved, non-null session the flag predicate and handler receive. */
type LoadedSession = NonNullable<Awaited<ReturnType<typeof readSession>>>;

export type FlagGateSpec = {
  /** Feature-flag registry key, e.g. "brand_v3". Must exist in ops/flags.yaml. */
  flagKey: string;
  /** Resolve the flag for the current session. Returning false OR throwing closes the gate (404). */
  flag: (session: LoadedSession) => boolean | Promise<boolean>;
  /** logServerError tag used for session-read, flag-throw and handler failures. */
  tag: string;
  /** Gate response headers. Defaults to `{ "Cache-Control": "private, no-store", Vary: "Cookie" }`. */
  headers?: Record<string, string>;
  /** When true, require the Origin header to equal the request origin (403 otherwise). */
  sameOrigin?: boolean;
};

export type FlagGateHandler<Ctx> = (
  request: Request,
  session: LoadedSession,
  ctx: Ctx,
) => Response | Promise<Response>;

/** Dependencies, injectable for tests. Defaults wire the real server modules. */
export type FlagGateDeps = {
  requireCurrentConsent: typeof requireCurrentConsent;
  readSession: typeof readSession;
  logServerError: typeof logServerError;
};

const defaultDeps: FlagGateDeps = { requireCurrentConsent, readSession, logServerError };

export type FlagGatedRoute<Ctx> = ((request: Request, ctx: Ctx) => Promise<Response>) & {
  readonly [FLAG_GATE]: string;
};

/**
 * Wrap an App Router API route handler in the canonical consent → session →
 * (same-origin) → flag gate. The order is byte-for-byte the order used by
 * src/app/api/owner-view/route.ts so existing routes migrate without behaviour
 * change. The request body is NEVER touched before `handler` runs.
 */
export function withFlagGate<Ctx = unknown>(
  spec: FlagGateSpec,
  handler: FlagGateHandler<Ctx>,
  deps: FlagGateDeps = defaultDeps,
): FlagGatedRoute<Ctx> {
  const headers = spec.headers ?? DEFAULT_HEADERS;

  const gated = async (request: Request, ctx: Ctx): Promise<Response> => {
    const denied = await deps.requireCurrentConsent(undefined, "api");
    if (denied) return denied;

    let session: Awaited<ReturnType<typeof readSession>>;
    try {
      session = await deps.readSession();
    } catch (error) {
      deps.logServerError(spec.tag, error);
      return new Response(null, { status: 500, headers });
    }
    if (!session) return new Response(null, { status: 401, headers });

    if (spec.sameOrigin && request.headers.get("origin") !== new URL(request.url).origin) {
      return new Response(null, { status: 403, headers });
    }

    // Fail closed: a false flag OR a throwing lookup both become 404. A throw is logged.
    try {
      if (!(await spec.flag(session))) return new Response(null, { status: 404, headers });
    } catch (error) {
      deps.logServerError(spec.tag, error);
      return new Response(null, { status: 404, headers });
    }

    try {
      return await handler(request, session, ctx);
    } catch (error) {
      deps.logServerError(spec.tag, error);
      return new Response(null, { status: 500, headers });
    }
  };

  Object.defineProperty(gated, FLAG_GATE, {
    value: spec.flagKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return gated as FlagGatedRoute<Ctx>;
}
