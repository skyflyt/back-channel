"use client";

/**
 * "Agents on your PCs": the Remote page's readiness checklist (vault design pc-agent-readiness.md; docs/remote-app-
 * sessions.md, "Setting up a PC"). For one of the person's agents to use an app on a PC, six things must be true there.
 * The Back Channel worker on each PC reports what it can tell every 10 minutes; this card shows, per worker and per
 * registered PC, which steps are done, which need action and which can't be told from here, with one line saying where
 * on that PC each is done (AppBridge → Agents). It also shows each agent's key fingerprint, for comparing in step 5.
 *
 * Read-only: GET /api/remote-app/readiness (cookie). Plain text only, no HTML strings (the site runs a Trusted Types
 * CSP). Timers are the global functions, called directly.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip } from "@/components/ui/primitives";

type State = "done" | "needed" | "unknown";
interface Step { step: number; key: string; title: string; state: State; howTo: string | null }
interface Sender { agentId: string; name: string | null; pinned: boolean }
interface Report { appbridge: { pipe: string; hostName: string | null }; profiles: { remoteApp: { present: boolean; senders: Sender[] } } }
interface AgentRow {
  agentId: string; name: string; fingerprint: string | null; readiness: Report | null; readinessAt: string | null; reporting: boolean;
  pc: { hostDeviceId: string; name: string } | null; reportsFrom: string | null; steps: Step[]; ready: boolean; missing: string[];
}
interface PcRow { hostDeviceId: string; name: string; note: string; steps: Step[]; ready: boolean; missing: string[] }
interface Reply { staleAfterMinutes: number; agents: AgentRow[]; pcs: PcRow[] }

function ago(iso: string, now: number): string {
  const secs = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `on ${new Date(iso).toLocaleString()}`;
}
const stepsLeft = (n: number) => `${n} step${n === 1 ? "" : "s"} left`;

// Non-production only, like the page's other cards: a signed-out visit shows a sample so the card can be reviewed.
function demo(): Reply {
  const t = Date.now();
  const steps = (states: State[], howTo: (string | null)[]): Step[] => [
    "AppBridge 1.1.32 or newer", "PC registered with Back Channel", "Allow agent control is on", "Back Channel worker set up and running",
    "Agents allowed to hand it sessions", "Claude signed in",
  ].map((title, i) => ({ step: i + 1, key: ["appbridge", "registered", "agent_control", "worker", "senders", "claude"][i], title, state: states[i], howTo: states[i] === "done" ? null : howTo[i] }));
  const done: State[] = ["done", "done", "done", "done", "done", "done"];
  const report = (host: string): Report => ({ appbridge: { pipe: "listening", hostName: host }, profiles: { remoteApp: { present: true, senders: [{ agentId: "demo-a", name: "Laptop Claude", pinned: true }] } } });
  return {
    staleAfterMinutes: 30,
    agents: [
      { agentId: "demo-1", name: "Office agent", fingerprint: "3F2A-91C0-7B4D-E215", readiness: report("Office PC"), readinessAt: new Date(t - 4 * 60_000).toISOString(), reporting: true,
        pc: { hostDeviceId: "demo-pc-1", name: "Office PC" }, reportsFrom: "Office PC", steps: steps(done, []), ready: true, missing: [] },
      { agentId: "demo-2", name: "Shop agent", fingerprint: "A0C4-5521-9E7B-08DD", readiness: report("Shop-PC"), readinessAt: new Date(t - 2 * 60_000).toISOString(), reporting: true,
        pc: { hostDeviceId: "demo-pc-2", name: "Shop-PC" }, reportsFrom: "Shop-PC",
        steps: steps(["done", "done", "done", "done", "needed", "needed"], [null, null, null, null, "On that PC, open AppBridge → Agents → Choose agents…, and check each fingerprint matches the one Back Channel shows for that agent.", "On that PC, open AppBridge → Agents → Sign in to Claude."]),
        ready: false, missing: ["senders", "claude"] },
    ],
    pcs: [{ hostDeviceId: "demo-pc-3", name: "Warehouse PC", note: "No agent set up on this PC yet.", ready: false, missing: ["appbridge", "agent_control", "worker", "senders", "claude"],
      steps: steps(["unknown", "done", "unknown", "needed", "unknown", "unknown"], Array(6).fill("Back Channel learns this once the worker on that PC reports.").map((x, i) => (i === 3 ? "On that PC, open AppBridge → Agents → Set up worker (Get a code gives it a connect code), then Start." : x))) }],
  };
}

function Checklist({ steps }: { steps: Step[] }) {
  return (
    <ol style={{ margin: "10px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
      {steps.map((s) => (
        <li key={s.key} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span aria-hidden="true" className="ds-mono" style={{ width: 18, flexShrink: 0, textAlign: "center", fontWeight: 700, color: s.state === "done" ? "var(--ds-ok)" : s.state === "needed" ? "var(--ds-warn)" : "var(--ds-faint)" }}>
            {s.state === "done" ? "✓" : s.state === "needed" ? "!" : "?"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ds-igoal" style={{ marginTop: 0 }}>
              {s.step}. {s.title}{" "}
              {s.state === "done" ? <span className="ds-fine">done</span> : s.state === "needed" ? <Chip tone="warn">Needs action</Chip> : <Chip>Unknown</Chip>}
            </div>
            {s.howTo && <div className="ds-fine">{s.howTo}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Badge({ ready, missing, stale }: { ready: boolean; missing: number; stale: boolean }) {
  if (ready) return <Chip tone="ok">Ready for agents</Chip>;
  if (stale) return <Chip tone="warn">Not reporting</Chip>;
  return <Chip tone="warn">{stepsLeft(missing)}</Chip>;
}

export default function AgentsReadiness() {
  const [data, setData] = useState<Reply | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/remote-app/readiness", { credentials: "include" });
      if (r.status === 401) {
        if (process.env.NODE_ENV !== "production") { setData(demo()); setState("ready"); } else setState("hidden");
        return;
      }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json()); setState("ready");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { load(); }, [load]);
  // "Last reported 4 min ago" keeps moving; the reports themselves arrive every 10 minutes, so refresh now and then.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const refresh = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, [load]);

  if (state === "loading" || state === "hidden") return null;
  if (state === "error" || !data) {
    return <div className="ds-card"><div className="ds-cardh">Agents on your PCs</div><p className="ds-fine" style={{ margin: 0 }}>Couldn&apos;t load your PCs&apos; readiness. Refresh to try again.</p></div>;
  }

  // A worker that has reported (now or before) is a row with its checklist. A Dispatch agent that never reported from
  // a PC (one that only hands sessions over, or an older worker) is listed with its fingerprint only.
  const workers = data.agents.filter((a) => a.readinessAt);
  const others = data.agents.filter((a) => !a.readinessAt);
  const nothing = workers.length === 0 && data.pcs.length === 0;

  const where = (a: AgentRow) => {
    const from = a.reporting ? "Reports from" : "Reported from";
    return a.pc ? `${from} PC ${a.pc.name}` : a.reportsFrom ? `${from} a PC called "${a.reportsFrom}", not matched to a PC registered here` : "Couldn't tell which PC it reports from";
  };
  const when = (a: AgentRow) => (!a.readinessAt ? "" : a.reporting ? `last reported ${ago(a.readinessAt, now)}`
    : `not reporting: the worker isn't running on that PC (last reported ${ago(a.readinessAt, now)})`);

  return (
    <div className="ds-card" id="agents-on-pcs">
      <div className="ds-cardh">Agents on your PCs</div>
      <p className="ds-cardsub">
        For one of your agents to use an app on a PC, that PC needs the six steps below. Each is done on the PC itself, in AppBridge → Agents.
        This shows what the Back Channel worker on each PC reports (every 10 minutes). Anything it can&apos;t tell from here says Unknown.
      </p>

      {nothing && <p className="ds-fine" style={{ margin: 0 }}>No PCs or agents set up yet. Register a PC under Add a device below, then set up its worker in AppBridge → Agents on that PC.</p>}

      {workers.map((a) => {
        const senders = a.readiness?.profiles.remoteApp.senders.filter((s) => s.pinned) ?? [];
        return (
          <div key={a.agentId} className="ds-item" style={{ display: "block" }}>
            <div className="ds-iname"><Badge ready={a.ready} missing={a.missing.length} stale={!a.reporting} /> {a.name}{a.pc ? ` on ${a.pc.name}` : ""}</div>
            <div className="ds-imeta">{where(a)} · {when(a)}.</div>
            {a.fingerprint && (
              <div className="ds-fine" style={{ marginTop: 4 }}>
                Fingerprint <span className="ds-mono" style={{ color: "var(--ds-ink)" }}>{a.fingerprint}</span>. When another PC lists this agent under Choose agents…, check it shows the same.
              </div>
            )}
            {a.reporting && senders.length > 0 && (
              <div className="ds-fine">Agents that may hand it sessions: {senders.map((s) => s.name ?? "an agent you no longer have").join(", ")}.</div>
            )}
            <Checklist steps={a.steps} />
          </div>
        );
      })}

      {data.pcs.map((p) => (
        <div key={p.hostDeviceId} className="ds-item" style={{ display: "block" }}>
          <div className="ds-iname"><Badge ready={false} missing={p.missing.length} stale={false} /> {p.name}</div>
          <div className="ds-imeta">{p.note}</div>
          <Checklist steps={p.steps} />
        </div>
      ))}

      {others.length > 0 && (
        <>
          <div className="ds-lsec" style={{ paddingLeft: 0 }}>Your other agents</div>
          <p className="ds-fine" style={{ margin: "0 0 6px" }}>
            These don&apos;t report from any PC, which is expected for an agent that only hands sessions to one. When you choose agents on a PC (step 5), check the fingerprint it shows matches the one here.
          </p>
          {others.map((a) => (
            <div key={a.agentId} className="ds-item" style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <div className="ds-iname" style={{ flex: 1, minWidth: 160 }}>{a.name}</div>
              <span className="ds-mono ds-fine">{a.fingerprint ?? "not enrolled for Dispatch"}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
