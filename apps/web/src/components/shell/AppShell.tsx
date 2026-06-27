// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { NavIcon } from "@/components/shell/NavIcon";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { pluginNav } from "@/plugins/registry.generated";
import {
  ADMIN_CONTRIBUTION,
  bottomTabs,
  chatSection,
  CORE_CONTRIBUTION,
  isActive,
  moreSections,
  railGroups,
  resolveSections,
  SETTINGS_SECTION,
  TOOLS_CONTRIBUTION,
  type NavSection,
} from "@/lib/shell/nav";

/**
 * The product shell (UI_DESIGN_BRIEF §4).
 *
 * - **Desktop (≥1024px):** a persistent left rail — Chat pinned at top,
 *   domain groups, System group, Settings at the foot.
 * - **Mobile:** a bottom tab bar (Chat + top domain homes + More) plus a
 *   global quick-add FAB; detail/menus open as bottom sheets.
 *
 * Visibility is pure CSS (`.rail` / `.tabbar` media queries), so one
 * tree serves both. Nav sections come from the resolved bundle
 * contributions (core only for now).
 */
export function AppShell({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  // Filter to only show non-integration bundles in the rail.
  // Integrations (group="Integrations") are demoted to Settings instead of the main nav.
  const contributedNav = React.useMemo(
    () => pluginNav
      .filter((c) => c.group !== "Integrations")
      .map((c) => ({ ...c, sections: c.sections.filter((s) => s.href !== "/p/fs") }))
      .filter((c) => c.sections.length > 0),
    [],
  );
  const sections = React.useMemo(
    () => resolveSections([CORE_CONTRIBUTION, TOOLS_CONTRIBUTION, ADMIN_CONTRIBUTION, ...contributedNav]),
    [contributedNav],
  );
  const chat = chatSection(sections);
  const groups = React.useMemo(() => railGroups(sections), [sections]);
  const tabs = React.useMemo(() => bottomTabs(sections), [sections]);
  const more = React.useMemo(
    () => moreSections(sections).filter((s) => !s.desktopOnly),
    [sections],
  );

  const [moreOpen, setMoreOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [accountOpen, setAccountOpen] = React.useState(false);

  // The quick-add FAB sits bottom-right — exactly where the chat composer's
  // Send button is. On chat screens it both overlaps Send and is redundant
  // (you're already in chat; its only base action is "New chat"), so hide it
  // there and keep it on other screens for bundle-contributed quick actions.
  const onChat = pathname === "/" || pathname.startsWith("/c/");

  // Close transient sheets on navigation.
  React.useEffect(() => {
    setMoreOpen(false);
    setAddOpen(false);
    setAccountOpen(false);
  }, [pathname]);

  // Sign out, then hard-redirect to /login so all in-memory + cookie state is gone.
  const onSignOut = React.useCallback(async () => {
    await signOut();
    window.location.href = "/login";
  }, [signOut]);

  const initial = (user?.email?.[0] ?? "E").toUpperCase();

  return (
    <div className="appshell">
      {/* ---- desktop rail ---- */}
      <aside className="rail">
        <Link href="/" className="rail__brand">
          <span className="mk">
            <Sparkles className="i-sm" aria-hidden />
          </span>
          eidan
        </Link>

        {chat ? <RailLink section={chat} pathname={pathname} /> : null}

        {groups.map((g) => (
          <div key={g.key}>
            <div className="rail__group">{g.label}</div>
            {g.sections.map((s) => (
              <RailLink key={s.id} section={s} pathname={pathname} />
            ))}
          </div>
        ))}

        <div className="rail__spacer" />
        <RailLink section={SETTINGS_SECTION} pathname={pathname} />
      </aside>

      {/* ---- main column ---- */}
      <div className="app-main">
        <header className="shellhead">
          <Link href="/" className="shellhead__brand lg:hidden">
            <span className="mk">
              <Sparkles className="i-sm" aria-hidden />
            </span>
            eidan
          </Link>
          <div className="shellhead__right">
            <ThemeToggle />
            <button
              type="button"
              className="avatar"
              aria-label="Account"
              aria-haspopup="dialog"
              onClick={() => setAccountOpen(true)}
            >
              {initial}
            </button>
          </div>
        </header>

        <main className="app-scroll">{children}</main>

        {/* ---- mobile bottom bar ---- */}
        <nav className="tabbar" aria-label="Primary">
          {tabs.map((s) => (
            <Link
              key={s.id}
              href={s.href}
              className="tab"
              aria-current={isActive(s, pathname) ? "page" : undefined}
            >
              <NavIcon name={s.icon} />
              {s.label}
            </Link>
          ))}
          <button type="button" className="tab" onClick={() => setMoreOpen(true)}>
            <NavIcon name="more" />
            More
          </button>
          {!onChat ? (
            <button
              type="button"
              className="fab"
              onClick={() => setAddOpen(true)}
              aria-label="Quick add"
            >
              <Plus className="i" aria-hidden />
            </button>
          ) : null}
        </nav>
      </div>

      {/* ---- mobile "More" sheet ---- */}
      {moreOpen ? (
        <Sheet onClose={() => setMoreOpen(false)} className="moremenu" label="All sections">
          <div className="sheet-head">
            <h3>All sections</h3>
            <button type="button" className="btn--quiet" onClick={() => setMoreOpen(false)}>
              Done
            </button>
          </div>
          <div className="menu-grid">
            {more.map((s) => (
              <Link
                key={s.id}
                href={s.href}
                className="menu-cell"
                aria-current={isActive(s, pathname) ? "page" : undefined}
              >
                <NavIcon name={s.icon} />
                {s.label}
              </Link>
            ))}
          </div>
        </Sheet>
      ) : null}

      {/* ---- global quick-add sheet (preset actions land as bundles install) ---- */}
      {addOpen ? (
        <Sheet onClose={() => setAddOpen(false)} className="qsheet" label="Quick add">
          <div className="sheet__grip" />
          <div className="sheet-head">
            <h3>Quick add</h3>
            <button type="button" className="btn--quiet" onClick={() => setAddOpen(false)}>
              Close
            </button>
          </div>
          <p className="screen-sub" style={{ marginBottom: "var(--s4)" }}>
            Context-aware actions (log a meal, a check-in, a deal…) appear here as
            bundles are installed.
          </p>
          <Link href="/" className="btn btn--primary btn--block" onClick={() => setAddOpen(false)}>
            New chat
          </Link>
        </Sheet>
      ) : null}

      {/* ---- account menu (avatar) ---- */}
      {accountOpen ? (
        <Sheet onClose={() => setAccountOpen(false)} className="qsheet" label="Account">
          <div className="sheet__grip" />
          <div className="sheet-head">
            <h3>Account</h3>
            <button type="button" className="btn--quiet" onClick={() => setAccountOpen(false)}>
              Close
            </button>
          </div>
          {user?.email ? (
            <p className="screen-sub" style={{ marginBottom: "var(--s4)" }}>
              Signed in as {user.email}
            </p>
          ) : null}
          <Link
            href="/settings"
            className="btn btn--block"
            onClick={() => setAccountOpen(false)}
            style={{ marginBottom: "var(--s3)" }}
          >
            Settings
          </Link>
          <button type="button" className="btn btn--primary btn--block" onClick={onSignOut}>
            Sign out
          </button>
        </Sheet>
      ) : null}
    </div>
  );
}

function RailLink({
  section,
  pathname,
}: {
  section: NavSection;
  pathname: string;
}): React.ReactElement {
  return (
    <Link
      href={section.href}
      className="navitem"
      aria-current={isActive(section, pathname) ? "page" : undefined}
      title={section.label}
    >
      <NavIcon name={section.icon} />
      <span className="navitem__label">{section.label}</span>
    </Link>
  );
}

function Sheet({
  children,
  onClose,
  className,
  label,
}: {
  children: React.ReactNode;
  onClose: () => void;
  className: string;
  label: string;
}): React.ReactElement {
  // Close on backdrop click or Escape; the inner sheet swallows clicks.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className={className} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
