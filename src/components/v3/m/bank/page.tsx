import { bankMonth, type BankMonthFilter } from "../../../../server/b3-bank-month";
import type { Session } from "../../../../server/types";
import { BankMonthView } from "./bank";

export type BankSearchParams = { error?: string; month?: string; filter?: string; cursor?: string };
export async function BankV3Page({ session, params }: { session: Session; params: BankSearchParams }) {
  const data = await bankMonth(session, { month: params.month, filter: params.filter as BankMonthFilter | undefined, cursor: params.cursor });
  return <BankMonthView key={`${params.month ?? "current"}:${params.filter ?? "review"}:${params.cursor ?? ""}`} data={data} locale={session.locale} month={params.month} filter={params.filter} cursor={params.cursor} />;
}
