import { makeT } from "@/i18n";
import { payeeStrings } from "@/i18n/payee";
import { tenantPayee } from "@/server/payee";
import { payeeAccount } from "@/server/payee-rules";
import type { Session } from "@/server/types";

export async function TenantPayee({ session, leaseId }: { session: Session; leaseId: string }) {
  const view = await tenantPayee(session, leaseId);
  const t = makeT(session.locale);
  const s = payeeStrings(session.locale);
  if (!view.enabled) {
    return <p className="small">{view.last5 ? t("i_account_last5", { last5: view.last5 }) : s.notSet}</p>;
  }
  const account = view.account;
  const number = account ? payeeAccount(account.account_number, account.account_last5) : "";
  if (!account || !number) return <p className="small">{s.notSet}</p>;
  return (
    <div className="small" data-testid="tenant-payee">
      <p className="b">{account.owner_contact_id ? s.owner : s.company}</p>
      {account.holder_name ? <p>{s.holder}: {account.holder_name}</p> : null}
      {account.bank_name ? <p>{s.bank}: {account.bank_name}</p> : null}
      {account.bank_code ? <p>{s.bankCode}: {account.bank_code}</p> : null}
      {account.branch_code ? <p>{s.branch}: {account.branch_code}</p> : null}
      <p>{s.number}: {number}</p>
      {typeof account.details.swift === "string" ? <p>{s.swift}: {account.details.swift}</p> : null}
      {typeof account.details.routing === "string" ? <p>{s.routing}: {account.details.routing}</p> : null}
    </div>
  );
}
