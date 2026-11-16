import { loadShareFile } from "@/server/b110-case-share";

export const dynamic = "force-dynamic";

/** B-110: an issued or voided document's stored PDF through a live share link only. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const file = await loadShareFile(token, "document", id).catch(() => null);
  if (!file?.pdf) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(new Uint8Array(file.pdf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store",
    "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff" } });
}
