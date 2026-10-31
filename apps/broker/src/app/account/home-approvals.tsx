"use client";

/**
 * Approvals: the top card of Home (docs/web-ia.md; plan §4.1). Everything waiting on the person, in one list:
 *
 *   thread approvals      friends' agents asking to work with yours      GET /api/inbox (the dashboard's own fetch)
 *   replies to answer     open threads where it is your turn              GET /api/account/sessions (the dashboard's own)
 *   list OKs              friends' tasks your agents need your OK for     GET /api/lists/plate → ok_requests
 *   work to check         finished tasks waiting for your review          GET /api/lists/plate → waiting_on_you
 *   secret uses           an agent on one of your PCs wants a secret      GET /api/secret-broker → requests (status open)
 *   support codes         an agent asked for a one-time help code         GET /api/support/invites → pending
 *   agent sessions        an agent wants to use one of your PCs           GET /api/remote-app/sessions → pending
 *
 * Thread approvals, replies and list OKs act right here (the same handlers the Inbox and My plate use). A secret
 * use, a support code and an agent session are approved with a passkey against that card's own challenge, so
 * their rows open the Devices page card that does it (deny stays one click there too). No new endpoints: the
 * hook below reuses the Devices cards' reads, and the dashboard passes in what it already loaded.
 *
 * In demo mode (non-production, signed out) each source shows one sample row so the card can be reviewed.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip, PersonAvatar, shortHandle } from "@/components/ui/primitives";
import { listsApi, openListsAt, whoName, type TaskView } from "./lists/api";
import { when } from "./shared";

export interface ApprovalInboxReq { id: string; requester_handle: string; scopes: string[]; message: string | null; created_at: string }
export interface ApprovalThread { session_id: string; peer_handle: string; goal: string | null; started_at: string; live?: boolean }

interface AgentSession { id: string; status: string; pc: { label: string }; apps: string[]; goal: string; minutes: number; scope?: string; startedBy: { name: string }; requestedAt: string; startedAt: string | null; expiresAt: string | null }
interface SupportReq { id: string; for: string; task: string; minutes: number; requestedBy: { name: string }; requestedAt: string }
interface SecretReq { id: string; machine: string; name: string; mode: string; code: string; status: string; expiresAt: string; raisedAt: string; requester: { agent?: string | null } | null }

export interface HomeActivity {
  agentPending: AgentSession[];
  agentLive: AgentSession[];
  supportPending: SupportReq[];
  secretOpen: SecretReq[];
  okRequests: TaskView[];
  reviews: TaskView[];
  /** The plate's lists, for naming where a task lives. */
  listEmoji: Map<string, string | null>;
  reload: () => void;
}

const minsAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();
const DEMO_ACTIVITY = {
  agentPending: [{ id: "demo-s1", status: "awaiting_consent", scope: "desktop", pc: { label: "Office PC" }, apps: ["QuickBooks"], goal: "Enter this week's three supplier invoices.", minutes: 20, startedBy: { name: "Claude Code" }, requestedAt: minsAgo(1), startedAt: null, expiresAt: null }],
  agentLive: [{ id: "demo-s2", status: "running", scope: "desktop", pc: { label: "Office PC" }, apps: ["Excel"], goal: "Update the inventory sheet.", minutes: 15, startedBy: { name: "Loby (Cowork)" }, requestedAt: minsAgo(6), startedAt: minsAgo(5), expiresAt: minsAgo(-10) }],
  supportPending: [{ id: "demo-p1", for: "Mom", task: "Get the printer working again.", minutes: 30, requestedBy: { name: "Claude Code" }, requestedAt: minsAgo(1) }],
  secretOpen: [{ id: "demo-sec1", machine: "Office PC", name: "github-token", mode: "serve", code: "4Q7P", status: "open", expiresAt: minsAgo(-1), raisedAt: minsAgo(0), requester: { agent: "Claude Code" } }],
  okRequests: [] as TaskView[],
  reviews: [] as TaskView[],
};
// A friend's task waiting for an OK, in the shape the plate returns; only the fields the row reads are real.
const DEMO_OK_TASK = {
  id: "demo-task-ok", title: "Draft the workshop budget", list: { id: "demo-list-1", name: "Tools workshop", shared: true },
  created_by: { handle: "maren@bc", person: "Maren" }, assignee: { kind: "their_agents" }, agent_may_act: { why: "Maren added it; your agents need your OK." },
  due: null, status: "open", summary: null, completed_by: null, completed_at: null, claim: null,
} as unknown as TaskView;

/** The Devices cards' reads and the plate, once, for Home. */
export function useHomeActivity(demoMode: boolean, enabled: boolean): HomeActivity {
  const [agent, setAgent] = useState<{ pending: AgentSession[]; live: AgentSession[] }>({ pending: [], live: [] });
  const [support, setSupport] = useState<SupportReq[]>([]);
  const [secrets, setSecrets] = useState<SecretReq[]>([]);
  const [plate, setPlate] = useState<{ ok: TaskView[]; reviews: TaskView[]; lists: { id: string; emoji: string | null }[] }>({ ok: [], reviews: [], lists: [] });

  const load = useCallback(async () => {
    if (demoMode || !enabled) return;
    const get = async (path: string) => { try { const r = await fetch(path, { credentials: "include" }); return r.ok ? await r.json() : null; } catch { return null; } };
    const [a, s, b, p] = await Promise.all([get("/api/remote-app/sessions"), get("/api/support/invites"), get("/api/secret-broker"), listsApi.plate().catch(() => null)]);
    if (a) setAgent({ pending: a.pending ?? [], live: a.live ?? [] });
    if (s?.available) setSupport(s.pending ?? []);
    if (b) setSecrets((b.requests ?? []).filter((r: SecretReq) => r.status === "open" && new Date(r.expiresAt).getTime() > Date.now()));
    if (p) setPlate({ ok: p.ok_requests ?? [], reviews: p.waiting_on_you ?? [], lists: p.lists ?? [] });
  }, [demoMode, enabled]);
  useEffect(() => { void load(); }, [load]);
  // Anything waiting here is short-lived (a secret request lives about 90 s): look again while the page is on screen.
  useEffect(() => {
    if (demoMode || !enabled) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => clearInterval(t);
  }, [demoMode, enabled, load]);

  if (demoMode) {
    return { ...DEMO_ACTIVITY, okRequests: [DEMO_OK_TASK], listEmoji: new Map([["demo-list-1", "🛠️"]]), reload: () => {} };
  }
  return { agentPending: agent.pending, agentLive: agent.live, supportPending: support, secretOpen: secrets, okRequests: plate.ok, reviews: plate.reviews, listEmoji: new Map(plate.lists.map((l) => [l.id, l.emoji])), reload: () => { void load(); } };
}

/** One thing waiting on the person: who or what, the ask, and the actions. */
function Row({ lead, title, meta, children }: { lead: React.ReactNode; title: React.ReactNode; meta: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="ds-item">
      {lead}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ds-iname">{title}</div>
        <div className="ds-imeta">{meta}</div>
      </div>
      <div className="ds-iright">{children}</div>
    </div>
  );
}
const Icon = ({ children }: { children: string }) => <span aria-hidden style={{ fontSize: 18, width: 34, textAlign: "center", flexShrink: 0, lineHeight: "34px" }}>{children}</span>;
const Open = ({ href, children = "Open" }: { href: string; children?: string }) => <a className="ds-btn ghost" style={{ textDecoration: "none" }} href={href}>{children}</a>;
const SCOPE_LABELS: Record<string, string> = { "config.read": "read relevant settings", "config.suggest": "suggest changes for you to approve" };
const plainScope = (scope: string) => SCOPE_LABELS[scope] ?? scope.replace(/[._]/g, " ");
const appList = (apps: string[]) => (apps.length <= 1 ? apps.join("") : `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1]}`);

export function HomeApprovals({ inbox, yours, activity, demoMode, busy, onAccept, onReject, onOpenRequest, onOpenThread, onOpenLists }: {
  inbox: ApprovalInboxReq[];
  /** Open threads where it is the person's turn. */
  yours: ApprovalThread[];
  activity: HomeActivity;
  demoMode: boolean;
  busy: string;
  onAccept: (id: string, who: string) => void;
  onReject: (id: string) => void;
  onOpenRequest: (id: string) => void;
  onOpenThread: (sessionId: string) => void;
  /** Switch to the Lists tab (after openListsAt has pointed it at a task). */
  onOpenLists: () => void;
}) {
  const [okBusy, setOkBusy] = useState("");
  const [okErr, setOkErr] = useState("");
  const okTask = async (t: TaskView) => {
    setOkBusy(t.id); setOkErr("");
    try { await listsApi.okTask(t.id); activity.reload(); } catch { setOkErr("Couldn't OK that task. Open it to see why."); }
    setOkBusy("");
  };
  const openTask = (t: TaskView) => { openListsAt({ listId: t.list.id, taskId: t.id }); onOpenLists(); };
  const where = (t: TaskView) => `${activity.listEmoji.get(t.list.id) ? `${activity.listEmoji.get(t.list.id)} ` : ""}${t.list.name}`;

  const total = inbox.length + yours.length + activity.okRequests.length + activity.reviews.length + activity.secretOpen.length + activity.supportPending.length + activity.agentPending.length;

  return (
    <div className="ds-card" id="approvals" style={{ marginBottom: 22, borderColor: total ? "var(--ds-acc-line)" : undefined }}>
      <h2 className="ds-cardh">Approvals{total ? ` (${total})` : ""}</h2>
      <p className="ds-cardsub">Everything waiting on you, in one place. Nothing here happens until you say so.</p>
      {total === 0 && <p className="ds-fine" style={{ margin: 0 }}>Nothing is waiting on you right now.</p>}

      {activity.secretOpen.map((r) => (
        <Row key={`sec-${r.id}`} lead={<Icon>🔑</Icon>}
          title={<><Chip tone="acc">Secret</Chip> {r.requester?.agent ?? "An agent"} on {r.machine} wants <strong>{r.name}</strong></>}
          meta={<>{r.mode}{" · "}code <span className="ds-mono">{r.code}</span> · asked {when(r.raisedAt)}. Approve with your passkey after checking the code matches the PC.</>}>
          <Open href="/account/remote#secrets">Review</Open>
        </Row>
      ))}

      {activity.agentPending.map((s) => (
        <Row key={`ag-${s.id}`} lead={<Icon>🖥️</Icon>}
          title={<><Chip tone="acc">PC</Chip> {s.startedBy.name} wants to use {s.scope === "desktop" ? `the whole PC (${s.pc.label})` : `${appList(s.apps)} on ${s.pc.label}`} for {s.minutes} minutes</>}
          meta={<>{s.goal} · asked {when(s.requestedAt)}. Approving asks for your passkey.</>}>
          <Open href="/account/remote#agent-sessions">Review</Open>
        </Row>
      ))}

      {activity.supportPending.map((p) => (
        <Row key={`sup-${p.id}`} lead={<Icon>🤝</Icon>}
          title={<><Chip tone="acc">Help code</Chip> {p.requestedBy.name} asked for a code to help {p.for}</>}
          meta={<>{p.task} · up to {p.minutes} minutes · asked {when(p.requestedAt)}. Approving shows you the code once.</>}>
          <Open href="/account/remote#support-sessions">Review</Open>
        </Row>
      ))}

      {inbox.map((r) => (
        <Row key={`req-${r.id}`} lead={<PersonAvatar handle={r.requester_handle} />}
          title={<><Chip tone="acc">Thread</Chip> {shortHandle(r.requester_handle)}&apos;s agent wants to work with yours</>}
          meta={<>{r.message ?? "wants to collaborate"} · asks to: {r.scopes.map(plainScope).join(", ")} · {when(r.created_at)}</>}>
          <button className="ds-btn" disabled={busy === `inbox:${r.id}` || demoMode} onClick={() => onAccept(r.id, r.requester_handle)}>{busy === `inbox:${r.id}` ? "…" : "Approve"}</button>
          <button className="ds-btn ghost" disabled={busy === `inbox:${r.id}` || demoMode} onClick={() => onReject(r.id)}>Decline</button>
          <button className="ds-link" onClick={() => onOpenRequest(r.id)}>Open</button>
        </Row>
      ))}

      {yours.map((t) => (
        <Row key={`thr-${t.session_id}`} lead={<PersonAvatar handle={t.peer_handle} />}
          title={<><Chip tone="acc">Reply</Chip> {shortHandle(t.peer_handle)} replied{t.live ? <> <Chip tone="ok">● live</Chip></> : null}</>}
          meta={<>{t.goal ?? "an open thread"} · started {when(t.started_at)}. Respond now, or your agent picks it up on its next check.</>}>
          <button className="ds-btn" onClick={() => onOpenThread(t.session_id)}>Respond</button>
        </Row>
      ))}

      {activity.okRequests.map((t) => (
        <Row key={`ok-${t.id}`} lead={<Icon>☑</Icon>}
          title={<><Chip tone="acc">List</Chip> {t.title}</>}
          meta={<>{where(t)} · {whoName(t.created_by)} added it{t.assignee?.kind === "their_agents" ? " for your agents" : t.assignee ? " for you" : ""}. Your agents need your OK.{okErr && okBusy === "" ? ` ${okErr}` : ""}</>}>
          <button className="ds-btn" disabled={okBusy === t.id || demoMode} onClick={() => void okTask(t)}>{okBusy === t.id ? "…" : "OK for my agents"}</button>
          <button className="ds-link" onClick={() => openTask(t)} disabled={demoMode}>Open</button>
        </Row>
      ))}

      {activity.reviews.map((t) => (
        <Row key={`rev-${t.id}`} lead={<Icon>☑</Icon>}
          title={<><Chip tone="acc">Check</Chip> {t.title}</>}
          meta={<>{where(t)} · {whoName(t.completed_by)} finished it{t.summary ? `: “${t.summary.split("\n")[0]}”` : ""}. Accept it or send it back.</>}>
          <button className="ds-btn" onClick={() => openTask(t)} disabled={demoMode}>Review</button>
        </Row>
      ))}
    </div>
  );
}

/** "What's happening": the live agent sessions, for Home's activity card (same read as Approvals). */
export function LiveAgentSessions({ live }: { live: AgentSession[] }) {
  if (!live.length) return null;
  return (
    <>
      {live.map((s) => (
        <div className="ds-item" key={`live-${s.id}`}>
          <Icon>🖥️</Icon>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ds-iname">{s.status === "blocked" ? <Chip tone="warn">Paused</Chip> : <Chip tone="ok">Running</Chip>} {s.startedBy.name} is using {s.scope === "desktop" ? `the whole PC (${s.pc.label})` : `${appList(s.apps)} on ${s.pc.label}`}</div>
            <div className="ds-imeta">{s.goal}{s.startedAt ? ` · started ${when(s.startedAt)}` : ""}</div>
          </div>
          <div className="ds-iright"><Open href="/account/remote#agent-sessions">Watch</Open></div>
        </div>
      ))}
    </>
  );
}
