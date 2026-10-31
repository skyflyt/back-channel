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
