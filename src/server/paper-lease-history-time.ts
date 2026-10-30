/** Render history timestamps using the selected organization's zone, never the server zone. */
export function paperHistoryTime(value: string, zone: string, locale: string, calendar = "gregorian") {
  if (!/(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  let timeZone = zone;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(date);
  } catch {
    timeZone = "UTC";
  }
  const formatter = new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-TW" : "en", {
    calendar: calendar === "roc" ? "roc" : "gregory", timeZone, year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  return { iso: date.toISOString(), label: `${formatter.format(date)} (${timeZone})` };
}
