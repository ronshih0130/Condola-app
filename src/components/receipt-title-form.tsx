"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { receiptTitleCopy } from '@/i18n/owner-finance-replies';
import { saveReceiptTitleAction } from '@/server/owner-finance-replies-actions';
import type { ReceiptTitleView } from '@/server/owner-finance-replies';

export function ReceiptTitleForm({ view, locale }: { view: ReceiptTitleView; locale: string }) {
  const t = receiptTitleCopy(locale), router = useRouter();
  const [title, setTitle] = useState(view.title ?? ''), [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, start] = useTransition();
  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title || title.length > 100 || title !== title.trim()) { setError(t.invalid); return; }
    const id = requestId ?? crypto.randomUUID(); setRequestId(id); setError(''); setNotice('');
    start(async () => {
      try {
        const r = await saveReceiptTitleAction({ requestId: id, title });
        if (r.state === 'recorded') { setRequestId(null); setNotice(t.saved); router.refresh(); } else setError(t.unavailable);
      } catch { setError(t.unavailable); }
    });
  }
  return (
    <section className="card pad" data-testid="owner-receipt-title">
      <h1>{t.title}</h1>
      <p>{t.intro}</p>
      <p>{t.current}: {view.title ? <strong>{view.title}</strong> : <span className="muted">{t.empty}</span>}</p>
      <form onSubmit={save}>
        <label>{t.label}<input className="inp" value={title} maxLength={100} disabled={pending || !!requestId} onChange={(e) => setTitle(e.target.value)} required /></label>
        <button className="btn pri" disabled={pending}>{requestId ? t.retry : t.save}</button>
      </form>
      {pending && <p role="status">{t.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <h2>{t.history}</h2>
      {view.revisions.length === 0 ? <p>{t.noHistory}</p> : <ul>{view.revisions.map((r, i) => <li key={`${r.created_at}-${i}`}>{r.created_at} · {r.title}</li>)}</ul>}
    </section>
  );
}
