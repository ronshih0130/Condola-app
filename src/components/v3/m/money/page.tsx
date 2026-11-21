import React from "react";
import { readMoneyPage, type MoneyParams } from "../../../../server/money-page";
import type { Session } from "../../../../server/types";
import { MoneyPage } from "./money";

export async function MoneyMonthPage({ session, params }: { session: Session; params: MoneyParams }) {
  const data = await readMoneyPage(session, params);
  return <MoneyPage session={session} {...data} error={params.error} />;
}
