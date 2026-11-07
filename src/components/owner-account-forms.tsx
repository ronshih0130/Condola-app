"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ownerAccountCopy } from '@/i18n/owner-account';
import { revokeOwnerSessionAction, saveOwnerProfileAction, setOwnerNotificationPreferenceAction } from '@/server/owner-account-actions';
import type { OwnerAccountResult } from '@/server/owner-account';

type Copy = ReturnType<typeof ownerAccountCopy>;

function message(c: Copy, state: OwnerAccountResult['state']) {
  switch (state) {
    case 'stale': return c.profileStale;
    case 'invalid': return c.profileInvalid;
    case 'reauth_required': return c.reauthRequired;
    case 'current': return c.current;
    case 'gone': return c.gone;
    case 'conflict': return c.conflict;
    default: return c.unavailable;
  }
}

/**
 * One request id per intended change, reused on retry, so a resubmitted POST is an
 * idempotent replay. Editing the input starts a new request.
 */
function useRequest() {
  const [requestId, setRequestId] = useState<string | null>(null);
  return {
    requestId,
    take: () => { const id = requestId ?? crypto.randomUUID(); setRequestId(id); return id; },
    reset: () => setRequestId(null),
  };
}

export function OwnerProfileForm({ locale, profile }: {
  locale: string;
  profile: { display_name: string; locale: string; preferred_channel: string | null; channels: string[]; version: string };
}) {
  const c = ownerAccountCopy(locale), router = useRouter(), request = useRequest();
  const [name, setName] = useState(profile.display_name), [lang, setLang] = useState(profile.locale);
  const [channel, setChannel] = useState(profile.preferred_channel ?? '');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, start] = useTransition();
  const edit = (fn: () => void) => { fn(); request.reset(); setError(''); setNotice(''); };
  function save() {
    const id = request.take(); setError(''); setNotice('');
    start(async () => {
      try {
        const res = await saveOwnerProfileAction({ requestId: id, displayName: name, locale: lang, channel: channel || null, version: profile.version });
        if (res.state === 'recorded' || res.state === 'replayed' || res.state === 'unchanged') {
          request.reset(); setNotice(res.state === 'unchanged' ? c.profileUnchanged : c.profileSaved); router.refresh();
        } else setError(message(c, res.state));
      } catch { setError(c.unavailable); }
    });
  }
  return (
    <div data-testid="owner-profile-form">
      <label className="f" htmlFor="owner-display-name">{c.displayName}</label>
      <input id="owner-display-name" className="inp" value={name} maxLength={100} disabled={pending}
        onChange={(e) => edit(() => setName(e.target.value))} />
      <label className="f" htmlFor="owner-locale">{c.language}</label>
      <select id="owner-locale" className="inp" value={lang} disabled={pending} onChange={(e) => edit(() => setLang(e.target.value))}>
        {Object.entries(c.languages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label className="f" htmlFor="owner-channel">{c.channel}</label>
      <select id="owner-channel" className="inp" value={channel} disabled={pending} onChange={(e) => edit(() => setChannel(e.target.value))}>
        <option value="">{c.channelDefault}</option>
        {profile.channels.map((value) => <option key={value} value={value}>{c.channels[value as keyof typeof c.channels] ?? value}</option>)}
      </select>
      <button type="button" className="btn pri" disabled={pending} onClick={save} style={{ marginTop: 8 }}>
        {request.requestId && error ? c.retry : c.saveProfile}
      </button>
      {pending && <p role="status">{c.loading}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function OwnerPreferenceToggle({ locale, category, enabled }: { locale: string; category: string; enabled: boolean }) {
  const c = ownerAccountCopy(locale), router = useRouter(), request = useRequest();
  const [error, setError] = useState(''), [pending, start] = useTransition();
  function toggle() {
    const id = request.take(); setError('');
    start(async () => {
      try {
        const res = await setOwnerNotificationPreferenceAction({ requestId: id, category, enabled: !enabled });
        if (res.state === 'recorded' || res.state === 'replayed' || res.state === 'unchanged') { request.reset(); router.refresh(); }
        else setError(message(c, res.state));
      } catch { setError(c.unavailable); }
    });
  }
  return (
    <span data-testid={`owner-pref-${category}`}>
      <button type="button" className="btn sm" disabled={pending} onClick={toggle}>
        {request.requestId && error ? c.retry : enabled ? c.turnOff : c.turnOn}
      </button>
      {error && <span role="alert"> {error}</span>}
    </span>
  );
}

export function OwnerRevokeSessionButton({ locale, sessionId }: { locale: string; sessionId: string }) {
  const c = ownerAccountCopy(locale), router = useRouter(), request = useRequest();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [pending, start] = useTransition();
  function revoke() {
    const id = request.take(); setError(''); setNotice('');
    start(async () => {
      try {
        const res = await revokeOwnerSessionAction({ targetSessionId: sessionId, requestId: id });
        if (res.state === 'revoked' || res.state === 'replayed' || res.state === 'gone') {
          request.reset(); setNotice(res.state === 'gone' ? c.gone : c.signedOut); router.refresh();
        } else {
          if (res.state === 'reauth_required') request.reset();
          setError(message(c, res.state));
        }
      } catch { setError(c.unavailable); }
    });
  }
  return (
    <div data-testid="owner-revoke-session">
      <button type="button" className="btn sm" disabled={pending} onClick={revoke}>
        {request.requestId && error ? c.retry : c.signOutDevice}
      </button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
