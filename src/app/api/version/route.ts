import { BUILD_SHA } from "@/build-info";

export const dynamic = "force-dynamic";

export function GET() {
  const commit = process.env.NEXT_PUBLIC_COMMIT || BUILD_SHA;
  return Response.json({ sha: BUILD_SHA, commit }, { headers: { "Cache-Control": "no-store" } });
}
