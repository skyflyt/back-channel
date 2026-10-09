"use client";
/**
 * The Lists tab's forms: start a list, change a list's settings (name, emoji,
 * archive, which agents may work it), and quick add.
 */
import { useEffect, useMemo, useState } from "react";
import { Chip, HealthDot } from "@/components/ui/primitives";
import {
  listsApi, errorText, agentActivity, dueInfo, RUNTIME_LABEL,
  type AccountAgent, type Access, type ListDetail, type YourAgent,
} from "./api";
import { parseQuickAdd, assigneeParam, agentSlug } from "./quick-add.mjs";

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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

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
      const r = await listsApi.createList({ name: name.trim(), ...(emoji.trim() ? { emoji: emoji.trim() } : {}), agents: [...picked] });
      onCreated(r.list.id);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ds-lists-newform" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className="ds-label" htmlFor="ds-newlist-name" style={{ marginTop: 0 }}>Name</label>
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

/* ------------------------------- list settings ------------------------------ */

const ACCESS_OPTIONS: { value: Access; label: string; title: string }[] = [
  { value: "none", label: "None", title: "Can't see this list" },
  { value: "view", label: "View", title: "Can read tasks and comment" },
  { value: "work", label: "Work", title: "Can add, pick up and finish tasks" },
];

export function ListSettings({ detail, onChanged }: { detail: ListDetail; onChanged: () => void }) {
  const l = detail.list;
  const isOwner = l.your_role === "owner";
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

      {isOwner && (
        <>
          <div className="ds-label" style={{ marginTop: 18 }}>{l.archived ? "Archived" : "Archive"}</div>
          <p className="ds-fine" style={{ margin: "0 0 8px" }}>
            {l.archived
              ? "This list is read-only and hidden from your agents' plates. Unarchive it to use it again."
              : "Archiving hides the list from your agents' plates and makes it read-only. Nothing is deleted."}
          </p>
          <button className="ds-btn ghost ds-sm" disabled={!!busy} onClick={() => void act("archive", () => listsApi.updateList(l.id, { archived: !l.archived }), l.archived ? "Unarchived." : "Archived.")}>
            {busy === "archive" ? "…" : l.archived ? "Unarchive list" : "Archive list"}
          </button>
        </>
      )}
      {err && <p className="ds-err" role="alert">{err}</p>}
      {note && !err && <p className="ds-fine" role="status" style={{ color: "var(--ds-ok)" }}>{note}</p>}
    </div>
  );
}

/* --------------------------------- quick add -------------------------------- */

export function QuickAdd({ listId, agents, disabled, onAdded }: {
  listId: string; agents: YourAgent[] | undefined; disabled: boolean; onAdded: () => void;
}) {
  const [text, setText] = useState("");
  const [skipDue, setSkipDue] = useState(false);
  const [skipAssignee, setSkipAssignee] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const known = useMemo(() => (agents ?? []).map((a) => ({ id: a.id, name: a.name, access: a.access })), [agents]);
  const parsed = useMemo(() => parseQuickAdd(text, { now: new Date(), agents: known, skipDue, skipAssignee }), [text, known, skipDue, skipAssignee]);
  const example = (agents ?? []).find((a) => a.access === "work");
  const mentions = example ? `@me, @agents, @${agentSlug(example.name)}` : "@me or @agents";

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
  const who = parsed.assignee
    ? parsed.assignee.kind === "me" ? "For you" : parsed.assignee.kind === "my_agents" ? "For your agents" : `For ${parsed.assignee.name}`
    : null;

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
