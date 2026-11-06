"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { reportRepliesCopy } from '@/i18n/owner-finance-replies';
import { recordReportReplyAction } from '@/server/owner-finance-replies-actions';

export type TransferLine = { id: string; kind: 'owner_payout' | 'reversal'; effectiveDate: string; amount: string };
export type RepliesPanelView = {
  statementId: string;
  transfers: TransferLine[] | null;
  replies: { latestVersionId: string | null; latestVersionNo: number; confirmedCurrent: boolean; canReply: boolean; stale: boolean; displayedVersionId: string | null; hadEarlierConfirm: boolean;
    items: Array<{ id: string; versionNo: number | null; kind: string; body: string | null; createdAt: string; byOwner: boolean }> } | null;
};

export function OwnerReportReplies({ view, locale }: { view: RepliesPanelView; locale: string }) {
  const t = reportRepliesCopy(locale), router = useRouter();
  const [body, setBody] = useState(''), [requestId, setRequestId] = useState<{ id: string; kind: 'confirm' | 'dispute' } | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, start] = useTransition();
  const r = view.replies;
  function send(kind: 'confirm' | 'dispute') {
    if (!r) return;
    if (kind === 'dispute' && (!body || body.length > 1000 || body !== body.trim())) { setError(t.invalid); return; }
    const req = requestId && requestId.kind === kind ? requestId : { id: crypto.randomUUID(), kind };
    setRequestId(req); setError(''); setNotice('');
    start(async () => {
      try {
        const res = await recordReportReplyAction({ statementId: view.statementId, versionId: r.displayedVersionId, requestId: req.id, kind, body: kind === 'dispute' ? body : null });
        if (res.state === 'recorded') { setRequestId(null); setBody(''); setNotice(t.sent); router.refresh(); } else setError(t.unavailable);
      } catch { setError(t.unavailable); }
    });
  }
  return (
    <>
      {view.transfers && (
        <section className="card pad" data-testid="owner-transfer-history">
          <h2>{t.transfersTitle}</h2>
          <p className="small muted">{t.transfersNote}</p>
          {view.transfers.length === 0 ? <p>{t.noTransfers}</p> : (
            <ul>{view.transfers.map((x) => <li key={x.id}>{x.effectiveDate} · {x.kind === 'reversal' ? t.reversal : t.payout} · {x.amount}</li>)}</ul>
          )}
        </section>
      )}
      {r && (
        <section className="card pad" data-testid="owner-report-replies">
          <h2>{t.repliesTitle}</h2>
          <p data-testid="owner-report-confirm-state">{r.confirmedCurrent ? t.confirmed(r.latestVersionNo) : r.hadEarlierConfirm ? t.reconfirm : t.notConfirmed}</p>
          {r.stale && <p className="small" role="status">{t.stale}</p>}
          {r.canReply && (
            <div>
              {!r.confirmedCurrent && <button type="button" className="btn pri" disabled={pending} onClick={() => send('confirm')}>{requestId?.kind === 'confirm' ? t.retry : t.confirm}</button>}
              <label>{t.disputeLabel}<textarea className="inp" value={body} maxLength={1000} disabled={pending || requestId?.kind === 'dispute'} onChange={(e) => setBody(e.target.value)} /></label>
              <button type="button" className="btn" disabled={pending} onClick={() => send('dispute')}>{requestId?.kind === 'dispute' ? t.retry : t.dispute}</button>
            </div>
          )}
          <h3>{t.history}</h3>
          {r.items.length === 0 ? <p>{t.noReplies}</p> : (
            <ul>{r.items.map((i) => <li key={i.id}>{i.createdAt} · {t.version(i.versionNo)} · {t.kind[i.kind] ?? i.kind}{i.byOwner ? ` · ${t.byOwner}` : ''}{i.body ? `：${i.body}` : ''}</li>)}</ul>
          )}
          {pending && <p role="status">{t.loading}</p>}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </>
  );
}
