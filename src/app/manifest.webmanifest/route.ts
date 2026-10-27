import { NextResponse } from "next/server";
import manifest from "../../server/legacy-manifest";

export const dynamic = "force-static";

export function GET() {
  // Match Next's metadata-route serializer and revalidation header exactly.
  return new NextResponse(JSON.stringify(manifest()), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}
