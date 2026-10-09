"use client";
/**
 * Lists in the browser: types for what /api/lists returns, one fetch helper
 * per endpoint (cookie auth, CSRF on writes), freshness (the live stream, with
 * the 10-second poll as its fallback: live.mjs), and the small wording helpers
 * the Lists tab and the My plate card share.
 *
 * Shapes follow src/lib/lists.ts (the op* functions) and taskView/entryView in
 * src/lib/lists/rules.mjs. Errors carry the server's plain-sentence `message`.
 */
import { useEffect, useRef } from "react";
import { createListsFeed, createSharedFeed, STREAM_URL } from "./live.mjs";

/* ---------------------------------- types ---------------------------------- */

export type TaskStatus = "open" | "in_progress" | "blocked" | "needs_review" | "done" | "dropped";
export type Access = "none" | "view" | "work";
/** Whose tasks a person's agents may take without an OK, on one list (their own setting). */
export type AgentsTakeFrom = "me" | "anyone";
/** Email nudges for one person on one list: off, or mentions, results to check and OK requests (at most one an hour). */
export type ListNotify = "off" | "mentions_reviews";
/** The only reactions there are, in display order. */
export const REACTIONS = ["\u{1F44D}", "\u{1F389}", "\u{1F64F}", "✅"] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];
export interface ReactionCount { emoji: ReactionEmoji; count: number; you: boolean }

/** A person, or an agent and its person. */
export interface PersonRef {
  person: string;
  handle: string | null;
  agent: string | null;
  agent_id: string | null;
  is_you: boolean;
  /** Only when an agent is asking. */
  is_this_agent?: boolean;
}

export interface ListRef { id: string; name: string; shared: boolean }

export interface TaskView {
  id: string;
  list: ListRef;
  title: string;
  notes: string;
  version: number;
  status: TaskStatus;
  due: string | null;
  created_by: PersonRef | null;
  assignee: (PersonRef & { kind: "person" | "their_agents" | "agent" }) | null;
  claim: { by: PersonRef | null; since: string | null; lapses_at: string | null; stale?: boolean } | null;
  /** The OK rule for the caller's own agents. false on a friend's task until the caller OKs it (POST .../ok). */
  agent_may_act: { ok: boolean; why: string };
  /** Only reactions someone gave, in REACTIONS order. `you`: the caller reacted. */
  reactions: ReactionCount[];
  created_at: string | null;
  updated_at: string | null;
  completed_at?: string;
  completed_by?: PersonRef | null;
  summary?: string;
  needs_review_by?: PersonRef | null;
  send_back_until?: string;
  /** On list and plate views, for tasks being worked: the latest progress line. */
  last_progress?: { text: string; by: PersonRef | null; at: string | null } | null;
  /** On list and plate views, for blocked tasks: what it's blocked on. */
  blocked_reason?: string | null;
}

export interface EntryView {
  id: string;
  kind: "comment" | "progress" | "event";
  by: PersonRef | null;
  event?: string;
  text: string;
  at: string | null;
}

export interface TaskDetail extends TaskView { entries: EntryView[] }

export interface ListSummary {
  id: string;
  name: string;
  emoji: string | null;
  archived: boolean;
  shared: boolean;
  your_role: string | null;
  counts: { open: number; in_progress: number; blocked: number; needs_review: number; done: number };
  agents?: { agent_id: string; access: Access }[];
}

export interface YourAgent {
  id: string;
  name: string;
  runtime_type: string | null;
  last_used_at: string | null;
  hosted: boolean;
  access: Access;
}

/** Someone on a list, as everyone on it sees them. Owner first, then by when they joined. */
export interface MemberView {
  handle: string | null;
  display_name: string | null;
  role: "owner" | "member";
  joined_at: string | null;
  is_you: boolean;
  /** What to type to mention them in a comment ("@alex"). */
  mention: string | null;
  /** Their agents with access to this list, and the mention that reaches each ("@claude-code"). */
  agents: { name: string; access: Exclude<Access, "none">; mention: string }[];
}

/** A list-level activity line: "Skylar added Alex", "Alex left the list", "Skylar took Alex off the list". */
export interface ListEventView {
  id: string;
  event: "member_added" | "member_left" | "member_removed";
  by: PersonRef | null;
  subject: PersonRef | null;
  /** Read as "<whoName(by)> <text>". */
  text: string;
  at: string | null;
}

export interface ListDetail {
  list: ListRef & { emoji: string | null; archived: boolean; your_role: string | null; agents_take_from: AgentsTakeFrom; notify: ListNotify };
  /** Everyone on the list who still counts (a friend who untrusted the owner drops out at once). */
  members: MemberView[];
  /** The last 20 list-level events, oldest first. */
  activity: ListEventView[];
  tasks: TaskView[];
  your_agents?: YourAgent[];
}

/** A comment or progress line that mentions you (or, for an agent, it or its person). */
export interface MentionView {
  id: string;
  /** Who was mentioned: you, or (for an agent asking) it or its person. */
  of: PersonRef | null;
  entry: EntryView;
  task: TaskView;
}

export interface Plate {
  lists: { id: string; name: string; emoji: string | null; shared: boolean }[];
  doing: TaskView[];
  up_next: TaskView[];
  claimable: TaskView[];
  /** Finished work for you to check (needs_review with you as the reviewer). */
  waiting_on_you: TaskView[];
  /**
   * "OK for my agents?": friends' tasks (for you, for your agents, or unassigned on a list where one of your
   * agents has work access) that your agents can't act on until you OK them. Up to 20, by due date. A task
   * can also be in up_next.
   */
  ok_requests: TaskView[];
  /** Unread mentions of you, newest first, up to 20. Opening the task (GET /api/lists/tasks/:id) marks them read. */
  mentions: MentionView[];
  done_recently: TaskView[];
  hint?: string;
}

/** A peer as GET /api/trust lists it. Only `mutual` friends can be added to a list. */
export interface TrustPeer {
  handle: string;
  last_session_at: string | null;
  trusted: boolean;
  mutual: boolean;
  established_at: string | null;
}

/**
 * A template a list can start from: one of the four built-ins ("builtin:<slug>")
 * or one the person saved. `preview` is its first five task titles.
 */
export interface TemplateView {
  id: string;
  kind: "builtin" | "saved";
  name: string;
  emoji: string | null;
  count: number;
  preview: string[];
  created_at?: string | null;
}

/** The person's own Lists settings: the opt-in daily summary email. */
export interface ListsPreferences {
  digest: "off" | "daily";
  /** 0 to 23, in `timezone`. */
  digest_hour: number;
  timezone: string | null;
  last_digest_at: string | null;
  /** False when the account has no verified email to send it to. */
  email_ready: boolean;
}

/** An agent as /api/account/agents lists it (for the new-list form). */
export interface AccountAgent {
  id: string;
  name: string;
  runtime_type: string;
  scope?: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/* --------------------------------- fetching -------------------------------- */

/** Read the non-httpOnly bc_csrf cookie to echo in the x-bc-csrf header. */
export const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export class ListsError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const OFFLINE = "Couldn't reach Back Channel. Check your connection and try again.";

async function call<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: method === "GET" ? undefined : { "content-type": "application/json", "x-bc-csrf": csrf() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ListsError(0, "offline", OFFLINE);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const { error, message, ...extra } = data;
    const fallback = res.status === 401 ? "Your sign-in expired. Refresh the page to sign in again." : "Something went wrong. Try again.";
    throw new ListsError(res.status, typeof error === "string" ? error : "error", typeof message === "string" && message ? message : fallback, extra);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const listsApi = {
  lists: () => call<{ lists: ListSummary[] }>("GET", "/api/lists"),
  /**
   * A new list: blank, from a template (`template`: a built-in "builtin:<slug>" or a saved template's id; name and
   * emoji default to the template's), or a copy of a list you can see (`duplicate`: its unfinished tasks).
   */
  createList: (body: { name?: string; emoji?: string; agents?: string[]; template?: string; duplicate?: string }) =>
    call<{ list: { id: string; name: string; emoji: string | null }; tasks_added?: number }>("POST", "/api/lists", body),
  plate: () => call<Plate>("GET", "/api/lists/plate"),
  changes: (since: string | null) => call<{ at: string; changed: boolean }>("GET", `/api/lists/changes${since ? `?since=${enc(since)}` : ""}`),
  getList: (id: string) => call<ListDetail>("GET", `/api/lists/${enc(id)}`),
  updateList: (id: string, body: { name?: string; emoji?: string | null; archived?: boolean }) => call<{ list: unknown }>("PATCH", `/api/lists/${enc(id)}`, body),
  setAgentAccess: (id: string, agentId: string, access: Access) => call<{ agent_id: string; access: Access }>("PUT", `/api/lists/${enc(id)}/agents`, { agent_id: agentId, access }),
  addTask: (listId: string, body: { title: string; notes?: string; assignee?: string; due?: string }) =>
    call<{ tasks: TaskView[] }>("POST", `/api/lists/${enc(listId)}/tasks`, body),
  getTask: (taskId: string) => call<{ task: TaskDetail }>("GET", `/api/lists/tasks/${enc(taskId)}`),
  updateTask: (taskId: string, body: Record<string, unknown>) => call<{ task: TaskView }>("PATCH", `/api/lists/tasks/${enc(taskId)}`, body),
  claim: (taskId: string) => call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/claim`, {}),
  release: (taskId: string, reason?: string) => call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/release`, reason ? { reason } : {}),
  done: (taskId: string, summary?: string) => call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/done`, summary ? { summary } : {}),
  review: (taskId: string, verdict: "accept" | "send_back", comment?: string) =>
    call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/review`, comment ? { verdict, comment } : { verdict }),
  entries: (taskId: string) => call<{ entries: EntryView[]; more?: boolean }>("GET", `/api/lists/tasks/${enc(taskId)}/entries`),
  addEntry: (taskId: string, kind: "comment" | "progress", text: string) => call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/entries`, { kind, text }),
  accountAgents: () => call<{ agents: AccountAgent[] }>("GET", "/api/account/agents"),

  /* Sharing (Phase 2). Members, settings and OKs are cookie-only. */

  /** Owner only. A non-friend and an unknown handle both fail with 403 not_a_friend ("You can only add friends to a list."). */
  addMember: (listId: string, handle: string) => call<{ members: MemberView[] }>("POST", `/api/lists/${enc(listId)}/members`, { handle }),
  /** The owner takes someone off. Returns the members left. */
  removeMember: (listId: string, handle: string) => call<{ members: MemberView[] }>("DELETE", `/api/lists/${enc(listId)}/members/${enc(handle)}`),
  /** Leave a list you don't own (pass your own handle). The owner gets 409 owner_cant_leave. */
  leaveList: (listId: string, yourHandle: string) => call<{ left: true }>("DELETE", `/api/lists/${enc(listId)}/members/${enc(yourHandle)}`),
  /** Your own settings on one list. */
  updateMe: (listId: string, body: { agents_take_from?: AgentsTakeFrom; notify?: ListNotify }) =>
    call<{ me: { agents_take_from: AgentsTakeFrom; notify: ListNotify } }>("PATCH", `/api/lists/${enc(listId)}/me`, body),
  /** "OK for my agents": your agents may act on this friend's task. Harmless to repeat. 409 bad_status unless open, in progress or blocked. */
  okTask: (taskId: string) => call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/ok`, {}),
  /** Toggle one of REACTIONS on a task. */
  react: (taskId: string, emoji: ReactionEmoji) => call<{ task: TaskView }>("POST", `/api/lists/tasks/${enc(taskId)}/react`, { emoji }),
  /** Your friends and would-be friends (the member picker offers the mutual ones). */
  friends: () => call<{ peers: TrustPeer[] }>("GET", "/api/trust"),

  /* Phase 3: templates and the daily summary. Saving, deleting and the summary are cookie-only. */

  /** The four built-ins, then the templates you saved. */
  templates: () => call<{ templates: TemplateView[] }>("GET", "/api/lists/templates"),
  /** Save a list's unfinished tasks that you or your agents wrote. `skipped`: unfinished tasks other people wrote, left out. */
  saveTemplate: (listId: string, body: { name?: string; emoji?: string | null } = {}) =>
    call<{ template: TemplateView; skipped: number }>("POST", "/api/lists/templates", { list_id: listId, ...body }),
  deleteTemplate: (id: string) => call<{ deleted: true }>("DELETE", `/api/lists/templates/${enc(id)}`),
  preferences: () => call<{ preferences: ListsPreferences }>("GET", "/api/lists/preferences"),
  updatePreferences: (body: { digest?: "off" | "daily"; digest_hour?: number; timezone?: string | null }) =>
    call<{ preferences: ListsPreferences }>("PATCH", "/api/lists/preferences", body),
};

export const errorText = (e: unknown) => (e instanceof ListsError ? e.message : "Something went wrong. Try again.");

/* -------------------------------- freshness -------------------------------- */

/**
 * The page's one feed: the live stream (GET /api/lists/stream, cookie-only
 * SSE) when the browser has EventSource, falling back to polling
 * /api/lists/changes every 10 seconds while the page is visible whenever the
 * stream isn't there. Shared by everything on the page, so a tab holds one
 * stream however many components listen (the server allows two per account).
 */
const sharedFeed = createSharedFeed((onChange) =>
  createListsFeed({
    onChange,
    fetchChanges: (since) => listsApi.changes(since),
    openStream: typeof window !== "undefined" && typeof window.EventSource === "function" ? () => new EventSource(STREAM_URL) : null,
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
    watchVisibility: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  }),
);

/**
 * Call `onChange` whenever anything the person can see changed, through the
 * live stream or, when it isn't available, the 10-second poll. It also runs
 * once at the start, even in a background tab, so the hook does the initial
 * load.
 */
export function useListChanges(onChange: () => void, enabled = true) {
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!enabled) return;
    return sharedFeed.subscribe(() => latest.current());
  }, [enabled]);
}

/* ----------------------------- opening a task ------------------------------ */

export const LISTS_OPEN_EVENT = "bc:lists-open";
export interface ListsTarget { listId?: string; taskId?: string; newList?: boolean }

/**
 * Point the Lists tab at a list or task (or the new-list form) from anywhere
 * on the page: the URL carries it for a fresh mount, and an event tells a
 * Lists tab that's already showing. The caller then switches to the tab.
 */
export function openListsAt(target: ListsTarget) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("list");
  url.searchParams.delete("task");
  if (target.listId) url.searchParams.set("list", target.listId);
  if (target.taskId) url.searchParams.set("task", target.taskId);
  if (target.newList) url.searchParams.set("list", "new");
  window.history.replaceState({}, "", url.pathname + url.search);
  window.dispatchEvent(new CustomEvent<ListsTarget>(LISTS_OPEN_EVENT, { detail: target }));
}

/* --------------------------------- wording --------------------------------- */

const short = (name: string) => name.replace(/@bc$/, "");

/** "Skylar's Claude Code", or just "Alex's Claude" when the agent's name already says whose it is. */
function agentOf(person: string, agent: string): string {
  const p = short(person).toLowerCase();
  return agent.toLowerCase().replace(/’/g, "'").startsWith(`${p}'s `) ? agent : `${short(person)}'s ${agent}`;
}

/** "You", "Skylar", or "Skylar's Claude Code". */
export function whoName(ref: PersonRef | null | undefined): string {
  if (!ref) return "Nobody";
  if (ref.agent) return agentOf(ref.person, ref.agent);
  return ref.is_you ? "You" : short(ref.person);
}

/**
 * Who did something, as a byline next to an avatar: "Alex", "You", or for an
 * agent's work "Alex · via Codex" (the person first: agents act for them).
 */
export function attribution(ref: PersonRef | null | undefined): string {
  if (!ref) return "Nobody";
  const person = ref.is_you ? "You" : short(ref.person);
  return ref.agent ? `${person} · via ${ref.agent}` : person;
}

/** Someone on a list as a PersonRef, for their avatar. */
export function memberRef(m: MemberView): PersonRef {
  return { person: m.display_name || m.handle || "someone", handle: m.handle, agent: null, agent_id: null, is_you: m.is_you };
}

/** "Alex", or their handle when they have no display name. */
export const memberLabel = (m: MemberView) => (m.display_name && m.display_name.trim()) || short(m.handle ?? "") || "someone";

/**
 * Would your agents take this friend's task, once you OK it? The same test as
 * the plate's ok_requests (okRequests in src/lib/lists/rules.mjs): someone else
 * wrote it, it's open or blocked with nobody on it, it's for you, your agents,
 * or anyone (then only where one of your agents has work access), and neither
 * an OK nor your list setting covers it yet.
 */
export function needsMyOk(t: TaskView, agentsCanWork: boolean): boolean {
  if (t.agent_may_act.ok || t.created_by?.is_you) return false;
  if ((t.status !== "open" && t.status !== "blocked") || t.claim) return false;
  if (t.assignee) return t.assignee.is_you;
  return agentsCanWork;
}

/** Who a task waiting for a check is waiting for: you, or "Alex". */
export function reviewerLabel(t: Pick<TaskView, "needs_review_by">): string {
  const r = t.needs_review_by;
  if (!r) return "someone";
  return r.is_you ? "you" : short(r.person);
}

/** The person's own agents read better as just the agent's name in tight spots. */
export function whoShort(ref: PersonRef | null | undefined): string {
  if (!ref) return "Nobody";
  if (ref.agent) return ref.is_you ? ref.agent : agentOf(ref.person, ref.agent);
  return ref.is_you ? "You" : short(ref.person);
}

/** Who a task is for, as a short phrase. */
export function assigneeLabel(t: Pick<TaskView, "assignee">): string | null {
  const a = t.assignee;
  if (!a) return null;
  if (a.kind === "agent") return `For ${a.is_you ? a.agent : whoName(a)}`;
  if (a.kind === "their_agents") return a.is_you ? "For your agents" : `For ${short(a.person)}'s agents`;
  return a.is_you ? "For you" : `For ${short(a.person)}`;
}

/**
 * The assignee value for a task, in the vocabulary PATCH accepts: "nobody", "me", "my_agents", one of your
 * agent ids, or for someone else on a shared list "@alex" / "@alex's agents".
 */
export function assigneeValue(t: Pick<TaskView, "assignee">): string {
  const a = t.assignee;
  if (!a) return "nobody";
  if (a.kind === "agent") return a.agent_id ?? "nobody";
  const other = !a.is_you && a.handle ? `@${short(a.handle)}` : null;
  if (a.kind === "their_agents") return other ? `${other}'s agents` : "my_agents";
  return other ?? "me";
}

/** "just now", "6 min ago", "3 h ago", "2 days ago", then a date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const secs = (now - t) / 1000;
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "6 min" or "2 h" of elapsed time, for "Claude Code · 6 min". */
export function elapsed(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** "lapses in 42 min" for an agent's claim. */
export function lapsesIn(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const mins = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (mins <= 0) return "lapsing now";
  return `lapses in ${mins} min`;
}

/** A due date's calendar day ("2026-10-16"). Dues are stored at noon UTC, so the UTC day is the day. */
export const dueDay = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

/** Today in the person's own calendar ("2026-10-09"). */
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "Fri, Oct 16" for a "YYYY-MM-DD" day. */
export function dayName(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00.000Z`);
  return d.toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/** The due chip: label plus whether it's overdue or today. */
export function dueInfo(iso: string | null | undefined, now = new Date()): { label: string; tone?: "warn" | "acc" } | null {
  const day = dueDay(iso);
  if (!day) return null;
  const today = todayLocal(now);
  const tomorrow = todayLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12));
  if (day < today) return { label: `Overdue · ${dayName(day)}`, tone: "warn" };
  if (day === today) return { label: "Due today", tone: "acc" };
  if (day === tomorrow) return { label: "Due tomorrow" };
  return { label: `Due ${dayName(day)}` };
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  needs_review: "Ready for you",
  done: "Done",
  dropped: "Dropped",
};

/** The wording an activity line uses, from the event's stored text ("picked this up"). */
export function eventLine(e: EntryView): string {
  // "OK'd this for their agents" reads oddly after "You".
  const text = e.event === "ok" && e.by?.is_you && !e.by.agent ? e.text.replace("for their agents", "for your agents") : e.text;
  return `${whoName(e.by)} ${text}`;
}

/** A list-level activity line: "Skylar added Alex", "You took Carol off the list". */
export function listEventLine(e: ListEventView): string {
  return `${whoName(e.by)} ${e.text}`;
}

/** What each reaction means, for screen readers and tooltips. */
export const REACTION_LABEL: Record<ReactionEmoji, string> = {
  "\u{1F44D}": "thumbs up",
  "\u{1F389}": "celebrate",
  "\u{1F64F}": "thanks",
  "✅": "done",
};

/** What a blocked event said it was blocked on, if anything. */
export function blockedReason(e: EntryView): string | null {
  if (e.kind !== "event" || e.event !== "blocked") return null;
  const i = e.text.indexOf(": ");
  return i >= 0 ? e.text.slice(i + 2) : null;
}

/** Runtime names, matching the Agents tab. */
export const RUNTIME_LABEL: Record<string, string> = {
  cowork: "Cowork", codex: "Codex", claude_code: "Claude Code", chatgpt: "ChatGPT", other: "Other",
};

/** "active 2 min ago" health text for the access editor and new-list form, from when Back Channel last heard from an agent. */
export function agentActivity(lastUsedAt: string | null): { label: string; color: string } {
  if (!lastUsedAt) return { label: "never used", color: "#94a3b8" };
  const mins = (Date.now() - new Date(lastUsedAt).getTime()) / 60_000;
  const color = mins < 15 ? "#10b981" : mins < 120 ? "#eab308" : mins < 1440 ? "#f97316" : "#ef4444";
  return { label: `active ${ago(lastUsedAt)}`, color };
}
