import { loadSharePhoto } from "@/server/b110-case-share";
import { downloadRepairObject } from "@/server/ticket-photos";
import { sniffPhotoMime } from "@/server/repair-rules";

export const dynamic = "force-dynamic";

/** B-110: an approved 處理後 photo through a live share link only; never a storage URL. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const file = await loadSharePhoto(token, id).catch(() => null);
  if (!file?.storage_path) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const bytes = await downloadRepairObject(file.storage_path).catch(() => null);
  const type = bytes ? sniffPhotoMime(bytes) : null;
  if (!bytes || !type) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
