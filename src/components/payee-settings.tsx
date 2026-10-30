import { payeeStrings } from "@/i18n/payee";
import { payeeSettings } from "@/server/payee";
import type { PayeeAccount } from "@/server/payee-rules";
import { actionSavePayee, actionSetLeasePayee } from "@/server/payee-actions";
import type { Session } from "@/server/types";

export async function PayeeSettings({ session }: { session: Session }) {
  const data = await payeeSettings(session);
  if (!data) return null;
  const s = payeeStrings(session.locale);
  function accountForm(account: PayeeAccount | null) {
    const fields = [
      ["holderName", s.holder, account?.holder_name, true],
      ["bankName", s.bank, account?.bank_name, data!.country !== "TW"],
      ...(data!.country === "TW" ? [
        ["bankCode", s.bankCode, account?.bank_code, true],
        ["branchCode", s.branch, account?.branch_code, true],
      ] : [
        ["swift", s.swift, account?.details.swift, false],
        ["routing", s.routing, account?.details.routing, false],
      ]),
      ["accountNumber", s.number, account?.account_number, true],
    ] as const;
    return (
      <form action={actionSavePayee} key={account?.id ?? "new"}>
        <h4>{account ? account.holder_name || account.bank_name || s.company : s.create}</h4>
        {account ? <input type="hidden" name="id" value={account.id} /> : null}
        {(fields as unknown as ReadonlyArray<readonly [string, string, string | null | undefined, boolean]>).map(([name, label, value, required]) => (
          <label className="fg" key={name}>
            {label}
            <input className="inp" name={name} defaultValue={value ?? ""} required={required} />
          </label>
        ))}
        <label className="fg">
          {s.owner}
          <select name="ownerContactId" defaultValue={account?.owner_contact_id ?? ""}>
            <option value="">{s.company}</option>
            {data!.owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.display_name}</option>)}
          </select>
        </label>
        <label className="row">
          <input name="isDefault" type="checkbox" defaultChecked={account?.is_default_payee ?? false} />
          {s.defaultPayee}
        </label>
        <button className="btn pri" type="submit">{s.save}</button>
      </form>
    );
  }
  return (
    <section className="card pad" style={{ maxWidth: 720, marginBottom: 16 }}>
      <h3>{s.title}</h3>
      {data.accounts.map(accountForm)}
      {accountForm(null)}
      {data.leases.map((lease) => (
        <form action={actionSetLeasePayee} key={lease.id}>
          <label>{s.lease}: {lease.label || s.lease}</label>
          <input name="leaseId" type="hidden" value={lease.id} />
          <select name="accountId" defaultValue={lease.payee_bank_account_id ?? ""}>
            <option value="">{s.inherit}</option>
            {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.owner_contact_id ? s.owner : s.company}: {a.holder_name || a.id}</option>)}
          </select>
          <button className="btn" type="submit">{s.assign}</button>
        </form>
      ))}
    </section>
  );
}
