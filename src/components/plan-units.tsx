import Link from "next/link";
import type { CSSProperties } from "react";
import type { T } from "@/i18n";
import type { UnitLimitView } from "@/server/unit-limit-store";
import { UnitKeepPicker } from "./unit-keep-picker";

export function PlanUnits({ t, view, admin }: { t: T; view: UnitLimitView; admin: boolean }) {
  const showLimit = view.phase === "grace" || view.phase === "locked";
  const showPending = view.pending != null && view.nextStart;
  if (!showLimit && !showPending) return null;
  return (
    <div data-testid="plan-limit" data-phase={view.phase} style={{ marginBottom: 16 }}>
      {view.phase === "grace" ? (
        <div className="alert warn plan-banner" data-testid="plan-grace" data-grace-left={view.graceDaysLeft}>
          <p data-testid="plan-s15">{t("i_plan_s15_banner", { n: view.spaceCount, left: view.graceDaysLeft })}</p>
          <p data-testid="plan-s12">{t("i_plan_s12_after", { n: view.otherCount })}</p>
          <Link className="btn pri" href="/pricing">
            {t("i_plan_s16_upgrade")}
          </Link>
          {admin ? (
            <UnitKeepPicker
              spaces={view.spaces}
              keptIds={view.spaces.filter((space) => space.kept).map((space) => space.id)}
              limit={4}
              openLabel={t("i_plan_s16_pick")}
              title={t("i_plan_s17_title")}
              lead={t("i_plan_s17_lead")}
              createdLabel={t("i_plan_s17_created")}
              note={t("i_plan_s17_note")}
              saveLabel={t("i_save")}
              cancelLabel={t("i_cancel")}
            />
          ) : null}
        </div>
      ) : null}
      {view.phase === "locked" ? (
        <div className="alert warn plan-banner" data-testid="plan-s16">
          <p>{t("i_plan_s16_banner")}</p>
          {admin ? (
            <UnitKeepPicker
              spaces={view.spaces}
              keptIds={view.spaces.filter((space) => space.kept).map((space) => space.id)}
              limit={4}
              openLabel={t("i_plan_s16_pick")}
              title={t("i_plan_s17_title")}
              lead={t("i_plan_s17_lead")}
              createdLabel={t("i_plan_s17_created")}
              note={t("i_plan_s17_note")}
              saveLabel={t("i_save")}
              cancelLabel={t("i_cancel")}
            />
          ) : null}
          <Link className="btn pri" href="/pricing">
            {t("i_plan_s16_upgrade")}
          </Link>
        </div>
      ) : null}
      {showPending ? (
        <p className="small" data-testid="plan-next-period" data-billed={view.billed ?? ""} data-pending={view.pending} data-active={view.active}>
          <span className="nw">
            {view.nextStart?.replaceAll("-", "/")} {t("i_plan_s12_next")}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export function ReadOnlyAction({
  testId,
  className,
  label,
  note,
  style,
}: {
  testId: string;
  className: string;
  label: string;
  note: string;
  style?: CSSProperties;
}) {
  return (
    <span className="locked-edit">
      <button
        className={className}
        type="button"
        disabled
        aria-disabled="true"
        data-testid={testId}
        data-i18n-key="i_readonly_edit_pending"
        title={note}
        style={style}
      >
        {label}
      </button>
      <span className="small muted" data-testid="readonly-edit-note" data-i18n-key="i_readonly_edit_pending">
        {note}
      </span>
    </span>
  );
}

export function LockedEditButton({ label, note }: { label: string; note: string }) {
  return <ReadOnlyAction testId="edit-locked" className="btn sm" label={label} note={note} />;
}
