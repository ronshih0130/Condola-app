import { landingHtml, referrerHeaders } from "@/server/unit-line-invite";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  return new Response(landingHtml({ token }), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...referrerHeaders() },
  });
}
