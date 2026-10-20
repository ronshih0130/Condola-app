import { signedLeasePdf } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSession();
  if (session.kind !== "staff") return new Response("Not found", { status: 404 });
  const file = await signedLeasePdf(session, id);
  if (!file) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.from(file.content);
  return new Response(new Blob([bytes], { type: "application/pdf" }), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
