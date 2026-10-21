import type { Locale } from "@/i18n";
import { FlowError } from "./errors";
import { DEPOSIT_CAP_MONTHS, depositExceedsCap, depositReasonOk, normalizePhone } from "./lease-rules";
import { taipeiToday, toMinor } from "./money";

/**
 * Column header map for the property / unit / tenant / lease spreadsheet.
 * Legacy headers are aliases, not UI copy. They stay as escapes so product
 * source does not carry those words as labels.
 */
export const LEGACY_OWNER_ALIASES = [
  "\u623f\u6771\u59d3\u540d",
  "\u623f\u6771",
  "\u623f\u6771email",
  "\u623f\u6771 email",
  "\u623f\u6771\u4fe1\u7bb1",
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
  "tenantId",
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

/** Rows per dry-run or commit request. Sized for the Workers free-plan CPU budget. */
export const IMPORT_REQUEST_ROWS = 50;
export const IMPORT_COMMIT_BATCH = IMPORT_REQUEST_ROWS;
/** Whole file, across every batched request. */
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
  tenantId: "租客身分證字號",
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
  tenantId: "Tenant ID",
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
  tenantId: ["身分證", "身分證字號", "租客身分證", "id", "id number", "national id"],
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

export function coerceImportRows(input: unknown): ImportRequestRow[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, IMPORT_MAX_ROWS + 1).map((item, index) => {
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
  tenantId: string | null;
  tenantIdHash: string | null;
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
      if (!kind) issues.push({ line: raw.line, severity: "error", key: "im_e_type", vars: { v: shown(raw.rentalMode) } });
    const roomLabel = boundedText(raw.line, ZH_HEADERS.roomLabel, raw.roomLabel, issues);
    if (kind === "room" && !roomLabel) issues.push(req(raw.line, ZH_HEADERS.roomLabel));
    if (kind === "whole_unit" && roomLabel) issues.push({ line: raw.line, severity: "error", key: "im_e_whole_room" });
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
    const tenantPhone = blank(boundedText(raw.line, ZH_HEADERS.tenantPhone, raw.tenantPhone, issues));
    const tenantId = blank(boundedText(raw.line, ZH_HEADERS.tenantId, raw.tenantId, issues));
    const startDate = dateField(raw.line, raw.startDate, issues);
    const endDate = dateField(raw.line, raw.endDate, issues);
    const electricity = electricityField(raw.line, raw.electricity, issues);
    const lease = Boolean(tenantName || tenantPhone || tenantEmail || tenantId || raw.startDate.trim() || raw.endDate.trim() || raw.deposit.trim());
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
        if (!phoneE164) issues.push({ line: raw.line, severity: "error", key: "im_e_phone" });
      }
      if (!startDate && !raw.startDate.trim()) issues.push(req(raw.line, ZH_HEADERS.startDate));
      if (!endDate && !raw.endDate.trim()) issues.push(req(raw.line, ZH_HEADERS.endDate));
      if (startDate && endDate && endDate < startDate) issues.push({ line: raw.line, severity: "error", key: "im_e_order" });
      if (endDate && endDate < today) issues.push({ line: raw.line, severity: "error", key: "im_e_ended" });
      dueDay = dueField(raw.line, raw.dueDay, issues);
      depositMonths = rentMinor > 0 ? Math.round((depositMinor / rentMinor) * 100) / 100 : depositMinor > 0 ? 99 : 0;
      if (depositMonths > DEPOSIT_MONTHS_MAX) {
        issues.push({ line: raw.line, severity: "error", key: "im_e_bound", vars: { f: ZH_HEADERS.deposit } });
      }
      const reason = raw.depositReason.trim();
      if (!depositReasonOk(depositMonths, reason)) {
        issues.push({ line: raw.line, severity: "error", key: "im_e_dep", vars: { v: depositMonths, cap: DEPOSIT_CAP_MONTHS } });
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
      if (first) issues.push({ line: raw.line, severity: "error", key: "im_e_dup", vars: { n: first } });
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
      tenantId,
      tenantIdHash: null,
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

export type ExistingIndex = {
  properties: Map<string, { id: string; addressKey: string }>;
  units: Map<string, { id: string; propertyId: string; mode: SpaceKind }>;
  rooms: Map<string, { id: string; unitId: string }>;
  ownersByEmail: Map<string, string>;
  ownersByName: Map<string, string>;
  tenantsByPhone: Map<string, string[]>;
  tenantsByHash: Map<string, string[]>;
  leases: IndexedLease[];
};

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
  return base;
}

function roomSpaceKey(row: ParsedImportRow, unitId: string | null) {
  if (row.kind === "room") return `room:${unitId ?? `new:${row.addressKey}:${row.unitLabel}`}:${row.roomLabel}`;
  return `unit:${unitId ?? `new:${row.addressKey}:${row.unitLabel}`}`;
}

function matchTenant(row: ParsedImportRow, index: ExistingIndex, issues: ImportIssue[]): string | null | "blocked" {
  const phones = row.phoneE164 ? (index.tenantsByPhone.get(row.phoneE164) ?? []) : [];
  if (row.tenantIdHash) {
    const hashes = index.tenantsByHash.get(row.tenantIdHash) ?? [];
    if (hashes.length > 1) {
      issues.push({ line: row.line, severity: "error", key: "im_e_id_dup" });
      return "blocked";
    }
    if (hashes.length === 1) {
      if (phones.some((id) => id !== hashes[0])) {
        issues.push({ line: row.line, severity: "error", key: "im_e_tenant" });
        return "blocked";
      }
      return hashes[0];
    }
    if (phones.length > 0) {
      issues.push({ line: row.line, severity: "error", key: "im_e_tenant" });
      return "blocked";
    }
    return null;
  }
  if (phones.length > 1) {
    issues.push({ line: row.line, severity: "error", key: "im_e_phone_dup" });
    return "blocked";
  }
  return phones[0] ?? null;
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
    const id = plan.tenantId ?? `new-tenant:${row.phoneE164 ?? row.tenantIdHash ?? row.line}`;
    plan.tenantId = id;
    addTenantKey(index.tenantsByPhone, row.phoneE164, id);
    addTenantKey(index.tenantsByHash, row.tenantIdHash, id);
  }
  if (plan.createLease && row.startDate && row.endDate && plan.tenantId) {
    index.leases.push({
      spaceKey: roomSpaceKey(row, plan.unitId),
      start: row.startDate,
      end: row.endDate,
      phone: row.phoneE164,
      idHash: row.tenantIdHash,
      tenantId: plan.tenantId,
      rentMinor: row.rentMinor,
      depositMinor: row.depositMinor,
      dueDay: row.dueDay ?? -1,
    });
  }
}

export function addTenantKey(map: Map<string, string[]>, key: string | null, id: string) {
  if (!key) return;
  const list = map.get(key);
  if (!list) {
    map.set(key, [id]);
    return;
  }
  if (!list.includes(id)) list.push(id);
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
  for (const plan of plans) {
    for (const issue of plan.issues) {
      if (issue.severity === "error") errors.push(issue);
      else warnings.push(issue);
    }
    if (plan.blocked) continue;
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
    openingMinor += plan.row.openingMinor;
  }
  return { dryRun, fileName, created, reused, openingMinor, errors, warnings };
}

function req(line: number, field: string): ImportIssue {
  return { line, severity: "error", key: "im_e_req", vars: { f: field } };
}

function blank(value: string) {
  const text = value.trim();
  return text ? text : null;
}

function numberField(line: number, field: string, raw: string, issues: ImportIssue[], optional: boolean, max: number) {
  const text = raw.trim().replace(/,/g, "");
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
    issues.push({ line, severity: "error", key: "im_e_num", vars: { f: field } });
    return null;
  }
  if (value > max) {
    issues.push({ line, severity: "error", key: "im_e_bound", vars: { f: field } });
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

function dateField(line: number, raw: string, issues: ImportIssue[]) {
  const text = raw.trim();
  if (text.length > IMPORT_FIELD_MAX) {
    issues.push({ line, severity: "error", key: "im_e_len", vars: { f: "date", max: IMPORT_FIELD_MAX } });
    return null;
  }
  if (!text) return null;
  if (/^\d+(\.0+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
      return new Date(utc).toISOString().slice(0, 10);
    }
  }
  const match = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(text);
  if (!match) {
    issues.push({ line, severity: "error", key: "im_e_date", vars: { v: shown(text) } });
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const iso = `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) {
    issues.push({ line, severity: "error", key: "im_e_date", vars: { v: shown(text) } });
    return null;
  }
  return iso;
}

function dueField(line: number, raw: string, issues: ImportIssue[]) {
  const text = raw.trim();
  if (!text) {
    issues.push({ line, severity: "error", key: "im_e_due" });
    return null;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 28) {
    issues.push({ line, severity: "error", key: "im_e_due" });
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
  issues.push({ line, severity: "error", key: "im_e_elec", vars: { v: shown(raw) } });
  return null;
}
