import React from "react";
import { ownerRulesPage } from "../../../../server/b094-owner-rules";
import type { Session } from "../../../../server/types";
import { RulesError, RulesNoPerm, RulesView } from "./rules";

/** RO-RULES page body. OFF never reaches here (the route 404s first). */
export async function RulesPage({ session }: { session: Session }) {
  const page = await ownerRulesPage(session);
  if (page.state === "forbidden") return <RulesNoPerm locale={session.locale} />;
  if (page.state !== "ready") return <RulesError locale={session.locale} />;
  return <RulesView locale={session.locale} company={page.company} repairs={page.repairs} rule={page.rule.rule} revision={page.rule.revision} />;
}
