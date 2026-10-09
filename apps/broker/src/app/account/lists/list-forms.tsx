"use client";
/**
 * The Lists tab's forms: start a list (blank or from a template), change a
 * list's settings (name, emoji, who is on it, your own settings there, which
 * of your agents may work it, duplicate it or save it as a template, archive
 * or leave), and quick add.
 */
import { useEffect, useMemo, useState } from "react";
import { Chip, HealthDot } from "@/components/ui/primitives";
import {
  listsApi, errorText, agentActivity, dueInfo, RUNTIME_LABEL,
  type AccountAgent, type Access, type ListDetail, type MemberView, type TemplateView, type YourAgent,
} from "./api";
import { parseQuickAdd, assigneeParam, assigneeChip, agentSlug, bareHandle } from "./quick-add.mjs";
import { MembersPanel, MySettings, LeaveList } from "./members";

const DAY = 24 * 60 * 60_000;
const EMOJIS = ["📝", "🏠", "💼", "🛒", "🧳", "🎯", "🔧", "📚"];
const AGENT_LINE = "Agents you tick can see and work this list.";

function EmojiPicker({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <>
      <div className="ds-lists-emojis" role="group" aria-label="Pick an emoji">
        {EMOJIS.map((e) => (
          <button key={e} type="button" className={value === e ? "on" : ""} aria-pressed={value === e} onClick={() => onChange(value === e ? "" : e)}>{e}</button>
        ))}
      </div>
      <input id={id} className="ds-input" style={{ marginTop: 6, width: 120 }} maxLength={16} placeholder="or type one" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Emoji" />
    </>
  );
}

/* --------------------------------- new list -------------------------------- */

export function NewListForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [agents, setAgents] = useState<AccountAgent[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    listsApi.templates()
      .then((r) => { if (live) setTemplates(r.templates); })
      .catch(() => { if (live) setTemplates([]); });
    return () => { live = false; };
  }, []);

  const chosen = templates?.find((t) => t.id === templateId) ?? null;
  const builtins = (templates ?? []).filter((t) => t.kind === "builtin");
  const saved = (templates ?? []).filter((t) => t.kind === "saved");

  // A template names the list (and picks its emoji) unless you've already typed your own.
  const pick = (id: string) => {
    const next = templates?.find((t) => t.id === id) ?? null;
    if (!name.trim() || (chosen && name === chosen.name)) setName(next?.name ?? "");
    if (!emoji || (chosen && emoji === (chosen.emoji ?? ""))) setEmoji(next?.emoji ?? "");
    setTemplateId(id);
    setConfirmDelete(false);
    setErr("");
  };

  const deleteTemplate = async () => {
    if (!chosen || chosen.kind !== "saved") return;
    setBusy(true); setErr("");
    try {
      await listsApi.deleteTemplate(chosen.id);
      setTemplates((ts) => ts?.filter((t) => t.id !== chosen.id) ?? ts);
      if (name === chosen.name) setName("");
      if (emoji === (chosen.emoji ?? "")) setEmoji("");
      setTemplateId("");
      setConfirmDelete(false);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    listsApi.accountAgents()
      .then((r) => {
        if (!live) return;
        const mine = r.agents.filter((a) => !a.revoked_at);
        setAgents(mine);
        // Pre-tick agents the person runs themselves that were active in the last 30 days.
        // Hosted apps (claude.ai, ChatGPT connectors) start unticked.
        setPicked(new Set(mine.filter((a) => a.scope === "full" && a.last_used_at && Date.now() - new Date(a.last_used_at).getTime() < 30 * DAY).map((a) => a.id)));
      })
      .catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, []);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const create = async () => {
    if (!name.trim()) { setErr("Give the list a name."); return; }
    setBusy(true); setErr("");
    try {
      const r = await listsApi.createList({
        name: name.trim(), emoji: emoji.trim(), agents: [...picked], ...(templateId ? { template: templateId } : {}),
      });
      onCreated(r.list.id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ds-lists-newform" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="ds-label" htmlFor="ds-newlist-template" style={{ marginTop: 0 }}>Start from</label>
      <select id="ds-newlist-template" className="ds-select" style={{ width: "100%" }} value={templateId} disabled={templates === null} onChange={(e) => pick(e.target.value)}>
        <option value="">A blank list</option>
        {builtins.length > 0 && (
          <optgroup label="Templates">
            {builtins.map((t) => <option key={t.id} value={t.id}>{t.emoji ? `${t.emoji} ` : ""}{t.name}</option>)}
          </optgroup>
        )}
        {saved.length > 0 && (
          <optgroup label="Your templates">
            {saved.map((t) => <option key={t.id} value={t.id}>{t.emoji ? `${t.emoji} ` : ""}{t.name}</option>)}
          </optgroup>
        )}
      </select>
      {chosen && (
        <p className="ds-fine" style={{ margin: "6px 0 0" }}>
          {chosen.count} {chosen.count === 1 ? "task" : "tasks"}: {chosen.preview.join(", ")}{chosen.count > chosen.preview.length ? ", and more" : ""}.
          {chosen.kind === "saved" && !confirmDelete && <> <button type="button" className="ds-link" style={{ fontSize: 12 }} onClick={() => setConfirmDelete(true)}>Delete this template</button></>}
        </p>
      )}
      {chosen?.kind === "saved" && confirmDelete && (
        <div className="ds-inline-form" role="alert">
          <p style={{ margin: 0, fontSize: 13 }}>Delete the template &ldquo;{chosen.name}&rdquo;? Lists you already started from it stay as they are.</p>
          <div className="ds-actions">
            <button type="button" className="ds-btn danger ds-sm" disabled={busy} onClick={() => void deleteTemplate()}>{busy ? "Deleting…" : "Delete template"}</button>
            <button type="button" className="ds-btn ghost ds-sm" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep it</button>
          </div>
        </div>
      )}
      <label className="ds-label" htmlFor="ds-newlist-name">Name</label>
      <input id="ds-newlist-name" className="ds-input" autoFocus maxLength={80} placeholder="e.g. House, Work, Vegas trip" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="ds-label" htmlFor="ds-newlist-emoji">Emoji</label>
      <EmojiPicker id="ds-newlist-emoji" value={emoji} onChange={setEmoji} />
      <div className="ds-label">Agents</div>
      <p className="ds-fine" style={{ margin: "0 0 4px" }}>{AGENT_LINE}</p>
      {agents === null && <div className="ds-skel" style={{ height: 13, width: "80%", margin: "8px 0" }} />}
      {agents?.length === 0 && <p className="ds-fine" style={{ margin: "4px 0" }}>No agents connected yet. You can give them access later in the list&apos;s settings.</p>}
      {agents?.map((a) => {
        const act = agentActivity(a.last_used_at);
        const hosted = a.scope !== "full";
        return (
          <label key={a.id} className="ds-check">
            <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
            <span style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{a.name}</span>
              {hosted && <> <Chip title="An app you connected through your Back Channel account, like claude.ai or ChatGPT">connected app</Chip></>}
              <span className="ds-imeta" style={{ display: "flex", alignItems: "center", gap: 6 }}><HealthDot color={act.color} />{act.label}</span>
            </span>
          </label>
        );
      })}
      {err && <p className="ds-err" role="alert">{err}</p>}
      <div className="ds-actions" style={{ marginTop: 10 }}>
        <button className="ds-btn ds-sm" type="submit" disabled={busy}>{busy ? "Creating…" : "Create list"}</button>
        {onCancel && <button className="ds-btn ghost ds-sm" type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/* ------------------------- duplicate, save as template ------------------------ */

/**
 * "Duplicate list" (anyone on the list: a new list of your own with its
 * unfinished tasks, each still credited to whoever wrote it) and "Save as
 * template" (the unfinished tasks you or your agents wrote).
 */
function CopyList({ detail, onDuplicated }: { detail: ListDetail; onDuplicated: (id: string) => void }) {
  const l = detail.list;
  const [saving, setSaving] = useState(false);
  const [templateName, setTemplateName] = useState(l.name);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const shared = detail.members.length > 1;

  const duplicate = async () => {
    setBusy("duplicate"); setErr(""); setNote("");
    try {
      const r = await listsApi.createList({ duplicate: l.id });
      onDuplicated(r.list.id);
    } catch (e) {
      setErr(errorText(e));
      setBusy("");
    }
  };

  const save = async () => {
    if (!templateName.trim()) { setErr("Give the template a name."); return; }
    setBusy("save"); setErr(""); setNote("");
    try {
      const r = await listsApi.saveTemplate(l.id, { name: templateName.trim() });
      const left = r.skipped ? ` ${r.skipped} ${r.skipped === 1 ? "task" : "tasks"} other people wrote stayed out: a template keeps only your own.` : "";
      setNote(`Saved “${r.template.name}” with ${r.template.count} ${r.template.count === 1 ? "task" : "tasks"}. Pick it under Start from when you make a new list.${left}`);
      setSaving(false);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="ds-label" style={{ marginTop: 18 }}>Copy this list</div>
      <p className="ds-fine" style={{ margin: "0 0 8px" }}>
        Duplicate makes a new list of your own with the tasks that aren&apos;t finished: titles, notes and order, not who they&apos;re for, comments or history.
        {shared ? " Each task still shows who wrote it, so a friend's task still needs your OK before your agents take it." : ""}
      </p>
      <div className="ds-actions">
        <button className="ds-btn ghost ds-sm" disabled={!!busy} onClick={() => void duplicate()}>{busy === "duplicate" ? "Duplicating…" : "Duplicate list"}</button>
        {!saving && <button className="ds-btn ghost ds-sm" disabled={!!busy} onClick={() => { setSaving(true); setTemplateName(l.name); setNote(""); }}>Save as template</button>}
      </div>
      {saving && (
        <form className="ds-inline-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="ds-label" htmlFor={`tpl-${l.id}`} style={{ marginTop: 0 }}>Template name</label>
          <input id={`tpl-${l.id}`} className="ds-input" maxLength={80} autoFocus value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
          <p className="ds-fine" style={{ margin: "6px 0 0" }}>
            Saves the unfinished tasks you or your agents wrote, with their notes.{shared ? " Tasks other people wrote stay out." : ""} Only you and your agents can use it.
          </p>
          <div className="ds-actions">
            <button className="ds-btn ds-sm" type="submit" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save template"}</button>
            <button className="ds-btn ghost ds-sm" type="button" disabled={!!busy} onClick={() => setSaving(false)}>Cancel</button>
          </div>
        </form>
      )}
      {err && <p className="ds-err" role="alert">{err}</p>}
      {note && !err && <p className="ds-fine" role="status" style={{ color: "var(--ds-ok)" }}>{note}</p>}
    </>
  );
}

/* ------------------------------- list settings ------------------------------ */

const ACCESS_OPTIONS: { value: Access; label: string; title: string }[] = [
  { value: "none", label: "None", title: "Can't see this list" },
  { value: "view", label: "View", title: "Can read tasks and comment" },
  { value: "work", label: "Work", title: "Can add, pick up and finish tasks" },
];

export function ListSettings({ detail, focusMembers, onChanged, onLeft, onDuplicated }: {
  detail: ListDetail; focusMembers?: boolean; onChanged: () => void; onLeft: () => void; onDuplicated: (id: string) => void;
}) {
  const l = detail.list;
  const isOwner = l.your_role === "owner";
  const shared = detail.members.length > 1;
  const [name, setName] = useState(l.name);
  const [emoji, setEmoji] = useState(l.emoji ?? "");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const dirty = name.trim() !== l.name || (emoji.trim() || null) !== (l.emoji ?? null);

  const act = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setErr(""); setNote("");
    try {
      await fn();
      if (done) setNote(done);
      onChanged();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="ds-card" style={{ marginBottom: 18 }}>
      <h2 className="ds-cardh" style={{ margin: 0 }}>List settings</h2>

      {isOwner && (
        <form onSubmit={(e) => { e.preventDefault(); if (dirty && name.trim()) void act("save", () => listsApi.updateList(l.id, { name: name.trim(), emoji: emoji.trim() || null }), "Saved."); }}>
          <label className="ds-label" htmlFor="ds-list-name">Name</label>
          <input id="ds-list-name" className="ds-input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="ds-label" htmlFor="ds-list-emoji">Emoji</label>
          <EmojiPicker id="ds-list-emoji" value={emoji} onChange={setEmoji} />
          <div className="ds-actions" style={{ marginTop: 10 }}>
            <button className="ds-btn ds-sm" type="submit" disabled={!!busy || !dirty || !name.trim()}>{busy === "save" ? "Saving…" : "Save"}</button>
          </div>
        </form>
      )}

      <MembersPanel detail={detail} focusAdd={focusMembers} onChanged={onChanged} />
      {shared && <MySettings detail={detail} onChanged={onChanged} />}

      <div className="ds-label" style={{ marginTop: 18 }}>Which of your agents can use this list</div>
      <p className="ds-fine" style={{ margin: "0 0 4px" }}>Work: add, pick up and finish tasks. View: read and comment. None: can&apos;t see it. Changes apply on the agent&apos;s next request.</p>
      {(detail.your_agents ?? []).length === 0 && <p className="ds-fine">No agents connected yet. Connect one from the Agents tab.</p>}
      {(detail.your_agents ?? []).map((a: YourAgent) => {
        const activity = agentActivity(a.last_used_at);
        const runtime = a.runtime_type ? RUNTIME_LABEL[a.runtime_type] ?? a.runtime_type : "";
        return (
          <div key={a.id} className="ds-access">
            <HealthDot color={activity.color} label={activity.label} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ds-iname" style={{ fontSize: 13 }}>
                {a.name}
                {a.hosted && <> <Chip title="An app you connected through your Back Channel account, like claude.ai or ChatGPT">connected app</Chip></>}
              </div>
              <div className="ds-imeta">{runtime && runtime.toLowerCase() !== a.name.toLowerCase() ? `${runtime} · ` : ""}{activity.label}</div>
            </div>
            <div className="ds-seg" role="group" aria-label={`${a.name}'s access`}>
              {ACCESS_OPTIONS.map((o) => (
                <button key={o.value} type="button" title={o.title} className={a.access === o.value ? "on" : ""} aria-pressed={a.access === o.value}
                  disabled={!!busy || l.archived} onClick={() => { if (a.access !== o.value) void act(`agent:${a.id}`, () => listsApi.setAgentAccess(l.id, a.id, o.value)); }}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <CopyList detail={detail} onDuplicated={onDuplicated} />

      {isOwner && (
        <>
          <div className="ds-label" style={{ marginTop: 18 }}>{l.archived ? "Archived" : "Archive"}</div>
          <p className="ds-fine" style={{ margin: "0 0 8px" }}>
            {l.archived
              ? "This list is read-only and hidden from your agents' plates. Unarchive it to use it again."
              : shared
                ? "Archiving makes the list read-only for everyone on it and takes it off every agent's plate. Nothing is deleted."
                : "Archiving hides the list from your agents' plates and makes it read-only. Nothing is deleted."}
          </p>
          <button className="ds-btn ghost ds-sm" disabled={!!busy} onClick={() => void act("archive", () => listsApi.updateList(l.id, { archived: !l.archived }), l.archived ? "Unarchived." : "Archived.")}>
            {busy === "archive" ? "…" : l.archived ? "Unarchive list" : "Archive list"}
          </button>
        </>
      )}
      <LeaveList detail={detail} onLeft={onLeft} />
      {err && <p className="ds-err" role="alert">{err}</p>}
      {note && !err && <p className="ds-fine" role="status" style={{ color: "var(--ds-ok)" }}>{note}</p>}
    </div>
  );
}

/* --------------------------------- quick add -------------------------------- */

export function QuickAdd({ listId, agents, members, disabled, onAdded }: {
  listId: string; agents: YourAgent[] | undefined; members: MemberView[]; disabled: boolean; onAdded: () => void;
}) {
  const [text, setText] = useState("");
  const [skipDue, setSkipDue] = useState(false);
  const [skipAssignee, setSkipAssignee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const known = useMemo(() => (agents ?? []).map((a) => ({ id: a.id, name: a.name, access: a.access })), [agents]);
  const parsed = useMemo(() => parseQuickAdd(text, { now: new Date(), agents: known, members, skipDue, skipAssignee }), [text, known, members, skipDue, skipAssignee]);
  const example = (agents ?? []).find((a) => a.access === "work");
  const friend = members.find((m) => !m.is_you && m.handle);
  const mentions = [
    "@me", "@agents",
    ...(example ? [`@${agentSlug(example.name)}`] : []),
    ...(friend ? [`@${bareHandle(friend.handle)}`, `@${bareHandle(friend.handle)}'s agents`] : []),
  ].join(", ");

  const change = (v: string) => {
    setText(v);
    setErr("");
    if (!v.trim()) { setSkipDue(false); setSkipAssignee(false); }
  };

  const add = async () => {
    if (busy) return;
    if (!parsed.title) {
      if (text.trim()) setErr("Add a few words about what needs doing, not just a day or a name.");
      return;
    }
    const assignee = assigneeParam(parsed.assignee);
    setBusy(true); setErr("");
    try {
      await listsApi.addTask(listId, { title: parsed.title, ...(parsed.due ? { due: parsed.due } : {}), ...(assignee ? { assignee } : {}) });
      change("");
      onAdded();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const read = !!parsed.due || !!parsed.assignee;
  const due = parsed.due ? dueInfo(`${parsed.due}T12:00:00.000Z`) : null;
  const who = assigneeChip(parsed.assignee);

  return (
    <div className="ds-qa">
      <input
        className="ds-input"
        aria-label="Add a task"
        placeholder={disabled ? "This list is archived." : "Add a task and press Enter"}
        disabled={disabled}
        maxLength={400}
        value={text}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void add(); }
          if (e.key === "Escape" && text) { e.preventDefault(); change(""); }
        }}
      />
      {(read || parsed.problems.length > 0) && (
        <div className="ds-qa-chips" aria-live="polite">
          {due && (
            <span className="ds-qa-chip">
              {due.label}
              <button type="button" aria-label={`Keep "${parsed.dueToken}" in the title`} title={`Keep "${parsed.dueToken}" in the title`} onClick={() => setSkipDue(true)}>×</button>
            </span>
          )}
          {who && (
            <span className="ds-qa-chip">
              {who}
              <button type="button" aria-label={`Keep "${parsed.assigneeToken}" in the title`} title={`Keep "${parsed.assigneeToken}" in the title`} onClick={() => setSkipAssignee(true)}>×</button>
            </span>
          )}
          {parsed.problems.map((p) => <span key={p.token} className="ds-qa-chip warn">{p.message}</span>)}
          {read && parsed.title && <span className="ds-qa-title">Adds &ldquo;{parsed.title}&rdquo;</span>}
        </div>
      )}
      {err && <p className="ds-err" role="alert">{err}</p>}
      {!disabled && (
        <p className="ds-fine" style={{ margin: "6px 0 0" }}>
          Enter adds it. End with a day (today, fri, 2026-10-31) or who it&apos;s for ({mentions}).
          {busy && " Adding…"}
        </p>
      )}
    </div>
  );
}
