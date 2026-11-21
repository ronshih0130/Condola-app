/**
 * B-105 client controllers, kept free of React so their guards are unit-tested with a mocked fetch.
 * - Decisions: one request id per decision kind for the page's lifetime (a retry is a replay), a double-submit
 *   guard, and a reload on success or conflict so the stored decision shows (tab A accepts, tab B declines).
 * - Photos: busy from the moment a file is picked (HEIC conversion included), the prepared file is kept on a
 *   failed save, and a retry after a successful sign + upload only repeats the confirm.
 */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type DecisionKind = "accepted" | "declined";
export type DecisionOutcome = "recorded" | "conflict" | "invalid" | "failed" | "busy";

export function createDecisionController(deps: { fetch: Fetch; reload: () => void; newId?: () => string }) {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const ids: Record<DecisionKind, string> = { accepted: newId(), declined: newId() };
  let busy = false;
  return {
    get busy() { return busy; },
    requestId(kind: DecisionKind) { return ids[kind]; },
    async submit(token: string, kind: DecisionKind, fields: { agreedOn?: string | null; reason?: string | null }): Promise<DecisionOutcome> {
      if (busy) return "busy";
      busy = true;
      try {
        const body = kind === "accepted"
          ? { token, requestId: ids.accepted, decision: kind, agreedOn: fields.agreedOn || null }
          : { token, requestId: ids.declined, decision: kind, reason: fields.reason?.trim() || null };
        const response = await deps.fetch("/api/vendor-jobs/case-decision", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const result = (await response.json().catch(() => null)) as { status?: string } | null;
        const outcome: DecisionOutcome = response.ok && result?.status === "recorded" ? "recorded"
          : result?.status === "rejected_conflict" ? "conflict"
          : result?.status === "rejected_invalid" ? "invalid" : "failed";
        if (outcome === "recorded" || outcome === "conflict") deps.reload();
        return outcome;
      } catch {
        return "failed";
      } finally {
        busy = false;
      }
    },
  };
}

export type PreparedPhoto = { file: File; mime: string; signed?: { path: string; uploadToken: string } };
export type UploadOutcome = "saved" | "busy" | "limit" | "failed" | { invalid: string };

export function createPhotoUploadController(deps: {
  fetch: Fetch; reload: () => void; token: string; phase: "before" | "after";
  prepare: (file: File) => Promise<PreparedPhoto | string>;
}) {
  let busy = false;
  let kept: PreparedPhoto | null = null;

  async function send(item: PreparedPhoto): Promise<UploadOutcome> {
    try {
      if (!item.signed) {
        const response = await deps.fetch("/api/vendor-jobs/photos/sign", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: deps.token, fileName: item.file.name, mime: item.mime, size: item.file.size }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string; uploadUrl?: string; token?: string; path?: string; uploadToken?: string };
        if (body.error === "errors.photoLimit") { kept = null; return "limit"; }
        if (!response.ok || !body.uploadUrl || !body.path || !body.uploadToken) throw new Error("sign");
        const headers: Record<string, string> = { "content-type": item.mime };
        if (body.token) headers.authorization = `Bearer ${body.token}`;
        const uploaded = await deps.fetch(body.uploadUrl, { method: "PUT", headers, body: item.file });
        if (!uploaded.ok) throw new Error("upload");
        item = { ...item, signed: { path: body.path, uploadToken: body.uploadToken } };
      }
      kept = item;
      const signed = item.signed!;
      const confirmed = await deps.fetch("/api/vendor-jobs/case-photos/confirm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: deps.token, phase: deps.phase, path: signed.path, fileName: item.file.name,
          mime: item.mime, size: item.file.size, uploadToken: signed.uploadToken }),
      });
      if (!confirmed.ok) {
        const body = (await confirmed.json().catch(() => ({}))) as { error?: string };
        if (body.error === "errors.photoLimit") { kept = null; return "limit"; }
        throw new Error("confirm");
      }
      kept = null;
      deps.reload();
      return "saved";
    } catch {
      kept = kept ?? item;
      return "failed";
    }
  }

  async function run(work: () => Promise<UploadOutcome>): Promise<UploadOutcome> {
    if (busy) return "busy";
    busy = true;
    try { return await work(); } finally { busy = false; }
  }

  return {
    get busy() { return busy; },
    get kept() { return kept; },
    /** Busy covers preparation too, so a second pick during HEIC conversion is refused. */
    pick(file: File) {
      return run(async () => {
        const prepared = await deps.prepare(file).catch(() => "");
        if (typeof prepared === "string") { kept = null; return { invalid: prepared }; }
        kept = null;
        return send(prepared);
      });
    },
    retry() {
      return run(async () => kept ? send(kept) : "failed");
    },
  };
}
