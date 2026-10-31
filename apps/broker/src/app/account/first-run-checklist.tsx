"use client";

/**
 * The first-run checklist (plan §7; docs/web-ia.md): the same five steps every app shows, each linking to where
 * it is done. Step state comes from what Home already has (agents, Toolkit, friends) plus the account's devices
 * by role (GET /api/appbridge/v1/account/devices, the Devices page's own read) and whether a list exists
 * (GET /api/lists). The card hides once all five are done.
 */

import { useEffect, useState } from "react";
import { DEMO_DEVICES } from "@/lib/demo-data";
import { listsApi, openListsAt } from "./lists/api";

export function FirstRunChecklist({ demoMode, hasAgent, hasTool, hasFriend, forceShow, onLists, onToolkit, onPeople }: {
  demoMode: boolean;
  /** Keep the card even when every step is done (a non-production review aid). */
  forceShow?: boolean;
  hasAgent: boolean;
  hasTool: boolean;
  hasFriend: boolean;
  /** Switch to the Lists tab (openListsAt has already asked for the new-list form). */
  onLists: () => void;
  onToolkit: () => void;
  /** Open the Inbox with the People column and the invite form showing. */
  onPeople: () => void;
}) {
  const [devices, setDevices] = useState<{ pc: boolean; phone: boolean } | null>(demoMode ? roles(DEMO_DEVICES.devices.devices) : null);
  const [hasList, setHasList] = useState<boolean>(false);

  useEffect(() => {
    if (demoMode) return;
    let stop = false;
    (async () => {
      try {
        const r = await fetch("/api/appbridge/v1/account/devices", { credentials: "include" });
        if (r.ok && !stop) setDevices(roles(((await r.json()).devices ?? []) as { role: string; revokedAt: string | null }[]));
      } catch { /* the steps stay open */ }
      try {
        const l = await listsApi.lists();
        if (!stop) setHasList(l.lists.length > 0);
      } catch { /* the step stays open */ }
    })();
    return () => { stop = true; };
  }, [demoMode]);

  const steps = [
    { done: hasAgent, label: "Connect an agent", hint: "Devices → Add → An agent", action: <a className="ds-btn ghost" style={{ textDecoration: "none" }} href="/account/remote?add=agent">Go</a> },
    { done: hasTool || hasList, label: "Give it something to do", hint: "make a list, or save a tool", action: <>
      <button className="ds-btn ghost" onClick={() => { openListsAt({ newList: true }); onLists(); }}>Make a list</button>
      <button className="ds-btn ghost" onClick={onToolkit}>Save a tool</button>
    </> },
    { done: hasFriend, label: "Add a friend, so your agents can talk", hint: "Inbox → People → Invite", action: <button className="ds-btn ghost" onClick={onPeople}>Go</button> },
    { done: !!devices?.pc, label: "Install Back Channel on a PC, so agents and your phone can reach it", hint: "Devices → Add → A PC", action: <a className="ds-btn ghost" style={{ textDecoration: "none" }} href="/account/remote?add=pc">Go</a> },
    { done: !!devices?.phone, label: "Install Back Channel on your phone, for approvals and remote access", hint: "Devices → Add → A phone or laptop", action: <a className="ds-btn ghost" style={{ textDecoration: "none" }} href="/account/remote?add=phone">Go</a> },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length && !forceShow) return null;

  return (
    <div className="ds-card" id="first-run" style={{ borderColor: "var(--ds-acc-line)" }}>
      <h2 className="ds-cardh">👋 Get set up — {doneCount}/{steps.length}</h2>
      <p className="ds-cardsub">Five steps, in any order. The same list is on your PC and your phone.</p>
      {steps.map((step, i) => (
        <div className="ds-item" key={i} style={{ alignItems: "center" }}>
          <span aria-hidden style={{
            width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, color: "#fff", background: step.done ? "var(--ds-ok)" : "var(--ds-line)",
          }}>{step.done ? "✓" : ""}</span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", color: step.done ? "var(--ds-faint)" : "var(--ds-ink)", textDecoration: step.done ? "line-through" : "none", fontSize: 13.5 }}>{i + 1}. {step.label}</span>
            {!step.done && <span className="ds-imeta">{step.hint}</span>}
          </span>
          {!step.done && <div className="ds-iright">{step.action}</div>}
        </div>
      ))}
    </div>
  );
}

function roles(devices: { role: string; revokedAt: string | null }[]): { pc: boolean; phone: boolean } {
  const live = devices.filter((d) => !d.revokedAt);
  return { pc: live.some((d) => d.role === "host"), phone: live.some((d) => d.role === "remote") };
}
