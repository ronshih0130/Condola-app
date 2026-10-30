import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { HANDOVER_MAX_BYTES, handoverBytes, handoverMeta, sealHandoverObject } from "./handover-storage";

test("handover evidence validates content and uses verified immutable object writes", async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
  const hash = createHash("sha256").update(jpeg).digest("hex");
  assert.equal(handoverBytes(jpeg, "image/jpeg", jpeg.length), hash);
  assert.throws(() => handoverBytes(jpeg, "image/png", jpeg.length));
  assert.throws(() => handoverBytes(jpeg, "image/jpeg", jpeg.length + 1));
  assert.throws(() => handoverMeta("x.jpg", "image/jpeg", HANDOVER_MAX_BYTES + 1));
  assert.equal(handoverMeta("../x.jpg", "image/jpeg", 4).fileName, ".._x.jpg");
  const previousFetch = globalThis.fetch;
  const oldUrl = process.env.SUPABASE_URL, oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://127.0.0.1:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-test-only";
  let posted: Buffer | undefined;
  try {
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "POST") { posted = Buffer.from(init.body as Uint8Array); return new Response("{}", { status: 200 }); }
      return new Response(Uint8Array.from(posted ?? []), { status: 200 });
    }) as typeof fetch;
    await sealHandoverObject("org/example/sealed", jpeg, "image/jpeg", hash);
    assert.deepEqual(posted, Buffer.from(jpeg));
    globalThis.fetch = (async (_url, init) => init?.method === "POST" ? new Response("", { status: 409 }) : new Response(Uint8Array.from([0xff, 0xd8, 0xff, 2]))) as typeof fetch;
    await assert.rejects(sealHandoverObject("org/example/sealed", jpeg, "image/jpeg", hash));
    globalThis.fetch = (async () => { throw new Error("private provider details"); }) as typeof fetch;
    await assert.rejects(sealHandoverObject("org/example/sealed", jpeg, "image/jpeg", hash), { message: "errors.photoStorage" });
  } finally {
    globalThis.fetch = previousFetch;
    if (oldUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  }
});
