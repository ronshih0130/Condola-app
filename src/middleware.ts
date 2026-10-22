import { NextResponse, type NextRequest } from "next/server";
import { MAX_PHOTO_BYTES } from "@/lib/jpeg-size";
import { idUploadTooLarge } from "@/server/id-upload-guard";
import { PORTAL_ROLE_COOKIE } from "@/server/portal-role";

export function middleware(request: NextRequest) {
  if (request.method === "POST" && request.nextUrl.pathname === "/t/id" && idUploadTooLarge(request.headers.get("content-length"))) {
    return new NextResponse(null, { status: 413 });
  }
  if (request.method === "POST" && request.nextUrl.pathname === "/api/id-documents/photo") {
    const length = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > MAX_PHOTO_BYTES) return new NextResponse(null, { status: 413 });
  }
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
