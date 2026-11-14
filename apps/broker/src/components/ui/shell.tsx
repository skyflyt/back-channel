"use client";

/**
 * AppShell — the logged-in app chrome (from prototype variant B, "Mission Control"):
 * white top bar, brand, horizontal tab nav, Ctrl-K search, avatar menu. Used by
 * /account, /account/remote, /admin, and /sessions/[id] so the whole signed-in
 * experience reads as one product (docs/web-ia.md § The shell).
 *
 * Every page gets the same chrome, whatever it passes in:
 *   - the Home tab carries the number of things waiting on the person (`waiting`), and so does the
 *     browser tab's title, so Approvals are visible from anywhere in the app;
 *   - the command palette always offers navigation, every Settings section and target, every Devices
 *     card and help (account-nav.ts `basePaletteItems`); a page adds its own items on top;
 *   - the avatar opens a menu (who you are, Settings, shortcuts, help, sign out);
 *   - keyboard: Ctrl-K or "/" searches, "g" then h/i/l/t/d/s goes to a tab, "?" lists the shortcuts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, useCommandPalette, type PaletteItem } from "./command-palette";
import { basePaletteItems, GO_KEYS, ACCOUNT_TABS, ADMIN_TAB } from "./account-nav";
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

const GROUP_ORDER = ["Go to", "Actions", "Threads", "Friends", "Toolkit", "Settings", "Devices", "Help"];
const groupRank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.indexOf("Toolkit") + 0.5 : i; };

/** True when a keypress is going into a field, so single-key shortcuts must stay out of the way. */
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
};

const SHORTCUTS: [string, string][] = [
  ["Ctrl K  or  /", "Search everything: threads, friends, tools, settings, devices"],
  ["g  h", "Home (Approvals)"],
  ["g  i", "Inbox"],
  ["g  l", "Lists"],
  ["g  t", "Toolkit"],
  ["g  d", "Devices"],
  ["g  s", "Settings"],
  ["?", "This list"],
  ["Esc", "Close a menu or dialog"],
];

export function AppShell({ tabs, activeTab, userLabel, userTitle, onAvatarClick, paletteItems, demoBanner, waiting, owner, onSignOut, signedOut, children }: {
  tabs: ShellTab[];
  activeTab?: string;
  /** 1–2 chars for the avatar; falls back to "?" */
  userLabel?: string;
  userTitle?: string;
  /** Opens Settings in place (the dashboard); other pages link to it. */
  onAvatarClick?: () => void;
  /** The page's own palette items (threads, friends, tools…); they override base items with the same id. */
  paletteItems?: PaletteItem[];
  /** Shown under the top bar when rendering demo data (dev preview). */
  demoBanner?: React.ReactNode;
  /** Things waiting on the person (the Approvals total): badges the Home tab and the browser tab title. */
  waiting?: number | null;
  /** The owner sees Admin in the palette. */
  owner?: boolean;
  /** Overrides the default sign-out (POST /api/auth/logout, then /login). */
  onSignOut?: () => void;
  /** Nobody is signed in (a signed-out card, a transcript opened with a pasted key): brand and a Sign in link only. */
  signedOut?: boolean;
  children: React.ReactNode;
}) {
  if (signedOut) {
    return (
      <div className="ds-root">
        <header className="ds-topbar">
          <div className="ds-topbar-in">
            <a href="/" className="ds-brand">◇ Back Channel</a>
            <div className="ds-topbar-right"><a className="ds-btn ghost" style={{ textDecoration: "none" }} href="/login">Sign in</a></div>
          </div>
        </header>
        {children}
      </div>
    );
  }
  return <SignedInShell {...{ tabs, activeTab, userLabel, userTitle, onAvatarClick, paletteItems, demoBanner, waiting, owner, onSignOut }}>{children}</SignedInShell>;
}

function SignedInShell({ tabs, activeTab, userLabel, userTitle, onAvatarClick, paletteItems, demoBanner, waiting, owner, onSignOut, children }: {
  tabs: ShellTab[]; activeTab?: string; userLabel?: string; userTitle?: string; onAvatarClick?: () => void; paletteItems?: PaletteItem[];
  demoBanner?: React.ReactNode; waiting?: number | null; owner?: boolean; onSignOut?: () => void; children: React.ReactNode;
}) {
  const { open, setOpen } = useCommandPalette();
  const [menuOpen, setMenuOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // The tab row scrolls on a phone: keep the active tab in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => { navRef.current?.querySelector(".ds-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [activeTab]);

  // The browser tab shows the count too, so a backgrounded tab still says something is waiting. Next re-applies
  // the page's metadata <title> after navigations and hydration, so watch it and put the count back each time.
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\)\s+/, "") || "Back Channel";
      const want = waiting ? `(${waiting}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => mo.disconnect();
  }, [waiting]);

  const go = useCallback((key: string) => {
    const t = tabs.find((x) => x.key === key);
    if (t?.onSelect) { t.onSelect(); return; }
    const href = t?.href ?? (key === ADMIN_TAB.key ? ADMIN_TAB.href : ACCOUNT_TABS.find((x) => x.key === key)?.href);
    if (href) window.location.assign(href);
  }, [tabs]);

  const signOut = useCallback(async () => {
    if (onSignOut) { onSignOut(); return; }
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = "/login";
  }, [onSignOut]);

  // Keyboard: "/" searches, "g" + key goes to a tab, "?" shows the shortcuts, Esc closes menus.
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenuOpen(false); setKeysOpen(false); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || open) return;
      if (e.key === "/") { e.preventDefault(); setOpen(true); return; }
      if (e.key === "?") { e.preventDefault(); setKeysOpen((v) => !v); return; }
      if (e.key === "g") { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt < 1200 && GO_KEYS[e.key]) { e.preventDefault(); gAt = 0; go(GO_KEYS[e.key]); return; }
      gAt = 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, open, setOpen]);

  // Close the avatar menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // One palette on every page: the base destinations, with the page's own items layered on top.
  const allItems: PaletteItem[] = useMemo(() => {
    const page = new Map((paletteItems ?? []).map((it) => [it.id, it]));
    const merged: PaletteItem[] = basePaletteItems(!!owner || tabs.some((t) => t.key === ADMIN_TAB.key)).map((b) => page.get(b.id) ?? {
      id: b.id, group: b.group, label: b.label, meta: b.meta, keywords: b.keywords, icon: b.icon,
      onSelect: () => {
        if (b.href === "#shortcuts") { setKeysOpen(true); return; }
        const navKey = b.id.startsWith("nav-") ? b.id.slice(4) : null;
        const tab = navKey ? tabs.find((t) => t.key === navKey) : undefined;
        if (tab?.onSelect) { tab.onSelect(); return; }
        window.location.assign(b.href);
      },
    });
    const baseIds = new Set(merged.map((m) => m.id));
    for (const it of paletteItems ?? []) if (!baseIds.has(it.id)) merged.push(it);
    // Stable sort by group so each group header shows once.
    return merged.map((it, i) => ({ it, i })).sort((a, b) => groupRank(a.it.group) - groupRank(b.it.group) || a.i - b.i).map((x) => x.it);
  }, [paletteItems, tabs, owner]);

  const shownTabs = tabs.map((t) => (t.key === "home" && waiting && t.count === undefined ? { ...t, count: waiting } : t));
  const homeTitle = waiting ? `${waiting} waiting on you` : undefined;

  return (
    <div className="ds-root">
      <header className="ds-topbar">
        <div className="ds-topbar-in">
          <a href="/" className="ds-brand">◇ Back Channel</a>
          <nav className="ds-tabs" aria-label="Sections" ref={navRef}>
            {shownTabs.map((t) => {
              const label = <>{t.label}{t.count ? <span className="ds-count" aria-label={`${t.count} waiting`}>{t.count}</span> : null}</>;
              const title = t.key === "home" ? homeTitle : undefined;
              return t.href ? (
                <a key={t.key} className={`ds-tab${activeTab === t.key ? " on" : ""}`} href={t.href} title={title} aria-current={activeTab === t.key ? "page" : undefined}>{label}</a>
              ) : (
                <button key={t.key} className={`ds-tab${activeTab === t.key ? " on" : ""}`} onClick={t.onSelect} title={title} aria-current={activeTab === t.key ? "page" : undefined}>{label}</button>
              );
            })}
          </nav>
          <div className="ds-topbar-right">
            <button className="ds-searchhint" onClick={() => setOpen(true)} title="Search (Ctrl+K or /)" aria-label="Search">
              ⌕ <span className="ds-searchword">Search</span> <span className="ds-kbd">Ctrl K</span>
            </button>
            <div className="ds-menu-wrap" ref={menuRef}>
              <button className="ds-avatar" title={userTitle} onClick={() => setMenuOpen((v) => !v)} aria-label={userTitle ?? "Account menu"} aria-haspopup="menu" aria-expanded={menuOpen}>
                {userLabel || "?"}
              </button>
              {menuOpen && (
                <div className="ds-menu" role="menu">
                  {userTitle && <div className="ds-menu-head">{userTitle.replace(/ — settings$/, "")}</div>}
                  <button role="menuitem" className="ds-menu-item" onClick={() => { setMenuOpen(false); if (onAvatarClick) onAvatarClick(); else window.location.assign("/account?tab=settings"); }}>⚙ Settings</button>
                  <a role="menuitem" className="ds-menu-item" href="/account/remote">🖥 Devices</a>
                  <button role="menuitem" className="ds-menu-item" onClick={() => { setMenuOpen(false); setKeysOpen(true); }}>⌨ Keyboard shortcuts <span className="ds-kbd" style={{ marginLeft: "auto" }}>?</span></button>
                  <a role="menuitem" className="ds-menu-item" href="/faq">? Help &amp; FAQ</a>
                  <a role="menuitem" className="ds-menu-item" href="/commands">› Commands for your agent</a>
                  <div className="ds-menu-sep" />
                  <button role="menuitem" className="ds-menu-item" onClick={() => { setMenuOpen(false); void signOut(); }}>Sign out</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      {demoBanner}
      {children}
      <CommandPalette open={open} onClose={() => setOpen(false)} items={allItems} />
      {keysOpen && (
        <div className="ds-pal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setKeysOpen(false); }}>
          <div className="ds-pal" role="dialog" aria-label="Keyboard shortcuts" style={{ padding: "6px 0" }}>
            <div className="ds-pal-sec" style={{ padding: "10px 18px 6px" }}>Keyboard shortcuts</div>
            {SHORTCUTS.map(([k, what]) => (
              <div key={k} className="ds-keys-row"><span className="ds-kbd">{k}</span><span>{what}</span></div>
            ))}
            <div className="ds-pal-foot"><span>Shortcuts are off while you type in a field.</span><button className="ds-link" style={{ marginLeft: "auto" }} onClick={() => setKeysOpen(false)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
