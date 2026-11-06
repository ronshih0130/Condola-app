import { createHash } from "node:crypto";

export type BankLine = { date: string; amountMinor: bigint; last5: string | null; memo: string };

export function bankRowKeys(accountId: string, rows: BankLine[]): string[] {
  const counts = new Map<string, number>();
  return rows.map(({date,amountMinor,last5,memo}) => {
    const normMemo = memo.normalize("NFKC").toLowerCase().trim().replace(/\s+/g," ");
    const tuple = ["b009-row-v1",accountId,date,amountMinor.toString(),last5 ?? "",normMemo];
    const identity = JSON.stringify(tuple);
    const ordinal = counts.get(identity) ?? 0;
    counts.set(identity,ordinal+1);
    return createHash("sha256").update(JSON.stringify([...tuple,ordinal])).digest("hex");
  });
}

export function bankDecisionDigest(input: {decision:string;bankId:string;paymentId?:string;suggestionId?:string;reason:string}): string {
  return createHash("sha256").update(JSON.stringify(["b009-decision-v1",input.decision,input.bankId,input.paymentId ?? "",input.suggestionId ?? "",input.reason])).digest("hex");
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Closed set stored on a bank-match decision. Not free text. */
export const BANK_MATCH_REASON_CODES = [
  "confirmed_amount",
  "wrong_payment",
  "duplicate",
  "other",
] as const;

export type BankMatchReasonCode = (typeof BANK_MATCH_REASON_CODES)[number];

const bankMatchReasonCodes: readonly string[] = BANK_MATCH_REASON_CODES;

export function bankMatchReasonCode(input: unknown): BankMatchReasonCode | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return bankMatchReasonCodes.includes(value) ? value as BankMatchReasonCode : null;
}

/** Supported explicit comma-separated UTF-8/Big5 mapping; malformed rows fail closed. */
export function parseBankCsv(text: string, dateFormat: "iso" | "roc" = "iso"): BankLine[] {
  if (text.length > 1_000_000) throw new Error("Invalid bank CSV");
  const records: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let closed = false;
  const source = text.replace(/^\uFEFF/, "");
  const endRow = () => { row.push(cell); if (row.some((v) => v.trim())) records.push(row); row = []; cell = ""; closed = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new Error("Invalid bank CSV");
      quoted = true;
    } else if (c === ",") { row.push(cell); cell = ""; closed = false; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && source[i+1] === "\n") i++; endRow(); }
    else { if (closed) throw new Error("Invalid bank CSV"); cell += c; }
  }
  if (quoted) throw new Error("Invalid bank CSV");
  if (cell || row.length || closed) endRow();
  if (records.length < 2 || records.length > 10001) throw new Error("Invalid bank CSV");
  const aliases: Record<string,string> = { date:"date", "交易日期":"date", amount:"amount", "存入金額":"amount", last5:"last5", "帳號末五碼":"last5", memo:"memo", "備註":"memo" };
  const header = records[0].map((v) => aliases[v.trim()] ?? v.trim());
  if (new Set(header).size !== header.length || !header.includes("date") || !header.includes("amount")) throw new Error("Invalid bank CSV");
  return records.slice(1).map((r) => {
    if (r.length !== header.length) throw new Error("Invalid bank CSV");
    const get = (key: string) => (r[header.indexOf(key)] ?? "").trim();
    const rawDate = get("date");
    const roc = dateFormat === "roc" ? /^(\d{1,3})\/(\d{2})\/(\d{2})$/.exec(rawDate) : null;
    const date = dateFormat === "roc" && roc && Number(roc[1]) > 0 ? `${String(Number(roc[1])+1911).padStart(4,"0")}-${roc[2]}-${roc[3]}` : dateFormat === "iso" ? rawDate : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000") || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw new Error("Invalid bank CSV");
    const amount = get("amount");
    if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)) throw new Error("Invalid bank CSV");
    const negative = amount.startsWith("-"); const [whole,fraction=""] = (negative ? amount.slice(1) : amount).replaceAll(",","").split(".");
    const minor = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2,"0"));
    if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid bank CSV");
    const last5 = get("last5"); if (last5 && !/^\d{5}$/.test(last5)) throw new Error("Invalid bank CSV");
    const memo = get("memo"); if (memo.length > 500) throw new Error("Invalid bank CSV");
    return {date,amountMinor:negative ? -minor : minor,last5:last5 || null,memo};
  });
}
