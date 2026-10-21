import { SANDBOX_SAMPLE_CSV } from "../data/sandbox-sample";
import type { OrgEnvironment } from "./org-scope";

export const SAMPLE_LABEL = "範例資料";
export const FREE_ACTIVE_UNITS = 4;

export const COPY_KINDS = [
  "settings",
  "properties",
  "rooms",
  "owners",
  "fee_templates",
  "bank_accounts",
  "invites",
] as const;

export const NEVER_KINDS = ["tenants", "leases", "bills", "payments", "ledger", "statements"] as const;

export type SampleCounts = {
  properties: number;
  spaces: number;
  owners: number;
  tenants: number;
  leases: number;
  bills: number;
};

export type SampleRow = {
  property: string;
  address: string;
  ownerName: string;
  ownerEmail: string;
  rentalMode: string;
  floor: string;
  room: string;
  roomType: string;
  area: string;
  rent: string;
  tenantName: string;
  tenantPhone: string;
  tenantEmail: string;
  start: string;
  end: string;
  deposit: string;
  dueDay: string;
  utility: string;
  note: string;
  billAmount: string;
};

export type PlanSnapshot = {
  tier: string;
  trialUntil: string | null;
};

const HEADERS = [
  "物件名稱",
  "地址",
  "屋主姓名",
  "屋主 Email",
  "出租型態",
  "戶別／樓層",
  "房號",
  "房型",
  "坪數",
  "月租",
  "租客姓名",
  "租客電話",
  "租客 Email",
  "起租日",
  "到期日",
  "押金",
  "繳租日",
  "電費方式",
  "每度電價",
  "台電帳單度數",
  "台電帳單金額",
  "期初欠款",
  "押金超過上限原因",
  "電價超過上限原因",
  "備註",
] as const;

let cachedRows: SampleRow[] | null = null;

export function withSampleName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(SAMPLE_LABEL) || trimmed.includes("[Sample data]")) return trimmed;
  return `${trimmed}〔${SAMPLE_LABEL}〕`;
}

export function isSampleName(name: string) {
  return name.includes(SAMPLE_LABEL) || name.includes("[Sample data]");
}

export function toE164(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const body = digits.startsWith("886") ? digits : digits.startsWith("0") ? `886${digits.slice(1)}` : digits;
  const phone = `+${body}`;
  return /^\+[1-9][0-9]{6,14}$/.test(phone) ? phone : null;
}

/** One masked sample id per tenant. Not a real national id. */
export function sampleIdMask(index: number) {
  return `A00****${String(index).padStart(3, "0")}`;
}

function parseLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function parseSampleCsv(text: string): SampleRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  const header = parseLine(lines[0] ?? "");
  const index = new Map(HEADERS.map((name) => [name, header.indexOf(name)]));
  if ([...index.values()].some((value) => value < 0)) {
    throw new Error("sandbox sample csv is missing a column");
  }
  const cell = (cells: string[], name: (typeof HEADERS)[number]) => cells[index.get(name) ?? -1] ?? "";
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    return {
      property: cell(cells, "物件名稱"),
      address: cell(cells, "地址"),
      ownerName: cell(cells, "屋主姓名"),
      ownerEmail: cell(cells, "屋主 Email"),
      rentalMode: cell(cells, "出租型態"),
      floor: cell(cells, "戶別／樓層"),
      room: cell(cells, "房號"),
      roomType: cell(cells, "房型"),
      area: cell(cells, "坪數"),
      rent: cell(cells, "月租"),
      tenantName: cell(cells, "租客姓名"),
      tenantPhone: cell(cells, "租客電話"),
      tenantEmail: cell(cells, "租客 Email"),
      start: cell(cells, "起租日"),
      end: cell(cells, "到期日"),
      deposit: cell(cells, "押金"),
      dueDay: cell(cells, "繳租日"),
      utility: cell(cells, "電費方式"),
      note: cell(cells, "備註"),
      billAmount: cell(cells, "台電帳單金額"),
    };
  });
}

export function loadSampleRows() {
  if (cachedRows) return cachedRows;
  cachedRows = parseSampleCsv(SANDBOX_SAMPLE_CSV);
  return cachedRows;
}

/** Lengths of the parsed dataset. Callers must not substitute the brief's numbers. */
export function sampleCounts(rows: SampleRow[]): SampleCounts {
  return {
    properties: new Set(rows.map((row) => row.property).filter(Boolean)).size,
    spaces: rows.length,
    owners: new Set(rows.map((row) => row.ownerEmail.toLowerCase()).filter(Boolean)).size,
    tenants: rows.filter((row) => row.tenantName).length,
    leases: rows.filter((row) => row.tenantName && row.start).length,
    bills: rows.filter((row) => row.billAmount.trim()).length,
  };
}

export function planSnapshot(planTier: string | null | undefined, settings: unknown): PlanSnapshot {
  const record = settings && typeof settings === "object" ? (settings as { plan?: { tier?: string; trialUntil?: string | null } }) : {};
  return {
    tier: record.plan?.tier || planTier || "free",
    trialUntil: record.plan?.trialUntil ?? null,
  };
}

export function hasPlanOrTrial(plan: PlanSnapshot, now: Date) {
  if (plan.tier === "pro" || plan.tier === "business" || plan.tier === "standard") return true;
  if (plan.trialUntil && Date.parse(plan.trialUntil) > now.getTime()) return true;
  return false;
}

/** Sandbox never hits the free-space cap. Live does once it is past 4 without a plan or trial. */
export function overFree(input: { environment: OrgEnvironment; activeUnits: number; plan: PlanSnapshot; now: Date }) {
  if (input.environment === "sandbox") return false;
  if (hasPlanOrTrial(input.plan, input.now)) return false;
  return input.activeUnits > FREE_ACTIVE_UNITS;
}

export function goLiveAllowed(input: { activeUnits: number; plan: PlanSnapshot; now: Date }) {
  return !overFree({ environment: "live", ...input });
}
