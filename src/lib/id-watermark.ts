/**
 * On-screen sentence for a view. The middle dot is U+30FB.
 * 僅供{firm}核對租約身分使用・{viewer}・{YYYY-MM-DD HH:mm}
 * Viewer is the display name, or the email local part when that name is
 * missing. The clock is Asia/Taipei at the moment of the view.
 * Those two parts stay on the screen. The stored second copy is only
 * idFixedWatermark: the firm sentence, burned once at upload.
 */
export const ID_WATERMARK_TEMPLATE = "僅供{firm}核對租約身分使用・{viewer}・{when}";

/** Object path of the watermarked copy. The original object keeps `storagePath`. */
export function watermarkObjectPath(storagePath: string) {
  return `${storagePath}.wm`;
}

/** AES-GCM binding for the watermarked copy. It is not the original slot. */
export function watermarkSlot(slot: string) {
  return `${slot}#wm`;
}

/** Fixed sentence burned into the second copy. No viewer and no clock. */
export function idFixedWatermark(firm: string) {
  const name = firm.replace(/\s+/g, " ").trim();
  if (!name) throw new Error("watermark firm is empty");
  return `僅供${name}核對租約身分使用`;
}

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
