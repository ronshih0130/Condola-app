import { BUILD_SHA } from "@/build-info";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ sha: BUILD_SHA }, { headers: { "Cache-Control": "no-store" } });
}
