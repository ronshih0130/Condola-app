import Link from "next/link";
import { makeT } from "@/i18n";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const LINKS = ["/m/properties/new", "/m/leases/new", "/m/payments", "/m/bank", "/m/statements", "/t", "/o"];

export default async function WalkPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const steps = Array.from({ length: 20 }, (_, index) => t(`i_w${index + 1}`));
  return (
    <div className="main">
      <h1>{t("i_walk_title")}</h1>
      <ol>
        {steps.map((step, index) => (
          <li key={step} style={{ marginBottom: 8 }}>
            <span className="small muted">{t("i_walk_step", { step: index + 1, total: 20 })}</span> {step}{" "}
            <Link href={LINKS[index % LINKS.length]}>{t("i_continue")}</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
