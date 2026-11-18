export async function readCappedJson(request: Request, limit = 1024): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > limit) return { ok: false, status: 413 };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body?.getReader();
    if (!reader) return { ok: false, status: 400 };
    const decoder = new TextDecoder();
    let bytes = 0, text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        // Don't wait for the underlying source to acknowledge cancellation.
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { ok: true, value: JSON.parse(text + decoder.decode()) };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader?.releaseLock();
  }
}
