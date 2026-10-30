import { FlowError } from "./errors";

/** Serializable, server-selected context. It never comes from uploaded rows. */
export type ImportRegion = {
  country: "TW";
  jurisdiction: "TW";
  jurisdictionId: string;
  currency: "TWD";
  timezone: string;
  today: string;
};

export type ImportRegionRecord = {
  country_code: string;
  jurisdiction_id: string | null;
  jurisdiction_code: string | null;
  jurisdiction_country: string | null;
  default_currency: string;
  timezone: string;
};

/** Only the currently offered import profile is supported. Never default another region to TW. */
export function resolveImportRegion(row: ImportRegionRecord, at = new Date()): ImportRegion {
  if (row.country_code !== "TW" || row.jurisdiction_code !== "TW" || row.jurisdiction_country !== "TW"
    || !row.jurisdiction_id || row.default_currency !== "TWD") throw new FlowError("im_region_unavailable");
  let today: string;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: row.timezone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory",
    }).formatToParts(at);
    const value = (type: string) => parts.find(part => part.type === type)?.value;
    today = `${value("year")}-${value("month")}-${value("day")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("date");
  } catch {
    throw new FlowError("im_region_unavailable");
  }
  return { country: "TW", jurisdiction: "TW", jurisdictionId: row.jurisdiction_id,
    currency: "TWD", timezone: row.timezone, today };
}
