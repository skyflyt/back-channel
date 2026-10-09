"use client";
/**
 * Sharing a list (Phase 2), inside the list's settings:
 *   - People on this list: who is on it, their role, when they joined, and
 *     which of their agents can see or work it. The owner adds mutual friends
 *     and takes people off; anyone else can leave. List activity (who joined,
 *     left or was taken off) sits underneath.
 *   - Your settings on this list: whose tasks your agents take without asking,
 *     and email nudges. Each person's own; nobody else's setting changes yours.
 *
 * Adding people is cookie-only on the server and owner-only; a refusal comes
 * back as one plain sentence, shown as is.
 */
import { useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/primitives";
import {
  listsApi, errorText, ago, memberRef, memberLabel, listEventLine,
  type AgentsTakeFrom, type ListDetail, type ListNotify, type MemberView, type TrustPeer,
} from "./api";
import { WhoAvatar } from "./bits";
import { bareHandle } from "./quick-add.mjs";

const sameHandle = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && bareHandle(a).toLowerCase() === bareHandle(b).toLowerCase();

const ACCESS_WORD = { work: "can work", view: "can read" } as const;

/* ------------------------------ people on a list ----------------------------- */

export function MembersPanel({ detail, focusAdd, onChanged }: { detail: ListDetail; focusAdd?: boolean; onChanged: () => void }) {
  const l = detail.list;
  const isOwner = l.your_role === "owner";
  const members = detail.members;
  const others = members.filter((m) => !m.is_you);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [showAll, setShowAll] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusAdd) sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusAdd]);

  const takeOff = async (m: MemberView) => {
    if (!m.handle) return;
    setBusy(`off:${m.handle}`); setErr("");
    try {
      await listsApi.removeMember(l.id, m.handle);
      setConfirm(null);
      onChanged();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const events = [...detail.activity].reverse();
  const shownEvents = showAll ? events : events.slice(0, 4);

  return (
    <div ref={sectionRef} id="ds-list-members" style={{ scrollMarginTop: 80 }}>
      <div className="ds-label" style={{ marginTop: 18 }}>People on this list</div>
      <p className="ds-fine" style={{ margin: "0 0 4px" }}>
        {others.length
          ? "Everyone here can see the list, add tasks and pick them up. Each person decides which of their own agents can use it."
          : isOwner
            ? "Just you for now. Add a friend and they can see the list, add tasks and pick them up, with the agents they choose."
            : "Just you."}
      </p>
      {members.map((m) => {
        const name = memberLabel(m);
        const handle = m.handle ? `@${bareHandle(m.handle)}` : "";
        const confirming = confirm === m.handle;
        return (
          <div key={m.handle ?? name} className="ds-member">
            <WhoAvatar who={memberRef(m)} size={30} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="ds-iname" style={{ fontSize: 13.5, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {name}{m.is_you && <span className="ds-imeta" style={{ margin: 0 }}>(you)</span>}
                {m.role === "owner" && <Chip tone="acc">Owner</Chip>}
              </div>
              <div className="ds-imeta">
                {[handle, m.joined_at ? (m.role === "owner" ? `started it ${ago(m.joined_at)}` : `joined ${ago(m.joined_at)}`) : ""].filter(Boolean).join(" · ")}
              </div>
              <div className="ds-imeta">
                {m.agents.length
                  ? <>Agents: {m.agents.map((a, i) => <span key={`${a.name}-${i}`}>{i ? ", " : ""}{a.name} <span className="ds-faint-note">({ACCESS_WORD[a.access]})</span></span>)}</>
                  : m.is_you ? "None of your agents can use this list yet." : "No agents on this list."}
              </div>
              {confirming && (
                <div className="ds-inline-form" role="alert">
                  <p style={{ margin: 0, fontSize: 13 }}>
                    Take {name} off this list? They and their agents lose access right away, and anything they&apos;re working on goes back to the list. Their past work stays.
                  </p>
                  <div className="ds-actions">
                    <button className="ds-btn danger ds-sm" disabled={!!busy} onClick={() => void takeOff(m)}>{busy === `off:${m.handle}` ? "…" : "Take off"}</button>
                    <button className="ds-btn ghost ds-sm" onClick={() => setConfirm(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
            {isOwner && !m.is_you && m.role !== "owner" && !confirming && (
              <button className="ds-btn ghost ds-sm" disabled={!!busy} onClick={() => { setConfirm(m.handle); setErr(""); }}>Take off</button>
            )}
          </div>
        );
      })}
      {err && <p className="ds-err" role="alert">{err}</p>}

      {isOwner && !l.archived && <AddFriend listId={l.id} members={members} autoFocus={focusAdd} onAdded={onChanged} />}
      {isOwner && l.archived && <p className="ds-fine">Unarchive the list to add people to it.</p>}

      {events.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="ds-drawer-label">Recent changes</div>
          <div className="ds-tl" style={{ gap: 6 }}>
            {shownEvents.map((e) => (
              <div key={e.id} className="ds-tl-event">
                <span>{listEventLine(e)}</span>
                <time className="ds-tl-time" dateTime={e.at ?? undefined} title={e.at ? new Date(e.at).toLocaleString() : undefined}>{ago(e.at)}</time>
              </div>
            ))}
          </div>
          {events.length > shownEvents.length && <button className="ds-link" style={{ marginTop: 6 }} onClick={() => setShowAll(true)}>Show all {events.length}</button>}
        </div>
      )}
    </div>
  );
}

/** The owner's picker: mutual friends who aren't on the list yet. */
function AddFriend({ listId, members, autoFocus, onAdded }: { listId: string; members: MemberView[]; autoFocus?: boolean; onAdded: () => void }) {
  const [friends, setFriends] = useState<TrustPeer[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Who was just added: "Added @carol" shows while they're still on the list.
  const [added, setAdded] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const note = added && members.some((m) => sameHandle(m.handle, added)) ? `Added @${bareHandle(added)}. They can see this list now.` : "";

  const load = async () => {
    setLoadErr("");
    try {
      const r = await listsApi.friends();
      setFriends(r.peers.filter((p) => p.mutual));
    } catch (e) {
      setLoadErr(errorText(e));
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (autoFocus && friends?.length) selectRef.current?.focus(); }, [autoFocus, friends]);

  const candidates = (friends ?? []).filter((f) => !members.some((m) => sameHandle(m.handle, f.handle)));

  const add = async () => {
    if (!pick || busy) return;
    setBusy(true); setErr(""); setAdded("");
    try {
      await listsApi.addMember(listId, pick);
      setAdded(pick);
      setPick("");
      onAdded();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <label className="ds-label" htmlFor="ds-add-friend" style={{ marginTop: 0 }}>Add a friend</label>
      {friends === null && !loadErr && <div className="ds-skel" style={{ height: 13, width: "60%", margin: "8px 0" }} />}
      {loadErr && <p className="ds-fine" style={{ margin: "4px 0" }}>{loadErr} <button className="ds-link" onClick={() => void load()}>Try again</button></p>}
      {friends && friends.length === 0 && (
        <p className="ds-fine" style={{ margin: "4px 0" }}>
          You can share a list with friends on Back Channel. You don&apos;t have any yet. <a className="ds-link" href="/account?tab=friends">Add one on the Friends tab</a>.
        </p>
      )}
      {friends && friends.length > 0 && candidates.length === 0 && <p className="ds-fine" style={{ margin: "4px 0" }}>All your friends are on this list.</p>}
      {candidates.length > 0 && (
        <form className="ds-addrow" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <select id="ds-add-friend" ref={selectRef} className="ds-select" value={pick} onChange={(e) => { setPick(e.target.value); setErr(""); setAdded(""); }}>
            <option value="">Pick a friend</option>
            {candidates.map((f) => <option key={f.handle} value={f.handle}>@{bareHandle(f.handle)}</option>)}
          </select>
          <button className="ds-btn ds-sm" type="submit" disabled={!pick || busy}>{busy ? "Adding…" : "Add"}</button>
        </form>
      )}
      {friends && friends.length > 0 && <p className="ds-fine" style={{ margin: "6px 0 0" }}>Only friends can be added. They&apos;ll see everything on this list.</p>}
      {err && <p className="ds-err" role="alert">{err}</p>}
      {note && !err && <p className="ds-fine" role="status" style={{ color: "var(--ds-ok)" }}>{note}</p>}
    </div>
  );
}

/* ---------------------------- your own settings ---------------------------- */

const TAKE_FROM: { value: AgentsTakeFrom; label: string }[] = [
  { value: "me", label: "Only me" },
  { value: "anyone", label: "Anyone on this list" },
];

export function MySettings({ detail, onChanged }: { detail: ListDetail; onChanged: () => void }) {
  const l = detail.list;
  const [takeFrom, setTakeFrom] = useState<AgentsTakeFrom>(l.agents_take_from);
  const [notify, setNotify] = useState<ListNotify>(l.notify);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  // A refresh from elsewhere (another tab) wins over what's on screen, unless a save is in flight.
  useEffect(() => { if (!busy) setTakeFrom(l.agents_take_from); }, [l.agents_take_from]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!busy) setNotify(l.notify); }, [l.notify]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (what: "take" | "notify", body: { agents_take_from?: AgentsTakeFrom; notify?: ListNotify }, undo: () => void) => {
    setBusy(what); setErr("");
    try {
      await listsApi.updateMe(l.id, body);
      onChanged();
    } catch (e) {
      undo();
      setErr(errorText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <div className="ds-label" style={{ marginTop: 18 }}>Your settings on this list</div>
      <div className="ds-fine" id="ds-take-from-label" style={{ color: "var(--ds-ink)", fontSize: 13, margin: "2px 0 6px" }}>My agents may take tasks from:</div>
      <div className="ds-seg" role="group" aria-labelledby="ds-take-from-label">
        {TAKE_FROM.map((o) => (
          <button key={o.value} type="button" className={takeFrom === o.value ? "on" : ""} aria-pressed={takeFrom === o.value} disabled={!!busy || l.archived}
            onClick={() => {
              if (takeFrom === o.value) return;
              const before = takeFrom;
              setTakeFrom(o.value);
              void save("take", { agents_take_from: o.value }, () => setTakeFrom(before));
            }}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="ds-fine" style={{ margin: "6px 0 0" }}>
        {takeFrom === "me"
          ? "Your agents ask you before taking a task someone else wrote. It only changes what your own agents do."
          : "Your agents can take anyone's tasks here without asking you first. It only changes what your own agents do."}
      </p>
      <label className="ds-check" style={{ marginTop: 8 }}>
        <input type="checkbox" checked={notify === "mentions_reviews"} disabled={!!busy || l.archived}
          onChange={(e) => {
            const next: ListNotify = e.target.checked ? "mentions_reviews" : "off";
            const before = notify;
            setNotify(next);
            void save("notify", { notify: next }, () => setNotify(before));
          }} />
        <span>Email me about mentions, reviews and OK requests (at most hourly)</span>
      </label>
      {err && <p className="ds-err" role="alert">{err}</p>}
    </div>
  );
}

/* --------------------------------- leaving --------------------------------- */

export function LeaveList({ detail, onLeft }: { detail: ListDetail; onLeft: () => void }) {
  const l = detail.list;
  const me = detail.members.find((m) => m.is_you);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (l.your_role === "owner" || !me?.handle) return null;

  const leave = async () => {
    setBusy(true); setErr("");
    try {
      await listsApi.leaveList(l.id, me.handle!);
      onLeft();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ds-label" style={{ marginTop: 18 }}>Leave</div>
      {!confirming ? (
        <>
          <p className="ds-fine" style={{ margin: "0 0 8px" }}>You can leave this list any time. Only its owner can add you back.</p>
          <button className="ds-btn danger ds-sm" onClick={() => setConfirming(true)}>Leave this list</button>
        </>
      ) : (
        <div className="ds-inline-form" role="alert">
          <p style={{ margin: 0, fontSize: 13 }}>
            Leave &ldquo;{l.name}&rdquo;? You and your agents lose access right away, and anything you&apos;re working on goes back to the list. Your past work stays.
          </p>
          <div className="ds-actions">
            <button className="ds-btn danger ds-sm" disabled={busy} onClick={() => void leave()}>{busy ? "Leaving…" : "Leave list"}</button>
            <button className="ds-btn ghost ds-sm" disabled={busy} onClick={() => setConfirming(false)}>Stay</button>
          </div>
        </div>
      )}
      {err && <p className="ds-err" role="alert">{err}</p>}
    </>
  );
}
