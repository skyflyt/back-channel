"use client";
/**
 * The Lists tab (/account?tab=lists): your lists on the left, the open list
 * on the right in bands (Waiting on you, Ready for you, Doing, Up next, Done,
 * and dropped behind a toggle), quick add on top, and the task drawer for one
 * task.
 *
 * Phase 1 is personal lists worked by you and the agents you pick. Phase 2
 * shares a list with friends: members in its settings, a "Shared" badge, the
 * OK rule ("OK for my agents" on a friend's task your agents could take),
 * people and their agents as assignees, @mentions, reactions, and agent work
 * shown as "Alex · via Codex". The URL carries the open list and task
 * (&list=…&task=…) so My plate on Overview, and any bookmark, can open a task
 * directly. Freshness is a 10-second poll of /api/lists/changes while the page
 * is visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, EmptyState, SkeletonRows } from "@/components/ui/primitives";
import {
  listsApi, errorText, useListChanges, whoName, ago, elapsed, lapsesIn, assigneeLabel, needsMyOk, memberRef, memberLabel, reviewerLabel,
  LISTS_OPEN_EVENT, type ListsTarget, type ListDetail, type ListSummary, type MentionView, type Plate, type ReactionEmoji, type TaskView, type EntryView, type PersonRef,
} from "./api";
import { WhoAvatar, DueChip, PlainText, MentionText, Reactions, Byline } from "./bits";
import { NewListForm, ListSettings, QuickAdd } from "./list-forms";
import { TaskDrawer } from "./task-drawer";
import { mentionDirectory } from "./mentions.mjs";

const PRIVACY_NOTE = "Back Channel stores your lists so every app you use can open them. Keep passwords out of tasks.";
const SHARED_PRIVACY_NOTE = "Everyone on this list, and the agents they allow, can see it. Keep passwords out of tasks.";
const WEEK = 7 * 24 * 60 * 60_000;
const ACTIVE = new Set(["open", "in_progress", "blocked", "needs_review"]);

/** What a Doing row shows under the title: the latest progress line, or what it's blocked on. */
type Line = { updated_at: string | null; progress: { text: string; by: EntryView["by"]; at: string | null } | null; blocked: string | null };

const isDoing = (t: TaskView) => (!!t.claim && ACTIVE.has(t.status)) || t.status === "blocked" || t.status === "in_progress";
const dueSort = (a: TaskView, b: TaskView) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity);
const shortName = (ref: PersonRef | null | undefined) => (ref ? ref.person.replace(/@bc$/, "") : "someone");

function readUrl(): { list: string | null; task: string | null } {
  if (typeof window === "undefined") return { list: null, task: null };
  const p = new URLSearchParams(window.location.search);
  return { list: p.get("list"), task: p.get("task") };
}

export function ListsPane({ demoMode }: { demoMode: boolean }) {
  if (demoMode) {
    return (
      <>
        <h1 className="ds-h1">Lists</h1>
        <p className="ds-sub">Tasks for you and your agents, in one place every app can open.</p>
        <div className="ds-card">
          <EmptyState icon="☑">Lists need a signed-in account. Sign in to start one, then pick which of your agents can work it.</EmptyState>
        </div>
      </>
    );
  }
  return <LiveLists />;
}

function LiveLists() {
  const [initial] = useState(readUrl);
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [plate, setPlate] = useState<Plate | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [selId, setSelId] = useState<string | null>(initial.list && initial.list !== "new" ? initial.list : null);
  const [creating, setCreating] = useState(initial.list === "new");
  const [detail, setDetail] = useState<ListDetail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [taskId, setTaskId] = useState<string | null>(initial.task);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [focusMembers, setFocusMembers] = useState(false);
  const [offerShare, setOfferShare] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [rowBusy, setRowBusy] = useState("");
  const [rowErr, setRowErr] = useState<{ id: string; msg: string } | null>(null);
  const [sendBack, setSendBack] = useState<{ id: string; text: string } | null>(null);

  const selRef = useRef(selId);
  useEffect(() => { selRef.current = selId; }, [selId]);
  const plateRef = useRef(plate);
  useEffect(() => { plateRef.current = plate; }, [plate]);
  const linesRef = useRef<Record<string, Line>>({});

  /* ------------------------------- loading ------------------------------- */

  const loadLists = useCallback(async () => {
    try {
      const [l, p] = await Promise.all([listsApi.lists(), listsApi.plate()]);
      setLists(l.lists);
      setPlate(p);
      setLoadErr("");
    } catch (e) {
      setLoadErr(errorText(e));
    }
  }, []);

  // The latest progress line (or blocked reason) for each task being worked arrives with
  // the task itself (last_progress / blocked_reason), so nothing is fetched per task.
  const loadLines = useCallback(async (tasks: TaskView[]) => {
    const next = { ...linesRef.current };
    for (const t of tasks.filter(isDoing)) {
      next[t.id] = { updated_at: t.updated_at, progress: t.last_progress ?? null, blocked: t.blocked_reason ?? null };
    }
    linesRef.current = next;
    setLines(next);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await listsApi.getList(id);
      if (selRef.current !== id) return;
      setDetail(d);
      setDetailErr("");
      void loadLines(d.tasks);
    } catch (e) {
      if (selRef.current === id) setDetailErr(errorText(e));
    }
  }, [loadLines]);

  const refresh = useCallback(() => {
    void loadLists();
    if (selRef.current) void loadDetail(selRef.current);
  }, [loadLists, loadDetail]);

  // The poll's first call is the initial load; later ones also tell an open drawer to reload.
  const polled = useRef(false);
  useListChanges(useCallback(() => {
    refresh();
    if (polled.current) setRefreshKey((k) => k + 1);
    polled.current = true;
  }, [refresh]));

  // A different list: clear the old one away and load the new one. The one-time
  // "Share with a friend" offer belongs to the list just created, and goes with it.
  useEffect(() => {
    setDetail(null); setDetailErr(""); setShowSettings(false); setFocusMembers(false); setShowDone(false); setShowDropped(false); setSendBack(null); setRowErr(null);
    setOfferShare((o) => (o === selId ? o : null));
    if (selId) void loadDetail(selId);
  }, [selId, loadDetail]);

  // Pick a list when none is chosen, or when the chosen one couldn't be opened
  // (a stale link, or a list you were taken off). A list that's just been
  // created may not be in `lists` yet; it loads on its own. With no lists at
  // all, open the new-list form.
  useEffect(() => {
    if (!lists) return;
    if (selId && (lists.some((l) => l.id === selId) || !detailErr)) return;
    const first = lists.find((l) => !l.archived) ?? lists[0];
    if (first) setSelId(first.id);
    else { setSelId(null); setCreating(true); }
  }, [lists, selId, detailErr]);

  /* ----------------------------- URL and events ---------------------------- */

  useEffect(() => {
    const url = new URL(window.location.href);
    const list = creating && !selId ? "new" : selId;
    if (list) url.searchParams.set("list", list); else url.searchParams.delete("list");
    if (taskId) url.searchParams.set("task", taskId); else url.searchParams.delete("task");
    const next = url.pathname + url.search;
    if (next !== window.location.pathname + window.location.search) window.history.replaceState({}, "", next);
  }, [selId, taskId, creating]);

  useEffect(() => () => {
    // Leaving the tab: drop &list and &task so they don't follow you around.
    const url = new URL(window.location.href);
    url.searchParams.delete("list");
    url.searchParams.delete("task");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<ListsTarget>).detail ?? {};
      if (t.newList) { setCreating(true); return; }
      if (t.listId) { setSelId(t.listId); setCreating(false); }
      setTaskId(t.taskId ?? null);
    };
    window.addEventListener(LISTS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(LISTS_OPEN_EVENT, onOpen);
  }, []);

  /* -------------------------------- actions -------------------------------- */

  const selectList = (id: string) => {
    setSelId(id);
    setCreating(false);
    setTaskId(null);
    setNotice("");
  };

  const rowAction = async (t: TaskView, label: string, fn: () => Promise<unknown>) => {
    setRowBusy(`${t.id}:${label}`); setRowErr(null);
    try {
      await fn();
      setSendBack(null);
      refresh();
    } catch (e) {
      setRowErr({ id: t.id, msg: errorText(e) });
    } finally {
      setRowBusy("");
    }
  };

  // A reaction shows at once from the answer, then everything refreshes as usual.
  const react = (t: TaskView, emoji: ReactionEmoji) => void rowAction(t, `react:${emoji}`, async () => {
    const r = await listsApi.react(t.id, emoji);
    setDetail((d) => (d && d.list.id === t.list.id ? { ...d, tasks: d.tasks.map((x) => (x.id === t.id ? { ...x, reactions: r.task.reactions } : x)) } : d));
  });
  const okTask = (t: TaskView) => void rowAction(t, "ok", () => listsApi.okTask(t.id));

  const openPeople = () => { setShowSettings(true); setFocusMembers(true); setOfferShare(null); };

  // You left a list: it's gone for you, so drop it here at once and open another.
  const onLeft = (name: string, id: string) => {
    setLists((ls) => ls?.filter((x) => x.id !== id) ?? ls);
    setNotice(`You left “${name}”. Its owner can add you back.`);
    setTaskId(null);
    setSelId(null);
    void loadLists();
  };

  const closeDrawer = useCallback(() => setTaskId(null), []);
  // A task opened by link from another list: show the list it's on behind it.
  // Opening a task reads the mentions of you on it, so the plate refreshes then.
  const followTask = useCallback((t: TaskView) => {
    if (selRef.current !== t.list.id) { setSelId(t.list.id); setCreating(false); }
    if (plateRef.current?.mentions.some((m) => m.task.id === t.id)) void loadLists();
  }, [loadLists]);

  /* --------------------------------- views --------------------------------- */

  // What needs you, per list: tasks for you, finished work waiting for your look,
  // friends' tasks waiting for your OK, and mentions of you.
  const needsYou = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (listId: string, id: string) => {
      if (!m.has(listId)) m.set(listId, new Set());
      m.get(listId)!.add(id);
    };
    for (const t of [...(plate?.up_next ?? []), ...(plate?.waiting_on_you ?? []), ...(plate?.ok_requests ?? [])]) add(t.list.id, t.id);
    for (const x of plate?.mentions ?? []) add(x.task.list.id, x.task.id);
    return m;
  }, [plate]);

  const dir = useMemo(() => mentionDirectory(detail?.members ?? []), [detail?.members]);

  const live = (lists ?? []).filter((l) => !l.archived);
  const archived = (lists ?? []).filter((l) => l.archived);
  const summary = lists?.find((l) => l.id === selId);
  // The open list stays in view even when it's archived.
  const showArchivedNow = showArchived || !!summary?.archived;

  const listItem = (l: ListSummary) => {
    const need = needsYou.get(l.id)?.size ?? 0;
    const open = l.counts.open + l.counts.in_progress + l.counts.blocked + l.counts.needs_review;
    const title = [l.shared ? "Shared with friends" : "", need ? `${need} need${need === 1 ? "s" : ""} you` : "", `${open} not done yet`].filter(Boolean).join(" · ");
    return (
      <button key={l.id} className={`ds-lists-item${l.id === selId && !creating ? " on" : ""}${l.archived ? " archived" : ""}`} onClick={() => selectList(l.id)} title={title} aria-current={l.id === selId ? "true" : undefined}>
        <span className="ds-lists-emoji" aria-hidden>{l.emoji || "☑"}</span>
        <span className="ds-lists-name">{l.name}</span>
        {l.shared && <span className="ds-lists-shared">Shared</span>}
        {need > 0 && <span className="ds-lists-need" aria-label={`${need} need you`}>{need}</span>}
        {open > 0 && <span className="ds-lists-open" aria-label={`${open} not done`}>{open}</span>}
      </button>
    );
  };

  const side = (
    <aside className="ds-lists-side" aria-label="Your lists">
      {!creating && <button className="ds-btn" style={{ width: "100%" }} onClick={() => setCreating(true)}>＋ New list</button>}
      {creating && (
        <NewListForm
          onCreated={(id) => { setCreating(false); setDetailErr(""); setNotice(""); setOfferShare(id); setSelId(id); setTaskId(null); void loadLists(); }}
          onCancel={live.length || archived.length ? () => setCreating(false) : undefined}
        />
      )}
      {lists === null && !loadErr && <div style={{ padding: 8 }}><SkeletonRows rows={4} /></div>}
      {live.length > 0 && <div className="ds-lists-sec">Your lists</div>}
      {live.map(listItem)}
      {archived.length > 0 && (
        <button className="ds-lists-sec ds-band-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchivedNow}>
          {showArchivedNow ? "▾" : "▸"} Archived ({archived.length})
        </button>
      )}
      {showArchivedNow && archived.map(listItem)}
    </aside>
  );

  /* ------------------------------ task rows ------------------------------ */

  const errFor = (t: TaskView) => rowErr?.id === t.id ? <p className="ds-err" role="alert" style={{ margin: "6px 0 0" }}>{rowErr.msg}</p> : null;
  const busyFor = (t: TaskView, label: string) => rowBusy === `${t.id}:${label}`;
  const reactBusy = (t: TaskView): ReactionEmoji | null => (rowBusy.startsWith(`${t.id}:react:`) ? (rowBusy.slice(t.id.length + 7) as ReactionEmoji) : null);
  const locked = !!detail?.list.archived;
  const isOwner = detail?.list.your_role === "owner";
  const agentsCanWork = (detail?.your_agents ?? []).some((a) => a.access === "work");

  const reactions = (t: TaskView, all = false) => (
    <Reactions reactions={t.reactions} all={all && !locked} disabled={locked} busy={reactBusy(t)} onToggle={(emoji) => react(t, emoji)} />
  );

  const sendBackForm = (t: TaskView) => sendBack?.id === t.id && (
    <div className="ds-inline-form">
      <label className="ds-label" htmlFor={`sb-${t.id}`} style={{ marginTop: 0 }}>What needs another pass?</label>
      <textarea id={`sb-${t.id}`} className="ds-textarea" rows={2} autoFocus maxLength={8000} value={sendBack.text}
        onChange={(e) => setSendBack({ id: t.id, text: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setSendBack(null); } }} />
      <div className="ds-actions">
        <button className="ds-btn ds-sm" disabled={!sendBack.text.trim() || busyFor(t, "send_back")}
          onClick={() => void rowAction(t, "send_back", () => listsApi.review(t.id, "send_back", sendBack.text.trim()))}>
          {busyFor(t, "send_back") ? "…" : "Send back"}
        </button>
        <button className="ds-btn ghost ds-sm" onClick={() => setSendBack(null)}>Cancel</button>
      </div>
    </div>
  );

  const openTask = (t: TaskView) => setTaskId(t.id);

  const okButton = (t: TaskView, primary = true) => (
    <button className={`ds-btn ds-sm${primary ? "" : " ghost"}`} disabled={busyFor(t, "ok")} title={t.agent_may_act.why} onClick={() => okTask(t)}>
      {busyFor(t, "ok") ? "…" : "OK for my agents"}
    </button>
  );

  /** "Alex added this for your agents. They need your OK to take it." */
  const okAsk = (t: TaskView) => {
    const who = whoName(t.created_by);
    if (t.assignee?.kind === "their_agents") return `${who} added this for your agents. They need your OK to take it.`;
    if (t.assignee) return `${who} added this for you. Your agents need your OK to help with it.`;
    return `${who} added this. Your agents need your OK to take it.`;
  };

  const okRow = (t: TaskView) => (
    <div key={`ok-${t.id}`} className={`ds-task${t.id === taskId ? " on" : ""}`}>
      <WhoAvatar who={t.created_by} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
          <div className="ds-task-title">{t.title}</div>
          <div className="ds-task-line">{okAsk(t)}</div>
          {t.due && <div className="ds-task-meta"><DueChip due={t.due} /></div>}
        </button>
        {errFor(t)}
      </div>
      {!locked && <div className="ds-task-actions">{okButton(t)}</div>}
    </div>
  );

  const mentionRow = (m: MentionView) => {
    const text = m.entry.text.replace(/\s+/g, " ");
    const snippet = text.length > 180 ? `${text.slice(0, 179)}…` : text;
    return (
      <div key={`m-${m.id}`} className={`ds-task${m.task.id === taskId ? " on" : ""}`}>
        <WhoAvatar who={m.entry.by} />
        <button className="ds-task-main" onClick={() => openTask(m.task)}>
          <div className="ds-task-title"><Byline who={m.entry.by} /> mentioned you</div>
          <div className="ds-task-line"><MentionText inline text={snippet} dir={dir} author={m.entry.by} /></div>
          <div className="ds-task-meta"><span>On &ldquo;{m.task.title}&rdquo; · {ago(m.entry.at)}</span></div>
        </button>
      </div>
    );
  };

  const doingRow = (t: TaskView) => {
    const by = t.claim?.by ?? null;
    const line = lines[t.id];
    const agent = !!by?.agent;
    return (
      <div key={t.id} className={`ds-task${t.id === taskId ? " on" : ""}`}>
        {by ? <WhoAvatar who={by} pulse={agent && t.status === "in_progress"} /> : <span className="ds-task-check" aria-hidden />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
            <div className="ds-task-title">{t.title}</div>
            {t.status === "blocked" && line?.blocked && <div className="ds-task-line">Blocked on: {line.blocked}</div>}
            {line?.progress && <div className="ds-task-line progress">&ldquo;{line.progress.text.split("\n")[0]}&rdquo;</div>}
            <div className="ds-task-meta">
              {by && <span><Byline who={by} />{t.claim?.since ? ` · ${elapsed(t.claim.since)}` : ""}</span>}
              {!by && <span>Nobody is on it</span>}
              {agent && t.claim?.lapses_at && <span>· {lapsesIn(t.claim.lapses_at)}</span>}
              {t.claim?.stale && <span className="ds-nudge">{by?.is_you && !agent ? "Still on it?" : "No word for 3 days"}</span>}
              {t.status === "blocked" && <Chip tone="warn">Blocked</Chip>}
              <DueChip due={t.due} />
            </div>
          </button>
          {reactions(t)}
          {errFor(t)}
        </div>
      </div>
    );
  };

  const upNextRow = (t: TaskView) => {
    const who = assigneeLabel(t);
    const elsewhere = !!t.assignee && !t.assignee.is_you;
    const ask = !locked && needsMyOk(t, agentsCanWork);
    const fromFriend = !!detail?.list.shared && !!t.created_by && !t.created_by.is_you;
    return (
      <div key={t.id} className={`ds-task${t.id === taskId ? " on" : ""}`}>
        <span className="ds-task-check" aria-hidden />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
            <div className="ds-task-title">{t.title}</div>
            {(who || t.due || t.notes || fromFriend) && (
              <div className="ds-task-meta">
                {who && <Chip tone={t.assignee?.is_you && t.assignee.kind === "person" ? "acc" : undefined}>{who}</Chip>}
                <DueChip due={t.due} />
                {fromFriend && <span>Added by <Byline who={t.created_by} /></span>}
                {t.notes && <span title="Has notes">≡ notes</span>}
              </div>
            )}
          </button>
          {reactions(t)}
          {errFor(t)}
        </div>
        {!locked && (ask || !elsewhere) && (
          <div className="ds-task-actions">
            {ask && okButton(t)}
            {!elsewhere && (
              <button className="ds-btn ghost ds-sm" disabled={busyFor(t, "claim")} title="Say you're on it" onClick={() => void rowAction(t, "claim", () => listsApi.claim(t.id))}>
                {busyFor(t, "claim") ? "…" : "Claim"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const readyRow = (t: TaskView) => {
    // The person who asked checks it. (The list's owner can still step in from the drawer.)
    const mineToCheck = !!t.needs_review_by?.is_you;
    return (
      <div key={t.id} className={`ds-task${t.id === taskId ? " on" : ""}`}>
        <WhoAvatar who={t.completed_by} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
            <div className="ds-task-title">{t.title}</div>
            <div className="ds-summary ready">
              <strong><Byline who={t.completed_by} /></strong> {t.summary ? <PlainText text={t.summary} /> : "finished this."}
            </div>
            {!t.needs_review_by?.is_you && <div className="ds-task-meta"><span>Waiting for {reviewerLabel(t)} to check it</span></div>}
          </button>
          {reactions(t)}
          {sendBackForm(t)}
          {errFor(t)}
        </div>
        {!locked && mineToCheck && sendBack?.id !== t.id && (
          <div className="ds-task-actions">
            <button className="ds-btn ds-sm" disabled={busyFor(t, "accept")} onClick={() => void rowAction(t, "accept", () => listsApi.review(t.id, "accept"))}>{busyFor(t, "accept") ? "…" : "Looks good"}</button>
            <button className="ds-btn ghost ds-sm" onClick={() => setSendBack({ id: t.id, text: "" })}>Send back</button>
          </div>
        )}
      </div>
    );
  };

  const doneRow = (t: TaskView) => (
    <div key={t.id} className={`ds-task done${t.id === taskId ? " on" : ""}`}>
      <span className="ds-task-check done" aria-hidden>✓</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
          <div className="ds-task-title">{t.title}</div>
          {t.summary && <div className="ds-summary"><PlainText text={t.summary} /></div>}
          <div className="ds-task-meta"><span>Finished by <Byline who={t.completed_by} /> {ago(t.completed_at)}</span></div>
        </button>
        {reactions(t, true)}
        {sendBackForm(t)}
        {errFor(t)}
      </div>
      {!locked && t.send_back_until && (!!t.created_by?.is_you || isOwner) && sendBack?.id !== t.id && (
        <div className="ds-task-actions">
          <button className="ds-btn ghost ds-sm" title="Hand it back to whoever did it, with a note" onClick={() => setSendBack({ id: t.id, text: "" })}>Send back</button>
        </div>
      )}
    </div>
  );

  const droppedRow = (t: TaskView) => (
    <div key={t.id} className={`ds-task dropped${t.id === taskId ? " on" : ""}`}>
      <span className="ds-task-check" aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
          <div className="ds-task-title">{t.title}</div>
          <div className="ds-task-meta"><span>Dropped {ago(t.updated_at)}</span></div>
        </button>
        {errFor(t)}
      </div>
      {!locked && (
        <div className="ds-task-actions">
          <button className="ds-btn ghost ds-sm" disabled={busyFor(t, "restore")} onClick={() => void rowAction(t, "restore", () => listsApi.updateTask(t.id, { status: "restored" }))}>{busyFor(t, "restore") ? "…" : "Restore"}</button>
        </div>
      )}
    </div>
  );

  /* ------------------------------- the list ------------------------------- */

  const main = () => {
    if (loadErr && lists === null) {
      return <div className="ds-card"><p className="ds-call danger" style={{ margin: "0 0 10px" }}>{loadErr}</p><button className="ds-btn ghost ds-sm" onClick={refresh}>Try again</button></div>;
    }
    if (lists !== null && lists.length === 0) {
      return (
        <div className="ds-card">
          {notice && <p className="ds-call ok" role="status" style={{ margin: "0 0 14px" }}>{notice}</p>}
          <EmptyState icon="☑">
            <strong style={{ color: "var(--ds-ink)" }}>Start your first list.</strong><br />
            Name it, pick which of your agents can work it, then add tasks. Your agents can pick tasks up, post progress as they go, and say what they did when they finish.
          </EmptyState>
          <p className="ds-fine" style={{ textAlign: "center", margin: 0 }}>{PRIVACY_NOTE}</p>
        </div>
      );
    }
    if (detailErr && !detail) {
      return <div className="ds-card"><p className="ds-call danger" style={{ margin: "0 0 10px" }}>{detailErr}</p><button className="ds-btn ghost ds-sm" onClick={() => selId && void loadDetail(selId)}>Try again</button></div>;
    }
    if (!detail) {
      return <div className="ds-card"><SkeletonRows rows={6} /></div>;
    }

    const l = detail.list;
    const now = Date.now();
    const tasks = detail.tasks;
    const members = detail.members;
    const shared = l.shared || members.length > 1;
    const doing = tasks.filter(isDoing);
    const upNext = tasks.filter((t) => t.status === "open" && !t.claim).sort(dueSort);
    const ready = tasks.filter((t) => t.status === "needs_review");
    const readyForMe = ready.every((t) => t.needs_review_by?.is_you);
    const done = tasks
      .filter((t) => t.status === "done" && now - Date.parse(t.completed_at ?? t.updated_at ?? "") < WEEK)
      .sort((a, b) => Date.parse(b.completed_at ?? "") - Date.parse(a.completed_at ?? ""));
    const dropped = tasks.filter((t) => t.status === "dropped");
    const workers = (detail.your_agents ?? []).filter((a) => a.access === "work");
    const viewers = (detail.your_agents ?? []).filter((a) => a.access === "view");
    const allDone = !doing.length && !upNext.length && !ready.length;
    const okHere = l.archived ? [] : (plate?.ok_requests ?? []).filter((t) => t.list.id === l.id);
    const mentionsHere = (plate?.mentions ?? []).filter((m) => m.task.list.id === l.id);
    const others = members.filter((m) => !m.is_you);

    return (
      <>
        {notice && <p className="ds-call ok" role="status" style={{ margin: "0 0 14px" }}>{notice}</p>}
        <div className="ds-lists-head">
          <h2 className="ds-lists-title"><span aria-hidden>{l.emoji || "☑"}</span>{l.name}</h2>
          {shared && <Chip tone="acc" title="Shared with friends">Shared</Chip>}
          {l.archived && <Chip>Archived</Chip>}
          <div className="ds-lists-headr">
            {shared && (
              <button className="ds-faces" onClick={openPeople} title={`On this list: ${members.map(memberLabel).join(", ")}`} aria-label={`${members.length} people on this list. Show who`}>
                {members.slice(0, 4).map((m) => <WhoAvatar key={m.handle ?? memberLabel(m)} who={memberRef(m)} size={24} />)}
                {members.length > 4 && <span className="ds-faces-more">+{members.length - 4}</span>}
              </button>
            )}
            <button className="ds-btn ghost ds-sm" aria-expanded={showSettings} onClick={() => { setShowSettings((v) => !v); setFocusMembers(false); }}>{showSettings ? "Close settings" : "Settings"}</button>
          </div>
        </div>
        <p className="ds-lists-privacy">{shared ? SHARED_PRIVACY_NOTE : PRIVACY_NOTE}</p>

        {offerShare === l.id && l.your_role === "owner" && !shared && !l.archived && !showSettings && (
          <div className="ds-call acc" style={{ margin: "0 0 18px" }}>
            <strong>Share with a friend?</strong> Friends you add can see this list, add tasks and pick them up, with the agents they choose.
            <div className="ds-actions" style={{ marginTop: 10 }}>
              <button className="ds-btn ds-sm" onClick={openPeople}>Share with a friend</button>
              <button className="ds-btn ghost ds-sm" onClick={() => setOfferShare(null)}>Not now</button>
            </div>
          </div>
        )}

        {showSettings && (
          <ListSettings key={`settings-${l.id}`} detail={detail} focusMembers={focusMembers} onChanged={refresh} onLeft={() => onLeft(l.name, l.id)} />
        )}

        {l.archived && !showSettings && (
          <p className="ds-call warn" style={{ margin: "0 0 18px" }}>
            This list is archived, so it&apos;s read-only and off your agents&apos; plates. {l.your_role === "owner" && <button className="ds-link" onClick={() => setShowSettings(true)}>Unarchive it in settings</button>}
          </p>
        )}

        {!l.archived && (
          <p className="ds-fine" style={{ margin: "-8px 0 12px" }}>
            {workers.length
              ? <>{joinNames(workers.map((a) => a.name))} can work this list{viewers.length ? `, and ${joinNames(viewers.map((a) => a.name))} can read it` : ""}. </>
              : <>None of your agents can work this list yet. </>}
            {shared && others.length > 0 && <>Shared with {joinNames(others.map(memberLabel))}. </>}
            <button className="ds-link" style={{ fontSize: 12 }} onClick={() => setShowSettings(true)}>Change</button>
          </p>
        )}

        {!l.archived && <QuickAdd key={`quickadd-${l.id}`} listId={l.id} agents={detail.your_agents} members={members} disabled={l.archived} onAdded={refresh} />}

        {(okHere.length > 0 || mentionsHere.length > 0) && (
          <section className="ds-band" aria-label="Waiting on you">
            <h3 className="ds-band-h">Waiting on you <span className="ds-band-n">{okHere.length + mentionsHere.length}</span></h3>
            <div className="ds-band-box ready">
              {okHere.map(okRow)}
              {mentionsHere.map(mentionRow)}
            </div>
          </section>
        )}

        {ready.length > 0 && (
          <section className="ds-band" aria-label={readyForMe ? "Ready for you" : "Ready for a look"}>
            <h3 className="ds-band-h">{readyForMe ? "Ready for you" : "Ready for a look"} <span className="ds-band-n">{ready.length}</span></h3>
            <div className="ds-band-box ready">{ready.map(readyRow)}</div>
          </section>
        )}

        <section className="ds-band" aria-label="Doing">
          <h3 className="ds-band-h">Doing <span className="ds-band-n">{doing.length || ""}</span></h3>
          <div className="ds-band-box">
            {doing.length ? doing.map(doingRow) : <div className="ds-band-empty">Nobody is working on anything here right now. Claim a task, or give one to an agent.</div>}
          </div>
        </section>

        <section className="ds-band" aria-label="Up next">
          <h3 className="ds-band-h">Up next <span className="ds-band-n">{upNext.length || ""}</span></h3>
          <div className="ds-band-box">
            {upNext.length
              ? upNext.map(upNextRow)
              : allDone && done.length
                ? <div className="ds-band-empty">All done. {tally(done)} this week.</div>
                : <div className="ds-band-empty">Nothing waiting. Add a task above.</div>}
          </div>
        </section>

        {done.length > 0 && (
          <section className="ds-band" aria-label="Done">
            <h3 className="ds-band-h">
              <button className="ds-band-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                {showDone ? "▾" : "▸"} Done this week <span className="ds-band-n">{done.length}</span>
              </button>
            </h3>
            {showDone && <div className="ds-band-box">{done.map(doneRow)}</div>}
          </section>
        )}

        {dropped.length > 0 && (
          <section className="ds-band" aria-label="Dropped">
            <h3 className="ds-band-h">
              <button className="ds-band-toggle" aria-expanded={showDropped} onClick={() => setShowDropped((v) => !v)}>
                {showDropped ? "▾ Hide dropped" : "▸ Show dropped"} <span className="ds-band-n">{dropped.length}</span>
              </button>
            </h3>
            {showDropped && <div className="ds-band-box">{dropped.map(droppedRow)}</div>}
          </section>
        )}
      </>
    );
  };

  const drawerList = detail && taskId ? detail : null;

  return (
    <>
      <h1 className="ds-h1">Lists</h1>
      <p className="ds-sub">Tasks for you, your agents and the friends you share a list with. Agents pick them up, post progress as they work, and say what they did.</p>
      <div className="ds-lists">
        {side}
        <div className="ds-lists-main">{main()}</div>
      </div>
      {taskId && (
        <TaskDrawer
          taskId={taskId}
          agents={drawerList?.your_agents}
          members={drawerList?.members}
          isOwner={(drawerList?.list.your_role ?? summary?.your_role) === "owner"}
          archived={!!(drawerList?.list.archived ?? summary?.archived)}
          refreshKey={refreshKey}
          onClose={closeDrawer}
          onChanged={refresh}
          onLoaded={followTask}
        />
      )}
    </>
  );
}

/** "Claude Code", "Claude Code and Codex", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Who finished what this week, people before their agents: "You finished 2 and
 * your agents finished 3", "Alex finished 4, you finished 1 and Alex's agents
 * finished 6".
 */
function tally(done: TaskView[]): string {
  const groups = new Map<string, { label: string; n: number; you: boolean; agents: boolean }>();
  for (const t of done) {
    const by = t.completed_by;
    const agents = !!by?.agent;
    const key = `${by?.handle ?? by?.person ?? "?"}|${agents ? 1 : 0}`;
    const label = by?.is_you ? (agents ? "your agents" : "you") : agents ? `${shortName(by)}'s agents` : shortName(by);
    const g = groups.get(key) ?? { label, n: 0, you: !!by?.is_you, agents };
    g.n += 1;
    groups.set(key, g);
  }
  const parts = [...groups.values()]
    .sort((a, b) => Number(a.agents) - Number(b.agents) || Number(b.you) - Number(a.you) || b.n - a.n)
    .map((g) => `${g.label} finished ${g.n}`);
  const text = joinNames(parts);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
