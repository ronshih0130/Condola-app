import Link from "next/link";
import { makeT } from "@/i18n";
import { ID_NOTICE_PATH } from "@/lib/id-notice";
import { FullNotice } from "@/lib/id-notice-view";
import { loadFirmNoticeContact } from "@/server/id-docs";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function IdNoticePage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const firm = await loadFirmNoticeContact(session);
  return (
    <article className="idv-task">
      <div className="idv-task-scroll">
        <FullNotice vars={{ firmName: firm.name, firmContact: firm.contact, fullNoticeUrl: ID_NOTICE_PATH }} />
      </div>
      <div className="idv-dock">
        <Link className="btn pri block" href="/t/id" data-testid="idv-back-upload">
          {t("i_back_upload")}
        </Link>
      </div>
    </article>
  );
}
