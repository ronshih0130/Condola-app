import { unitQrEntryResponse, unitQrPrivateHeaders } from "@/server/unit-qr-entry";
import { unitQrEntryEnabled } from "@/server/unit-qr-signup";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (await unitQrEntryEnabled()) return unitQrEntryResponse();
  } catch {
    // Admission failures reveal neither settings nor database details.
  }
  return new Response(null, { status: 404, headers: unitQrPrivateHeaders });
}
