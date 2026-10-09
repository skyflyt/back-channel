"use client";
/**
 * The Lists tab (/account?tab=lists): your lists on the left, the open list
 * on the right in bands (Doing, Up next, Ready for you, Done, and dropped
 * behind a toggle), quick add on top, and the task drawer for one task.
 *
 * Phase 1 is personal lists worked by you and the agents you pick. The URL
 * carries the open list and task (&list=…&task=…) so My plate on Overview,
 * and any bookmark, can open a task directly. Freshness is a 10-second poll
 * of /api/lists/changes while the page is visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, EmptyState, SkeletonRows } from "@/components/ui/primitives";
import {
  listsApi, errorText, useListChanges, whoName, ago, elapsed, lapsesIn, assigneeLabel, blockedReason,
  LISTS_OPEN_EVENT, type ListsTarget, type ListDetail, type ListSummary, type Plate, type TaskView, type EntryView,
} from "./api";
import { WhoAvatar, DueChip, PlainText } from "./bits";
import { NewListForm, ListSettings, QuickAdd } from "./list-forms";
import { TaskDrawer } from "./task-drawer";

const PRIVACY_NOTE = "Back Channel stores your lists so every app you use can open them. Keep passwords out of tasks.";
const WEEK = 7 * 24 * 60 * 60_000;
const ACTIVE = new Set(["open", "in_progress", "blocked", "needs_review"]);

/** What a Doing row shows under the title: the latest progress line, or what it's blocked on. */
type Line = { updated_at: string | null; progress: { text: string; by: EntryView["by"]; at: string | null } | null; blocked: string | null };

const isDoing = (t: TaskView) => (!!t.claim && ACTIVE.has(t.status)) || t.status === "blocked" || t.status === "in_progress";
const dueSort = (a: TaskView, b: TaskView) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity);

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
  const [showDone, setShowDone] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [rowBusy, setRowBusy] = useState("");
  const [rowErr, setRowErr] = useState<{ id: string; msg: string } | null>(null);
  const [sendBack, setSendBack] = useState<{ id: string; text: string } | null>(null);

  const selRef = useRef(selId);
  useEffect(() => { selRef.current = selId; }, [selId]);
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

  // The latest progress line (or blocked reason) for each task being worked.
  // Fetched per task, and only again when that task changed.
  const loadLines = useCallback(async (tasks: TaskView[]) => {
    const stale = tasks.filter(isDoing).filter((t) => linesRef.current[t.id]?.updated_at !== t.updated_at).slice(0, 12);
    if (!stale.length) return;
    const got = await Promise.all(stale.map(async (t) => {
      try {
        const { entries } = await listsApi.entries(t.id);
        const progress = [...entries].reverse().find((e) => e.kind === "progress");
        const blocked = [...entries].reverse().map(blockedReason).find((r) => r !== null) ?? null;
        return [t.id, { updated_at: t.updated_at, progress: progress ? { text: progress.text, by: progress.by, at: progress.at } : null, blocked }] as const;
      } catch {
        return null;
      }
    }));
    const next = { ...linesRef.current };
    for (const g of got) if (g) next[g[0]] = g[1];
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

  // A different list: clear the old one away and load the new one.
  useEffect(() => {
    setDetail(null); setDetailErr(""); setShowSettings(false); setShowDone(false); setShowDropped(false); setSendBack(null); setRowErr(null);
    if (selId) void loadDetail(selId);
  }, [selId, loadDetail]);

  // Pick a list when none is chosen (or the chosen one is gone); start the form when there are none.
  useEffect(() => {
    if (!lists) return;
    if (selId && lists.some((l) => l.id === selId)) return;
    if (selId && !lists.some((l) => l.id === selId) && detail === null && !detailErr) return; // still loading a deep link
    const first = lists.find((l) => !l.archived) ?? lists[0];
    if (first) setSelId(first.id);
    else { setSelId(null); setCreating(true); }
  }, [lists, selId, detail, detailErr]);

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

  const closeDrawer = useCallback(() => setTaskId(null), []);
  // A task opened by link from another list: show the list it's on behind it.
  const followTask = useCallback((t: TaskView) => {
    if (selRef.current !== t.list.id) { setSelId(t.list.id); setCreating(false); }
  }, []);

  /* --------------------------------- views --------------------------------- */

  // What needs you, per list: tasks for you and finished work waiting for your look.
  const needsYou = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of [...(plate?.up_next ?? []), ...(plate?.waiting_on_you ?? [])]) {
      if (!m.has(t.list.id)) m.set(t.list.id, new Set());
      m.get(t.list.id)!.add(t.id);
    }
    return m;
  }, [plate]);

  const live = (lists ?? []).filter((l) => !l.archived);
  const archived = (lists ?? []).filter((l) => l.archived);
  const summary = lists?.find((l) => l.id === selId);

  const listItem = (l: ListSummary) => {
    const need = needsYou.get(l.id)?.size ?? 0;
    const open = l.counts.open + l.counts.in_progress + l.counts.blocked + l.counts.needs_review;
    const title = [need ? `${need} need${need === 1 ? "s" : ""} you` : "", `${open} not done yet`].filter(Boolean).join(" · ");
    return (
      <button key={l.id} className={`ds-lists-item${l.id === selId && !creating ? " on" : ""}${l.archived ? " archived" : ""}`} onClick={() => selectList(l.id)} title={title} aria-current={l.id === selId ? "true" : undefined}>
        <span className="ds-lists-emoji" aria-hidden>{l.emoji || "☑"}</span>
        <span className="ds-lists-name">{l.name}</span>
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
          onCreated={(id) => { setCreating(false); setSelId(id); setTaskId(null); void loadLists(); }}
          onCancel={live.length || archived.length ? () => setCreating(false) : undefined}
        />
      )}
      {lists === null && !loadErr && <div style={{ padding: 8 }}><SkeletonRows rows={4} /></div>}
      {live.length > 0 && <div className="ds-lists-sec">Your lists</div>}
      {live.map(listItem)}
      {archived.length > 0 && (
        <button className="ds-lists-sec ds-band-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
          {showArchived ? "▾" : "▸"} Archived ({archived.length})
        </button>
      )}
      {showArchived && archived.map(listItem)}
    </aside>
  );

  /* ------------------------------ task rows ------------------------------ */

  const errFor = (t: TaskView) => rowErr?.id === t.id ? <p className="ds-err" role="alert" style={{ margin: "6px 0 0" }}>{rowErr.msg}</p> : null;
  const busyFor = (t: TaskView, label: string) => rowBusy === `${t.id}:${label}`;
  const locked = !!detail?.list.archived;

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

  const doingRow = (t: TaskView) => {
    const by = t.claim?.by ?? null;
    const line = lines[t.id];
    const agent = !!by?.agent;
    return (
      <div key={t.id} className={`ds-task${t.id === taskId ? " on" : ""}`}>
        {by ? <WhoAvatar who={by} pulse={agent && t.status === "in_progress"} /> : <span className="ds-task-check" aria-hidden />}
        <button className="ds-task-main" onClick={() => openTask(t)}>
          <div className="ds-task-title">{t.title}</div>
          {t.status === "blocked" && line?.blocked && <div className="ds-task-line">Blocked on: {line.blocked}</div>}
          {line?.progress && <div className="ds-task-line progress">&ldquo;{line.progress.text.split("\n")[0]}&rdquo;</div>}
          <div className="ds-task-meta">
            {by && <span>{whoName(by)}{t.claim?.since ? ` · ${elapsed(t.claim.since)}` : ""}</span>}
            {!by && <span>Nobody is on it</span>}
            {agent && t.claim?.lapses_at && <span>· {lapsesIn(t.claim.lapses_at)}</span>}
            {t.claim?.stale && <span className="ds-nudge">{by?.is_you && !agent ? "Still on it?" : "No word for 3 days"}</span>}
            {t.status === "blocked" && <Chip tone="warn">Blocked</Chip>}
            <DueChip due={t.due} />
          </div>
        </button>
      </div>
    );
  };

  const upNextRow = (t: TaskView) => {
    const who = assigneeLabel(t);
    return (
      <div key={t.id} className={`ds-task${t.id === taskId ? " on" : ""}`}>
        <span className="ds-task-check" aria-hidden />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
            <div className="ds-task-title">{t.title}</div>
            {(who || t.due || t.notes) && (
              <div className="ds-task-meta">
                {who && <Chip tone={t.assignee?.is_you && t.assignee.kind === "person" ? "acc" : undefined}>{who}</Chip>}
                <DueChip due={t.due} />
                {t.notes && <span title="Has notes">≡ notes</span>}
              </div>
            )}
          </button>
          {errFor(t)}
        </div>
        {!locked && (
          <div className="ds-task-actions">
            <button className="ds-btn ghost ds-sm" disabled={busyFor(t, "claim")} title="Say you're on it" onClick={() => void rowAction(t, "claim", () => listsApi.claim(t.id))}>
              {busyFor(t, "claim") ? "…" : "Claim"}
            </button>
          </div>
        )}
      </div>
    );
  };

  const readyRow = (t: TaskView) => (
    <div key={t.id} className={`ds-task${t.id === taskId ? " on" : ""}`}>
      <WhoAvatar who={t.completed_by} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
          <div className="ds-task-title">{t.title}</div>
          <div className="ds-summary ready">
            <strong>{whoName(t.completed_by)}</strong> {t.summary ? <PlainText text={t.summary} /> : "finished this."}
          </div>
        </button>
        {sendBackForm(t)}
        {errFor(t)}
      </div>
      {!locked && sendBack?.id !== t.id && (
        <div className="ds-task-actions">
          <button className="ds-btn ds-sm" disabled={busyFor(t, "accept")} onClick={() => void rowAction(t, "accept", () => listsApi.review(t.id, "accept"))}>{busyFor(t, "accept") ? "…" : "Looks good"}</button>
          <button className="ds-btn ghost ds-sm" onClick={() => setSendBack({ id: t.id, text: "" })}>Send back</button>
        </div>
      )}
    </div>
  );

  const doneRow = (t: TaskView) => (
    <div key={t.id} className={`ds-task done${t.id === taskId ? " on" : ""}`}>
      <span className="ds-task-check done" aria-hidden>✓</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button className="ds-task-main" style={{ width: "100%" }} onClick={() => openTask(t)}>
          <div className="ds-task-title">{t.title}</div>
          {t.summary && <div className="ds-summary"><PlainText text={t.summary} /></div>}
          <div className="ds-task-meta"><span>{whoName(t.completed_by)} finished this {ago(t.completed_at)}</span></div>
        </button>
        {sendBackForm(t)}
        {errFor(t)}
      </div>
      {!locked && t.send_back_until && sendBack?.id !== t.id && (
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
    const doing = tasks.filter(isDoing);
    const upNext = tasks.filter((t) => t.status === "open" && !t.claim).sort(dueSort);
    const ready = tasks.filter((t) => t.status === "needs_review");
    const done = tasks
      .filter((t) => t.status === "done" && now - Date.parse(t.completed_at ?? t.updated_at ?? "") < WEEK)
      .sort((a, b) => Date.parse(b.completed_at ?? "") - Date.parse(a.completed_at ?? ""));
    const dropped = tasks.filter((t) => t.status === "dropped");
    const workers = (detail.your_agents ?? []).filter((a) => a.access === "work");
    const viewers = (detail.your_agents ?? []).filter((a) => a.access === "view");
    const allDone = !doing.length && !upNext.length && !ready.length;
    const byYou = done.filter((t) => !t.completed_by?.agent).length;
    const byAgents = done.length - byYou;
    const tally = [byYou ? `You finished ${byYou}` : "", byAgents ? `${byYou ? "your" : "Your"} agents finished ${byAgents}` : ""].filter(Boolean).join(" and ");

    return (
      <>
        <div className="ds-lists-head">
          <h2 className="ds-lists-title"><span aria-hidden>{l.emoji || "☑"}</span>{l.name}</h2>
          {l.archived && <Chip>Archived</Chip>}
          <div style={{ marginLeft: "auto" }}>
            <button className="ds-btn ghost ds-sm" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>{showSettings ? "Close settings" : "Settings"}</button>
          </div>
        </div>
        <p className="ds-lists-privacy">{PRIVACY_NOTE}</p>

        {showSettings && <ListSettings key={l.id} detail={detail} onChanged={refresh} onClose={() => setShowSettings(false)} />}

        {l.archived && !showSettings && (
          <p className="ds-call warn" style={{ margin: "0 0 18px" }}>
            This list is archived, so it&apos;s read-only and off your agents&apos; plates. <button className="ds-link" onClick={() => setShowSettings(true)}>Unarchive it in settings</button>
          </p>
        )}

        {!l.archived && (
          <p className="ds-fine" style={{ margin: "-8px 0 12px" }}>
            {workers.length
              ? <>{joinNames(workers.map((a) => a.name))} can work this list{viewers.length ? `, and ${joinNames(viewers.map((a) => a.name))} can read it` : ""}. </>
              : <>None of your agents can work this list yet. </>}
            <button className="ds-link" style={{ fontSize: 12 }} onClick={() => setShowSettings(true)}>Change</button>
          </p>
        )}

        {!l.archived && <QuickAdd key={l.id} listId={l.id} agents={detail.your_agents} disabled={l.archived} onAdded={refresh} />}

        {ready.length > 0 && (
          <section className="ds-band" aria-label="Ready for you">
            <h3 className="ds-band-h">Ready for you <span className="ds-band-n">{ready.length}</span></h3>
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
                ? <div className="ds-band-empty">All done. {tally} this week.</div>
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
      <p className="ds-sub">Tasks for you and your agents. Agents pick them up, post progress as they work, and say what they did.</p>
      <div className="ds-lists">
        {side}
        <div className="ds-lists-main">{main()}</div>
      </div>
      {taskId && (
        <TaskDrawer
          taskId={taskId}
          agents={drawerList?.your_agents}
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
