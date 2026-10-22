const ROOM_TYPES = new Set(["suite", "shared_bath", "studio", "other"]);

/** Wizard values and the Traditional Chinese labels for the same room types. */
const ROOM_TYPE_LABELS: Record<string, string> = {
  套房: "suite",
  雅房: "shared_bath",
  獨立套房: "studio",
  其他: "other",
};

/** Empty becomes 套房. Unknown labels return null so the wizard can point at the field. */
export function canonicalRoomType(raw: string) {
  const value = raw.trim();
  if (!value) return "suite";
  if (ROOM_TYPES.has(value)) return value;
  return ROOM_TYPE_LABELS[value] ?? null;
}

/**
 * Step 4 of 新增物件 only previews a meter split. A rate above the bill average
 * needs a reason before the last step can be submitted.
 */
export function electricityCapBlocked(bill: string, usage: string, rate: string, reason: string) {
  const billN = Number(bill);
  const usageN = Number(usage);
  const rateN = Number(rate);
  const average = usageN > 0 && bill.trim() !== "" ? billN / usageN : null;
  const over = average !== null && rate.trim() !== "" && rateN > average + 1e-9;
  return { average, over, blocked: over && reason.trim() === "" };
}
