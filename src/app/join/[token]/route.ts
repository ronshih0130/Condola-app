import {
  INVITE_TOKEN_RE,
  joinLandingHeaders,
  landingHtml,
} from "@/server/unit-line-invite";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  // Only a well-formed invite token is ever reflected into the page; anything
  // else renders the generic landing page with no interpolation of raw input.
  const safeToken = INVITE_TOKEN_RE.test(token) ? token : undefined;
  return new Response(landingHtml({ token: safeToken }), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...joinLandingHeaders() },
  });
}
