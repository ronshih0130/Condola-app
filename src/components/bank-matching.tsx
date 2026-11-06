import type { Locale } from "@/i18n";
import { bankMatchingStrings } from "@/i18n/bank-matching";
import { actionDecideBankMatch, actionImportBankFile } from "@/server/bank-matching-actions";
import type { bankBoard } from "@/server/bank-matching";
import { BANK_MATCH_REASON_CODES } from "@/server/bank-matching-rules";
import { moneyLabel } from "@/server/format";

type Board = NonNullable<Awaited<ReturnType<typeof bankBoard>>>;
export function BankMatching({data,locale}:{data:Board;locale:Locale}) {
  const s = bankMatchingStrings(locale);
  const amountLabel = (amount: string, currency: string) => {
    const number = Number(amount);
    if (Number.isSafeInteger(number)) return moneyLabel(number,currency,locale);
    const minor = BigInt(amount), negative = minor < BigInt(0), absolute = negative ? -minor : minor;
    return `${currency} ${negative ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2,"0")}`;
  };
  return <div data-testid="bank-matching">
    <form action={actionImportBankFile} className="card pad">
      <h2>{s.title}</h2>
      {data.accounts.length ? <><label className="fg">{s.account}<select className="inp" name="account" required>{data.accounts.map(a => <option value={a.id} key={a.id}>{a.nickname} · {a.currency}</option>)}</select></label>
      <label className="fg">{s.csv}<input className="inp" type="file" name="file" accept=".csv,text/csv" required /></label>
      <label className="fg">{s.encoding}<select className="inp" name="encoding"><option value="utf-8">UTF-8</option><option value="big5">Big5</option></select></label>
      <label className="fg">{s.dateFormat}<select className="inp" name="dateFormat"><option value="iso">YYYY-MM-DD</option><option value="roc">ROC/MM/DD</option></select></label><button className="btn pri">{s.upload}</button></> : <p>{s.noAccounts}</p>}
    </form>
    <section className="card pad"><h2>{s.rows}</h2><p className="hint">{s.positive}</p>
      {!data.lines.length ? <p>{s.noRows}</p> : data.lines.map(line => {
        const options = data.payments.filter(p => p.amount === line.amount && p.currency === line.currency && (!line.account_property || line.account_property === p.property_id) && BigInt(line.amount)>BigInt(0) && BigInt(line.amount)<=BigInt(Number.MAX_SAFE_INTEGER));
        const suggestions = data.suggestions.filter(item => item.bank === line.id);
        return <article key={line.id} className="card pad" data-testid="bank-line">
          <strong>{line.account} · {line.date} · {amountLabel(line.amount,line.currency)}</strong><p>{line.last5 || "—"} {line.description}</p>
          {line.overlap ? <p className="hint">{s.overlap}</p> : null}
          {suggestions.map(suggestion => <form action={actionDecideBankMatch} key={suggestion.id}>
            <input type="hidden" name="bankId" value={line.id} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input type="hidden" name="suggestionId" value={suggestion.id} />
            <p>{s.suggestions}: {data.payments.find(p => p.id === suggestion.payment)?.name || "—"} · {suggestion.score}</p>
            <div data-testid="bank-suggestion-basis" className="hint">
              <p>{s.basis}</p>
              {suggestion.basis.amountExact || suggestion.basis.last5Matched || suggestion.basis.dateDeltaDays !== null ? <ul>
                {suggestion.basis.amountExact ? <li>{s.amountExact}</li> : null}
                {suggestion.basis.last5Matched ? <li>{s.last5Matched}</li> : null}
                {suggestion.basis.dateDeltaDays !== null ? <li>{s.dateGap.replace("{days}", String(suggestion.basis.dateDeltaDays))}</li> : null}
              </ul> : <p>{s.basisUnavailable}</p>}
            </div>
            <label>{s.reason}<select className="inp" name="reason" required defaultValue="" data-testid="bank-match-reason"><option value="" disabled>{s.reasonChoose}</option>{BANK_MATCH_REASON_CODES.map((code) => <option key={code} value={code}>{s.reasons[code]}</option>)}</select></label>
            <button className="btn" name="decision" value="match">{s.match}</button> <button className="btn" name="decision" value="reject">{s.reject}</button>
          </form>)}
          {options.length ? <form action={actionDecideBankMatch}>
            <input type="hidden" name="bankId" value={line.id} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input type="hidden" name="decision" value="match" />
            <label>{s.manual}<select className="inp" name="paymentId" required defaultValue=""><option value="">{s.choose}</option>{options.map(p => <option value={p.id} key={p.id}>{p.name || "—"} · {p.date} · {amountLabel(p.amount,p.currency)}</option>)}</select></label>
            <label>{s.reason}<select className="inp" name="reason" required defaultValue="" data-testid="bank-match-reason"><option value="" disabled>{s.reasonChoose}</option>{BANK_MATCH_REASON_CODES.map((code) => <option key={code} value={code}>{s.reasons[code]}</option>)}</select></label><button className="btn">{s.match}</button>
          </form> : null}
        </article>;
      })}
    </section>
  </div>;
}
