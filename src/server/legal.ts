import { Marked } from "marked";

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    html(token) {
      const text = typeof token === "string" ? token : token.text;
      return escapeHtml(text);
    },
  },
});

export function legalTitle(markdown: string) {
  const line = markdown.split("\n").find((item) => item.startsWith("# "));
  return (line ?? "# 租多啦").replace(/^#\s+/, "").trim();
}

/** Render the legal Markdown as HTML. Raw HTML in the source is escaped. */
export function renderLegalMarkdown(markdown: string) {
  const html = marked.parse(markdown, { async: false });
  if (typeof html !== "string") throw new Error("legal markdown");
  return html;
}
