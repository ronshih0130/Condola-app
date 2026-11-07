'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DocumentInviteView } from '@/lib/vendor-document-ui';
import { actionCreateVendorDocumentInvite, actionRevokeVendorDocumentInvite } from '@/server/vendor-document-invite-actions';
import { vendorDocumentsCopy } from '@/i18n/vendor-documents';

export function VendorDocumentInvites({ ticketId, view, locale }: { ticketId: string; view: DocumentInviteView; locale: string }) {
  const t = vendorDocumentsCopy(locale), router = useRouter();
  const [pending, start] = useTransition();
  const [buyer, setBuyer] = useState('owner'), [owner, setOwner] = useState(view.owners[0]?.id ?? '');
  const [company, setCompany] = useState({ name: '', address: '', tax_id: '' });
  const [link, setLink] = useState<{ grantId: string; url: string } | null>(null), [message, setMessage] = useState('');
  return <section className="card pad" data-testid="vendor-document-invites">
    <h2>{t.invites}</h2><p>{view.vendorName}</p><p>{t.inviteNote}</p>
    {!view.ready ? <p role="status">{t.inviteNotReady}</p> : <form onSubmit={(e) => {
      e.preventDefault(); setMessage(''); setLink(null);
      start(async () => {
        try {
          const result = await actionCreateVendorDocumentInvite({ ticketId, profileId: view.profileId!,
            buyer: buyer === 'owner' ? { kind: 'owner', contactId: owner } : { kind: 'company', ...company } });
          if (!result.ok) { setMessage(t.unavailable); return; }
          setLink({ grantId: result.grantId, url: result.url }); router.refresh();
        } catch { setMessage(t.unavailable); }
      });
    }}>
      <label>{t.buyer}<select value={buyer} disabled={pending} onChange={(e) => setBuyer(e.target.value)}>
        <option value="owner">{t.buyerOwner}</option><option value="company">{t.buyerCompany}</option>
      </select></label>
      {buyer === 'owner' ? <label>{t.buyerOwner}<select required value={owner} disabled={pending} onChange={(e) => setOwner(e.target.value)}>
        {view.owners.map((o) => <option value={o.id} key={o.id}>{o.name}</option>)}
      </select></label> : <>
        {(['name', 'address', 'tax_id'] as const).map((key) => <label key={key}>{t[key === 'name' ? 'companyName' : key === 'address' ? 'address' : 'buyerTaxId']}
          <input required maxLength={key === 'address' ? 500 : 200} value={company[key]} disabled={pending} onChange={(e) => setCompany({ ...company, [key]: e.target.value })} />
        </label>)}
      </>}
      <button className="btn" disabled={pending || (buyer === 'owner' && !owner)}>{t.createInvite}</button>
    </form>}
    {link && <button type="button" className="btn" disabled={pending} onClick={() => {
      start(async () => {
        try { await navigator.clipboard.writeText(new URL(link.url, window.location.origin).href); setMessage(t.copied); }
        catch { setMessage(t.copyFailed); }
      });
    }}>{t.copyInvite}</button>}
    <p className="small">{t.copyOnce}</p>
    <ul>{view.invites.map((i) => <li key={i.id}>{t[i.state]} · {i.expiresAt}
      {i.state === 'active' && <button type="button" className="btn" disabled={pending} onClick={() => {
        setMessage('');
        start(async () => {
          try {
            const result = await actionRevokeVendorDocumentInvite(i.id);
            if (!result.ok) { setMessage(t.unavailable); return; }
            setLink(null); setMessage(t.done); router.refresh();
          } catch { setMessage(t.unavailable); }
        });
      }}>{t.revokeInvite}</button>}
    </li>)}</ul>
    {message && <p role="status">{message}</p>}
  </section>;
}
