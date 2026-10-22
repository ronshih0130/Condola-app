/**
 * One watermark sentence, approved for every view.
 * 僅供{firm}核對租約身分使用・{viewer}・{YYYY-MM-DD HH:mm}
 * The middle dot is U+30FB. Viewer is the display name, or the email
 * local part when that name is missing. The clock is Asia/Taipei, the
 * moment of the view. It is not burned into the stored JPEG: the photo
 * GET and the view action draw it as an overlay so three photos stay a
 * database read plus a string, not a decode and re-encode.
 */
export const ID_WATERMARK_TEMPLATE = "僅供{firm}核對租約身分使用・{viewer}・{when}";

export function viewerLabel(displayName: string | null | undefined, email: string | null | undefined) {
  const name = (displayName ?? "").trim();
  if (name) return name;
  const local = (email ?? "").trim().split("@")[0]?.trim() ?? "";
  return local || "user";
}

/** UTC+8 wall clock. Taipei has no daylight saving. */
export function taipeiViewStamp(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${part(shifted.getUTCMonth() + 1)}-${part(shifted.getUTCDate())} ${part(shifted.getUTCHours())}:${part(shifted.getUTCMinutes())}`;
}

export function idWatermarkText(firm: string, viewer: string, when: string) {
  const text = ID_WATERMARK_TEMPLATE.replaceAll("{firm}", firm.trim())
    .replaceAll("{viewer}", viewer.trim())
    .replaceAll("{when}", when);
  if (!viewer.trim() || text.includes("・・")) throw new Error("watermark viewer is empty");
  return text;
}
