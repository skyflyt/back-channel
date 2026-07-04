"use client";
/**
 * FriendPage — per-friend agent page (Phase 4, composer-sends-friend-page,
 * scope items 5-6). Sibling extraction from page.tsx, mounted at
 * /account?friend=<handle> (URL-synced client-tab state, same pattern as the
 * existing ?tab= sync in page.tsx). Reuses the EXISTING discover/shared-with-me
 * skill data + card rendering conventions and the existing threads list —
 * no new endpoints, no rebuilt skill-card UI.
 */
import { useState } from "react";
import { Composer, type ComposerPrefill } from "./composer";

export interface FriendTrust { handle: string; last_session_at: string; trusted: boolean; mutual: boolean; established_at: string | null }
export interface FriendSess {
  session_id: string; role: string; peer_handle: string; goal: string | null;
  started_at: string; ended_at: string | null; end_reason: string | null;
  duration_min: number | null; unread_count?: number; live?: boolean;
  peer_present?: boolean; peer_ever_connected?: boolean;
}
export interface FriendDiscoverSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; type?: string }
export interface FriendSharedSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; type?: string }

interface Props {
  handle: string;
  trust: FriendTrust[];
  active: FriendSess[];
  recent: FriendSess[];
  discover: FriendDiscoverSkill[];
  sharedWithMe: FriendSharedSkill[];
  when: (iso: string) => string;
  onBack: () => void;
  onOpenThread: (sessionId: string) => void;
  /** "Invite to something new" — reuses the existing invite-a-friend plumbing
   *  that already lives in page.tsx's Friends tab (no new endpoint here). */
  onInviteToSomethingNew: (handle: string) => void;
}

const plainKind = (kind: string) => (kind === "template" ? "Copyable" : kind === "rpc" ? "Runs with friend" : kind.replace(/[._]/g, " "));

type CtaMode = null | "message" | "request";

export function FriendPage({ handle, trust, active, recent, discover, sharedWithMe, when, onBack, onOpenThread, onInviteToSomethingNew }: Props) {
  const [ctaMode, setCtaMode] = useState<CtaMode>(null);
  const shortHandle = handle.replace(/@bc$/, "");
  const friend = trust.find((t) => t.handle === handle);
  const friendActive = active.filter((x) => x.peer_handle === handle);
  const friendRecent = recent.filter((x) => x.peer_handle === handle);
  const friendDiscover = discover.filter((d) => d.owner_handle === handle);
  const friendShared = sharedWithMe.filter((sk) => sk.owner_handle === handle);

  // Friend-grade presence copy (no visitor/host jargon, no raw enums) — derived
  // from the most recently active thread with this friend, if any.
  const mostRecentActive = friendActive[0];
  let presence: string;
  if (mostRecentActive?.peer_present) presence = `${shortHandle}'s agent · ready to chat`;
  else if (mostRecentActive && mostRecentActive.peer_ever_connected === false) presence = `${shortHandle}'s agent hasn't come online yet — they'll get a nudge`;
  else if (mostRecentActive) presence = `${shortHandle}'s agent · offline, they'll see it later`;
  else presence = friend?.mutual ? "No open conversation yet — say hi below" : `Waiting to hear back from ${shortHandle}`;

  const messagePrefill: ComposerPrefill = { friend: handle, lockFriend: true, framing: "message" };
  const requestPrefill: ComposerPrefill = { friend: handle, lockFriend: true, framing: "request", topic: friendDiscover[0] ? `could I get your "${friendDiscover[0].name}" lesson?` : "" };

  return (
    <div>
      <button style={s.backLink} onClick={onBack}>← Back to Friends</button>

      {/* Friend header */}
      <section style={s.card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={s.avatar}>{shortHandle.charAt(0).toUpperCase()}</span>
          <div>
            <h2 style={s.h1}>{shortHandle}</h2>
            <div style={s.presenceRow}>
              {friend?.trusted && (friend.mutual
                ? <span style={s.okTag}>mutual</span>
                : <span style={s.pendTag}>waiting for them</span>)}
              <span style={s.presence}>🤖 {presence}</span>
            </div>
          </div>
        </div>
        {friend?.last_session_at && <p style={s.meta}>last worked together {when(friend.last_session_at)}</p>}
      </section>

      {/* Their lessons — reuses the existing discover (in-circle) + shared-with-me
          sections and badges, scoped to this friend. Not rebuilt. */}
      <section style={s.card}>
        <h3 style={s.h3}>{shortHandle}&apos;s lessons</h3>
        {friendDiscover.length === 0 && friendShared.length === 0 && (
          <p style={s.mutedText}>Nothing visible yet. Ask {shortHandle} to share a lesson, or check back once they&apos;ve marked one discoverable.</p>
        )}
        {friendShared.length > 0 && (
          <>
            <p style={s.subLabel}>🎁 Shared with you</p>
            {friendShared.map((sk) => (
              <div key={sk.id} style={s.skillRow}>
                <span style={s.skillIcon}>{(sk.type || "skill") === "link" ? "↗" : sk.kind === "template" ? "🧩" : "⚡"}</span>
                <div style={{ flex: 1 }}>
                  <div style={s.skillName}>{sk.name}</div>
                  {sk.description && <div style={s.skillDesc}>{sk.description}</div>}
                  <div style={s.rowMeta}>{plainKind(sk.kind)}</div>
                </div>
              </div>
            ))}
          </>
        )}
        {friendDiscover.length > 0 && (
          <>
            <p style={s.subLabel}>✨ In your circle</p>
            {friendDiscover.map((d) => (
              <div key={d.id} style={s.skillRow}>
                <span style={s.skillIcon}>{(d.type || "skill") === "link" ? "↗" : d.kind === "template" ? "🧩" : "⚡"}</span>
                <div style={{ flex: 1 }}>
                  <div style={s.skillName}>{d.name}</div>
                  {d.description && <div style={s.skillDesc}>{d.description}</div>}
                </div>
              </div>
            ))}
          </>
        )}
      </section>

      {/* Your threads with them — filtered existing threads list. */}
      <section style={s.card}>
        <h3 style={s.h3}>Your threads with {shortHandle}</h3>
        {friendActive.length === 0 && friendRecent.length === 0 && (
          <p style={s.mutedText}>No conversations yet. Send a message below to start one.</p>
        )}
        {friendActive.map((x) => (
          <div key={x.session_id} style={s.threadRow} onClick={() => onOpenThread(x.session_id)}>
            <div style={{ flex: 1 }}>
              {x.goal && <div style={s.goal}>{x.goal}</div>}
              <div style={s.rowMeta}>started {when(x.started_at)}{!!x.unread_count && ` · ${x.unread_count} unread`}{x.live ? " · ● live" : ""}</div>
            </div>
            <span style={s.smallLink}>Open →</span>
          </div>
        ))}
        {friendRecent.map((x) => (
          <div key={x.session_id} style={s.threadRow}>
            <div style={{ flex: 1 }}>
              {x.goal && <div style={s.goal}>{x.goal}</div>}
              <div style={s.rowMeta}>{x.ended_at ? when(x.ended_at) : ""} · {x.duration_min ?? "?"} min · {x.end_reason ?? "ended"}</div>
            </div>
          </div>
        ))}
      </section>

      {/* CTA row — Message · Request a lesson · Invite to something new. All ride
          the existing composer + invite plumbing; no new endpoints. */}
      <section style={s.card}>
        <h3 style={s.h3}>What do you want to do?</h3>
        {!ctaMode && (
          <div style={s.ctaRow}>
            <button style={s.ctaBtn} onClick={() => setCtaMode("message")}>💬 Message</button>
            <button style={s.ctaBtn} onClick={() => setCtaMode("request")}>📚 Request a lesson</button>
            <button style={s.ctaBtnGhost} onClick={() => onInviteToSomethingNew(handle)}>✨ Invite to something new</button>
          </div>
        )}
        {ctaMode === "message" && (
          <>
            <Composer embedded prefill={messagePrefill} onSent={() => setCtaMode(null)} />
            <button style={s.backLink} onClick={() => setCtaMode(null)}>← choose a different action</button>
          </>
        )}
        {ctaMode === "request" && (
          <>
            <Composer embedded prefill={requestPrefill} onSent={() => setCtaMode(null)} />
            <button style={s.backLink} onClick={() => setCtaMode(null)}>← choose a different action</button>
          </>
        )}
      </section>
    </div>
  );
}

const s = {
  card: { background: "#fff", border: "1px solid #e8edf3", borderRadius: 16, padding: 24, marginBottom: 16, boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.03)" } as const,
  backLink: { background: "none", border: "none", color: "#0f766e", fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0, marginBottom: 12, display: "block" } as const,
  avatar: { width: 44, height: 44, borderRadius: "50%", background: "linear-gradient(135deg,#0f766e,#0d9488)", color: "#fff", fontWeight: 700, fontSize: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } as const,
  h1: { fontSize: 20, fontWeight: 700, color: "#0f172a", margin: 0, fontFamily: "ui-monospace, Menlo, monospace" } as const,
  h3: { fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 12px" } as const,
  presenceRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" } as const,
  presence: { fontSize: 13.5, color: "#475569" } as const,
  okTag: { fontSize: 11, fontWeight: 700, color: "#0f766e", background: "#f0fdfa", padding: "1px 7px", borderRadius: 6 } as const,
  pendTag: { fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fffbeb", padding: "1px 7px", borderRadius: 6 } as const,
  meta: { fontSize: 13, color: "#94a3b8", margin: "10px 0 0" } as const,
  mutedText: { fontSize: 14, color: "#64748b", lineHeight: 1.5 } as const,
  subLabel: { fontSize: 12.5, fontWeight: 700, color: "#64748b", margin: "14px 0 8px" } as const,
  ctaRow: { display: "flex", gap: 8, flexWrap: "wrap" } as const,
  ctaBtn: { background: "#0f766e", color: "#fff", border: "none", borderRadius: 9, padding: "8px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" } as const,
  ctaBtnGhost: { background: "#fff", color: "#0f766e", border: "1px solid #99f6e4", borderRadius: 9, padding: "8px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" } as const,
  skillRow: { display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 0", borderBottom: "1px solid #f1f5f9" } as const,
  skillIcon: { fontSize: 18, flexShrink: 0 } as const,
  skillName: { fontSize: 14, fontWeight: 700, color: "#0f172a" } as const,
  skillDesc: { fontSize: 13, color: "#64748b", marginTop: 2 } as const,
  rowMeta: { fontSize: 12, color: "#94a3b8", marginTop: 2 } as const,
  goal: { fontSize: 13, color: "#475569" } as const,
  threadRow: { display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f1f5f9", cursor: "pointer" } as const,
  smallLink: { fontSize: 13, color: "#0f766e", fontWeight: 600, flexShrink: 0 } as const,
};
