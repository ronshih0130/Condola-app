import React from "react";
import { makeT, type Locale } from "@/i18n";
import { brandV3TeamCopy } from "@/i18n/lanes/brand-v3-r5-team";
import { brandV3AssignCopy } from "@/i18n/lanes/brand-v3-assign";
import Link from "next/link";
import { ConfirmDeactivate } from "@/components/confirm-deactivate";
import { TeamInviteLinkButton } from "@/components/team-invite-link-button";
import { actionMemberActive, actionMemberRole, actionResendInvite, actionRevokeInvite } from "@/server/auth-actions";
import type { TeamRowActions, TeamRowV3 } from "@/server/b073-team";
import { ROLE_KEYS } from "@/server/perms";

const ROLE_LABEL = { admin: "i_role_admin", manager: "i_role_manager", accountant: "i_role_accountant", maintenance: "i_role_maintenance" } as const;

/**
 * R5-TEAM row actions as text (MGT-133-AC1). 「重寄邀請」 is today's link rotation (live: the B-040 link button,
 * which copies a new link; sandbox: the legacy resend form) behind the same staff-invite gate; nothing is mailed.
 * 「更多」 opens today's B-040 actions for the row through the same server actions; R5-OFF (handover) is a later slice.
 */
export function TeamRowActionsCell({ locale, row, actions, assignHref = null }: { locale: Locale; row: TeamRowV3; actions: TeamRowActions;
  /** B-059 (GS-24): 「負責的單位」 for a maintenance row while maint_unit_assign is on; null otherwise. */
  assignHref?: string | null }) {
  const c = brandV3TeamCopy(locale);
  const t = makeT(locale);
  return <div className="v3-team-actions">
    {assignHref ? <Link className="btn txt" href={assignHref} data-testid="team-assign">{brandV3AssignCopy(locale).teamLink}</Link> : null}
    {actions.primary === "resend-link" && row.invitationId
      ? <TeamInviteLinkButton invitationId={row.invitationId} label={c.resend} buttonClassName="btn txt" />
      : actions.primary === "resend-legacy" && row.invitationId
        ? <form action={actionResendInvite}>
          <input type="hidden" name="invitationId" value={row.invitationId} />
          <button className="btn txt" type="submit">{c.resend}</button>
        </form> : null}
    {actions.more.length ? <details className="v3-team-more">
      <summary className="btn txt">{c.more}</summary>
      <div className="v3-team-more-body">
        {actions.more.map(action => {
          if (action === "locked-self") return <p className="v3-team-sub" key={action}>{t("i_own_role")}</p>;
          if (action === "locked-last-admin") return <p className="v3-team-sub" key={action}>{t("i_last_admin")}</p>;
          if (action === "role" && row.memberId) return <form action={actionMemberRole} className="v3-team-row" key={action}>
            <input type="hidden" name="memberId" value={row.memberId} />
            <select className="inp" name="role" defaultValue={row.role} aria-label={t("i_role_label")}>
              {ROLE_KEYS.map(role => <option key={role} value={role}>{t(ROLE_LABEL[role])}</option>)}
            </select>
            <button className="btn sm" type="submit">{t("i_save")}</button>
          </form>;
          if (action === "deactivate" && row.memberId) return <ConfirmDeactivate key={action} memberId={row.memberId} email={row.contact ?? row.name}
            label={t("i_deactivate")} confirmLabel={t("i_deactivate_confirm")} cancelLabel={t("i_cancel")} note={t("i_deactivate_note")} />;
          if (action === "reactivate" && row.memberId) return <form action={actionMemberActive} key={action}>
            <input type="hidden" name="memberId" value={row.memberId} />
            <input type="hidden" name="active" value="1" />
            <button className="btn sm" type="submit">{t("i_reactivate")}</button>
          </form>;
          if (action === "revoke" && row.invitationId) return <form action={actionRevokeInvite} key={action}>
            <input type="hidden" name="invitationId" value={row.invitationId} />
            <button className="btn sm danger" type="submit">{t("i_revoke")}</button>
          </form>;
          return null;
        })}
      </div>
    </details> : null}
  </div>;
}
