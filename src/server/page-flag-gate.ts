import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { FLAG_GATE } from "@/server/flag-gate";
import { getSession } from "@/server/session";

// Lauren 2c (CEO option a, hub 20-build/lauren-1-6/page-gate-proposal.md; DECISIONS 2026-11-18). Page twin of
// withFlagGate (src/server/flag-gate.ts) for App Router GATE pages only: flag OFF → notFound(). Branch pages (flag OFF →
// legacy render) stay hand-written. Constraint: AGENTS.md §7, REVIEW-CHECKLIST 13.
//
// The gate is today's hand-written page prologue, statement for statement:
//   await requireCurrentConsent(undefined, "page");   // redirects to /consent… or /partner-consent; return value ignored
//   const session = await getSession();               // no session → redirect("/login"); a read error propagates
//   if (!(await flag(session))) notFound();           // OFF → 404
//   …page body…
//
// Constraint (deliberate difference from withFlagGate): a flag predicate that THROWS is NOT caught here. It propagates
// exactly as it does from today's pages (Next renders the error boundary / 500), whereas the route wrapper fails closed
// to 404. Pages catch nothing today, so failing closed here would be a silent behaviour change. The predicates the gate
// pages use (brandV3EnabledForOrg, maintUnitAssignEnabledForOrg) catch internally and never reject, so for them both
// wrappers agree. A page whose predicate can throw keeps that behaviour; changing it needs its own approval.
//
// Several flags (e.g. brand_v3 then an item flag) or a role precondition are one predicate joined with `&&`, as in the
// 2b maint-unit-assign route: short-circuiting keeps today's order (the second lookup runs only when the first is ON).
//
// props (and props.params / props.searchParams, both Promises) are never read, awaited or enumerated before the gate;
// the same props object is handed to the page untouched.

/** The resolved session the flag predicate and the page receive (getSession never returns null). */
type LoadedSession = Awaited<ReturnType<typeof getSession>>;

export type PageFlagGateSpec = {
  /** Feature-flag registry key for the FLAG_GATE marker, e.g. "brand_v3". Must exist in ops/flags.yaml. */
  flagKey: string;
  /** Resolve the gate for the current session. Falsy → notFound(). A throw propagates (see the Constraint above). */
  flag: (session: LoadedSession) => boolean | Promise<boolean>;
};

/** The page body that runs once the gate is open. `props` is exactly what Next passed; `session` is the gate's session. */
export type PageFlagGatePage<Props, Result> = (props: Props, session: LoadedSession) => Result | Promise<Result>;

/** Dependencies, injectable for tests only. Production pages never pass them (HANDOFF-MAC lesson B2). */
export type PageFlagGateDeps = {
  requireCurrentConsent: typeof requireCurrentConsent;
  getSession: typeof getSession;
  notFound: typeof notFound;
};

const defaultDeps: PageFlagGateDeps = { requireCurrentConsent, getSession, notFound };

export type FlagGatedPage<Props, Result> = ((props: Props) => Promise<Result>) & {
  readonly [FLAG_GATE]: string;
};

/**
 * Wrap an App Router gate page's default export: consent → session → flag (OFF → notFound()) → Page(props, session).
 * Use it as `export default withPageFlagGate({ flagKey: "…", flag: s => … }, async (props, session) => …)`: a direct
 * call, two arguments, no lazy wrapping, and `flag` and the page written inline in the call (the consent and B017
 * entrypoint scanners reject identifiers there, so what they scan is what runs).
 */
export function withPageFlagGate<Props, Result>(
  spec: PageFlagGateSpec,
  Page: PageFlagGatePage<Props, Result>,
  deps: PageFlagGateDeps = defaultDeps,
): FlagGatedPage<Props, Result> {
  const gated = async (props: Props): Promise<Result> => {
    await deps.requireCurrentConsent(undefined, "page");
    const session = await deps.getSession();
    if (!(await spec.flag(session))) return deps.notFound();
    return Page(props, session);
  };

  Object.defineProperty(gated, FLAG_GATE, {
    value: spec.flagKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return gated as FlagGatedPage<Props, Result>;
}
