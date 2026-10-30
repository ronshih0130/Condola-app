import { createHash } from "node:crypto";
import { FlowError } from "./errors";
import { sniffPhotoMime } from "./repair-rules";

export const HANDOVER_BUCKET = "handover-attachments-private";
export const HANDOVER_MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export function handoverMeta(fileName: string, mime: string, size: number) {
  const name = fileName.trim().replace(/[/\\\x00-\x1f\x7f]/g, "_");
  if (!name || name.length > 180 || !TYPES.has(mime) || !Number.isInteger(size) || size < 1 || size > HANDOVER_MAX_BYTES) throw new FlowError("errors.required");
  return { fileName: name, mime, size };
}
export function handoverBytes(bytes: Uint8Array, mime: string, size: number) {
  if (bytes.length !== size || size < 1 || size > HANDOVER_MAX_BYTES) throw new FlowError("errors.photoSize");
  const actual = bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-" ? "application/pdf" : sniffPhotoMime(bytes);
  if (actual !== mime) throw new FlowError("errors.photoType");
  return createHash("sha256").update(bytes).digest("hex");
}
function config() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new FlowError("errors.photoStorage");
  return { url, key };
}
function encoded(path: string) { return path.split("/").map(encodeURIComponent).join("/"); }
async function request(method: string, path: string) {
  const { url, key } = config();
  try { return await fetch(`${url}/storage/v1${path}`, { method, cache: "no-store", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${key}`, apikey: key } }); }
  catch { throw new FlowError("errors.photoStorage"); }
}
export async function readHandoverObject(path: string): Promise<Uint8Array> {
  const response = await request("GET", `/object/${HANDOVER_BUCKET}/${encoded(path)}`);
  if (!response.ok || !response.body) throw new FlowError("errors.photoStorage");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > HANDOVER_MAX_BYTES) throw new FlowError("errors.photoSize");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new Uint8Array(Buffer.concat(chunks, total));
}
export async function deleteHandoverObject(path: string) {
  const response = await request("DELETE", `/object/${HANDOVER_BUCKET}/${encoded(path)}`);
  if (!response.ok && response.status !== 404) throw new FlowError("errors.photoStorage");
}

/** Store verified bytes under a path for which no client upload grant exists. */
export async function sealHandoverObject(path: string, bytes: Uint8Array, mime: string, hash: string) {
  const { url, key } = config();
  let response: Response;
  try {
    response = await fetch(`${url}/storage/v1/object/${HANDOVER_BUCKET}/${encoded(path)}`, {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": mime, "x-upsert": "false" },
      body: Buffer.from(bytes),
    });
  } catch { throw new FlowError("errors.photoStorage"); }
  // A prior attempt may have committed even when its response failed;
  // accept an existing object only after independently reading matching bytes.
  // This also avoids depending on a particular duplicate-object status code.
  if (!response.ok) await response.body?.cancel().catch(() => undefined);
  const stored = await readHandoverObject(path);
  if (handoverBytes(stored, mime, bytes.length) !== hash) throw new FlowError("errors.photoStorage");
}
