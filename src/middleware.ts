import { NextResponse, type NextRequest } from "next/server";
import { PORTAL_ROLE_COOKIE } from "@/server/portal-role";

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  const path = request.nextUrl.pathname;
  headers.set("x-pathname", path);
  const response = NextResponse.next({ request: { headers } });
  const role = path === "/o" || path.startsWith("/o/") ? "owner" : path === "/t" || path.startsWith("/t/") ? "tenant" : "";
  if (role) {
    response.cookies.set(PORTAL_ROLE_COOKIE, role, { path: "/", sameSite: "lax", httpOnly: true });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
