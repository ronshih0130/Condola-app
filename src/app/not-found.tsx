import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { readSession } from "@/server/session";
import { Illustration } from "@/components/v3/illustrations";
import type { Metadata } from "next";
import { MissingPage } from "@/components/missing-page";

export const metadata: Metadata = {
  title: { absolute: "找不到這個頁面｜租多啦" },
};

export default async function NotFound() {
  const session = await readSession();
  const v3 = await brandV3EnabledForOrg(session?.orgId);
  return (
    <div className="main">
      {v3 ? <Illustration name="24" /> : null}
      <MissingPage href="/" />
    </div>
  );
}
