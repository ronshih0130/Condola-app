"use client";
import { useState } from "react";
import type { Locale } from "../../i18n";
import { brandV3RoomInvitesCopy } from "../../i18n/lanes/brand-v3-room-invites";
import { staffRoomInvitePath } from "../../lib/staff-invite";

/**
 * FE-ROOMINV list: one line per room, 「複製連結」 and 「列印 QR」 (the room's own M4 print view). Nothing is sent by the
 * system; the manager shares each link. The link itself is never printed as text on this page.
 */
export function RoomInviteList({ locale, place, origin, rooms }: {
  locale: Locale; place: string; origin: string; rooms: { roomId: string; label: string; path: string }[];
}) {
  const c = brandV3RoomInvitesCopy(locale);
  const [copied, setCopied] = useState<string | null>(null), [failed, setFailed] = useState(false);
  return <section className="staff-invite si-room-list" data-testid="room-invite-list">
    <h1>{c.title}</h1>
    <p className="si-muted">{place}</p>
    <ul>{rooms.map(room => <li key={room.roomId} className="si-room-line">
      <span className="si-room-label">{room.label}</span>
      <button className="si-button" type="button" aria-label={`${room.label} ${c.copy}`} onClick={async () => {
        try { await navigator.clipboard.writeText(`${origin}${room.path}`); setFailed(false); setCopied(room.roomId); } catch { setFailed(true); }
      }}>{copied === room.roomId ? c.copied : c.copy}</button>
      <a className="si-button" href={`${staffRoomInvitePath(room.roomId)}/print`} aria-label={`${room.label} ${c.print}`}>{c.print}</a>
    </li>)}</ul>
    {failed && <p role="alert">{c.error}</p>}
  </section>;
}
