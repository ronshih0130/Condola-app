import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PropertyView } from "../components/v3/m/properties/property";
import { RoomInviteList } from "../components/staff-invite/room-invites";
import { brandV3RoomInvitesCopy } from "../i18n/lanes/brand-v3-room-invites";
import { staffRoomInviteApiPath, staffRoomInvitePath } from "../lib/staff-invite";
import { propertyRoomState, propertyTotals } from "./b3-property-rules";
import type { PropertyReady } from "./b3-property";
Object.assign(globalThis, { React });

// B-102 INV-ROOM / FE-ROOMINV (MGT-147-AC1/AC2). Synthetic data only.
const read = (p: string) => readFileSync(p, "utf8");
const room = (id: string, label: string) => propertyRoomState({ id, unitId: "u", kind: "room", label, unitLabel: "3F", roomType: null, addressReady: true, ownerReady: true, moneyReady: true, tenantReady: false, leaseStatus: null });
const rows = [room("ra", "A"), room("rb", "B")];
const data: PropertyReady = { state: "ready", id: "p", name: "Sample", archived: false, canInvite: true, rows, ...propertyTotals(rows) };
const invites = [{ rowId: "ra", href: staffRoomInvitePath("ra") }, { rowId: "rb", href: staffRoomInvitePath("rb") }];
const all = [{ unitId: "u", href: "/m/units/u/room-invites", label: "3F" }];

test("FE-ROOMINV copy: the approved strings (P52 2026-11-16) and never 收款", () => {
  const zh = brandV3RoomInvitesCopy("zh-TW");
  assert.deepEqual([zh.title, zh.copy, zh.print], ["一次邀請全部房間", "複製連結", "列印 QR"]);
  assert.doesNotMatch(JSON.stringify(zh), /收款|入帳/);
  assert.deepEqual(Object.keys(brandV3RoomInvitesCopy("en")), Object.keys(zh));
});

test("MGT-147-AC1/AC2: each room row opens its own invite; one 「一次邀請全部房間」 per by_room unit", () => {
  const html = renderToStaticMarkup(<PropertyView data={data} locale="zh-TW" id="p" invites={invites} roomInviteAll={all} />);
  assert.ok(html.includes(`href="/m/rooms/ra/invite"`) && html.includes(`href="/m/rooms/rb/invite"`));
  assert.match(html, /data-testid="room-invite-all"><a class="btn" href="\/m\/units\/u\/room-invites">一次邀請全部房間<\/a><\/p>/);
  const two = renderToStaticMarkup(<PropertyView data={data} locale="zh-TW" id="p" invites={invites} roomInviteAll={[...all, { unitId: "v", href: "/m/units/v/room-invites", label: "5F" }]} />);
  assert.match(two, />3F 一次邀請全部房間<.*>5F 一次邀請全部房間</, "the unit label tells two by_room units apart");
  for (const variant of [{ ...data, archived: true }, { ...data, canInvite: false }])
    assert.doesNotMatch(renderToStaticMarkup(<PropertyView data={variant} locale="zh-TW" id="p" invites={invites} roomInviteAll={all} />), /room-invite-all/);
  assert.doesNotMatch(renderToStaticMarkup(<PropertyView data={data} locale="zh-TW" id="p" />), /room-invite-all|\/m\/rooms\//, "no entries → today's markup");
});

test("FE-ROOMINV list: one line per room with 「複製連結」 and 「列印 QR」 (the room's print view); the link is never printed as text", () => {
  const html = renderToStaticMarkup(<RoomInviteList locale="zh-TW" place="3F" origin="https://example.test" rooms={[
    { roomId: "ra", label: "A", path: "/join/" + "a".repeat(43) }, { roomId: "rb", label: "B", path: "/join/" + "b".repeat(43) }]} />);
  assert.equal((html.match(/class="si-room-line"/g) ?? []).length, 2);
  assert.equal((html.match(/>複製連結</g) ?? []).length, 2);
  assert.ok(html.includes(`href="/m/rooms/ra/invite/print"`) && html.includes(`href="/m/rooms/rb/invite/print"`));
  assert.match(html, /aria-label="A 複製連結"/);
  assert.doesNotMatch(html, /\/join\/|aaaa|https:\/\/example\.test/);
  assert.doesNotMatch(html, /<form|method="post"/i, "nothing is sent by the system");
});

test("wiring: room paths, the room routes reuse the M4 screens, invite headers cover the new pages", () => {
  assert.equal(staffRoomInvitePath("r 1"), "/m/rooms/r%201/invite");
  assert.equal(staffRoomInviteApiPath("r1"), "/api/m/rooms/r1/staff-invite");
  assert.match(read("src/app/m/rooms/[roomId]/invite/[[...view]]/page.tsx"), /page = await staffRoomInvitePage\(session, roomId, view\);/);
  assert.match(read("src/app/api/m/rooms/[roomId]/staff-invite/[[...view]]/route.ts"), /return serveStaffRoomInvite\(session, roomId, view \?\? \[\], request\);/);
  assert.match(read("src/components/staff-invite/panel.tsx"), /const base = data\.roomId \? staffRoomInvitePath\(data\.roomId\) : staffInvitePath\(data\.unitId\)/);
  const config = read("next.config.ts");
  for (const source of ["/m/rooms/:roomId/invite/:path*", "/m/units/:unitId/room-invites"]) assert.ok(config.includes(`{ source: "${source}", headers: INVITE_HEADERS }`), source);
  const page = read("src/components/v3/m/properties/page.tsx");
  assert.match(page, /const rooms=await staffRoomInviteEntries\(session,roomRows\);/);
  assert.match(page, /href:staffRoomInvitePath\(entry\.roomId\)/);
});
