import type { Locale } from "@/i18n";
import { FlowError } from "./errors";
import { DEPOSIT_CAP_MONTHS, depositExceedsCap, depositReasonOk, normalizePhone } from "./lease-rules";
import { taipeiToday, toMinor } from "./money";

/**
 * Column header map for the property / unit / tenant / lease spreadsheet.
 * Legacy headers are aliases, not UI copy. They are built from code points
 * so product source does not carry those words as labels.
 */
function legacyAlias(codes: readonly number[], suffix = "") {
  return String.fromCharCode(...codes) + suffix;
}

const LEGACY_NAME = [0x623f, 0x6771] as const;

export const LEGACY_OWNER_ALIASES = [
  legacyAlias([...LEGACY_NAME, 0x59d3, 0x540d]),
  legacyAlias(LEGACY_NAME),
  legacyAlias(LEGACY_NAME, "email"),
  legacyAlias(LEGACY_NAME, " email"),
  legacyAlias([...LEGACY_NAME, 0x4fe1, 0x7bb1]),
] as const;

export const IMPORT_FIELDS = [
  "propertyName",
  "address",
  "ownerName",
  "ownerEmail",
  "rentalMode",
  "unitLabel",
  "roomLabel",
  "roomType",
  "area",
  "rent",
  "tenantName",
  "tenantPhone",
  "tenantEmail",
  "startDate",
  "endDate",
  "deposit",
  "dueDay",
  "electricity",
  "rate",
  "billKwh",
  "billAmount",
  "opening",
  "depositReason",
  "rateReason",
  "notes",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Dry-run rows per request. Commit sends the whole file in one transaction. */
export const IMPORT_DRY_BATCH = 25;
/** Rows compared with stored tenants and leases per preview request. */
export const IMPORT_PREVIEW_BATCH = 100;
/** Whole file, counted on parsed data rows (csv and xlsx alike). */
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_FIELD_MAX = 500;
export const IMPORT_MONEY_MAX = 100_000_000;
export const IMPORT_AREA_MAX = 100_000;
export const IMPORT_RATE_MAX = 10_000;
export const IMPORT_KWH_MAX = 1_000_000;
const DEPOSIT_MONTHS_MAX = 99.99;

export const REQUIRED_FIELDS: ImportField[] = ["propertyName", "address", "ownerName", "rentalMode", "unitLabel", "rent"];

const ZH_HEADERS: Record<ImportField, string> = {
  propertyName: "物件名稱",
  address: "地址",
  ownerName: "屋主姓名",
  ownerEmail: "屋主 Email",
  rentalMode: "出租型態",
  unitLabel: "戶別／樓層",
  roomLabel: "房號",
  roomType: "房型",
  area: "坪數",
  rent: "月租",
  tenantName: "租客姓名",
  tenantPhone: "租客電話",
  tenantEmail: "租客 Email",
  startDate: "起租日",
  endDate: "到期日",
  deposit: "押金",
  dueDay: "繳租日",
  electricity: "電費方式",
  rate: "每度電價",
  billKwh: "台電帳單度數",
  billAmount: "台電帳單金額",
  opening: "期初欠款",
  depositReason: "押金超過上限原因",
  rateReason: "電價超過上限原因",
  notes: "備註",
};

const EN_HEADERS: Record<ImportField, string> = {
  propertyName: "Property name",
  address: "Address",
  ownerName: "Owner name",
  ownerEmail: "Owner email",
  rentalMode: "Rental type",
  unitLabel: "Unit",
  roomLabel: "Room",
  roomType: "Room type",
  area: "Area",
  rent: "Rent",
  tenantName: "Tenant name",
  tenantPhone: "Tenant phone",
  tenantEmail: "Tenant email",
  startDate: "Start date",
  endDate: "End date",
  deposit: "Deposit",
  dueDay: "Due day",
  electricity: "Electricity",
  rate: "Rate",
  billKwh: "Bill kWh",
  billAmount: "Bill amount",
  opening: "Opening balance",
  depositReason: "Deposit reason",
  rateReason: "Rate reason",
  notes: "Notes",
};

const EXTRA_ALIASES: Partial<Record<ImportField, string[]>> = {
  propertyName: ["property", "building"],
  address: ["address"],
  ownerName: ["屋主", "owner", "owner name", LEGACY_OWNER_ALIASES[0], LEGACY_OWNER_ALIASES[1]],
  ownerEmail: [
    "屋主email",
    "屋主信箱",
    "owner email",
    "owner email address",
    LEGACY_OWNER_ALIASES[2],
    LEGACY_OWNER_ALIASES[3],
    LEGACY_OWNER_ALIASES[4],
  ],
  rentalMode: ["rental", "type"],
  unitLabel: ["戶別", "樓層", "unit number", "unit no"],
  roomLabel: ["房號", "room no", "room number"],
  roomType: ["type of room"],
  area: ["坪", "ping"],
  rent: ["月租金", "租金", "monthly rent"],
  tenantName: ["租客", "tenant"],
  tenantPhone: ["電話", "手機", "phone"],
  tenantEmail: ["tenant mail"],
  startDate: ["起租", "lease start"],
  endDate: ["到期", "lease end"],
  deposit: ["押金金額", "deposit amount"],
  dueDay: ["繳款日", "rent due day"],
  electricity: ["電費", "utility"],
  rate: ["電價", "per kwh"],
  billKwh: ["度數", "kwh"],
  billAmount: ["電費金額", "taipower"],
  opening: ["欠款", "opening arrears"],
  depositReason: ["押金原因", "deposit cap reason"],
  rateReason: ["電價原因", "rate cap reason"],
  notes: ["note", "備註說明"],
};

export type ColumnMapping = Record<ImportField, number | null>;

export function fieldLabel(field: ImportField, locale: Locale) {
  return locale === "zh-TW" ? ZH_HEADERS[field] : EN_HEADERS[field];
}

export function templateHeaders(locale: Locale) {
  return IMPORT_FIELDS.map((field) => fieldLabel(field, locale));
}

export function emptyMapping(): ColumnMapping {
  return Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])) as ColumnMapping;
}

export function normHeader(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_]+/g, "").replace(/／/g, "/");
}

export function matchColumns(headers: string[]): ColumnMapping {
  const mapping = emptyMapping();
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const aliases = new Set([ZH_HEADERS[field], EN_HEADERS[field], ...(EXTRA_ALIASES[field] ?? [])].map(normHeader));
    const at = headers.findIndex((header, index) => !used.has(index) && aliases.has(normHeader(header)));
    if (at >= 0) {
      mapping[field] = at;
      used.add(at);
    }
  }
  return mapping;
}

/** Headers that carry a national ID. They are never mapped and never stored. */
export function ignoredNationalIdHeaders(headers: string[]): string[] {
  const mapped = new Set(Object.values(matchColumns(headers)).filter((index): index is number => index !== null));
  const seen = new Set<string>();
  const found: string[] = [];
  headers.forEach((header, index) => {
    if (mapped.has(index)) return;
    const label = header.trim();
    const key = normHeader(label);
    if (!key || seen.has(key) || !isNationalIdHeader(key)) return;
    seen.add(key);
    found.push(label);
  });
  return found;
}

function isNationalIdHeader(key: string) {
  return key.includes("身分證") || key.includes("nationalid") || key.includes("idnumber") || key === "tenantid";
}

export function missingRequired(mapping: ColumnMapping) {
  return REQUIRED_FIELDS.filter((field) => mapping[field] === null);
}

export type ImportRequestRow = { line: number } & Record<ImportField, string>;

export function tableToRows(table: string[][], mapping: ColumnMapping): ImportRequestRow[] {
  return table.slice(1).map((cells, index) => {
    const row = { line: index + 2 } as ImportRequestRow;
    for (const field of IMPORT_FIELDS) {
      const at = mapping[field];
      row[field] = at === null || at === undefined ? "" : String(cells[at] ?? "").trim();
    }
    return row;
  });
}

export function coerceImportRows(input: unknown, maxRows = IMPORT_MAX_ROWS): ImportRequestRow[] {
  if (!Array.isArray(input)) return [];
  if (input.length > IMPORT_MAX_ROWS) throw new FlowError("im_too_many", { n: input.length, max: IMPORT_MAX_ROWS });
  if (input.length > maxRows) throw new FlowError("im_too_many", { n: input.length, max: maxRows });
  return input.map((item, index) => {
    const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const row = { line: index + 2 } as ImportRequestRow;
    const line = Number(source.line);
    row.line = Number.isInteger(line) && line > 0 ? line : index + 2;
    for (const field of IMPORT_FIELDS) {
      const text = String(source[field] ?? "");
      if (text.length > IMPORT_FIELD_MAX) throw new FlowError("im_e_len", { f: field, max: IMPORT_FIELD_MAX });
      row[field] = text;
    }
    return row;
  });
}

export type ImportIssue = {
  line: number;
  severity: "error" | "warn";
  key: string;
  vars?: Record<string, string | number>;
  /** Bad cell text. Empty string means the cell was blank. */
  value?: string;
};

export type SpaceKind = "room" | "whole_unit";
export type RoomType = "suite" | "shared_bath" | "studio" | "other";
export type ElectricityMethod = "submeter" | "tenant_direct" | "included";

export type ParsedImportRow = {
  line: number;
  propertyName: string;
  address: string;
  addressKey: string;
  ownerName: string;
  ownerEmail: string | null;
  kind: SpaceKind;
  unitLabel: string;
  roomLabel: string | null;
  roomType: RoomType;
  area: number | null;
  rentMajor: number;
  rentMinor: number;
  tenantName: string | null;
  tenantPhone: string | null;
  phoneE164: string | null;
  tenantEmail: string | null;
  startDate: string | null;
  endDate: string | null;
  depositMajor: number;
  depositMinor: number;
  depositMonths: number;
  dueDay: number | null;
  electricity: ElectricityMethod | null;
  rate: number | null;
  billKwh: number | null;
  billAmountMinor: number | null;
  openingMinor: number;
  depositReason: string | null;
  rateReason: string | null;
  notes: string | null;
  lease: boolean;
  issues: ImportIssue[];
};

export function addressKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export function unitKey(address: string, label: string) {
  return `${addressKey(address)}\n${label.normalize("NFKC").trim()}`;
}

export function validateImportRows(rows: ImportRequestRow[], today = taipeiToday()): ParsedImportRow[] {
  const parsed: ParsedImportRow[] = [];
  const seenSpace = new Map<string, number>();
  const seenName = new Map<string, string>();
  for (const raw of rows) {
    const issues: ImportIssue[] = [];
    const propertyName = boundedText(raw.line, ZH_HEADERS.propertyName, raw.propertyName, issues);
    const address = boundedText(raw.line, ZH_HEADERS.address, raw.address, issues);
    const ownerName = boundedText(raw.line, ZH_HEADERS.ownerName, raw.ownerName, issues);
    const unitLabel = boundedText(raw.line, ZH_HEADERS.unitLabel, raw.unitLabel, issues).normalize("NFKC").trim();
    if (!raw.propertyName.trim()) issues.push(req(raw.line, ZH_HEADERS.propertyName));
    if (!raw.address.trim()) issues.push(req(raw.line, ZH_HEADERS.address));
    if (!raw.ownerName.trim()) issues.push(req(raw.line, ZH_HEADERS.ownerName));
    if (!raw.unitLabel.trim()) issues.push(req(raw.line, ZH_HEADERS.unitLabel));
    const kind = rentalKind(raw.rentalMode);
    if (!kind) issues.push({ line: raw.line, severity: "error", key: "im_e_type", vars: { v: shown(raw.rentalMode), f: ZH_HEADERS.rentalMode }, value: shown(raw.rentalMode) });
    const roomLabel = boundedText(raw.line, ZH_HEADERS.roomLabel, raw.roomLabel, issues);
    if (kind === "room" && !roomLabel) issues.push(req(raw.line, ZH_HEADERS.roomLabel));
    if (kind === "whole_unit" && roomLabel) issues.push({ line: raw.line, severity: "error", key: "im_e_whole_room", vars: { f: ZH_HEADERS.roomLabel }, value: roomLabel });
    let roomType: RoomType = "suite";
    if (kind === "room") {
      const mapped = mapRoomType(raw.roomType);
      if (!raw.roomType.trim()) issues.push({ line: raw.line, severity: "warn", key: "im_w_rtype" });
      else if (!mapped) issues.push({ line: raw.line, severity: "warn", key: "im_w_rtype" });
      roomType = mapped ?? "suite";
    }
    const rent = numberField(raw.line, ZH_HEADERS.rent, raw.rent, issues, false, IMPORT_MONEY_MAX);
    const area = numberField(raw.line, ZH_HEADERS.area, raw.area, issues, true, IMPORT_AREA_MAX);
    const rate = numberField(raw.line, ZH_HEADERS.rate, raw.rate, issues, true, IMPORT_RATE_MAX);
    const billKwh = numberField(raw.line, ZH_HEADERS.billKwh, raw.billKwh, issues, true, IMPORT_KWH_MAX);
    const billAmount = numberField(raw.line, ZH_HEADERS.billAmount, raw.billAmount, issues, true, IMPORT_MONEY_MAX);
    const opening = numberField(raw.line, ZH_HEADERS.opening, raw.opening, issues, true, IMPORT_MONEY_MAX);
    const deposit = numberField(raw.line, ZH_HEADERS.deposit, raw.deposit, issues, true, IMPORT_MONEY_MAX);
    const ownerEmail = emailField(raw.line, raw.ownerEmail, issues);
    const tenantEmail = emailField(raw.line, raw.tenantEmail, issues);
    const tenantName = blank(boundedText(raw.line, ZH_HEADERS.tenantName, raw.tenantName, issues));
    const tenantPhone = blank(boundedText(raw.line, ZH_HEADERS.tenantPhone, importPhone(raw.tenantPhone), issues));
    const startDate = dateField(raw.line, ZH_HEADERS.startDate, raw.startDate, issues);
    const endDate = dateField(raw.line, ZH_HEADERS.endDate, raw.endDate, issues);
    const electricity = electricityField(raw.line, raw.electricity, issues);
    const lease = Boolean(tenantName || tenantPhone || tenantEmail || raw.startDate.trim() || raw.endDate.trim() || raw.deposit.trim());
    let dueDay: number | null = null;
    let phoneE164: string | null = null;
    let depositMonths = 0;
    const rentMinor = rent === null ? 0 : toMinor(rent);
    const depositMinor = deposit === null ? 0 : toMinor(deposit);
    if (lease) {
      if (!tenantName) issues.push(req(raw.line, ZH_HEADERS.tenantName));
      if (!tenantPhone) issues.push(req(raw.line, ZH_HEADERS.tenantPhone));
      else {
        phoneE164 = normalizePhone(tenantPhone);
        if (!phoneE164) issues.push({ line: raw.line, severity: "error", key: "im_e_phone", vars: { f: ZH_HEADERS.tenantPhone }, value: tenantPhone ?? "" });
      }
      if (!startDate && !raw.startDate.trim()) issues.push(req(raw.line, ZH_HEADERS.startDate));
      if (!endDate && !raw.endDate.trim()) issues.push(req(raw.line, ZH_HEADERS.endDate));
      if (startDate && endDate && endDate < startDate) issues.push({ line: raw.line, severity: "error", key: "im_e_order", vars: { f: ZH_HEADERS.endDate }, value: endDate });
      if (endDate && endDate < today) issues.push({ line: raw.line, severity: "error", key: "im_e_ended", vars: { f: ZH_HEADERS.endDate }, value: endDate });
      dueDay = dueField(raw.line, raw.dueDay, issues);
      depositMonths = rentMinor > 0 ? Math.round((depositMinor / rentMinor) * 100) / 100 : depositMinor > 0 ? 99 : 0;
      if (depositMonths > DEPOSIT_MONTHS_MAX) {
        issues.push({ line: raw.line, severity: "error", key: "im_e_bound", vars: { f: ZH_HEADERS.deposit } });
      }
      const reason = raw.depositReason.trim();
      if (!depositReasonOk(depositMonths, reason)) {
        issues.push({ line: raw.line, severity: "error", key: "im_e_dep", vars: { v: depositMonths, cap: DEPOSIT_CAP_MONTHS, f: ZH_HEADERS.deposit }, value: shown(raw.deposit) });
      } else if (depositExceedsCap(depositMonths)) {
        issues.push({ line: raw.line, severity: "warn", key: "im_w_dep", vars: { v: depositMonths, cap: DEPOSIT_CAP_MONTHS } });
      }
    }
    if (rate !== null && billKwh !== null && billAmount !== null && billKwh > 0) {
      const average = Math.round((billAmount / billKwh) * 100) / 100;
      if (rate > average + 1e-9) {
        const reason = raw.rateReason.trim();
        if (!reason) issues.push({ line: raw.line, severity: "error", key: "im_e_cap", vars: { rate, a: average } });
        else issues.push({ line: raw.line, severity: "warn", key: "im_w_cap", vars: { rate, a: average } });
      }
    } else if (rate !== null) {
      issues.push({ line: raw.line, severity: "warn", key: "im_w_nobill" });
    }
    let openingMinor = opening === null ? 0 : toMinor(opening);
    if (!lease && openingMinor > 0) {
      issues.push({ line: raw.line, severity: "warn", key: "im_w_bal_vacant" });
      openingMinor = 0;
    }
    const key = propertyName && address && unitLabel ? `${unitKey(address, unitLabel)}\n${kind === "room" ? roomLabel : ""}` : "";
    if (key) {
      const first = seenSpace.get(key);
      if (first) {
        const dupValue = [unitLabel, kind === "room" ? roomLabel : ""].filter(Boolean).join(" ");
        issues.push({ line: raw.line, severity: "error", key: "im_e_dup", vars: { n: first, f: ZH_HEADERS.unitLabel }, value: dupValue });
      }
      else seenSpace.set(key, raw.line);
    }
    if (propertyName && address) {
      const previous = seenName.get(propertyName);
      const current = addressKey(address);
      if (previous && previous !== current) issues.push({ line: raw.line, severity: "error", key: "im_e_exists", vars: { v: propertyName } });
      else if (!previous) seenName.set(propertyName, current);
    }
    parsed.push({
      line: raw.line,
      propertyName,
      address,
      addressKey: addressKey(address),
      ownerName,
      ownerEmail,
      kind: kind ?? "whole_unit",
      unitLabel,
      roomLabel: kind === "room" ? roomLabel : null,
      roomType,
      area,
      rentMajor: rent ?? 0,
      rentMinor,
      tenantName,
      tenantPhone,
      phoneE164,
      tenantEmail,
      startDate,
      endDate,
      depositMajor: deposit ?? 0,
      depositMinor,
      depositMonths,
      dueDay,
      electricity,
      rate,
      billKwh,
      billAmountMinor: billAmount === null ? null : toMinor(billAmount),
      openingMinor,
      depositReason: blank(boundedText(raw.line, ZH_HEADERS.depositReason, raw.depositReason, issues)),
      rateReason: blank(boundedText(raw.line, ZH_HEADERS.rateReason, raw.rateReason, issues)),
      notes: blank(boundedText(raw.line, ZH_HEADERS.notes, raw.notes, issues)),
      lease,
      issues,
    });
  }
  return parsed;
}

export function rowHasError(row: ParsedImportRow) {
  return row.issues.some((issue) => issue.severity === "error");
}

/** Columns on the confirm-step preview. Other errors stay on the status cell. */
export type PreviewColumn = "property" | "space" | "tenant" | "rent";

const PREVIEW_FIELD: Partial<Record<ImportField, PreviewColumn>> = {
  propertyName: "property",
  address: "property",
  rentalMode: "space",
  unitLabel: "space",
  roomLabel: "space",
  rent: "rent",
  tenantName: "tenant",
  tenantPhone: "tenant",
  tenantEmail: "tenant",
};

export function issuePreviewColumns(issue: ImportIssue): PreviewColumn[] {
  const field = String(issue.vars?.f ?? "");
  for (const key of IMPORT_FIELDS) {
    if (PREVIEW_FIELD[key] && (field === ZH_HEADERS[key] || field === EN_HEADERS[key])) return [PREVIEW_FIELD[key]];
  }
  switch (issue.key) {
    case "im_e_type":
    case "im_e_whole_room":
    case "im_e_dup":
    case "im_e_mode":
      return ["space"];
    case "im_e_phone":
    case "im_e_phone_dup":
    case "im_e_phone_name":
    case "im_e_tenant":
    case "im_e_id_dup":
      return ["tenant"];
    case "im_e_exists":
      return ["property"];
    default:
      return [];
  }
}

const ISSUE_FIELD: Partial<Record<string, ImportField>> = {
  im_e_due: "dueDay",
  im_e_dup: "unitLabel",
  im_e_ended: "endDate",
  im_e_order: "endDate",
  im_e_phone: "tenantPhone",
  im_e_phone_dup: "tenantPhone",
  im_e_phone_name: "tenantPhone",
  im_e_whole_room: "roomLabel",
  im_e_type: "rentalMode",
  im_e_elec: "electricity",
  im_e_exists: "propertyName",
  im_e_mode: "rentalMode",
  im_e_tenant: "tenantPhone",
  im_e_occupied: "unitLabel",
  im_e_terms: "rent",
  im_e_dep: "deposit",
  im_w_dep: "deposit",
  im_e_cap: "rate",
  im_w_cap: "rate",
  im_w_nobill: "rate",
  im_w_rtype: "roomType",
  im_w_bal_vacant: "opening",
  im_row_exists: "unitLabel",
  i_email: "ownerEmail",
};

const CELL_VALUE_KEYS = new Set(["im_e_date", "im_e_type", "im_e_elec", "im_e_exists"]);

export function importIssueColumn(issue: ImportIssue, locale: Locale): string {
  const named = String(issue.vars?.f ?? "").trim();
  if (named) return named;
  const field = ISSUE_FIELD[issue.key];
  return field ? fieldLabel(field, locale) : "";
}

/** Blank cells return "". Unknown cells return null so the caller can choose a placeholder. */
export function importIssueValue(issue: ImportIssue): string | null {
  if (typeof issue.value === "string") return issue.value;
  if (issue.vars && CELL_VALUE_KEYS.has(issue.key) && issue.vars.v != null) return String(issue.vars.v);
  return null;
}

export function formatImportIssueMessage(issue: ImportIssue, locale: Locale, expected: string, blank: string) {
  const raw = importIssueValue(issue);
  return {
    line: issue.line,
    column: importIssueColumn(issue, locale),
    value: raw == null || raw === "" ? blank : raw,
    expected,
  };
}

export function previewBadColumns(row: ParsedImportRow) {
  const bad = new Set<PreviewColumn>();
  for (const issue of row.issues) {
    if (issue.severity !== "error") continue;
    for (const column of issuePreviewColumns(issue)) bad.add(column);
  }
  return bad;
}

export type ExistingIndex = {
  properties: Map<string, { id: string; addressKey: string }>;
  units: Map<string, { id: string; propertyId: string; mode: SpaceKind }>;
  rooms: Map<string, { id: string; unitId: string }>;
  ownersByEmail: Map<string, string>;
  ownersByName: Map<string, string>;
  tenantsByPhone: Map<string, TenantRef[]>;
  tenantsByHash: Map<string, TenantRef[]>;
  leases: IndexedLease[];
};

export type TenantRef = { id: string; name: string };

export type IndexedLease = {
  spaceKey: string;
  start: string;
  end: string;
  phone: string | null;
  idHash: string | null;
  tenantId: string;
  rentMinor: number;
  depositMinor: number;
  dueDay: number;
};

export function emptyIndex(): ExistingIndex {
  return {
    properties: new Map(),
    units: new Map(),
    rooms: new Map(),
    ownersByEmail: new Map(),
    ownersByName: new Map(),
    tenantsByPhone: new Map(),
    tenantsByHash: new Map(),
    leases: [],
  };
}

export type RowPlan = {
  row: ParsedImportRow;
  issues: ImportIssue[];
  blocked: boolean;
  createProperty: boolean;
  createUnit: boolean;
  createRoom: boolean;
  createOwner: boolean;
  createTenant: boolean;
  createLease: boolean;
  reuseUnit: boolean;
  reuseTenant: boolean;
  reuseLease: boolean;
  vacant: boolean;
  propertyId: string | null;
  unitId: string | null;
  roomId: string | null;
  ownerId: string | null;
  tenantId: string | null;
};

export function planRows(rows: ParsedImportRow[], index: ExistingIndex): RowPlan[] {
  const plans: RowPlan[] = [];
  for (const row of rows) {
    const plan = planOne(row, index);
    if (!plan.blocked) rememberPlan(index, plan);
    plans.push(plan);
  }
  return plans;
}

export function planOne(row: ParsedImportRow, index: ExistingIndex): RowPlan {
  return planRow(row, index);
}

export function rememberPlan(index: ExistingIndex, plan: RowPlan) {
  remember(index, plan);
}

function planRow(row: ParsedImportRow, index: ExistingIndex): RowPlan {
  const issues = [...row.issues];
  const blockedByFile = rowHasError(row);
  const base: RowPlan = {
    row,
    issues,
    blocked: blockedByFile,
    createProperty: false,
    createUnit: false,
    createRoom: false,
    createOwner: false,
    createTenant: false,
    createLease: false,
    reuseUnit: false,
    reuseTenant: false,
    reuseLease: false,
    vacant: false,
    propertyId: null,
    unitId: null,
    roomId: null,
    ownerId: null,
    tenantId: null,
  };
  if (blockedByFile || !row.propertyName || !row.addressKey || !row.unitLabel) return base;
  const ukey = `${row.addressKey}\n${row.unitLabel}`;
  const existingUnit = index.units.get(ukey);
  if (existingUnit && existingUnit.mode !== row.kind) {
    issues.push({ line: row.line, severity: "error", key: "im_e_mode" });
    base.blocked = true;
    return base;
  }
  const named = index.properties.get(row.propertyName);
  if (!existingUnit && named && named.addressKey && named.addressKey !== row.addressKey) {
    issues.push({ line: row.line, severity: "error", key: "im_e_exists", vars: { v: row.propertyName } });
    base.blocked = true;
    return base;
  }
  if (existingUnit) {
    base.unitId = existingUnit.id;
    base.propertyId = existingUnit.propertyId;
    base.reuseUnit = true;
  } else if (named && (!named.addressKey || named.addressKey === row.addressKey)) {
    base.propertyId = named.id;
  } else {
    base.createProperty = true;
  }
  if (!existingUnit) base.createUnit = true;
  if (row.kind === "room" && row.roomLabel) {
    const room = existingUnit ? index.rooms.get(`${existingUnit.id}\n${row.roomLabel}`) : undefined;
    if (room) base.roomId = room.id;
    else base.createRoom = true;
  }
  if (row.ownerEmail && index.ownersByEmail.has(row.ownerEmail)) base.ownerId = index.ownersByEmail.get(row.ownerEmail) ?? null;
  else if (!row.ownerEmail && index.ownersByName.has(row.ownerName)) base.ownerId = index.ownersByName.get(row.ownerName) ?? null;
  else base.createOwner = true;
  if (row.lease) {
    const matched = matchTenant(row, index, issues);
    if (matched === "blocked") {
      base.blocked = true;
      return base;
    }
    if (matched) {
      base.tenantId = matched;
      base.reuseTenant = true;
    } else base.createTenant = true;
    const spaceKey = roomSpaceKey(row, base.unitId);
    const overlaps = index.leases.filter((lease) => lease.spaceKey === spaceKey && rangesOverlap(lease.start, lease.end, row.startDate, row.endDate));
    if (overlaps.length === 1 && sameLeaseTerms(overlaps[0], row, base.tenantId)) base.reuseLease = true;
    else if (overlaps.length > 0) {
      const samePerson = Boolean(base.tenantId) && overlaps.some((lease) => lease.tenantId === base.tenantId);
      issues.push({ line: row.line, severity: "error", key: samePerson ? "im_e_terms" : "im_e_occupied" });
      base.blocked = true;
      return base;
    } else base.createLease = true;
  } else base.vacant = true;
  if (planIsDuplicate(base)) issues.push({ line: row.line, severity: "warn", key: "im_row_exists" });
  return base;
}

function roomSpaceKey(row: ParsedImportRow, unitId: string | null) {
  if (row.kind === "room") return `room:${unitId ?? `new:${row.addressKey}:${row.unitLabel}`}:${row.roomLabel}`;
  return `unit:${unitId ?? `new:${row.addressKey}:${row.unitLabel}`}`;
}

function nameKey(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").trim().toLowerCase();
}

function matchTenant(row: ParsedImportRow, index: ExistingIndex, issues: ImportIssue[]): string | null | "blocked" {
  const phones = tenantsForPhone(index, row.phoneE164);
  if (phones.length > 1) {
    issues.push({ line: row.line, severity: "error", key: "im_e_phone_dup" });
    return "blocked";
  }
  const hit = phones[0];
  if (!hit) return null;
  if (nameKey(hit.name) !== nameKey(row.tenantName)) {
    issues.push({ line: row.line, severity: "error", key: "im_e_phone_name", vars: { n: row.line, name: hit.name } });
    return "blocked";
  }
  return hit.id;
}

function sameLeaseTerms(lease: IndexedLease, row: ParsedImportRow, tenantId: string | null) {
  if (!tenantId || lease.tenantId !== tenantId) return false;
  return (
    lease.start === row.startDate &&
    lease.end === row.endDate &&
    lease.rentMinor === row.rentMinor &&
    lease.depositMinor === row.depositMinor &&
    lease.dueDay === row.dueDay
  );
}

function rangesOverlap(start: string, end: string, otherStart: string | null, otherEnd: string | null) {
  if (!otherStart || !otherEnd) return false;
  return start <= otherEnd && end >= otherStart;
}

function remember(index: ExistingIndex, plan: RowPlan) {
  const row = plan.row;
  let propertyId = plan.propertyId;
  if (plan.createProperty) {
    propertyId = propertyId ?? `new-property:${row.propertyName}`;
    plan.propertyId = propertyId;
    index.properties.set(row.propertyName, { id: propertyId, addressKey: row.addressKey });
  } else if (propertyId && !index.properties.has(row.propertyName)) {
    index.properties.set(row.propertyName, { id: propertyId, addressKey: row.addressKey });
  }
  const ukey = `${row.addressKey}\n${row.unitLabel}`;
  let unitId = plan.unitId;
  if (plan.createUnit) {
    unitId = unitId ?? `new-unit:${ukey}`;
    plan.unitId = unitId;
    index.units.set(ukey, { id: unitId, propertyId: propertyId ?? "", mode: row.kind });
  }
  if (row.kind === "room" && row.roomLabel && plan.createRoom && unitId) {
    const id = plan.roomId ?? `new-room:${unitId}:${row.roomLabel}`;
    plan.roomId = id;
    index.rooms.set(`${unitId}\n${row.roomLabel}`, { id, unitId });
  }
  if (plan.createOwner) {
    const id = plan.ownerId ?? `new-owner:${row.ownerEmail ?? row.ownerName}`;
    plan.ownerId = id;
    if (row.ownerEmail) index.ownersByEmail.set(row.ownerEmail, id);
    index.ownersByName.set(row.ownerName, id);
  }
  if (plan.createTenant) {
    const id = plan.tenantId ?? `new-tenant:${row.phoneE164 ?? row.line}`;
    plan.tenantId = id;
    const tenant = { id, name: row.tenantName ?? "" };
    indexTenantPhone(index.tenantsByPhone, row.phoneE164, tenant);
  }
  if (plan.createLease && row.startDate && row.endDate && plan.tenantId) {
    index.leases.push({
      spaceKey: roomSpaceKey(row, plan.unitId),
      start: row.startDate,
      end: row.endDate,
      phone: row.phoneE164,
      idHash: null,
      tenantId: plan.tenantId,
      rentMinor: row.rentMinor,
      depositMinor: row.depositMinor,
      dueDay: row.dueDay ?? -1,
    });
  }
}

export function addTenantKey(map: Map<string, TenantRef[]>, key: string | null, tenant: TenantRef) {
  if (!key || !tenant.id) return;
  const list = map.get(key);
  if (!list) {
    map.set(key, [tenant]);
    return;
  }
  if (!list.some((item) => item.id === tenant.id)) list.push(tenant);
}

/**
 * One Taiwan mobile is stored as +8869xxxxxxxx or, when a leading 0 was kept, +88609xxxxxxxx.
 * Both, plus the 9-digit national number, point at the same tenant inside this org.
 */
export function phoneMatchKeys(e164: string | null | undefined): string[] {
  if (!e164) return [];
  const keys = new Set<string>([e164]);
  const digits = e164.replace(/\D/g, "");
  let national = "";
  if (digits.startsWith("8860") && digits.length === 13 && digits[4] === "9") national = digits.slice(4);
  else if (digits.startsWith("886") && digits.length === 12 && digits[3] === "9") national = digits.slice(3);
  if (national.length === 9) {
    keys.add(national);
    keys.add(`+886${national}`);
    keys.add(`+8860${national}`);
  }
  return [...keys];
}

export function indexTenantPhone(map: Map<string, TenantRef[]>, e164: string | null | undefined, tenant: TenantRef) {
  for (const key of phoneMatchKeys(e164)) addTenantKey(map, key, tenant);
}

function tenantsForPhone(index: ExistingIndex, e164: string | null): TenantRef[] {
  const seen = new Set<string>();
  const hits: TenantRef[] = [];
  for (const key of phoneMatchKeys(e164)) {
    for (const tenant of index.tenantsByPhone.get(key) ?? []) {
      if (seen.has(tenant.id)) continue;
      seen.add(tenant.id);
      hits.push(tenant);
    }
  }
  return hits;
}

export type ImportTotals = {
  properties: number;
  units: number;
  rooms: number;
  owners: number;
  tenants: number;
  leases: number;
  vacant: number;
};

export type ImportResult = {
  dryRun: boolean;
  fileName: string;
  created: ImportTotals;
  reused: { units: number; tenants: number; leases: number };
  /** Confirmed rows that already existed and were not inserted again. */
  duplicateRows: number;
  openingMinor: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
};

export function totalsFromPlans(plans: RowPlan[], fileName: string, dryRun: boolean): ImportResult {
  const created: ImportTotals = { properties: 0, units: 0, rooms: 0, owners: 0, tenants: 0, leases: 0, vacant: 0 };
  const reused = { units: 0, tenants: 0, leases: 0 };
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  let openingMinor = 0;
  let duplicateRows = 0;
  // A confirmed file is one write. One blocked row means none of the counts were saved.
  const writeNothing = !dryRun && plans.some((plan) => plan.blocked);
  for (const plan of plans) {
    for (const issue of plan.issues) {
      if (issue.severity === "error") errors.push(issue);
      else warnings.push(issue);
    }
    if (plan.blocked || writeNothing) continue;
    if (plan.createProperty) created.properties += 1;
    if (plan.createUnit) created.units += 1;
    if (plan.createRoom) created.rooms += 1;
    if (plan.createOwner) created.owners += 1;
    if (plan.createTenant) created.tenants += 1;
    if (plan.createLease) created.leases += 1;
    if (plan.reuseUnit) reused.units += 1;
    if (plan.reuseTenant) reused.tenants += 1;
    if (plan.reuseLease) reused.leases += 1;
    if (plan.vacant) created.vacant += 1;
    if (planIsDuplicate(plan)) duplicateRows += 1;
    openingMinor += plan.row.openingMinor;
  }
  return { dryRun, fileName, created, reused, duplicateRows, openingMinor, errors, warnings };
}

/** A confirmed row that matched data already stored, so this import does not insert it again. */
export function planIsDuplicate(plan: RowPlan) {
  if (plan.blocked) return false;
  if (plan.createProperty || plan.createUnit || plan.createRoom || plan.createOwner || plan.createTenant || plan.createLease) return false;
  return plan.reuseUnit || plan.reuseTenant || plan.reuseLease;
}

function req(line: number, field: string): ImportIssue {
  return { line, severity: "error", key: "im_e_req", vars: { f: field }, value: "" };
}

function blank(value: string) {
  const text = value.trim();
  return text ? text : null;
}

function numberField(line: number, field: string, raw: string, issues: ImportIssue[], optional: boolean, max: number) {
  const text = raw.normalize("NFKC").trim().replace(/[,\s\u00A0]/g, "");
  if (text.length > IMPORT_FIELD_MAX) {
    issues.push({ line, severity: "error", key: "im_e_len", vars: { f: field, max: IMPORT_FIELD_MAX } });
    return null;
  }
  if (!text) {
    if (!optional) issues.push(req(line, field));
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    issues.push({ line, severity: "error", key: "im_e_num", vars: { f: field }, value: shown(text) });
    return null;
  }
  if (value > max) {
    issues.push({ line, severity: "error", key: "im_e_bound", vars: { f: field }, value: shown(text) });
    return null;
  }
  return value;
}

function boundedText(line: number, field: string, raw: string, issues: ImportIssue[]) {
  const text = raw.trim();
  if (text.length > IMPORT_FIELD_MAX) {
    issues.push({ line, severity: "error", key: "im_e_len", vars: { f: field, max: IMPORT_FIELD_MAX } });
    return "";
  }
  return text;
}

function shown(value: string) {
  const text = value.trim();
  if (!text) return "—";
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function emailField(line: number, raw: string, issues: ImportIssue[]) {
  const text = boundedText(line, "Email", raw, issues).toLowerCase();
  if (!text) return null;
  if (!text.includes("@") || /\s/.test(text)) {
    issues.push({ line, severity: "error", key: "i_email" });
    return null;
  }
  return text;
}

function dateField(line: number, field: string, raw: string, issues: ImportIssue[]) {
  const text = raw.normalize("NFKC").trim().replace(/\s+/g, "");
  if (text.length > IMPORT_FIELD_MAX) {
    issues.push({ line, severity: "error", key: "im_e_len", vars: { f: field, max: IMPORT_FIELD_MAX }, value: shown(text) });
    return null;
  }
  if (!text) return null;
  const serial = excelSerialDate(text);
  if (serial) return serial;
  const roc = rocDate(text);
  if (roc) {
    if (roc === "invalid") issues.push({ line, severity: "error", key: "im_e_date", vars: { v: shown(text), f: field }, value: shown(text) });
    return roc === "invalid" ? null : roc;
  }
  const western = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(text);
  const iso = western ? calendarDate(Number(western[1]), Number(western[2]), Number(western[3])) : null;
  if (!iso || iso === "invalid") {
    issues.push({ line, severity: "error", key: "im_e_date", vars: { v: shown(text), f: field }, value: shown(text) });
    return null;
  }
  return iso;
}

function excelSerialDate(text: string) {
  if (!/^\d+(\.0+)?$/.test(text)) return null;
  const serial = Number(text);
  if (serial <= 20000 || serial >= 80000) return null;
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  return new Date(utc).toISOString().slice(0, 10);
}

/** Minguo 1 is 1912, so the Gregorian year is the ROC year plus 1911. 民國115年1月5日 is 2026-01-05. */
const ROC_YEAR_OFFSET = 1911;

function rocDate(text: string): string | "invalid" | null {
  const era = /^(?:民國)?(\d{1,3})年(\d{1,2})月(\d{1,2})日?$/.exec(text);
  const slash = /^(?:民國)?(\d{1,3})[./-](\d{1,2})[./-](\d{1,2})$/.exec(text);
  const match = era || slash;
  if (!match) return null;
  return calendarDate(Number(match[1]) + ROC_YEAR_OFFSET, Number(match[2]), Number(match[3]));
}

function calendarDate(year: number, month: number, day: number): string | "invalid" {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return "invalid";
  return iso;
}

/** Excel stores 09-numbers as integers and drops the leading zero. */
function importPhone(raw: string) {
  const text = raw.normalize("NFKC").trim();
  if (/e/i.test(text)) {
    const asNumber = Number(text);
    if (Number.isSafeInteger(asNumber) && /^9\d{8}$/.test(String(asNumber))) return `0${asNumber}`;
  }
  const digits = text.replace(/\D/g, "");
  if (/^9\d{8}$/.test(digits) && !text.startsWith("+")) return `0${digits}`;
  return text;
}

function dueField(line: number, raw: string, issues: ImportIssue[]) {
  const text = raw.normalize("NFKC").trim().replace(/[,\s]/g, "");
  if (!text) {
    issues.push({ line, severity: "error", key: "im_e_due", vars: { f: ZH_HEADERS.dueDay }, value: "" });
    return null;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 28) {
    issues.push({ line, severity: "error", key: "im_e_due", vars: { f: ZH_HEADERS.dueDay }, value: shown(text) });
    return null;
  }
  return value;
}

function rentalKind(raw: string): SpaceKind | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (["分租", "by_room", "room", "byroom"].includes(text)) return "room";
  if (["整層", "整戶", "whole", "whole_unit", "wholeunit"].includes(text)) return "whole_unit";
  return null;
}

function mapRoomType(raw: string): RoomType | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (text === "套房" || text === "suite") return "suite";
  if (text === "雅房" || text === "shared_bath" || text === "shared bath") return "shared_bath";
  if (text === "獨立套房" || text === "studio") return "studio";
  if (text === "其他" || text === "other") return "other";
  return null;
}

function electricityField(line: number, raw: string, issues: ImportIssue[]): ElectricityMethod | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return null;
  if (["分表", "submeter", "sub-meter"].includes(text)) return "submeter";
  if (["包含", "included", "include"].includes(text)) return "included";
  if (["租客自繳", "tenantdirect", "tenant_direct"].includes(text)) return "tenant_direct";
  issues.push({ line, severity: "error", key: "im_e_elec", vars: { v: shown(raw), f: ZH_HEADERS.electricity }, value: shown(raw) });
  return null;
}
