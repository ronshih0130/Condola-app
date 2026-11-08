'use client';
import { useId, useState } from 'react';
import { vendorDocumentsCopy } from '@/i18n/vendor-documents';
import type { FixedDataUpdate } from '@/lib/vendor-document-ui';
import type { TradeLineInput } from '@/server/vendor-document-trade-rules';
import { tradeLineItems, tradeTotal } from '@/server/vendor-document-trade-rules';

export type VendorFixedData = {
  kind: 'individual' | 'business'; display_name: string; business_name: string | null;
  representative_name: string | null; phone_e164: string; address: string | null;
};

/** Bound size/type before reading. The gateway also validates actual bytes. */
export async function documentAttachment(file: File, seal = false) {
  if (file.size < 1 || file.size > 5242880 || !(seal ? ['image/png', 'image/jpeg'] : ['image/png', 'image/jpeg', 'application/pdf']).includes(file.type)) throw new Error('invalid_attachment');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { base64: btoa(binary), mimeType: file.type };
}

export function FixedDataForm({ profile, version, pending, locale, save }: {
  profile: VendorFixedData; version: number; pending: boolean; locale: string;
  save: (update: FixedDataUpdate, seal: File | null) => void;
}) {
  const t = vendorDocumentsCopy(locale);
  const [fields, setFields] = useState(profile), [seal, setSeal] = useState<File | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof VendorFixedData, string>>>({});
  const formId = useId();
  const keys = profile.kind === 'business'
    ? ['display_name', 'business_name', 'representative_name', 'phone_e164', 'address'] as const
    : ['display_name', 'phone_e164', 'address'] as const;
  return <form noValidate data-testid="vendor-fixed-data" onSubmit={(e) => {
    e.preventDefault();
    const update: FixedDataUpdate = { expectedVersion: version };
    const invalid: typeof errors = {};
    for (const key of keys) {
      const raw = fields[key] ?? '', value = raw.trim();
      if (!value && !(key === 'address' && profile.kind === 'individual')) invalid[key] = t.fieldRequired;
      else if (raw.length > (key === 'address' ? 500 : 200) || /[\u0000-\u001f\u007f]/.test(raw)) invalid[key] = t.fieldInvalid;
      else if (key === 'phone_e164' && !/^\+[1-9][0-9]{6,14}$/.test(value)) invalid[key] = t.phoneInvalid;
      if (key === 'address') {
        if ((value || null) !== profile.address) update.address = value || null;
      } else if (value !== profile[key]) update[key] = value;
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (Object.keys(update).length > 1 || seal) save(update, seal);
  }}>
    <h2>{t.fixedData}</h2><p>{t.snapshotVersion} {version} · {t.versionNote}</p>
    {keys.map((key) => <div key={key}><label>{t[key]}<input className="inp" value={fields[key] ?? ''}
      required={key !== 'address' || profile.kind === 'business'} maxLength={key === 'address' ? 500 : 200}
      aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `${formId}-${key}` : undefined}
      type={key === 'phone_e164' ? 'tel' : 'text'} disabled={pending}
      onChange={(e) => { setFields({ ...fields, [key]: e.target.value }); setErrors({ ...errors, [key]: undefined }); }} /></label>
      {errors[key] && <span id={`${formId}-${key}`} role="alert">{errors[key]}</span>}</div>)}
    {profile.kind === 'business' && <label>{t.sealUpload}<input type="file" accept="image/png,image/jpeg" disabled={pending}
      onChange={(e) => setSeal(e.target.files?.[0] ?? null)} /></label>}
    <p className="small">{t.fileLimit}</p>
    <button className="btn" disabled={pending}>{t.saveFixedData}</button>
  </form>;
}

export function PaperScanForm({ pending, locale, upload }: { pending: boolean; locale: string; upload: (file: File, requestId: string) => Promise<boolean> }) {
  const t = vendorDocumentsCopy(locale);
  const [file, setFile] = useState<File | null>(null), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [inputKey, setInputKey] = useState(0);
  return <form data-testid="vendor-paper-scan" onSubmit={async (e) => {
    e.preventDefault(); if (!file) return;
    if (await upload(file, requestId)) { setFile(null); setRequestId(crypto.randomUUID()); setInputKey((k) => k + 1); }
  }}>
    <label>{t.scanUpload}<input key={inputKey} type="file" accept="image/png,image/jpeg,application/pdf" required disabled={pending}
      onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRequestId(crypto.randomUUID()); }} /></label>
    <p className="small">{t.scanNote} {t.fileLimit}</p>
    <button className="btn" disabled={pending || !file}>{t.attachScan}</button>
  </form>;
}

export function TradeItemsForm({ rows, setRows, pending, locale, totalMinor }: {
  rows: TradeLineInput[]; setRows: (rows: TradeLineInput[]) => void; pending: boolean; locale: string; totalMinor: string;
}) {
  const t = vendorDocumentsCopy(locale);
  let total: string | null = null;
  try { total = tradeTotal(tradeLineItems(rows)).toString(); } catch { /* Incomplete input stays editable. */ }
  return <fieldset disabled={pending} data-testid="vendor-trade-items">
    <legend>{t.tradeItems}</legend><p>{t.tradeNote}</p>
    {rows.map((row, index) => <div key={index} className="card pad">
      {(['name', 'quantity', 'unit', 'unit_price_minor'] as const).map((key) => <label key={key}>{t[key]}
        <input className="inp" value={row[key]} inputMode={key === 'quantity' ? 'decimal' : key === 'unit_price_minor' ? 'numeric' : 'text'}
          maxLength={key === 'name' ? 200 : 24} onChange={(e) => setRows(rows.map((r, i) => i === index ? { ...r, [key]: e.target.value } : r))} />
      </label>)}
      <label>{t.category}<select value={row.category} onChange={(e) => setRows(rows.map((r, i) => i === index ? { ...r, category: e.target.value as TradeLineInput['category'] } : r))}>
        {(['service', 'labor', 'material'] as const).map((c) => <option key={c} value={c}>{t[c]}</option>)}
      </select></label>
      <button type="button" className="btn" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, i) => i !== index))}>{t.removeItem}</button>
    </div>)}
    <button type="button" className="btn" disabled={rows.length >= 100} onClick={() => setRows([...rows, { name: '', quantity: '1', unit: '', unit_price_minor: '', category: 'service' }])}>{t.addItem}</button>
    <p role="status">{total === null ? t.invalidTrade : total !== totalMinor ? t.tradeMismatch : `${t.total}: ${total}`}</p>
  </fieldset>;
}
