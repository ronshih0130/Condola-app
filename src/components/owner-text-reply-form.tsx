"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ownerRepliesCopy } from '@/i18n/owner-replies-messages';
import { postOwnerMessageAction, replyOwnerLifecycleAction } from '@/server/owner-replies-messages-actions';

type Target =
  | { kind: 'lifecycle'; recordId: string; noticeVersion: number }
  | { kind: 'message'; propertyId: string };

/**
 * B-023 owner text form. The request id is generated once per text and reused on
 * retry, so a resubmitted POST is an idempotent replay, never a second record.
 */
export function OwnerTextReplyForm({ target, locale }: { target: Target; locale: string }) {
  const c = ownerRepliesCopy(locale), router = useRouter();
  const [body, setBody] = useState(''), [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, start] = useTransition();
  const lifecycle = target.kind === 'lifecycle';
  function send() {
    const text = body.trim();
    if (!text || text.length > 2000) { setError(c.invalid); return; }
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id); setError(''); setNotice('');
    start(async () => {
      try {
        const res = target.kind === 'lifecycle'
          ? await replyOwnerLifecycleAction({ recordId: target.recordId, noticeVersion: target.noticeVersion, requestId: id, body: text })
          : await postOwnerMessageAction({ propertyId: target.propertyId, requestId: id, body: text });
        if (res.state === 'recorded' || res.state === 'replayed') {
          setRequestId(null); setBody(''); setNotice(lifecycle ? c.sent : c.messageSent); router.refresh();
        } else setError(res.state === 'stale' ? c.stale : res.state === 'invalid' ? c.invalid : res.state === 'gone' ? c.messageGone
          : res.state === 'rate_limited' ? c.rateLimited : c.unavailable);
      } catch { setError(c.unavailable); }
    });
  }
  return (
    <div data-testid={lifecycle ? 'owner-lifecycle-reply-form' : 'owner-message-form'}>
      <label>{lifecycle ? c.replyLabel : c.messageLabel}
        <textarea className="inp" rows={3} value={body} maxLength={2000} disabled={pending || requestId !== null && !error}
          onChange={(e) => { setBody(e.target.value); setRequestId(null); }} />
      </label>
      <button type="button" className="btn pri" disabled={pending} onClick={send} style={{ marginTop: 8 }}>
        {requestId && error ? c.retry : lifecycle ? c.send : c.sendMessage}
      </button>
      {pending && <p role="status">{c.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
