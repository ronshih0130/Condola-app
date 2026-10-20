/** Team sign-in times and invite expiry are shown in Asia/Taipei (UTC+8, no DST). */
export function formatTaipei(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** Calendar date in Asia/Taipei, `YYYY-MM-DD`. */
export function formatTaipeiDate(value: string | Date) {
  return formatTaipei(value).slice(0, 10);
}
