"use client";

/**
 * People: the Inbox's left column (docs/web-ia.md). Your friends, each with a mutual / waiting chip and a
 * Message button, the Invite a friend form, and the would-be friends you can add or remove. Selecting a
 * person shows their page (friend-page.tsx) in place of the thread list. The Friends tab lived here until
 * 2026-10-31; the data (GET /api/trust, POST /api/friends/invite) and the handlers are the dashboard's own,
 * passed in, so nothing is fetched twice.
 */

import { Chip, PersonAvatar, shortHandle } from "@/components/ui/primitives";
import { when } from "./shared";

export interface PeopleFriend { handle: string; last_session_at: string | null; trusted: boolean; mutual: boolean; established_at: string | null }

export interface InviteState {
  open: boolean; email: string; note: string; sent: boolean; err: string;
  setOpen: (v: boolean) => void; setEmail: (v: string) => void; setNote: (v: string) => void; setSent: (v: boolean) => void; setErr: (v: string) => void;
  send: () => void;
}

export function PeopleColumn({ friends, selected, demoMode, busy, invite, onSelect, onMessage, onToggleTrust }: {
  friends: PeopleFriend[];
  /** The handle whose page is showing, if any. */
  selected: string | null;
  demoMode: boolean;
  busy: string;
  invite: InviteState;
  onSelect: (handle: string | null) => void;
  onMessage: (handle: string) => void;
  onToggleTrust: (handle: string, on: boolean) => void;
}) {
  const mutual = friends.filter((f) => f.trusted && f.mutual).length;
  return (
    <div className="ds-card ds-people-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <h2 className="ds-cardh" style={{ margin: 0, flex: 1 }}>People{mutual ? ` (${mutual})` : ""}</h2>
        <button className="ds-btn ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => { invite.setErr(""); invite.setSent(false); invite.setOpen(!invite.open); onSelect(null); }}>＋ Invite</button>
      </div>

      {invite.sent ? (
        <div className="ds-call ok" style={{ marginBottom: 10, padding: "10px 12px", fontSize: 12.5 }}>
          <strong>✅ Invitation sent!</strong> We emailed them a link to set up Back Channel and connect with you. When they accept, you become friends automatically.{" "}
          <button className="ds-link" onClick={() => invite.setSent(false)}>Invite another</button>
        </div>
      ) : invite.open ? (
        <div style={{ marginBottom: 10 }} id="friends-section">
          <label className="ds-label" style={{ marginTop: 0 }}>Your friend&apos;s email</label>
          <input className="ds-input" type="email" value={invite.email} onChange={(e) => invite.setEmail(e.target.value)} placeholder="friend@email.com" disabled={demoMode} />
          <label className="ds-label">A note (optional)</label>
          <input className="ds-input" value={invite.note} onChange={(e) => invite.setNote(e.target.value)} placeholder="Let's connect our agents on Back Channel" disabled={demoMode} />
          {invite.err && <p className="ds-call danger" style={{ marginTop: 10 }}>{invite.err}</p>}
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button className="ds-btn" disabled={busy === "friendinvite" || demoMode} onClick={invite.send}>{busy === "friendinvite" ? "Sending…" : "Send invite"}</button>
            <button className="ds-btn ghost" onClick={() => { invite.setOpen(false); invite.setErr(""); }}>Cancel</button>
          </div>
        </div>
      ) : null}

      {friends.length === 0 && !invite.open && !invite.sent && (
        <p className="ds-fine" style={{ margin: 0 }}>No friends yet. Invite someone by email: when they accept, your agents can reach each other without invite codes, and you still approve every thread.</p>
      )}

      {friends.map((f) => {
        const on = selected === f.handle;
        return (
          <div key={f.handle} className={`ds-prow${on ? " on" : ""}`}>
            <button className="ds-prow-main" onClick={() => onSelect(on ? null : f.handle)} title="Open this friend's page" aria-current={on ? "true" : undefined}>
              <PersonAvatar handle={f.handle} size={30} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="ds-lname" style={{ fontSize: 13 }}>{shortHandle(f.handle)}</span>
                <span className="ds-imeta" style={{ display: "block" }}>
                  {f.trusted ? (f.mutual ? <Chip tone="ok">mutual</Chip> : <Chip tone="warn">waiting for them</Chip>) : <Chip>not a friend yet</Chip>}
                  {f.last_session_at ? ` · ${when(f.last_session_at)}` : ""}
                </span>
              </span>
            </button>
            <div className="ds-prow-actions">
              {f.trusted && f.mutual ? (
                <>
                  <button className="ds-link" onClick={() => onMessage(f.handle)} disabled={demoMode} title="Message their agent">Message</button>
                  {on && <button className="ds-link" style={{ color: "var(--ds-danger)" }} disabled={busy === `trust:${f.handle}` || demoMode} onClick={() => onToggleTrust(f.handle, false)}>Remove</button>}
                </>
              ) : (
                <button className="ds-link" disabled={busy === `trust:${f.handle}` || demoMode} onClick={() => onToggleTrust(f.handle, !f.trusted)}>
                  {busy === `trust:${f.handle}` ? "…" : f.trusted ? "Remove" : "Add"}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <p className="ds-fine" style={{ margin: "10px 0 0" }}>Mutual friends&apos; agents can also be reached by asking your agent: &ldquo;use Back Channel to reach &lt;name&gt;&rdquo;.</p>
    </div>
  );
}
