"use client";

/**
 * Devices — everything connected to the account, on one page (docs/web-ia.md; plan §4.1):
 *
 *   Add                   one button, "What are you adding?": an agent, a PC, a phone or laptop (add-device.tsx)
 *   Agents                the agents connected to the account and the connect flow (agents-section.tsx)
 *   PCs                   registered PCs you reach, with revoke
 *   Phones and laptops    registered devices you reach from, with revoke
 *   Live agent sessions   an agent asking to use, or using, one of your PCs (agent-sessions.tsx)
 *   Secrets on your PCs   secret uses waiting for your OK, and each PC's broker (secrets-card.tsx)
 *   Agents on your PCs    per-PC readiness for agents to use apps there (agents-readiness.tsx)
 *   Help someone          one-time support codes (support-sessions.tsx)
 *   Plan                  the Back Channel Remote subscription (docs/remote-paid-tier.md)
 *   Get the apps          where the PC and phone apps are published
 *   Connection attempts   the 7-day relay log
 *
 * The device parts go through the cookie-authenticated /api/appbridge/v1/account/* routes (mutations echo the
 * bc_csrf cookie). No device credential, pass or key is ever shown here: a code is the only secret, it works once
 * and expires in 10 minutes. The Plan card reads /api/appbridge/v1/billing/status and hands off to Stripe-hosted
 * Checkout or the Billing Portal; it hides when billing isn't configured (the status route answers 503).
 *
 * Deep links: `#agents` scrolls to the Agents section (where /account?tab=agents lands); `?add=agent|pc|phone`
 * opens the Add flow on that path, `?add=1` opens the chooser.
 */

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/ui/shell";
import { accountShellTabs } from "@/components/ui/account-nav";
import { useIsOwner } from "@/components/ui/use-is-owner";
import { DEMO_DEVICES } from "@/lib/demo-data";
import AgentSessions, { consumeApprovalLink } from "./agent-sessions";
import SupportSessions from "./support-sessions";
import AgentsReadiness from "./agents-readiness";
import SecretsCard from "./secrets-card";
import AgentsSection from "./agents-section";
import AddDevice, { type AddChoice } from "./add-device";
import { ROLE_NOUN, deviceRoleLine, type RemoteRole } from "./remote-copy";

// Where the apps are published (a public repository; the source repository is private). The page
// links to it rather than fetching it: connect-src is 'self', and a download list that is always
// the releases page cannot go stale.
const RELEASES_URL = "https://github.com/skyflyt/appbridge-releases/releases";

interface RemoteDevice { id: string; role: RemoteRole; label: string | null; relayEnabled: boolean; enabled: boolean; connectorSpkiSha256: string; createdAt: string; revokedAt: string | null; }
interface DevicesReply { rollout: boolean; entitled: boolean; devices: RemoteDevice[]; }
interface Connection { hostDeviceId: string; remoteDeviceId: string; at: string; }
// GET /api/appbridge/v1/billing/status (docs/remote-paid-tier.md). null = billing isn't offered here.
interface BillingStatus { plan: "none" | "remote"; status: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; source: "admin" | "subscription" | null; }
// A subscription the owner can still manage in Stripe's portal (fix a card, cancel, see invoices).
const MANAGEABLE = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);
const STRIPE_PAGE = /^https:\/\/(checkout|billing)\.stripe\.com\//;

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
const mutate = (path: string, method: "POST" | "DELETE", body?: unknown) =>
  fetch(path, { method, credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: body === undefined ? undefined : JSON.stringify(body) });

function ago(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const deviceName = (d: RemoteDevice | undefined, fallback: string) => d?.label || (d ? `${ROLE_NOUN[d.role]} ${d.id.slice(0, 6)}` : fallback);

/** `?add=` → the Add flow's path. */
const ADD_PARAM: Record<string, AddChoice> = { agent: "agent", pc: "host", host: "host", phone: "remote", laptop: "remote", remote: "remote" };

/** The plan: what the account has, and the one Stripe action that fits (subscribe or manage). */
function PlanCard({ billing, busy, message, onOpen }: { billing: BillingStatus; busy: string; message: string; onOpen: (kind: "checkout" | "portal") => void }) {
  const manageable = !!billing.status && MANAGEABLE.has(billing.status);
  const troubled = billing.status === "past_due" || billing.status === "unpaid";
  let line: string;
  if (billing.source === "admin") line = "Remote is included with your account.";
  else if (billing.source === "subscription") {
    line = billing.cancelAtPeriodEnd ? `Back Channel Remote subscription. Cancelled; access ends ${day(billing.currentPeriodEnd)}.`
      : billing.status === "trialing" ? `Back Channel Remote subscription. Trial ends ${day(billing.currentPeriodEnd)}.`
      : `Back Channel Remote subscription. Renews ${day(billing.currentPeriodEnd)}.`;
  } else if (troubled) line = "Your last payment didn't go through, so remote access is paused. Update your payment method to turn it back on.";
  else line = "Subscribe to Back Channel Remote to reach your PCs through the relay when you're away from home. Cancel any time.";
  return (
    <div className="ds-card">
      <div className="ds-cardh">Plan</div>
      <p className="ds-cardsub" style={{ margin: 0 }}>{line}</p>
      {billing.source === "subscription" && troubled && (
        <p className="ds-fine" style={{ margin: "8px 0 0" }}>Your last payment didn&apos;t go through. Update your payment method within a few days to keep remote access.</p>
      )}
      {(billing.plan === "none" || manageable) && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        {billing.plan === "none" && !manageable && (
          <button className="ds-btn" disabled={busy === "checkout"} onClick={() => onOpen("checkout")}>Subscribe to Remote</button>
        )}
        {manageable && (
          <button className={billing.plan === "none" ? "ds-btn" : "ds-btn ghost"} disabled={busy === "portal"} onClick={() => onOpen("portal")}>Manage subscription</button>
        )}
      </div>}
      {message && <p className="ds-fine" style={{ marginTop: 12 }} aria-live="polite">{message}</p>}
    </div>
  );
}

/** PCs, or Phones and laptops: the connected devices of one role, each with Revoke. */
function DeviceList({ id, title, sub, devices, revokedCount, empty, busy, onRevoke, note }: {
  id: string; title: string; sub: string; devices: RemoteDevice[]; revokedCount: number; empty: string; busy: string; onRevoke: (d: RemoteDevice) => void; note?: string;
}) {
  return (
    <div className="ds-card" id={id}>
      <div className="ds-cardh">{title}{devices.length ? ` (${devices.length})` : ""}</div>
      <p className="ds-cardsub">{sub}</p>
      {note && <p className="ds-fine" style={{ margin: "0 0 10px" }}>{note}</p>}
      {devices.length === 0 && <p className="ds-cardsub" style={{ margin: 0 }}>{empty}</p>}
      {devices.map((d) => (
        <div key={d.id} className="ds-item" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="ds-iname">{deviceName(d, "")}</div>
            <div className="ds-imeta">{deviceRoleLine(d.role, d.relayEnabled)} · connected {ago(d.createdAt)}</div>
          </div>
          <button className="ds-btn danger" disabled={busy === d.id} onClick={() => onRevoke(d)}>Revoke</button>
        </div>
      ))}
      {revokedCount > 0 && <p className="ds-fine" style={{ marginTop: 12 }}>{revokedCount} revoked {revokedCount === 1 ? "device" : "devices"} hidden.</p>}
    </div>
  );
}

export default function DevicesPage() {
  const [state, setState] = useState<"loading" | "unauth" | "ready" | "error">("loading");
  const [demo, setDemo] = useState(false);
  const [data, setData] = useState<DevicesReply | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [billingMessage, setBillingMessage] = useState("");
  // The Add flow, and the Agents section's connect form it hands off to.
  const [addOpen, setAddOpen] = useState(false);
  const [addChoice, setAddChoice] = useState<AddChoice | null>(null);
  const tabs = accountShellTabs(useIsOwner());

  // Billing is optional: when it isn't configured the status route answers 503 and the plan card hides.
  const loadBilling = useCallback(async (): Promise<BillingStatus | null> => {
    try {
      const r = await fetch("/api/appbridge/v1/billing/status", { credentials: "include" });
      const b: BillingStatus | null = r.ok ? await r.json() : null;
      setBilling(b); return b;
    } catch { setBilling(null); return null; }
  }, []);

  const load = useCallback(async () => {
    try {
      await consumeApprovalLink(); // an agent's one-tap approval link signs the person in first
      const r = await fetch("/api/appbridge/v1/account/devices", { credentials: "include" });
      if (r.status === 401) {
        // Non-production only: a signed-out visit shows the fixture, like the dashboard's demo mode, so the page
        // can be reviewed without a database. Production always shows the signed-out card.
        if (process.env.NODE_ENV !== "production") { setDemo(true); setData(DEMO_DEVICES.devices); setConnections(DEMO_DEVICES.connections); setBilling(DEMO_DEVICES.billing); setState("ready"); return; }
        setState("unauth"); return;
      }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json());
      const c = await fetch("/api/appbridge/v1/account/connections", { credentials: "include" });
      if (c.ok) setConnections((await c.json()).connections ?? []);
      await loadBilling();
      setState("ready");
    } catch { setState("error"); }
  }, [loadBilling]);

  useEffect(() => { load(); }, [load]);

  // Deep links: ?add= opens the Add flow on a path; #agents (and the cards' ids) scroll into view once rendered.
  useEffect(() => {
    const add = new URLSearchParams(window.location.search).get("add");
    if (add) { setAddOpen(true); setAddChoice(ADD_PARAM[add] ?? null); }
  }, []);
  useEffect(() => {
    if (state !== "ready" || !/^#[a-z-]+$/.test(window.location.hash)) return;
    const el = document.getElementById(window.location.hash.slice(1));
    if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 50);
  }, [state]);

  // Back from Stripe Checkout: the subscription arrives by webhook, usually within seconds.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("billing");
    if (!result) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (result === "cancel") { setBillingMessage("Checkout cancelled. You haven't been charged."); return; }
    if (result !== "success") return;
    setBillingMessage("Thanks! Your subscription is being confirmed…");
    let tries = 0; let stopped = false;
    const poll = async () => {
      if (stopped) return;
      const b = await loadBilling();
      if (b?.source === "subscription") { setBillingMessage("You're subscribed. Remote access is on."); load(); return; }
      if (++tries < 10) setTimeout(poll, 2000);
      else setBillingMessage("Payment received. It can take a minute to show here; refresh if it doesn't.");
    };
    poll();
    return () => { stopped = true; };
  }, [loadBilling, load]);

  async function openStripe(kind: "checkout" | "portal") {
    setBusy(kind); setBillingMessage("");
    try {
      const r = await mutate(`/api/appbridge/v1/billing/${kind}`, "POST");
      const j = await r.json().catch(() => ({}));
      if (r.ok && typeof j.url === "string" && STRIPE_PAGE.test(j.url)) { window.location.assign(j.url); return; }
      setBillingMessage(
        j.error === "already_subscribed" ? "You already have a subscription. Use Manage subscription."
          : j.error === "email_unverified" ? "Verify your email first."
          : j.error === "rate_limited" ? "Too many attempts. Try again later."
          : j.error === "billing_unavailable" ? "Subscriptions aren't available right now."
          : "Couldn't reach the payment page. Try again.");
    } catch { setBillingMessage("Couldn't reach the payment page. Try again."); }
    setBusy("");
  }

  async function revoke(d: RemoteDevice) {
    if (!window.confirm(`Revoke ${deviceName(d, "this device")}? It stops reaching your PCs through the relay within a minute. Connections on your own network are not changed.`)) return;
    setBusy(d.id);
    const r = await mutate(`/api/appbridge/v1/account/devices/${encodeURIComponent(d.id)}`, "DELETE");
    setBusy("");
    setMessage(r.ok ? `${deviceName(d, "Device")} revoked.` : "Couldn't revoke that device. Try again.");
    load();
  }

  const byId = new Map((data?.devices ?? []).map((d) => [d.id, d]));
  const live = (data?.devices ?? []).filter((d) => !d.revokedAt);
  const pcs = live.filter((d) => d.role === "host");
  const phones = live.filter((d) => d.role === "remote");
  const revokedPcs = (data?.devices ?? []).filter((d) => d.revokedAt && d.role === "host").length;
  const revokedPhones = (data?.devices ?? []).filter((d) => d.revokedAt && d.role === "remote").length;
  const access = !data ? "" : !data.rollout ? "Remote access through the relay is switched off for now."
    : !data.entitled ? (billing
      ? "Reaching a PC away from home needs a Back Channel Remote subscription (see Plan below). Connecting devices works now; the relay opens once you subscribe."
      : "Your account isn't enabled for remote access yet. Connecting devices works; the relay opens once it is enabled.")
    : "Remote access is enabled for your account.";

  return (
    <AppShell tabs={tabs} activeTab="devices" demoBanner={demo ? (
      <div className="ds-demo-banner">Previewing with <strong>demo data</strong> — sign in (needs a local DB) for your real account. Actions are disabled.</div>
    ) : undefined}>
      <div className="ds-wrap">
        <h1 className="ds-h1">Devices</h1>
        <p className="ds-sub">Your agents, the PCs they and your phone can reach, and the phones and laptops you reach from. Everything stays end-to-end encrypted: the relay cannot see your screen or typing.</p>

        {state === "loading" && <div className="ds-card"><div className="ds-skel" style={{ width: 260, height: 16 }} /></div>}
        {state === "unauth" && (
          <div className="ds-card">
            <p style={{ margin: "0 0 14px", lineHeight: 1.6 }}>You&apos;re signed out, or your sign-in link expired.</p>
            <a className="ds-btn" style={{ textDecoration: "none", display: "inline-block" }} href="/login">Sign in</a>
          </div>
        )}
        {state === "error" && <div className="ds-card"><p className="ds-fine">Couldn&apos;t load your devices. Refresh to try again.</p></div>}

        {state === "ready" && data && (
          <div style={{ display: "grid", gap: 16 }}>
            <AddDevice demo={demo} open={addOpen} choice={addChoice} onOpen={setAddOpen} onChoice={(c) => { setAddChoice(c); if (c === "agent") setTimeout(() => document.getElementById("connect-agent")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }} />

            <AgentsSection demo={demo} connectOpen={addChoice === "agent"} onConnectOpenChange={(open) => { if (open) { setAddOpen(true); setAddChoice("agent"); } else setAddChoice((c) => (c === "agent" ? null : c)); }} />

            <DeviceList id="pcs" title="PCs" devices={pcs} revokedCount={revokedPcs} busy={busy} onRevoke={revoke}
              sub="Computers running Back Channel on your PC. Your phone can reach them, and your agents can use them, after your OK."
              empty="No PCs connected yet. Add → A PC gives you the code to type there."
              note={access} />

            <DeviceList id="phones" title="Phones and laptops" devices={phones} revokedCount={revokedPhones} busy={busy} onRevoke={revoke}
              sub="Devices running Back Channel on your phone, or the client on a laptop, that reach your PCs. Your phone is also where you approve things."
              empty="No phones or laptops connected yet. Add → A phone or laptop gives you the code to type there." />
            {message && <p className="ds-fine" style={{ margin: "-6px 0 0" }} aria-live="polite">{message}</p>}

            <AgentSessions />

            <SecretsCard />

            <AgentsReadiness />

            <SupportSessions />

            {billing && <PlanCard billing={billing} busy={busy} message={billingMessage} onOpen={openStripe} />}

            <div className="ds-card">
              <div className="ds-cardh">Get the apps</div>
              <p className="ds-cardsub">Install Back Channel on the PC you want to reach, and on the phone or laptop you&apos;ll reach it from. Each release lists what it runs on and how to install it. These are early pilot builds.</p>
              <a className="ds-btn ghost" style={{ textDecoration: "none", display: "inline-block" }} href={RELEASES_URL} target="_blank" rel="noopener noreferrer">Downloads and release notes</a>
              <p className="ds-fine" style={{ margin: "10px 0 0" }}>Opens the releases page on GitHub in a new tab.</p>
            </div>

            <div className="ds-card">
              <div className="ds-cardh">Connection attempts in the last 7 days</div>
              <p className="ds-cardsub">Which device was let through the relay to which PC, and when. Each entry is an attempt: it is recorded when the connection is allowed, so one that then failed to connect still appears. Nothing else is recorded, and entries are deleted after 7 days.</p>
              {connections.length === 0 && <p className="ds-fine" style={{ margin: 0 }}>No relayed connection attempts in the last 7 days.</p>}
              {connections.map((c, i) => (
                <div key={`${c.at}-${i}`} className="ds-item">
                  <div className="ds-iname">{deviceName(byId.get(c.remoteDeviceId), "A removed device")} → {deviceName(byId.get(c.hostDeviceId), "a removed PC")}</div>
                  <div className="ds-imeta">{ago(c.at)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
