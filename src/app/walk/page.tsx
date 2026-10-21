import Link from "next/link";
import { makeT } from "@/i18n";
import { showDemoLineCopy } from "@/server/demo";
import { readSession, requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

const LINKS = ["/m/properties/new", "/m/leases/new", "/m/payments", "/m/bank", "/m/statements", "/t", "/o"];

export default async function WalkPage() {
  const prefs = await requestPrefs();
  const session = await readSession();
  const t = makeT(prefs.locale);
  const demoLine = showDemoLineCopy(session?.environment ?? null);
  const steps = Array.from({ length: 20 }, (_, index) => t(`i_w${index + 1}`)).filter((step) => demoLine || !step.includes("LINE"));
  return (
    <div className="main">
      <h1>{t("i_walk_title")}</h1>
      <ol>
        {steps.map((step, index) => (
          <li key={step} style={{ marginBottom: 8 }}>
            <span className="small muted">{t("i_walk_step", { step: index + 1, total: steps.length })}</span> {step}{" "}
            <Link href={LINKS[index % LINKS.length]}>{t("i_continue")}</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
