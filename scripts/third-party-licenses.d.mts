export interface UpstreamSource {
  version: string;
  url: string;
  sha256: string;
  file: string;
  kind: "release" | "tag";
  topDir: string;
  libraryDir?: string;
}

export interface BrowserConfig {
  roots: {
    name: string;
    walk: boolean;
    exclude: string[];
    why: string;
  }[];
  embedded: {
    name: string;
    parent: string;
    license: string;
    probe: "libheif" | "libde265";
    homepage: string;
    sourceUrlTemplate: string;
  }[];
  vendored: {
    package: string;
    file: string;
    publicDir: string;
  }[];
  copyrightHolders?: Record<string, string>;
  copyleftTexts: Record<string, {
    from?: string;
    public: string;
    sha256?: string;
  }>;
  extraNotices: {
    from: string;
    public: string;
  }[];
  upstreamSources: Record<string, UpstreamSource>;
  buildProvenance: {
    prebuiltUrl: string;
    libheifCommit: string;
    emscriptenVersion: string;
  };
  notInWebpackBundle: Record<string, string>;
}

export type SourceArchive = {
  label: string;
  url: string;
} & (
  | { sha256: string; integrity?: never }
  | { integrity: string; sha256?: never }
);

export interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  licenseText: string | null;
  licenseTextSource: "spdx-template" | `package-file:${string}` | `upstream-file:${string}`;
  licenseUrl: string | null;
  gplUrl: string | null;
  noticeUrl: string | null;
  repository: string | null;
  sourceUrl: string;
  sourceArchives: SourceArchive[];
  copyrightHolders: string[];
  buildInputsUrl: string | null;
  buildInputFiles: { label: string; url: string }[];
  delivery: "bundled" | "separate-unmodified-file" | "inside:libheif-js";
  assetPath: string | null;
  sha256: string | null;
  requiredBy: string[];
}

export interface Manifest {
  generatedBy: string;
  packages: LicenseEntry[];
}

export interface BundledPackage {
  name: string;
  version: string;
}

export function resolvePackageDir(fromDir: string, name: string): string;
export function readLicenseText(pkgDir: string): string;
export function npmTarballUrl(name: string, version: string): string;
export function collectBrowserPackages(rootDir: string, config: BrowserConfig): {
  directory: string;
  metadata: {
    name: string;
    version: string;
    license: string;
    author?: string | { name: string; email?: string };
    dependencies?: Record<string, string>;
    repository?: string | { url: string };
  };
  requiredBy: string[];
}[];
export function probeEmbedded(rootDir: string): Promise<{ libheif: string; libde265: string }>;
export function buildManifest(rootDir: string, config: BrowserConfig): Promise<Manifest>;
export function assetModule(manifest: Manifest): string;
export function generate(rootDir: string, config: BrowserConfig, check?: boolean): Promise<Manifest>;
export function vendorAssets(rootDir: string, config: BrowserConfig): Promise<Manifest>;
export function verifyBundle(
  manifest: Pick<Manifest, "packages">,
  bundled: readonly BundledPackage[],
  config: Pick<BrowserConfig, "notInWebpackBundle">,
): { missing: string[]; unexpected: string[] };
