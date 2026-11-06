import type { OwnerDocumentFile } from "./owner-portal-access";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** Document bytes: never framed, never script-capable, never sniffed. */
const documentHeaders = {
  ...privateHeaders,
  "Content-Security-Policy": "sandbox",
  "X-Frame-Options": "DENY",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ownerDocumentNotFound() {
  return new Response("Not found", { status: 404, headers: privateHeaders });
}

/**
 * B-023 owner document open. `open` performs authorization, the access audit row
 * and the byte read in one DB gateway call; null (flag OFF, foreign id, no
 * authority) is a plain 404 with no write. `?view=1` is inline, otherwise attachment.
 */
export async function ownerDocumentHttp(input: {
  documentId: string;
  url: string;
  open: (kind: "view" | "download", requestId: string) => Promise<OwnerDocumentFile | null>;
  logError: (error: unknown) => void;
}): Promise<Response> {
  if (!UUID.test(input.documentId)) return ownerDocumentNotFound();
  let kind: "view" | "download" = "download";
  try { if (new URL(input.url).searchParams.get("view") === "1") kind = "view"; } catch { return ownerDocumentNotFound(); }
  try {
    const file = await input.open(kind, crypto.randomUUID());
    if (!file) return ownerDocumentNotFound();
    const bytes = Uint8Array.from(file.content);
    return new Response(new Blob([bytes], { type: "application/pdf" }), {
      headers: {
        ...documentHeaders,
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${kind === "view" ? "inline" : "attachment"}; filename="${encodeURIComponent(file.file_name)}"`,
      },
    });
  } catch (error) {
    input.logError(error);
    return new Response("Unavailable", { status: 503, headers: privateHeaders });
  }
}

/**
 * HEAD never opens a document and never writes an access row (Next would otherwise
 * answer HEAD by running GET). Flag OFF / not an owner ⇒ 404; ON ⇒ 405 Allow: GET.
 */
export async function ownerDocumentHeadHttp(input: { enabled: () => Promise<boolean> }): Promise<Response> {
  let enabled = false;
  try { enabled = await input.enabled(); } catch { enabled = false; }
  if (!enabled) return ownerDocumentNotFound();
  return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: "GET" } });
}
