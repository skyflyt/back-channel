"use client";
/**
 * The task drawer: one task in full, opened from a list or from My plate.
 *
 * Title and notes are saved with the version they were edited from. If
 * someone (often an agent) changed the same field meanwhile, the server says
 * edit_conflict with the current text, and the drawer shows both versions so
 * the person can merge instead of overwriting. An edit to a different field
 * only bumps the version, so that case saves on top without asking.
 *
 * Everything people and agents wrote is rendered as plain text with its line
 * breaks. No HTML, ever: production CSP enforces Trusted Types.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/primitives";
import {
  listsApi, ListsError, errorText, whoName, ago, elapsed, lapsesIn, dueDay, dayName, assigneeValue, assigneeLabel, blockedReason, eventLine,
  STATUS_LABEL, type TaskDetail, type TaskView, type YourAgent,
} from "./api";
import { WhoAvatar, PlainText } from "./bits";

type Field = "title" | "notes";
type Draft = { text: string; base: number; baseText: string };
type Current = { title: string; notes: string; version: number };
type Conflict = { field: Field; mine: string; current: Current };
type Pending = null | "block" | "done" | "send_back";

interface Props {
  taskId: string;
  /** The person's agents and their access on this task's list (from the list view). */
  agents: YourAgent[] | undefined;
  isOwner: boolean;
  archived: boolean;
  /** Bumped when the 10-second poll sees a change; the drawer reloads quietly. */
  refreshKey: number;
  onClose: () => void;
  /** Something changed here: the list and plate should refetch. */
  onChanged: () => void;
  /** Called with each fresh load, so the caller can show the task's own list. */
  onLoaded?: (task: TaskView) => void;
}

const ACTIVE = ["open", "in_progress", "blocked", "needs_review"];

export function TaskDrawer({ taskId, agents, isOwner, archived, refreshKey, onClose, onChanged, onLoaded }: Props) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [titleDraft, setTitleDraft] = useState<Draft | null>(null);
  const [notesDraft, setNotesDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [formText, setFormText] = useState("");
  const [kind, setKind] = useState<"comment" | "progress">("comment");
  const [entryText, setEntryText] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineEnd = useRef<HTMLDivElement>(null);

  const loadedRef = useRef(onLoaded);
  useEffect(() => { loadedRef.current = onLoaded; }, [onLoaded]);
  const load = useCallback(async () => {
    try {
      const r = await listsApi.getTask(taskId);
      setTask(r.task);
      setLoadErr("");
      loadedRef.current?.(r.task);
    } catch (e) {
      setLoadErr(errorText(e));
    }
  }, [taskId]);

  // A different task: start clean.
  useEffect(() => {
    setTask(null); setLoadErr(""); setErr(""); setTitleDraft(null); setNotesDraft(null); setConflict(null);
    setPending(null); setFormText(""); setEntryText(""); setKind("comment");
    void load();
  }, [load]);

  // The poll saw a change: reload quietly. Drafts stay as they are.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey !== firstKey.current) void loadRef.current();
  }, [refreshKey]);

  // Focus the panel once, keep the page behind it still, and close on Escape
  // (fields that use Escape themselves mark it handled first).
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) closeRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(label); setErr("");
    try {
      await fn();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setErr(errorText(e));
      return false;
    } finally {
      setBusy("");
    }
  };

  const clearDraft = (field: Field) => (field === "title" ? setTitleDraft(null) : setNotesDraft(null));

  const saveField = async (field: Field, text: string, base: number, baseText: string) => {
    if (!task) return;
    setBusy(`save-${field}`); setErr("");
    const put = (version: number) => listsApi.updateTask(task.id, { [field]: text, version });
    try {
      try {
        await put(base);
      } catch (e) {
        const current = e instanceof ListsError && e.code === "edit_conflict" ? (e.extra.current as Current | undefined) : undefined;
        if (!current) throw e;
        // Someone changed a different field: ours is untouched, so save on top.
        if (current[field] === baseText) await put(current.version);
        else {
          setConflict({ field, mine: text, current });
          return;
        }
      }
      clearDraft(field);
      setConflict(null);
      await load();
      onChanged();
    } catch (e) {
      setErr(errorText(e));
      if (e instanceof ListsError && e.code === "edit_conflict") void load();
    } finally {
      setBusy("");
    }
  };

  const post = async () => {
    const text = entryText.trim();
    if (!task || !text) return;
    const ok = await run("entry", () => listsApi.addEntry(task.id, kind, text));
    if (ok) {
      setEntryText("");
      setTimeout(() => timelineEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
    }
  };

  const submitPending = async () => {
    if (!task || !pending) return;
    const text = formText.trim();
    if (pending === "block" && !text) { setErr("Say what it's blocked on."); return; }
    if (pending === "send_back" && !text) { setErr("Say what needs another pass."); return; }
    const fn =
      pending === "done" ? () => listsApi.done(task.id, text || undefined)
      : pending === "block" ? () => listsApi.updateTask(task.id, { status: "blocked", reason: text })
      : () => listsApi.review(task.id, "send_back", text);
    if (await run(pending, fn)) { setPending(null); setFormText(""); }
  };

  const openForm = (p: Pending) => { setPending(p); setFormText(""); setErr(""); };

  /* --------------------------------- render --------------------------------- */

  const body = () => {
    if (!task) {
      return loadErr
        ? <p className="ds-call danger" style={{ margin: 0 }}>{loadErr}</p>
        : <div aria-hidden><div className="ds-skel" style={{ height: 22, width: "70%", marginBottom: 14 }} /><div className="ds-skel" style={{ height: 13, width: "45%", marginBottom: 24 }} /><div className="ds-skel" style={{ height: 80 }} /></div>;
    }
    const st = task.status;
    const claim = task.claim;
    const held = !!claim;
    const mine = !!claim?.by?.is_you && !claim?.by?.agent;
    const holderOk = !held || mine || isOwner;
    const locked = archived;
    const workAgents = (agents ?? []).filter((a) => a.access === "work");
    const assignee = assigneeValue(task);
    const lostAgent = task.assignee?.kind === "agent" && !workAgents.some((a) => a.id === task.assignee?.agent_id);
    const reason = st === "blocked" ? [...task.entries].reverse().map(blockedReason).find((r) => r !== null) ?? null : null;
    const anyBusy = !!busy;

    const actions: { key: string; label: string; title?: string; primary?: boolean; onClick: () => void }[] = [];
    if (st === "open" || (st === "blocked" && !held)) actions.push({ key: "claim", label: "Claim", title: "Say you're on it", primary: st === "open", onClick: () => void run("claim", () => listsApi.claim(task.id)) });
    if (held && mine) actions.push({ key: "release", label: "Let go", title: "Put it back for anyone to pick up", onClick: () => void run("release", () => listsApi.release(task.id)) });
    if (held && !mine && isOwner) actions.push({ key: "release", label: "Free it up", title: `Take it off ${whoName(claim?.by)} so anyone can pick it up`, onClick: () => void run("release", () => listsApi.release(task.id)) });
    if ((st === "open" || st === "in_progress" || st === "blocked") && holderOk) actions.push({ key: "done", label: "Done", primary: mine || st === "in_progress", onClick: () => openForm("done") });
    if ((st === "open" || st === "in_progress") && holderOk) actions.push({ key: "block", label: "Block", title: "Mark it stuck, and say on what", onClick: () => openForm("block") });
    if (st === "blocked" && holderOk) actions.push({ key: "unblock", label: "Unblock", onClick: () => void run("unblock", () => listsApi.updateTask(task.id, { status: "unblocked" })) });
    if (st === "needs_review") {
      actions.push({ key: "accept", label: "Looks good", primary: true, onClick: () => void run("accept", () => listsApi.review(task.id, "accept")) });
      actions.push({ key: "send_back", label: "Send back", onClick: () => openForm("send_back") });
    }
    if (st === "done") {
      if (task.send_back_until) actions.push({ key: "send_back", label: "Send back", title: "Hand it back to whoever did it, with a note", onClick: () => openForm("send_back") });
      actions.push({ key: "reopen", label: "Reopen", onClick: () => void run("reopen", () => listsApi.updateTask(task.id, { status: "reopened" })) });
    }
    if (ACTIVE.includes(st)) actions.push({ key: "drop", label: "Drop", title: "Take it off the list. You can restore it later.", onClick: () => void run("drop", () => listsApi.updateTask(task.id, { status: "dropped" })) });
    if (st === "dropped") actions.push({ key: "restore", label: "Restore", primary: true, onClick: () => void run("restore", () => listsApi.updateTask(task.id, { status: "restored" })) });

    const titleEditing = titleDraft !== null;
    const notesValue = notesDraft?.text ?? task.notes;
    const notesDirty = !!notesDraft && notesDraft.text !== notesDraft.baseText;

    return (
      <>
        {locked && <p className="ds-call warn" style={{ margin: "0 0 14px" }}>This list is archived. Unarchive it in the list&apos;s settings to make changes.</p>}

        {/* Title */}
        {titleEditing ? (
          <div>
            <label className="ds-label" htmlFor="ds-task-title" style={{ marginTop: 0 }}>Title</label>
            <input
              id="ds-task-title"
              className="ds-input"
              autoFocus
              maxLength={200}
              value={titleDraft.text}
              onChange={(e) => setTitleDraft({ ...titleDraft, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (titleDraft.text.trim()) void saveField("title", titleDraft.text.trim(), titleDraft.base, titleDraft.baseText); }
                if (e.key === "Escape") { e.preventDefault(); setTitleDraft(null); }
              }}
            />
            <div className="ds-actions" style={{ marginTop: 8 }}>
              <button className="ds-btn ds-sm" disabled={anyBusy || !titleDraft.text.trim()} onClick={() => void saveField("title", titleDraft.text.trim(), titleDraft.base, titleDraft.baseText)}>{busy === "save-title" ? "Saving…" : "Save"}</button>
              <button className="ds-btn ghost ds-sm" onClick={() => setTitleDraft(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="ds-drawer-title" id="ds-drawer-title" disabled={locked} title={locked ? undefined : "Click to rename"} onClick={() => setTitleDraft({ text: task.title, base: task.version, baseText: task.title })}>
            {st === "done" && <span aria-hidden style={{ color: "var(--ds-ok)" }}>✓ </span>}{task.title}
          </button>
        )}
        {conflict?.field === "title" && <ConflictBox conflict={conflict} busy={busy} onMine={(text) => setConflict({ ...conflict, mine: text })} onSave={() => void saveField("title", conflict.mine.trim(), conflict.current.version, conflict.current.title)} onTheirs={() => { setConflict(null); setTitleDraft(null); }} />}

        {/* Who is on it */}
        {claim && (
          <div className="ds-drawer-claim">
            <WhoAvatar who={claim.by} size={26} pulse={!!claim.by?.agent && st === "in_progress"} />
            <span>
              <strong style={{ color: "var(--ds-ink)" }}>{mine ? "You're on it" : `${whoName(claim.by)} is on it`}</strong>
              {claim.since && <> · {elapsed(claim.since)}</>}
              {claim.by?.agent && claim.lapses_at && <> · {lapsesIn(claim.lapses_at)}</>}
            </span>
            {claim.stale && <span className="ds-nudge">{mine ? "Still on it?" : "No word for 3 days. Still on it?"}</span>}
          </div>
        )}
        {st === "blocked" && (
          <div className="ds-drawer-claim">
            <Chip tone="warn">Blocked</Chip>
            {reason ? <span style={{ overflowWrap: "anywhere" }}>on: {reason}</span> : <span>No reason given.</span>}
          </div>
        )}
        {task.assignee && !claim && st !== "done" && st !== "dropped" && (
          <div className="ds-drawer-claim"><WhoAvatar who={task.assignee} size={22} /><span>{assigneeLabel(task)}. Nobody has picked it up yet.</span></div>
        )}

        {/* Finished work */}
        {st === "needs_review" && (
          <div className="ds-summary ready" style={{ marginTop: 14 }}>
            <strong>Ready for you.</strong> {whoName(task.completed_by)} finished this{task.summary ? ":" : "."}
            {task.summary && <PlainText text={task.summary} />}
          </div>
        )}
        {st === "done" && (
          <div className="ds-summary" style={{ marginTop: 14 }}>
            <strong>{whoName(task.completed_by)} finished this</strong> {ago(task.completed_at)}{task.summary ? ":" : "."}
            {task.summary && <PlainText text={task.summary} />}
            {task.send_back_until && <div className="ds-fine" style={{ marginTop: 4 }}>You can send it back until {dayName(task.send_back_until.slice(0, 10))}.</div>}
          </div>
        )}

        {/* Actions */}
        {!locked && actions.length > 0 && (
          <div className="ds-actions" style={{ marginTop: 16 }}>
            {actions.map((a) => (
              <button key={a.key} className={`ds-btn ds-sm${a.primary ? "" : " ghost"}`} title={a.title} disabled={anyBusy} onClick={a.onClick} aria-pressed={pending === a.key ? true : undefined}>
                {busy === a.key ? "…" : a.label}
              </button>
            ))}
          </div>
        )}
        {pending && !locked && (
          <div className="ds-inline-form">
            <label className="ds-label" htmlFor="ds-task-form" style={{ marginTop: 0 }}>
              {pending === "done" ? "What did you do? Optional, but it helps later." : pending === "block" ? "What's it blocked on?" : "What needs another pass?"}
            </label>
            {pending === "block" ? (
              <input id="ds-task-form" className="ds-input" autoFocus maxLength={1000} value={formText} onChange={(e) => setFormText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitPending(); } if (e.key === "Escape") { e.preventDefault(); setPending(null); } }} />
            ) : (
              <textarea id="ds-task-form" className="ds-textarea" autoFocus rows={3} maxLength={8000} value={formText} onChange={(e) => setFormText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submitPending(); } if (e.key === "Escape") { e.preventDefault(); setPending(null); } }} />
            )}
            <div className="ds-actions">
              <button className="ds-btn ds-sm" disabled={anyBusy} onClick={() => void submitPending()}>
                {busy === pending ? "…" : pending === "done" ? "Mark done" : pending === "block" ? "Block" : "Send back"}
              </button>
              <button className="ds-btn ghost ds-sm" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
        {err && <p className="ds-err" role="alert">{err}</p>}

        {/* Due and who it's for */}
        <div className="ds-drawer-sec ds-fields">
          <div>
            <label className="ds-drawer-label" htmlFor="ds-task-due">Due</label>
            <DueInput key={task.due ?? "none"} id="ds-task-due" value={dueDay(task.due)} disabled={locked || anyBusy}
              onCommit={(v) => void run("due", () => listsApi.updateTask(task.id, { due: v }))} />
          </div>
          <div>
            <label className="ds-drawer-label" htmlFor="ds-task-for">For</label>
            <select id="ds-task-for" className="ds-select" value={assignee} disabled={locked || anyBusy}
              onChange={(e) => void run("assignee", () => listsApi.updateTask(task.id, { assignee: e.target.value }))}>
              <option value="nobody">Nobody yet</option>
              <option value="me">Me</option>
              <option value="my_agents">My agents</option>
              {workAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              {lostAgent && task.assignee?.agent_id && <option value={task.assignee.agent_id} disabled>{task.assignee.agent} (no access)</option>}
            </select>
          </div>
        </div>

        {/* Notes */}
        <div className="ds-drawer-sec">
          <label className="ds-drawer-label" htmlFor="ds-task-notes">Notes</label>
          <textarea
            id="ds-task-notes"
            className="ds-textarea"
            rows={Math.min(14, Math.max(3, notesValue.split("\n").length + 1))}
            maxLength={20000}
            readOnly={locked}
            placeholder={locked ? "No notes." : "Details, links, or what done looks like."}
            value={notesValue}
            onChange={(e) => setNotesDraft(notesDraft ? { ...notesDraft, text: e.target.value } : { text: e.target.value, base: task.version, baseText: task.notes })}
          />
          {notesDirty && (
            <div className="ds-actions" style={{ marginTop: 8 }}>
              <button className="ds-btn ds-sm" disabled={anyBusy} onClick={() => void saveField("notes", notesDraft.text, notesDraft.base, notesDraft.baseText)}>{busy === "save-notes" ? "Saving…" : "Save notes"}</button>
              <button className="ds-btn ghost ds-sm" onClick={() => { setNotesDraft(null); if (conflict?.field === "notes") setConflict(null); }}>Discard changes</button>
            </div>
          )}
          {conflict?.field === "notes" && <ConflictBox conflict={conflict} busy={busy} onMine={(text) => setConflict({ ...conflict, mine: text })} onSave={() => void saveField("notes", conflict.mine, conflict.current.version, conflict.current.notes)} onTheirs={() => { setConflict(null); setNotesDraft(null); }} />}
        </div>

        {/* Activity */}
        <div className="ds-drawer-sec">
          <div className="ds-drawer-label">Activity</div>
          {task.entries.length >= 50 && <p className="ds-fine" style={{ marginTop: 0 }}>Showing the latest 50.</p>}
          <div className="ds-tl">
            {task.entries.map((e) =>
              e.kind === "event" ? (
                <div key={e.id} className="ds-tl-event">
                  <span>{eventLine(e)}</span>
                  <time className="ds-tl-time" dateTime={e.at ?? undefined} title={e.at ? new Date(e.at).toLocaleString() : undefined}>{ago(e.at)}</time>
                </div>
              ) : (
                <div key={e.id} className="ds-tl-row">
                  <WhoAvatar who={e.by} size={26} />
                  <div className={`ds-tl-bubble${e.kind === "progress" ? " progress" : ""}`}>
                    <div className="ds-tl-who">
                      {whoName(e.by)}
                      {e.kind === "progress" && <Chip tone="acc">progress</Chip>}
                      <time className="ds-tl-time" dateTime={e.at ?? undefined} title={e.at ? new Date(e.at).toLocaleString() : undefined}>{ago(e.at)}</time>
                    </div>
                    <PlainText className="ds-tl-text" text={e.text} />
                  </div>
                </div>
              ),
            )}
            <div ref={timelineEnd} />
          </div>

          {!locked && (
            <div style={{ marginTop: 14 }}>
              <div className="ds-seg" role="group" aria-label="What you're adding">
                <button className={kind === "comment" ? "on" : ""} aria-pressed={kind === "comment"} onClick={() => setKind("comment")}>Comment</button>
                <button className={kind === "progress" ? "on" : ""} aria-pressed={kind === "progress"} onClick={() => setKind("progress")}>Progress</button>
              </div>
              <textarea
                className="ds-textarea"
                style={{ marginTop: 8 }}
                rows={2}
                maxLength={8000}
                aria-label={kind === "comment" ? "Comment" : "Progress line"}
                placeholder={kind === "comment" ? "Ask a question or leave a note for whoever picks this up." : "What just happened? e.g. Called the vendor, waiting to hear back."}
                value={entryText}
                onChange={(e) => setEntryText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void post(); } }}
              />
              <div className="ds-actions" style={{ marginTop: 8, alignItems: "center" }}>
                <button className="ds-btn ds-sm" disabled={anyBusy || !entryText.trim()} onClick={() => void post()}>{busy === "entry" ? "Posting…" : kind === "comment" ? "Comment" : "Add progress"}</button>
                <span className="ds-fine">Ctrl+Enter posts. Everyone on the list can read it.</span>
              </div>
            </div>
          )}
        </div>

        <p className="ds-fine" style={{ marginTop: 22 }}>
          Added by {whoName(task.created_by)} {ago(task.created_at)}
          {task.updated_at && task.updated_at !== task.created_at ? <> · updated {ago(task.updated_at)}</> : null}
        </p>
      </>
    );
  };

  return (
    <>
      <div className="ds-drawer-back" onClick={onClose} aria-hidden />
      <div className="ds-drawer" role="dialog" aria-modal="true" aria-labelledby="ds-drawer-title" ref={panelRef} tabIndex={-1}>
        <div className="ds-drawer-head">
          <span className="ds-drawer-crumb">{task ? task.list.name : "Task"}</span>
          {task && <Chip tone={task.status === "needs_review" ? "acc" : task.status === "blocked" ? "warn" : task.status === "done" ? "ok" : undefined}>{STATUS_LABEL[task.status]}</Chip>}
          <button className="ds-drawer-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="ds-drawer-body">{body()}</div>
      </div>
    </>
  );
}

/** Both versions side by side so the person can merge, then save theirs on top of the current one. */
function ConflictBox({ conflict, busy, onMine, onSave, onTheirs }: {
  conflict: Conflict; busy: string; onMine: (text: string) => void; onSave: () => void; onTheirs: () => void;
}) {
  const what = conflict.field === "title" ? "the title" : "the notes";
  const current = conflict.field === "title" ? conflict.current.title : conflict.current.notes;
  const rows = conflict.field === "title" ? 2 : 6;
  return (
    <div className="ds-call warn" style={{ marginTop: 10 }} role="alert">
      <strong>Someone changed {what} while you were editing.</strong> Here are both. Copy what you need into yours, then save.
      <div className="ds-conflict">
        <div>
          <div className="ds-drawer-label">Now</div>
          <textarea className="ds-textarea" readOnly rows={rows} value={current} aria-label={`Current ${what}`} />
        </div>
        <div>
          <div className="ds-drawer-label">Yours</div>
          <textarea className="ds-textarea" rows={rows} value={conflict.mine} onChange={(e) => onMine(e.target.value)} aria-label={`Your ${what}`} />
        </div>
      </div>
      <div className="ds-actions" style={{ marginTop: 8 }}>
        <button className="ds-btn ds-sm" disabled={!!busy || (conflict.field === "title" && !conflict.mine.trim())} onClick={onSave}>{busy === `save-${conflict.field}` ? "Saving…" : "Save yours"}</button>
        <button className="ds-btn ghost ds-sm" onClick={onTheirs}>Keep theirs</button>
      </div>
    </div>
  );
}

/**
 * A date input that saves once a whole date is in (or it's cleared), not on
 * every keystroke of the year. Remounted by its key when the saved date changes.
 */
function DueInput({ id, value, disabled, onCommit }: { id: string; value: string; disabled: boolean; onCommit: (v: string) => void }) {
  const committed = useRef(value);
  const commit = (v: string) => {
    if (v === committed.current) return;
    if (v !== "" && !/^(19|20)\d{2}-\d{2}-\d{2}$/.test(v)) return;
    committed.current = v;
    onCommit(v);
  };
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <input id={id} type="date" className="ds-input" defaultValue={value} disabled={disabled}
        onChange={(e) => { if (e.target.value === "" || /^20\d{2}-/.test(e.target.value)) commit(e.target.value); }}
        onBlur={(e) => commit(e.target.value)} />
      {value && !disabled && <button className="ds-link" onClick={() => commit("")}>Clear</button>}
    </div>
  );
}
