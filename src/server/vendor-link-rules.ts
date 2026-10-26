/** Keep disabled until the remaining sharing and assignment contracts are reviewed. */
export const VENDOR_LINK_ENABLED = false;

export function vendorLinkOn(killSwitch: boolean, featureFlags: unknown): boolean {
  if (killSwitch !== true || !featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return false;
  }
  const value = (featureFlags as Record<string, unknown>).vendor_link;
  return value === true || value === "true";
}

export type VendorLinkCapability = "write" | "read_only" | "invalid";

export function vendorLinkCapability(input: {
  ticketStatus: string;
  active: boolean;
  revokedAt: Date | string | null;
  expiresAt: Date | string;
  now: Date;
}): VendorLinkCapability {
  const expiry = new Date(input.expiresAt).getTime();
  const now = input.now.getTime();
  if (!input.active || input.revokedAt !== null || !Number.isFinite(expiry) || !Number.isFinite(now) || now >= expiry) {
    return "invalid";
  }
  // Mirror #55's reportableTicket list, including resolved. Other states cannot write.
  return ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved"].includes(input.ticketStatus)
    ? "write"
    : "read_only";
}

type Photo = { id: string; name: string };
export type VendorLinkSafeView = {
  address: string;
  place: string;
  title: string;
  description: string;
  window: string;
  status: string;
  expiresAt: string;
  ticketNumber?: string;
  issuePhotos: Photo[];
  donePhotos: Photo[];
};

function photos(value: unknown): Photo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((photo: unknown) => {
    if (!photo || typeof photo !== "object") return [];
    const row = photo as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.name === "string"
      ? [{ id: row.id, name: row.name }]
      : [];
  });
}

/** Explicit display allowlist, including nested photos; never forward source objects. */
export function vendorLinkSafeView(input: unknown): VendorLinkSafeView {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const text = (key: string) => typeof row[key] === "string" ? row[key] as string : "";
  return {
    address: text("address"),
    place: text("place"),
    title: text("title"),
    description: text("description"),
    window: text("window"),
    status: text("status"),
    expiresAt: text("expiresAt"),
    ...(typeof row.ticketNumber === "string" ? { ticketNumber: row.ticketNumber } : {}),
    issuePhotos: photos(row.issuePhotos),
    donePhotos: photos(row.donePhotos),
  };
}

/** Per-type templates arrive with job_types in the 10/29 migration. Never expose raw JSON. */
export function renderableTypeFields(
  jobTypeCode: string | null,
  typeFields: unknown,
): Array<{ key: string; label: string; value: string }> {
  void jobTypeCode;
  void typeFields;
  return [];
}
