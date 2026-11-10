import { landingHtml, referrerHeaders } from "@/server/unit-line-invite";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> } | { params: { token: string } },
): Promise<Response> {
  const params = await Promise.resolve(ctx.params);
  return new Response(landingHtml({ token: params.token }), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...referrerHeaders() },
  });
}
