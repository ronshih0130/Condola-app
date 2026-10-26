export type VendorKind = "business" | "individual";

export type SealImageMimeType = "image/png" | "image/jpeg";

export interface ValidatedBusinessVendorOnboarding {
  kind: "business";
  display_name: string;
  business_name: string;
  representative_name: string;
  tax_id: string;
  phone_e164: string;
  address: string;
  qualification_attested: true;
  seal_mime_type: SealImageMimeType;
  service_job_types: string[];
}

export interface ValidatedIndividualVendorOnboarding {
  kind: "individual";
  display_name: string;
  business_name: null;
  representative_name: null;
  tax_id: null;
  phone_e164: string;
  address: string | null;
  qualification_attested: boolean;
  seal_mime_type: SealImageMimeType | null;
  service_job_types: string[];
}

export type ValidatedVendorOnboarding =
  | ValidatedBusinessVendorOnboarding
  | ValidatedIndividualVendorOnboarding;

const TAX_ID_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1] as const;
const DEFAULT_MAX_SEAL_BYTES = 5 * 1024 * 1024;
const NATIONAL_ID_KEY_PATTERN =
  /(?:national_?id|id_?number|id_?no|tw_?id|身分證|身份證)/i;

export function validateTaiwanTaxId(taxId: string): boolean {
  if (!/^\d{8}$/.test(taxId)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const digit = Number(taxId[i]);
    const product = digit * TAX_ID_WEIGHTS[i]!;
    sum += Math.floor(product / 10) + (product % 10);
  }

  const isDivisible = (value: number): boolean =>
    value % 5 === 0 || value % 10 === 0;

  if (isDivisible(sum)) {
    return true;
  }

  if (taxId[6] === "7" && isDivisible(sum + 1)) {
    return true;
  }

  return false;
}

export function normalizeTaiwanPhoneE164(raw: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const withoutExt = raw
    .trim()
    .replace(/\s*(?:#|ext\.?|分機)\s*\d+\s*$/i, "")
    .trim();

  if (!withoutExt) {
    return null;
  }

  const compact = withoutExt.replace(/[\s()-]/g, "");
  let nationalDigits: string;

  if (compact.startsWith("+886")) {
    nationalDigits = compact.slice(4);
    if (nationalDigits.startsWith("0")) {
      nationalDigits = nationalDigits.slice(1);
    }
  } else if (compact.startsWith("0")) {
    nationalDigits = compact.slice(1);
  } else {
    return null;
  }

  if (!/^[2-9]\d{7,8}$/.test(nationalDigits)) {
    return null;
  }

  return `+886${nationalDigits}`;
}

export function validateSealImageHeader(
  bytes: Uint8Array,
  maxBytes: number = DEFAULT_MAX_SEAL_BYTES,
):
  | { ok: true; mimeType: SealImageMimeType }
  | {
      ok: false;
      error: "seal_file_too_large" | "invalid_seal_format";
    } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { ok: false, error: "invalid_seal_format" };
  }

  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: "seal_file_too_large" };
  }

  const isPng =
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;

  if (isPng) {
    return { ok: true, mimeType: "image/png" };
  }

  const isJpeg =
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;

  if (isJpeg) {
    return { ok: true, mimeType: "image/jpeg" };
  }

  return { ok: false, error: "invalid_seal_format" };
}

export function assertNoNationalIdKeys(
  input: Record<string, unknown>,
):
  | { ok: true }
  | { ok: false; error: "national_id_forbidden"; forbiddenKey: string } {
  for (const key of Object.keys(input)) {
    if (NATIONAL_ID_KEY_PATTERN.test(key)) {
      return {
        ok: false,
        error: "national_id_forbidden",
        forbiddenKey: key,
      };
    }
  }
  return { ok: true };
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeServiceJobTypes(value: unknown): string[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return null;
    }
    normalized.push(item.trim());
  }
  return normalized;
}

export function validateVendorOnboardingInput(
  input: Record<string, unknown>,
  options?: { maxSealBytes?: number },
):
  | { ok: true; value: ValidatedVendorOnboarding }
  | { ok: false; error: string; forbiddenKey?: string } {
  const nationalIdCheck = assertNoNationalIdKeys(input);
  if (!nationalIdCheck.ok) {
    return nationalIdCheck;
  }

  const kind = input.kind;
  if (kind !== "business" && kind !== "individual") {
    return { ok: false, error: "invalid_vendor_kind" };
  }

  const phoneRaw =
    typeof input.phone === "string"
      ? input.phone
      : typeof input.phone_e164 === "string"
        ? input.phone_e164
        : "";
  const phoneE164 = normalizeTaiwanPhoneE164(phoneRaw);
  if (!phoneE164) {
    return { ok: false, error: "invalid_phone" };
  }

  const serviceJobTypes = normalizeServiceJobTypes(input.service_job_types);
  if (serviceJobTypes === null) {
    return { ok: false, error: "invalid_service_job_types" };
  }

  if (kind === "business") {
    const businessName = normalizeNonEmptyString(input.business_name);
    if (!businessName) {
      return { ok: false, error: "missing_business_name" };
    }

    const displayName =
      normalizeNonEmptyString(input.display_name) ?? businessName;

    const taxId = normalizeNonEmptyString(input.tax_id);
    if (!taxId || !validateTaiwanTaxId(taxId)) {
      return { ok: false, error: "invalid_tax_id" };
    }

    const representativeName = normalizeNonEmptyString(
      input.representative_name,
    );
    if (!representativeName) {
      return { ok: false, error: "missing_representative_name" };
    }

    const address = normalizeNonEmptyString(input.address);
    if (!address) {
      return { ok: false, error: "missing_address" };
    }

    if (input.qualification_attested !== true) {
      return { ok: false, error: "qualification_not_attested" };
    }

    if (!(input.seal_bytes instanceof Uint8Array)) {
      return { ok: false, error: "missing_seal_image" };
    }

    const sealCheck = validateSealImageHeader(
      input.seal_bytes,
      options?.maxSealBytes ?? DEFAULT_MAX_SEAL_BYTES,
    );
    if (!sealCheck.ok) {
      return sealCheck;
    }

    return {
      ok: true,
      value: {
        kind: "business",
        display_name: displayName,
        business_name: businessName,
        representative_name: representativeName,
        tax_id: taxId,
        phone_e164: phoneE164,
        address,
        qualification_attested: true,
        seal_mime_type: sealCheck.mimeType,
        service_job_types: serviceJobTypes,
      },
    };
  }

  const displayName = normalizeNonEmptyString(input.display_name);
  if (!displayName) {
    return { ok: false, error: "missing_display_name" };
  }

  if (input.tax_id !== undefined && input.tax_id !== null && input.tax_id !== "") {
    return { ok: false, error: "individual_cannot_have_tax_id" };
  }

  const address = normalizeNonEmptyString(input.address);

  return {
    ok: true,
    value: {
      kind: "individual",
      display_name: displayName,
      business_name: null,
      representative_name: null,
      tax_id: null,
      phone_e164: phoneE164,
      address,
      qualification_attested: Boolean(input.qualification_attested),
      seal_mime_type: null,
      service_job_types: serviceJobTypes,
    },
  };
}
