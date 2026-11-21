import React from "react";
import { notFound } from "next/navigation";
import { brandV3AssignCopy, fillAssign } from "@/i18n/lanes/brand-v3-assign";
import { assignEdit, assignList } from "@/server/b059-maint-unit-assign";
import { can } from "@/server/perms";
import { displaySampleName } from "@/server/sandbox-data";
import type { Session } from "@/server/types";
import { AssignError, AssignListView, AssignNoPerm, AssignNoUnits, ASSIGN_HREF, assignEditHref } from "./assign";
import { AssignForm } from "./assign-form";

/** 設定 › 單位分派 body (the route already returned 404 while brand_v3 or maint_unit_assign is OFF). */
export async function AssignListSection({ session }: { session: Session }) {
  const read = await assignList(session);
  // The flag turned OFF after the route's own check (the gateway re-reads it): the same 404.
  if (read.state === "off") notFound();
  if (read.state === "forbidden") return <AssignNoPerm locale={session.locale} />;
  if (read.state !== "ready") return <AssignError locale={session.locale} retryHref={ASSIGN_HREF} />;
  // MGT-118-AC6: 「新增同事」 only for a role that can add people (團隊 = team.manage, admin).
  return <AssignListView locale={session.locale} people={read.people.map(p => ({ ...p, name: displaySampleName(p.name) }))}
    canAdd={can(session, "team.manage")} />;
}

/** 負責的單位・{名字} body. */
export async function AssignEditSection({ session, target }: { session: Session; target: string }) {
  const read = await assignEdit(session, target);
  if (read.state === "off") notFound();
  if (read.state === "forbidden") return <AssignNoPerm locale={session.locale} />;
  if (read.state !== "ready") return <AssignError locale={session.locale} retryHref={assignEditHref(target)} />;
  const name = displaySampleName(read.person.name);
  if (!read.units.length) return <AssignNoUnits locale={session.locale} name={name} />;
  const c = brandV3AssignCopy(session.locale);
  return <section className="v3-assign" aria-labelledby="v3-assign-edit-title" data-testid="assign-edit">
    <header className="v3-assign-head"><h1 id="v3-assign-edit-title">{fillAssign(c.editTitle, { name })}</h1></header>
    <AssignForm locale={session.locale} target={read.person.id} name={name} doneHref={ASSIGN_HREF}
      units={read.units.map(u => ({ id: u.id, label: `${displaySampleName(u.property)} ${displaySampleName(u.label)}` }))}
      checked={read.units.filter(u => u.checked).map(u => u.id)} />
  </section>;
}
