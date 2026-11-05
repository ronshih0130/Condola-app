import type { VendorIdentityResolution } from "./vendor-identity";
import type { VendorLinkCapability } from "./vendor-link-rules";

export type VendorAttributionSource =
  | "first_temp"
  | "emergency"
  | "existing_open"
  | "unspecified";

export type VendorAttributionRecord = {
  jobId: string;
  orgId: string;
  ticketId: string;
  userId: string;
  tokenHash: string;
  capabilityAtWrite: VendorLinkCapability;
  linkableAtWrite: boolean;
  plannedAt: Date;
  source: VendorAttributionSource;
};

export type VendorAttributionPlan =
  | { status: "gated" }
  | { status: "not_linkable" }
  | { status: "no_user" }
  | { status: "attributable"; record: VendorAttributionRecord };

/** Pure attribution planning; persistence belongs to a future consumer. */
export function planVendorAttribution(
  resolution: VendorIdentityResolution | null,
  linkedUserId: string | null,
  now: Date,
  gateOn: boolean,
  source: VendorAttributionSource = "unspecified",
): VendorAttributionPlan {
  if (gateOn === false) return { status: "gated" };
  if (resolution == null || resolution.linkable === false) return { status: "not_linkable" };
  if (linkedUserId == null || linkedUserId === "") return { status: "no_user" };

  return {
    status: "attributable",
    record: {
      jobId: resolution.jobId,
      orgId: resolution.orgId,
      ticketId: resolution.ticketId,
      userId: linkedUserId,
      tokenHash: resolution.tokenHash,
      capabilityAtWrite: resolution.capability,
      linkableAtWrite: resolution.linkable,
      plannedAt: now,
      source,
    },
  };
}
