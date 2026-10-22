/** Link label substituted for 〔完整版連結〕 on the upload page. The notice file itself is unchanged. */
export const NOTICE_LINK_LABEL = "完整版";

/** Split a substituted short notice around the full-text URL so the URL is not shown. */
export function splitNoticeLink(text: string, url: string) {
  const at = text.indexOf(url);
  if (at < 0) throw new Error("notice link missing");
  return { before: text.slice(0, at), after: text.slice(at + url.length) };
}

/** Upload-page summary text. The URL is replaced by the link label. */
export function displayedNoticeText(text: string, url: string) {
  const parts = splitNoticeLink(text, url);
  return `${parts.before}${NOTICE_LINK_LABEL}${parts.after}`;
}
