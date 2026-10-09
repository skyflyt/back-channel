"use client";
/**
 * Lists in the browser: types for what /api/lists returns, one fetch helper
 * per endpoint (cookie auth, CSRF on writes), the 10-second freshness poll,
 * and the small wording helpers the Lists tab and the My plate card share.
 *
 * Shapes follow src/lib/lists.ts (the op* functions) and taskView/entryView in
 * src/lib/lists/rules.mjs. Errors carry the server's plain-sentence `message`.
 */
import { useEffect, useRef } from "react";

/* ---------------------------------- types ---------------------------------- */

export type TaskStatus = "open" | "in_progress" | "blocked" | "needs_review" | "done" | "dropped";
export type Access = "none" | "view" | "work";

/** A person, or an agent and its person. */
export interface PersonRef {
  person: string;
  handle: string | null;
  agent: string | null;
  agent_id: string | null;
  is_you: boolean;
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
  agent_may_act: { ok: boolean; why: string };
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

export interface ListDetail {
  list: ListRef & { emoji: string | null; archived: boolean; your_role: string | null; agents_take_from: string };
  tasks: TaskView[];
  your_agents?: YourAgent[];
}

export interface Plate {
  lists: { id: string; name: string; emoji: string | null; shared: boolean }[];
  doing: TaskView[];
  up_next: TaskView[];
  claimable: TaskView[];
  waiting_on_you: TaskView[];
  done_recently: TaskView[];
  hint?: string;
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

async function call<T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<T> {
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
  createList: (body: { name: string; emoji?: string; agents?: string[] }) =>
    call<{ list: { id: string; name: string; emoji: string | null } }>("POST", "/api/lists", body),
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
};

export const errorText = (e: unknown) => (e instanceof ListsError ? e.message : "Something went wrong. Try again.");

/* -------------------------------- freshness -------------------------------- */

/**
 * Poll /api/lists/changes every 10 seconds while the page is visible and call
 * `onChange` when anything the person can see changed. The first poll runs
 * even in a background tab and always counts as a change, so the hook also
 * does the initial load. Phase 3 swaps this for a live stream.
 */
export function useListChanges(onChange: () => void, enabled = true) {
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!enabled) return;
    let since: string | null = null;
    let busy = false;
    let stopped = false;
    const tick = async () => {
      // The first call always runs (it's the initial load); after that, only while someone can see the page.
      if (busy || stopped || (since && document.visibilityState !== "visible")) return;
      busy = true;
      try {
        const r = await listsApi.changes(since);
        if (!stopped && (r.changed || !since)) latest.current();
        since = r.at;
      } catch {
        // Offline or signed out: keep what's on screen and try again next tick.
        if (!since && !stopped) latest.current();
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, 10_000);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
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

/** "You", "Skylar", or "Skylar's Claude Code". */
export function whoName(ref: PersonRef | null | undefined): string {
  if (!ref) return "Nobody";
  if (ref.agent) return `${short(ref.person)}'s ${ref.agent}`;
  return ref.is_you ? "You" : short(ref.person);
}

/** The person's own agents read better as just the agent's name in tight spots. */
export function whoShort(ref: PersonRef | null | undefined): string {
  if (!ref) return "Nobody";
  if (ref.agent) return ref.is_you ? ref.agent : `${short(ref.person)}'s ${ref.agent}`;
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

/** The assignee picker's value for a task: "nobody", "me", "my_agents" or an agent id. */
export function assigneeValue(t: Pick<TaskView, "assignee">): string {
  const a = t.assignee;
  if (!a) return "nobody";
  if (a.kind === "agent") return a.agent_id ?? "nobody";
  if (a.kind === "their_agents") return "my_agents";
  return "me";
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
  return `${whoName(e.by)} ${e.text}`;
}

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
