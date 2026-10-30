/** Limit the actual stream, including when Content-Length is missing or false. */
export async function readHandoverJson(request: Request): Promise<Record<string, unknown>> {
  const max = 16 * 1024;
  const advertised = request.headers.get("content-length");
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > max)) throw new Error("Invalid request");
  if (!request.body) throw new Error("Invalid request");
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) throw new Error("Invalid request"); parts.push(part.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts,size)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
  return parsed as Record<string, unknown>;
}
