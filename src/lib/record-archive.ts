/** Browser-safe archive contract. Scope is a precondition, never authority. */
export type ArchiveKind = "property" | "unit" | "room";
export type ArchiveRef = { kind: ArchiveKind; id: string };
export type RenderedArchiveScope = { actorId: string; orgId: string; liveOrgId: string; environment: "live" | "sandbox" };
export type ArchiveCategory = "leases" | "signing" | "repairs" | "dispatch" | "utilities" | "finance" | "invitations";
export type ArchiveCoverage = { category: ArchiveCategory; state: "verified" | "unknown" };
export type ArchiveItem = { category: ArchiveCategory; label: string; href: string | null };
export type ArchiveObserved = {
  ref: ArchiveRef;
  propertyId: string;
  unitId: string | null;
  roomId: string | null;
  mode: "whole_unit" | "by_room" | null;
  name: string;
  propertyName: string;
  unitLabel: string | null;
  roomLabel: string | null;
  archivedAtUtc: string | null;
  inherited: Array<{ ref: ArchiveRef; archivedAtUtc: string }>;
  version: string;
};
export type ArchiveReady = {
  state: "ready";
  observed: ArchiveObserved;
  writeEnabled: boolean;
  canArchive: boolean;
  canRestore: boolean;
  blockers: ArchiveItem[];
  warnings: ArchiveItem[];
  coverage: ArchiveCoverage[];
  history: ArchiveItem[];
};
export type ArchiveView = ArchiveReady | { state: "unavailable" };
export type ArchiveList = { state: "ready"; rows: ArchiveObserved[]; hasMore: boolean; nextCursor: string | null } | { state: "unavailable" };
export type ArchiveCommandInput = { ref: ArchiveRef; desired: "archived" | "active"; expectedVersion: string; renderedScope: RenderedArchiveScope; reason: string; requestId: string };
export type ArchiveOutcome = { state: "changed" | "already_in_desired_state" | "stale" | "blocked" | "disabled" | "forbidden" | "busy" | "conflict" | "unknown" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isArchiveRef(value: unknown): value is ArchiveRef {
  if (!value || typeof value !== "object") return false;
  const v=value as Record<string,unknown>;
  return (v.kind === "property" || v.kind === "unit" || v.kind === "room") && typeof v.id === "string" && UUID.test(v.id);
}
export function isRenderedArchiveScope(value: unknown): value is RenderedArchiveScope {
  if (!value || typeof value !== "object") return false;
  const v=value as Record<string,unknown>;
  return [v.actorId,v.orgId,v.liveOrgId].every(x=>typeof x === "string" && UUID.test(x)) && (v.environment === "live" || v.environment === "sandbox");
}
export function sameArchiveScope(a: unknown, b: unknown): boolean {
  return isRenderedArchiveScope(a) && isRenderedArchiveScope(b) && a.actorId.toLowerCase()===b.actorId.toLowerCase() && a.orgId.toLowerCase()===b.orgId.toLowerCase() && a.liveOrgId.toLowerCase()===b.liveOrgId.toLowerCase() && a.environment===b.environment;
}
export function isArchiveCommand(value: unknown): value is ArchiveCommandInput {
  if (!value || typeof value !== "object") return false;
  const v=value as Record<string,unknown>;
  return isArchiveRef(v.ref) && (v.desired === "archived" || v.desired === "active") && typeof v.expectedVersion === "string" && /^[0-9a-f]{64}$/.test(v.expectedVersion) && isRenderedArchiveScope(v.renderedScope) && typeof v.reason === "string" && v.reason.length <= 500 && /\S/u.test(v.reason) && typeof v.requestId === "string" && UUID.test(v.requestId);
}
