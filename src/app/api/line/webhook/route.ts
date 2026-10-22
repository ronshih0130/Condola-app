import { handleLineWebhook } from "@/server/line-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 1_000_000) return new Response("too large", { status: 413 });
  try {
    const result = await handleLineWebhook(raw, request.headers.get("x-line-signature"));
    return new Response(result.body, { status: result.status });
  } catch (error) {
    console.error("line webhook", error instanceof Error ? error.message : "failed");
    return new Response("failed", { status: 500 });
  }
}
