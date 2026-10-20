import { makeT } from "@/i18n";
import { GoLiveForm } from "@/components/env-mode";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { goLivePreview } from "@/server/sandbox";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function GoLivePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const query = await searchParams;
  const t = makeT(session.locale);
  const preview = await goLivePreview(session);
  return (
    <>
      <PageHeader title={t("i_golive_title")} />
      <ErrorBanner t={t} error={query.error} />
      <div className="card pad" style={{ maxWidth: 720 }}>
        <GoLiveForm
          allowed={preview.allowed}
          activeUnits={preview.activeUnits}
          freeUnits={preview.freeUnits}
          canCopy={session.role === "admin"}
          liveEnabled={session.liveEnabled === true}
        />
      </div>
    </>
  );
}
