import manifestJson from "@/generated/third-party-licenses.json";
import type {
  LicenseEntry,
  Manifest,
} from "../../scripts/third-party-licenses.mjs";

export type { LicenseEntry };
export type LicenseDelivery = LicenseEntry["delivery"];

const manifest = manifestJson as Manifest;

export function licenseEntries(): readonly LicenseEntry[] {
  return manifest.packages;
}

export function deliveryLabelKey(delivery: LicenseDelivery) {
  switch (delivery) {
    case "bundled":
      return "i_lic_delivery_bundled";
    case "separate-unmodified-file":
      return "i_lic_delivery_separate";
    case "inside:libheif-js":
      return "i_lic_delivery_inside";
  }
}
