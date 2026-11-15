/**
 * The logged-in app's tabs, defined once (docs/web-ia.md). /account, /account/remote, /admin and
 * /sessions/[id] all build their shell from this list instead of hand-copying it.
 *
 * Tabs: Home · Inbox · Lists · Toolkit · Devices · Settings, plus Admin for the owner. The keys are
 * the internal ones (`messages`, `skills`) so existing `?tab=` links keep working; older tab names
 * are aliases (TAB_ALIASES) so bookmarks, emails and the command palette don't break.
 */

import type { ShellTab } from "./shell";

/** The tabs /account renders in place (no reload). */
export type AccountPaneKey = "home" | "messages" | "lists" | "skills" | "settings";
/** Every tab key the shell can mark active. */
export type AccountTabKey = AccountPaneKey | "devices" | "admin";

export interface AccountTab { key: AccountTabKey; label: string; href: string }

export const ACCOUNT_TABS: readonly AccountTab[] = Object.freeze([
  { key: "home", label: "Home", href: "/account?tab=home" },
  { key: "messages", label: "Inbox", href: "/account?tab=messages" },
  { key: "lists", label: "Lists", href: "/account?tab=lists" },
  { key: "skills", label: "Toolkit", href: "/account?tab=skills" },
  { key: "devices", label: "Devices", href: "/account/remote" },
  { key: "settings", label: "Settings", href: "/account?tab=settings" },
]);

export const ADMIN_TAB: AccountTab = Object.freeze({ key: "admin", label: "Admin", href: "/admin" });

const PANE_KEYS: ReadonlySet<string> = new Set<AccountPaneKey>(["home", "messages", "lists", "skills", "settings"]);

/**
 * Old `?tab=` values and where they land now. `friends` opens the Inbox with the People column
 * showing; `agents` goes to the Devices page's Agents section (a different route, so /account
 * redirects there).
 */
export const TAB_ALIASES: Readonly<Record<string, AccountTabKey>> = Object.freeze({
  overview: "home",
  account: "home", // a tab before the 2026-07 redesign
  friends: "messages",
  skills: "skills",
  agents: "devices",
  remote: "devices",
});

/** Where an alias lands on the Devices page. */
export const DEVICES_ALIAS_HASH: Readonly<Record<string, string>> = Object.freeze({ agents: "#agents" });

export interface ResolvedTab {
  /** The pane /account should show, or `devices` when the link belongs to /account/remote. */
  tab: AccountTabKey;
  /** `?tab=friends`: the Inbox should open with the People column showing. */
  people: boolean;
  /** For `devices`: the full href to go to. */
  href?: string;
}

/** Turn a raw `?tab=` value into the pane to show (null when it names nothing). */
export function resolveTab(raw: string | null): ResolvedTab | null {
  if (!raw) return null;
  if (PANE_KEYS.has(raw)) return { tab: raw as AccountPaneKey, people: false };
  const alias = TAB_ALIASES[raw];
  if (!alias) return null;
  if (alias === "devices") return { tab: "devices", people: false, href: `/account/remote${DEVICES_ALIAS_HASH[raw] ?? ""}` };
  return { tab: alias, people: raw === "friends" };
}

/** Link-style tabs for the pages that are not /account (Devices, Admin, a session transcript). */
export function accountShellTabs(admin: boolean): ShellTab[] {
  const tabs: ShellTab[] = ACCOUNT_TABS.map((t) => ({ key: t.key, label: t.label, href: t.href }));
  if (admin) tabs.push({ key: ADMIN_TAB.key, label: ADMIN_TAB.label, href: ADMIN_TAB.href });
  return tabs;
}

/* ------------------------------------------------------------------------------------------------ */
/* Settings: sections, and deep links into them (docs/web-ia.md § Settings)                          */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Settings shows one section at a time, picked from a side list (chips on a phone). The defaults are
 * what most people need; each section keeps its deeper controls behind its own "Advanced" disclosure,
 * so the simple view stays simple and nothing is more than one click away for the people who want it.
 */
export type SettingsSectionKey = "account" | "notifications" | "agents" | "security" | "developer" | "activity";

export const SETTINGS_SECTIONS: readonly { key: SettingsSectionKey; label: string; blurb: string }[] = Object.freeze([
  { key: "account", label: "Account", blurb: "Who you're signed in as, and your plan." },
  { key: "notifications", label: "Notifications", blurb: "When Back Channel emails you." },
  { key: "agents", label: "Agents & Inbox", blurb: "How often your agents check in, live threads, and limits on friends' requests." },
  { key: "security", label: "Security", blurb: "Passkeys, and reading threads in this browser." },
  { key: "developer", label: "Developer", blurb: "Your developer key and the endpoints agents use." },
  { key: "activity", label: "Activity", blurb: "Sign-ins, key changes, and trust changes on your account." },
]);

export const isSettingsSection = (raw: string | null): raw is SettingsSectionKey =>
  !!raw && SETTINGS_SECTIONS.some((s) => s.key === raw);

/**
 * A place inside Settings that a link or the command palette can open: the section, whether its
 * Advanced disclosure should be open, and the element to scroll to. `?tab=settings&section=<target>`
 * accepts a section key or any key here.
 */
export interface SettingsTarget { section: SettingsSectionKey; advanced: boolean; anchor?: string; label: string; keywords: string }

export const SETTINGS_TARGETS: Readonly<Record<string, SettingsTarget>> = Object.freeze({
  "sign-out": { section: "account", advanced: false, anchor: "set-signout", label: "Sign out", keywords: "log out logout" },
  "email-alerts": { section: "notifications", advanced: false, anchor: "set-notify", label: "Email when my agent is asleep", keywords: "notifications email idle" },
  "inbox-check": { section: "agents", advanced: false, anchor: "set-inboxchk", label: "How often agents check the Inbox", keywords: "cadence schedule interval minutes hourly daily once a day inbox check" },
  "live-mode": { section: "agents", advanced: false, anchor: "set-live", label: "Live thread length", keywords: "live mode real-time window minutes" },
  "custom-cadence": { section: "agents", advanced: true, anchor: "set-cadence-custom", label: "Exact check interval", keywords: "advanced cadence custom interval minutes hours exact" },
  "friend-limits": { section: "agents", advanced: true, anchor: "set-limits", label: "Limits on friends' requests", keywords: "advanced favors limits tokens per day compute budget" },
  passkeys: { section: "security", advanced: false, anchor: "passkeys", label: "Passkeys", keywords: "passkey webauthn security approve" },
  "browser-access": { section: "security", advanced: false, anchor: "set-browser", label: "Read threads in this browser", keywords: "browser access decrypt key mirror" },
  "developer-key": { section: "developer", advanced: true, anchor: "set-devkey", label: "Developer key", keywords: "advanced api key rotate developer" },
  endpoints: { section: "developer", advanced: false, anchor: "set-endpoints", label: "Endpoints for agents (MCP, skill)", keywords: "mcp endpoint url skill reference commands" },
  activity: { section: "activity", advanced: false, anchor: "set-activity", label: "Account activity", keywords: "audit log history sign-ins" },
});

/** Resolve `?section=` to a section plus what to open and scroll to. Unknown values land on Account. */
export function resolveSettingsTarget(raw: string | null): { section: SettingsSectionKey; advanced: boolean; anchor?: string } {
  if (isSettingsSection(raw)) return { section: raw, advanced: false };
  const t = raw ? SETTINGS_TARGETS[raw] : undefined;
  return t ? { section: t.section, advanced: t.advanced, anchor: t.anchor } : { section: "account", advanced: false };
}

export const settingsHref = (target: string) => `/account?tab=settings&section=${encodeURIComponent(target)}`;

/* ------------------------------------------------------------------------------------------------ */
/* Command palette: what every page offers (pages add their own items on top)                        */
/* ------------------------------------------------------------------------------------------------ */

/** The Devices page's cards, for the palette and the page's own jump list. Ids are the cards' element ids. */
export const DEVICES_SECTIONS: readonly { id: string; label: string; keywords: string }[] = Object.freeze([
  { id: "add", label: "Add an agent, PC or phone", keywords: "connect new add code pair" },
  { id: "agents", label: "Agents", keywords: "agents claude codex connected revoke rename reconnect" },
  { id: "pcs", label: "PCs", keywords: "computers pc host" },
  { id: "phones", label: "Phones and laptops", keywords: "phone laptop mobile" },
  { id: "agent-sessions", label: "Live agent sessions", keywords: "agent using pc session approve" },
  { id: "secrets", label: "Secrets on your PCs", keywords: "secret approve broker password" },
  { id: "agents-on-pcs", label: "Agents on your PCs", keywords: "readiness checklist" },
  { id: "support-sessions", label: "Help someone", keywords: "support help code" },
  { id: "plan", label: "Plan", keywords: "billing subscription stripe remote plan" },
  { id: "get-apps", label: "Get the apps", keywords: "download install windows android" },
  { id: "connections", label: "Connection attempts", keywords: "log relay connections history" },
]);

export interface BasePaletteItem { id: string; group: string; label: string; meta?: string; keywords?: string; icon?: string; href: string }

const sectionLabel = (k: SettingsSectionKey) => SETTINGS_SECTIONS.find((s) => s.key === k)?.label ?? "Settings";

/**
 * Navigation, Settings and Devices destinations as plain links, so the palette works the same on every
 * page. /account swaps the in-page ones for handlers that switch panes without a reload.
 */
export function basePaletteItems(admin: boolean): BasePaletteItem[] {
  const items: BasePaletteItem[] = ACCOUNT_TABS.map((t) => ({ id: `nav-${t.key}`, group: "Go to", label: t.label, icon: "→", href: t.href }));
  if (admin) items.push({ id: "nav-admin", group: "Go to", label: ADMIN_TAB.label, icon: "→", href: ADMIN_TAB.href });
  items.push({ id: "act-connect", group: "Actions", label: "Connect an agent…", icon: "⚡", href: "/account/remote?add=agent" });
  items.push({ id: "act-add-pc", group: "Actions", label: "Add a PC…", icon: "🖥", href: "/account/remote?add=pc" });
  items.push({ id: "act-add-phone", group: "Actions", label: "Add a phone or laptop…", icon: "📱", href: "/account/remote?add=phone" });
  items.push({ id: "act-approvals", group: "Actions", label: "See what's waiting on me", meta: "Approvals", icon: "✓", href: "/account?tab=home#approvals" });
  for (const s of SETTINGS_SECTIONS) items.push({ id: `set-${s.key}`, group: "Settings", label: `Settings: ${s.label}`, keywords: s.blurb, icon: "⚙", href: settingsHref(s.key) });
  for (const [key, t] of Object.entries(SETTINGS_TARGETS)) items.push({ id: `set-t-${key}`, group: "Settings", label: t.label, meta: `${sectionLabel(t.section)}${t.advanced ? " · Advanced" : ""}`, keywords: t.keywords, icon: "⚙", href: settingsHref(key) });
  for (const d of DEVICES_SECTIONS) items.push({ id: `dev-${d.id}`, group: "Devices", label: d.label, meta: "Devices", keywords: d.keywords, icon: "🖥", href: `/account/remote#${d.id}` });
  items.push({ id: "help-shortcuts", group: "Help", label: "Keyboard shortcuts", keywords: "keys hotkeys", icon: "⌨", href: "#shortcuts" });
  items.push({ id: "help-faq", group: "Help", label: "FAQ", icon: "?", href: "/faq" });
  items.push({ id: "help-commands", group: "Help", label: "Commands your agent understands", icon: "?", href: "/commands" });
  items.push({ id: "help-community", group: "Help", label: "Community tools", icon: "?", href: "/lessons" });
  return items;
}

/** Keyboard shortcuts: "g" then a key goes to a tab. Shown in the shortcuts sheet ("?"). */
export const GO_KEYS: Readonly<Record<string, AccountTabKey>> = Object.freeze({ h: "home", i: "messages", l: "lists", t: "skills", d: "devices", s: "settings" });
