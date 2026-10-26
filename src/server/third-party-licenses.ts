import manifestJson from "@/generated/third-party-licenses.json";

export type LicenseDelivery = "bundled" | "separate-unmodified-file" | "inside:libheif-js";

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  licenseText: string | null;
  licenseUrl: string | null;
  gplUrl: string | null;
  noticeUrl: string | null;
  repository: string | null;
  sourceUrl: string;
  delivery: LicenseDelivery;
  assetPath: string | null;
  sha256: string | null;
  requiredBy: string[];
}

interface LicenseManifest {
  generatedBy: string;
  packages: LicenseEntry[];
}

const manifest = manifestJson as LicenseManifest;

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
