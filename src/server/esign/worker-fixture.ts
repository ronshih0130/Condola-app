import { contractVersionDigest } from "./document";
import { signaturePng } from "./evidence";
import { generateContractPdf, stampSignature } from "./stamp";

/** Synthetic test entrypoint only; not imported by the application Worker. */
const fixture = {
  async fetch(request: Request) {
    const fontBytes = new Uint8Array(await request.arrayBuffer());
    if (fontBytes.length > 4 * 1024 * 1024) return new Response(null, { status: 413 });
    const start = performance.now();
    const generated = await generateContractPdf("住宅租約\n本版取代 2026-10-26 簽署之前版", fontBytes);
    const png = signaturePng([[{ x: 4, y: 4 }, { x: 40, y: 30 }, { x: 90, y: 8 }]]);
    const first = await stampSignature(generated.bytes, png, {
      signerDisplayName: "屋主", signedAt: "2026-10-26T12:00:00Z",
      documentDigest: generated.documentDigest, fontBytes,
    });
    const second = await stampSignature(first.bytes, png, {
      signerDisplayName: "租客", signedAt: "2026-10-26T12:01:00Z",
      documentDigest: first.postSigningDigest, fontBytes,
    });
    if (second.postSigningDigest !== await contractVersionDigest(second.bytes)) throw new Error("Hash mismatch");
    return new Response(new Uint8Array(second.bytes).buffer, { headers: {
      "Content-Type": "application/pdf", "X-Document-SHA256": second.postSigningDigest,
      "X-Elapsed-Ms": String(performance.now() - start),
    } });
  },
};

export default fixture;
