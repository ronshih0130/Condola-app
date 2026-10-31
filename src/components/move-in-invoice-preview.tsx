import { dictionary, type Locale } from "@/i18n";
import { moveInPreviewCopy } from "@/i18n/move-in-preview";
import { formatDate, signedMoneyLabel } from "@/server/format";
import type { MoveInPreview } from "@/server/move-in-preview";
import type { CalendarMode } from "@/server/types";

export function MoveInInvoicePreview({ preview, locale, calendar }: { preview: MoveInPreview; locale: Locale; calendar: CalendarMode }) {
  const c = moveInPreviewCopy(locale), dict = dictionary(locale);
  if (preview.kind === "unavailable") return <section className="card pad" data-testid="move-in-invoice-preview"><p role="status">{c.unavailable}</p></section>;
  return <section className="card pad" data-testid="move-in-invoice-preview">
    <h3>{preview.kind === "estimate" ? c.estimate : c.issued}</h3>
    {preview.kind === "estimate" ? <p className="hint">{c.asOf}</p> : null}
    <table className="t"><tbody>
      {preview.lines.map((line, index) => <tr key={index}><td>{line.type === "rent" ? c.rent : line.type === "deposit" ? c.deposit : line.type === "utility" ? c.utility : line.description}{preview.kind === "issued" && ["rent", "deposit", "utility"].includes(line.type) && line.description !== line.type ? ` — ${line.description}` : null}</td>
        <td className="num">{signedMoneyLabel(line.amount, preview.currency, locale)}</td></tr>)}
      <tr className="grp"><td>{c.total}</td><td className="num">{signedMoneyLabel(preview.totalMinor, preview.currency, locale)}</td></tr>
    </tbody></table>
    {preview.lines.filter(line => line.type === "rent").map((line, index) => <p key={index}>{c.period}: {line.period_start && line.period_end ? `${formatDate(line.period_start, locale, calendar, dict)} – ${formatDate(line.period_end, locale, calendar, dict)}` : c.unknown}</p>)}
    {preview.calculation ? <p>{preview.calculation.prorated ? `${c.formula} (${preview.calculation.days} ${c.days})` : c.full}</p> : null}
    {preview.kind === "estimate" && preview.totalMinor === 0 ? <p>{c.zero}</p> : null}
  </section>;
}
