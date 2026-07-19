"use client";

/**
 * AppShell — the logged-in app chrome (from prototype variant B, "Mission Control"):
 * white top bar, brand, horizontal tab nav, ⌘K search hint, avatar. Used by
 * /account, /admin, and /sessions/[id] so the whole signed-in experience reads
 * as one product.
 */

import { CommandPalette, useCommandPalette, type PaletteItem } from "./command-palette";
import "./theme.css";

export interface ShellTab {
  key: string;
  label: string;
  /** Badge count (e.g. items needing attention). */
  count?: number;
  /** href for link-style tabs (admin/sessions); omit when using onSelect. */
  href?: string;
  onSelect?: () => void;
}

export function AppShell({ tabs, activeTab, userLabel, userTitle, onAvatarClick, paletteItems, demoBanner, children }: {
  tabs: ShellTab[];
  activeTab?: string;
  /** 1–2 chars for the avatar; falls back to "?" */
  userLabel?: string;
  userTitle?: string;
  onAvatarClick?: () => void;
  paletteItems?: PaletteItem[];
  /** Shown under the top bar when rendering demo data (dev preview). */
  demoBanner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { open, setOpen } = useCommandPalette();

  return (
    <div className="ds-root">
      <header className="ds-topbar">
        <div className="ds-topbar-in">
          <a href="/" className="ds-brand">◇ Back Channel</a>
          <nav className="ds-tabs" aria-label="Sections">
            {tabs.map((t) =>
              t.href ? (
                <a key={t.key} className={`ds-tab${activeTab === t.key ? " on" : ""}`} href={t.href}>
                  {t.label}{t.count ? <span className="ds-count">{t.count}</span> : null}
                </a>
              ) : (
                <button key={t.key} className={`ds-tab${activeTab === t.key ? " on" : ""}`} onClick={t.onSelect}>
                  {t.label}{t.count ? <span className="ds-count">{t.count}</span> : null}
                </button>
              )
            )}
          </nav>
          <div className="ds-topbar-right">
            {paletteItems && paletteItems.length > 0 && (
              <button className="ds-searchhint" onClick={() => setOpen(true)} title="Search (Ctrl+K)">
                ⌕ Search <span className="ds-kbd">Ctrl K</span>
              </button>
            )}
            <button className="ds-avatar" title={userTitle} onClick={onAvatarClick} aria-label={userTitle ?? "Account"}>
              {userLabel || "?"}
            </button>
          </div>
        </div>
      </header>
      {demoBanner}
      {children}
      {paletteItems && (
        <CommandPalette open={open} onClose={() => setOpen(false)} items={paletteItems} />
      )}
    </div>
  );
}
