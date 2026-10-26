import { renderLegalMarkdown } from "@/server/legal";

export function LegalDocument({ markdown }: { markdown: string }) {
  return (
    <main
      className="legal"
      lang="zh-Hant-TW"
      data-testid="legal-doc"
      dangerouslySetInnerHTML={{ __html: renderLegalMarkdown(markdown) }}
    />
  );
}
