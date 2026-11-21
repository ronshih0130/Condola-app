import { notFound } from "next/navigation";
import { SharePage } from "@/components/v3/share/share-page";
import { loadShareView } from "@/server/b110-case-share";

export const dynamic = "force-dynamic";

/** B-110 public read-only case share (/s/[token]). Unknown link or gate off: 404. No session, no list. */
export default async function CaseSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadShareView(token).catch(() => null);
  if (!view) notFound();
  return <SharePage locale="zh-TW" token={token} view={view} />;
}
