"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { can, visibleNav, type PermKey } from "@/server/perms";
import type { OrgRole } from "@/server/types";
import { BrandImage } from "./brand";
import { useT } from "./locale";

export function BrandLink() {
  const t = useT();
  const name = t("i_brand");
  return (
    <Link href="/" className="brand" data-testid="brand-name" aria-label={name}>
      <span className="brand-frame">
        <BrandImage variant="horizontalDark" alt="" className="brand-lockup" />
        <BrandImage variant="symbolSmall" alt="" className="brand-symbol" />
      </span>
    </Link>
  );
}

export function LocaleLinks() {
  const path = usePathname() || "/";
  const t = useT();
  const next = encodeURIComponent(path);
  return (
    <span className="seg">
      <a data-testid="locale-zh" href={`/api/demo/locale?set=zh-TW&next=${next}`}>
        {t("i_lang_zh")}
      </a>
      <a data-testid="locale-en" href={`/api/demo/locale?set=en&next=${next}`}>
        {t("i_lang_en")}
      </a>
    </span>
  );
}

export function ModeLinks() {
  const t = useT();
  return (
    <span className="tabs">
      <a href="/api/demo/mode?mode=mgr">{t("i_mode_mgr")}</a>
      <a href="/api/demo/mode?mode=ten">{t("i_mode_ten")}</a>
      <a href="/api/demo/mode?mode=own">{t("i_mode_own")}</a>
    </span>
  );
}

export function PersonaSelect({
  personas,
  current,
  testId = "persona-select",
}: {
  personas: { id: string; name: string }[];
  current: string;
  testId?: string;
}) {
  return (
    <select
      className="inp top-field"
      data-testid={testId}
      value={current}
      aria-label="persona"
      onChange={(event) => {
        window.location.href = `/api/demo/persona?id=${event.target.value}`;
      }}
    >
      {personas.map((persona) => (
        <option key={persona.id} value={persona.id}>
          {persona.name}
        </option>
      ))}
    </select>
  );
}

export function SignOutButton({ testId = "sign-out" }: { testId?: string }) {
  const t = useT();
  return (
    <form action="/api/auth/sign-out" method="post">
      <button className="btn sm" type="submit" data-testid={testId}>
        {t("i_sign_out")}
      </button>
    </form>
  );
}

export function ResetButton({ testId = "reset-demo" }: { testId?: string }) {
  const t = useT();
  return (
    <button
      className="btn sm"
      type="button"
      data-testid={testId}
      onClick={async () => {
        if (!window.confirm(t("s_7018edd"))) return;
        await fetch("/api/demo/reset", { method: "POST" });
        window.location.href = "/?reset=1";
      }}
    >
      {t("i_reset")}
    </button>
  );
}

export function TaskPanel({
  flags,
  hidden,
}: {
  flags: { property: boolean; lease: boolean; statement: boolean; repair: boolean };
  hidden: boolean;
}) {
  const t = useT();
  const path = usePathname() || "/m";
  const next = encodeURIComponent(path);
  if (hidden) {
    return (
      <div className="tasks">
        <a data-testid="show-guide" href={`/api/demo/tryout?show=1&next=${next}`}>
          {t("i_show_guide")}
        </a>
      </div>
    );
  }
  const done = [flags.property, flags.lease, flags.statement].filter(Boolean).length;
  const items = [
    ["property", flags.property, t("i_task1"), "/m/properties/new"],
    ["lease", flags.lease, t("i_task2"), "/m/leases/new"],
    ["statement", flags.statement, t("i_task3"), "/m/statements"],
    ["bonus", flags.repair, t("i_task4"), "/t/repair"],
  ] as const;
  return (
    <div className="tasks" data-testid="tryout-panel">
      <div className="tt">
        <b>{t("i_tasks_title")}</b>
        <span className="chip pri">{t("i_progress", { n: done })}</span>
        <span className="sp" />
        <a data-testid="tryout-dismiss" href={`/api/demo/tryout?hide=1&next=${next}`}>
          {t("i_dismiss_guide")}
        </a>
      </div>
      <ol>
        {items.map(([id, complete, label, href]) => (
          <li key={id} className={complete ? "done" : ""} data-testid={`tryout-task-${id}`} data-complete={complete ? "true" : "false"}>
            <span className="ck">{complete ? "✓" : ""}</span>
            <a href={href}>{label}</a>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Sidebar({
  firm,
  pending,
  tickets,
  role,
  showReset,
  showDemo,
}: {
  firm: string;
  pending: number;
  tickets: number;
  role: OrgRole | null;
  showReset: boolean;
  showDemo: boolean;
}) {
  const t = useT();
  const path = usePathname() || "/m";
  const closeNav = () => {
    const box = document.getElementById("nav-open") as HTMLInputElement | null;
    if (box) box.checked = false;
  };
  const sections = visibleNav(role);
  return (
    <aside className="side">
      <div className="org">
        <div className="av">{firm.slice(0, 1)}</div>
        <div>
          <div className="b">{firm}</div>
          {showDemo ? (
            <div className="tiny muted" data-testid="demo-badge">
              {t("i_demo_only")}
            </div>
          ) : null}
        </div>
      </div>
      {can(role, "props.edit" as PermKey) ? (
        <Link className="btn block" href="/m/properties/new">
          + {t("s_aed91da")}
        </Link>
      ) : null}
      {can(role, "leases.edit") ? (
        <Link className="btn block" href="/m/leases/new" style={{ marginTop: 8 }}>
          + {t("s_e96eefc")}
        </Link>
      ) : null}
      {sections.map((section) => (
        <div key={section.section}>
          <div className="sec">{t(section.section)}</div>
          {section.links.map((link) => {
            const on = link.href === "/m" ? path === "/m" : path === link.href || path.startsWith(`${link.href}/`);
            const badge = link.href === "/m/payments" ? pending : link.href === "/m/tickets" ? tickets : 0;
            return (
              <Link key={link.href} href={link.href} className={`it${on ? " on" : ""}`} onClick={closeNav}>
                <span>{t(link.key)}</span>
                {badge > 0 ? <span className="badge">{badge}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
      <div className="side-tools">
        <Link href="/pricing">{t("i_nav_pricing")}</Link>
        <Link href="/m/account">{t("i_account")}</Link>
        <Link href="/m/roles">{t("i_roles_title")}</Link>
        <SignOutButton testId="sign-out-drawer" />
        {showReset ? <ResetButton testId="reset-demo-drawer" /> : null}
      </div>
    </aside>
  );
}

export function FooterNote() {
  const t = useT();
  return <div className="foot">{t("i_footer", { brand: t("i_brand") })}</div>;
}
