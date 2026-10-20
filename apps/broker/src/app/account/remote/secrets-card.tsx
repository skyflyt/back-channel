"use client";

/**
 * "Secrets on your PCs": the Remote page's card for each PC's secret broker (docs/secrets-epic.md §3.1, §3.3, §3.4).
 *
 * - Requests waiting: an agent on one of your PCs asked to use a secret and the broker there would take your answer from
 *   here. Approving IS a passkey prompt whose challenge is that broker's own digest for the grant you pick; the broker
 *   checks it itself. Compare the request code with the one at the PC (or in the phone notification) first.
 * - Each PC: its broker's installed commit, health, name count and lockdown; Install or Update to the release the broker
 *   repo pins (the UAC prompt at the PC is still yours); which of your passkeys it trusts for approvals from here; and
 *   Lockdown, one click.
 *
 * GET /api/secret-broker (cookie); changes with bc_csrf. Plain text only (the site runs a Trusted Types CSP). Timers are the
 * global functions, called directly.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip } from "@/components/ui/primitives";
import { approveSecret, PasskeyError, sendWithStepUp } from "../passkey-client";
import { AddPasskeyInline, usePasskeys } from "../passkeys";

interface Option { index: number; label: string }
interface Req {
  id: string; agentId: string; machine: string; kind: string; name: string; mode: string; tier: number | null; target: string | null;
  code: string; display: string; requester: { agent?: string | null; session?: string | null } | null; options: Option[];
  status: "open" | "approved" | "denied" | "expired" | "closed"; option: number | null; raisedAt: string; expiresAt: string; decidedAt: string | null;
}
interface Broker {
  installed: boolean; commit: string | null; healthy: boolean | null; names: number | null; lockdown: boolean | null;
  approverEnrolled: boolean | null; checks: { label: string; ok: boolean }[]; pin: { commit: string; subject: string | null } | null;
}
interface Machine {
  agentId: string; name: string; broker: Broker; brokerAt: string | null; current: boolean; updateAvailable: boolean;
  passkeys: { id: string; label: string; fingerprint: string; trusted: boolean }[];
  job: { id: string; kind: string; state: string; progress: { steps?: Record<string, boolean>; fingerprint?: string } | null; failure: string | null; createdAt: string; finishedAt: string | null } | null;
}
interface Reply { machines: Machine[]; requests: Req[] }

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf(), ...headers }, body: JSON.stringify(body) });
const short = (c: string | null) => (c ? c.slice(0, 7) : "unknown");
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleString();
}
/** What each job step means, in the order a person sees them happen. */
const STEP_LABELS: Record<string, string> = {
  fetched: "Release fetched and checked against the pin",
  installer_started: "Installer started (after your UAC click at the PC)",
  installer_finished: "Installer finished",
  service_running: "Service running at the pinned commit",
  approver_enrolled: "Windows Hello approver enrolled (at the PC)",
  token_stored: "Bitwarden machine token stored (typed at the PC)",
  doctor_healthy: "Doctor healthy",
  trusted: "Passkey trusted (you approved at the PC)",
  locked: "Locked down",
};
const FAILURES: Record<string, string> = {
  uac_declined: "The UAC prompt at the PC was declined or timed out.",
  pin_mismatch: "What the PC fetched didn't match the release pin, so nothing was run.",
  fetch_failed: "The PC couldn't fetch the broker release (is GitHub signed in there?).",
  installer_failed: "The installer stopped with an error. Look at its window on the PC.",
  not_supported: "This PC's worker can't install the broker on this system yet.",
  declined_at_machine: "It was declined at the PC.",
  broker_unavailable: "The broker on that PC isn't answering.",
};

function RequestCard({ r, busy, onApprove, onDeny, now, needsPasskey, onPasskeyAdded }: {
  r: Req; busy: string; onApprove: (r: Req, option: number) => void; onDeny: (r: Req) => void; now: number; needsPasskey: boolean; onPasskeyAdded: () => void;
}) {
  const [option, setOption] = useState(0);
  const left = new Date(r.expiresAt).getTime() - now;
  const who = r.requester?.agent ? `"${r.requester.agent}"${r.requester.session ? ` (session ${r.requester.session.slice(0, 12)})` : ""}` : "an agent";
  return (
    <div className="ds-item" style={{ display: "block" }}>
      <div className="ds-iname"><Chip tone="acc">Needs your OK</Chip> {who} on {r.machine} wants <strong>{r.name}</strong> ({r.mode}{r.target ? ` → ${r.target}` : ""})</div>
      <div style={{ fontFamily: "var(--ds-mono, monospace)", fontSize: 28, letterSpacing: 6, margin: "10px 0 4px" }} aria-label={`Request code ${r.code.split("").join(" ")}`}>{r.code}</div>
      <p className="ds-fine" style={{ margin: "0 0 8px" }}>Check this code matches the one at the PC or in your phone notification. Approve nothing that shows a different one.</p>
      <details style={{ margin: "0 0 8px" }}><summary className="ds-fine">What the broker shows</summary>
        <pre className="ds-mono" style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: "6px 0 0" }}>{r.display}</pre>
      </details>
      {r.options.length > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 8px" }}>
          <legend className="ds-fine">Grant for this agent session</legend>
          {r.options.map((o) => (
            <label key={o.index} style={{ display: "block", padding: "2px 0" }}>
              <input type="radio" name={`grant-${r.id}`} checked={option === o.index} onChange={() => setOption(o.index)} /> {o.label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="ds-imeta">{left > 0 ? `Expires in ${clock(left)}.` : "This request has expired."} Tier {r.tier ?? "?"}{r.kind !== "serve" ? ` · ${r.kind}` : ""}.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button className="ds-btn" disabled={!!busy || left <= 0} onClick={() => onApprove(r, option)}>{busy === `approve:${r.id}` ? "Waiting for your passkey…" : "Approve with passkey"}</button>
        <button className="ds-btn ghost" disabled={!!busy} onClick={() => onDeny(r)}>Deny</button>
      </div>
      {needsPasskey && <AddPasskeyInline action="Approving" onCancel={onPasskeyAdded} onAdded={onPasskeyAdded} />}
    </div>
  );
}

function MachineRow({ m, busy, onJob }: { m: Machine; busy: string; onJob: (m: Machine, kind: string, body?: unknown) => void }) {
  const b = m.broker;
  const status = !b.installed ? <Chip tone="warn">Not installed</Chip>
    : b.lockdown ? <Chip tone="warn">Locked down</Chip>
    : b.healthy === false ? <Chip tone="warn">Not healthy</Chip>
    : b.healthy === true ? <Chip tone="ok">Healthy</Chip>
    // A broker from before `doctor --json`, or one whose doctor didn't answer, hasn't said either way.
    : <Chip title="The broker there didn't report its health. Update it, or run secret-broker doctor at the PC.">Health unknown</Chip>;
  const lockdown = b.lockdown === true ? "on" : b.lockdown === false ? "off" : "unknown";
  const running = m.job && ["requested", "sent", "running"].includes(m.job.state);
  const steps = Object.entries(m.job?.progress?.steps ?? {});
  return (
    <div className="ds-item" style={{ display: "block" }} id={`secret-pc-${m.agentId}`}>
      <div className="ds-iname">{status} {m.name}</div>
      <div className="ds-imeta">
        {b.installed ? `Secret broker at ${short(b.commit)} · ${b.names ?? "?"} names · lockdown ${lockdown}` : "No secret broker on this PC yet"}
        {` · checked ${ago(m.brokerAt)}`}{!m.current ? " (the worker isn't reporting right now)" : ""}
      </div>
      {b.checks.some((c) => !c.ok) && <div className="ds-fine">Failing: {b.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {m.updateAvailable && <button className="ds-btn" disabled={!!busy || !!running} onClick={() => onJob(m, "update")}>Update to {short(b.pin?.commit ?? null)}</button>}
        {!b.installed && b.pin && <button className="ds-btn" disabled={!!busy || !!running} onClick={() => onJob(m, "install")}>Install</button>}
        {b.installed && !b.lockdown && <button className="ds-btn danger" disabled={!!busy} onClick={() => { if (window.confirm(`Lock down the secret broker on ${m.name}? Every request there is refused until you unlock it at the PC.`)) onJob(m, "lockdown"); }}>Lockdown</button>}
      </div>
      {b.pin && m.updateAvailable && <p className="ds-fine" style={{ margin: "6px 0 0" }}>The pinned release: {b.pin.subject ?? short(b.pin.commit)}. Updating asks for your passkey here, then UAC at the PC.</p>}
      {b.installed && (
        <div style={{ marginTop: 10 }}>
          <div className="ds-fine">Phone approvals: passkeys this broker trusts to approve from here</div>
          {m.passkeys.length === 0 && <div className="ds-fine">Add a passkey to your account first (Settings → Passkeys).</div>}
          {m.passkeys.map((p) => (
            <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "2px 0" }}>
              <span>{p.trusted ? "✓" : "–"} {p.label}</span><span className="ds-mono ds-fine">{p.fingerprint}</span>
              {!p.trusted && <button className="ds-link" disabled={!!busy || !!running} onClick={() => onJob(m, "enrol", { passkeyId: p.id })}>Trust for approvals</button>}
            </div>
          ))}
        </div>
      )}
      {m.job && (running || (m.job.finishedAt && Date.now() - new Date(m.job.finishedAt).getTime() < 3600_000)) && (
        <div style={{ marginTop: 10 }}>
          <div className="ds-fine">{({ install: "Install", update: "Update", enrol: "Trust passkey", lockdown: "Lockdown" } as Record<string, string>)[m.job.kind] ?? m.job.kind}: {m.job.state === "done" ? "done" : m.job.state === "failed" ? "failed" : m.job.state === "running" ? "in progress at the PC" : "waiting for the PC's worker"}</div>
          {m.job.kind === "enrol" && running && <div className="ds-fine">At the PC, approve the broker's prompt only if it shows fingerprint {String((m.passkeys.find((p) => !p.trusted) ?? { fingerprint: "" }).fingerprint)} for this passkey.</div>}
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {steps.map(([k, v]) => <li key={k} className="ds-fine">{v ? "✓" : "…"} {STEP_LABELS[k] ?? k}</li>)}
          </ul>
          {m.job.failure && <div className="ds-fine">{FAILURES[m.job.failure] ?? `Stopped: ${m.job.failure}.`}</div>}
        </div>
      )}
    </div>
  );
}

export default function SecretsCard() {
  const passkeys = usePasskeys();
  const [data, setData] = useState<Reply | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [needsPasskey, setNeedsPasskey] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/secret-broker", { credentials: "include" });
      if (r.status === 401) { setState("none"); return; }
      if (!r.ok) { setState("error"); return; }
      const j = (await r.json()) as Reply;
      setData(j);
      setState(j.machines.length || j.requests.length ? "ready" : "none");
    } catch { setState("error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const waiting = !!data && data.requests.some((r) => r.status === "open");
  const working = !!data && data.machines.some((m) => m.job && ["requested", "sent", "running"].includes(m.job.state));
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => { if (document.visibilityState === "visible") void load(); }, waiting || working ? 3000 : 30_000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, [waiting, working, load]);
  // From the phone notification's link (#secrets): bring the card into view.
  useEffect(() => {
    if (state === "ready" && typeof window !== "undefined" && window.location.hash === "#secrets") document.getElementById("secrets")?.scrollIntoView({ block: "start" });
  }, [state]);

  async function approve(r: Req, option: number) {
    setBusy(`approve:${r.id}`); setMessage(""); setNeedsPasskey(null);
    try {
      const chosen = await approveSecret(r.id, option);
      const label = r.options.find((o) => o.index === chosen)?.label;
      setMessage(`Approved${label ? ` (${label})` : ""}. The broker on ${r.machine} checks your passkey's answer itself, then the agent goes on.`);
    } catch (e) {
      if (e instanceof PasskeyError && e.code === "passkey_required") setNeedsPasskey(r.id);
      else setMessage(e instanceof Error ? e.message : "That didn't work. Try again.");
    }
    setBusy(""); void load();
  }
  async function deny(r: Req) {
    setBusy(`deny:${r.id}`); setMessage("");
    try {
      const res = await post(`/api/secret-broker/requests/${encodeURIComponent(r.id)}/deny`, {});
      const j = await res.json().catch(() => ({}));
      setMessage(res.ok ? `Denied. The agent on ${r.machine} gets nothing.` : typeof j.message === "string" ? j.message : "That didn't work. Try again.");
    } catch { setMessage("Couldn't reach Back Channel. Try again."); }
    setBusy(""); void load();
  }
  async function job(m: Machine, kind: string, body: unknown = {}) {
    setBusy(`${kind}:${m.agentId}`); setMessage("");
    const path = `/api/secret-broker/machines/${encodeURIComponent(m.agentId)}/${kind}`;
    const r = kind === "lockdown"
      ? await post(path, body).then(async (res) => ({ ok: res.ok, message: res.ok ? null : ((await res.json().catch(() => ({}))) as { message?: string }).message ?? "That didn't work.", needsPasskey: false }))
        .catch(() => ({ ok: false, message: "Couldn't reach Back Channel. Try again.", needsPasskey: false }))
      : await sendWithStepUp("secret_broker_admin", m.agentId, (h) => post(path, body, h), passkeys.hint);
    setMessage(r.ok ? ({ install: `Asked ${m.name} to install the broker. Accept the UAC prompt there.`, update: `Asked ${m.name} to update its broker. Accept the UAC prompt there.`,
      enrol: `Asked ${m.name} to trust that passkey. Approve the broker's prompt there after checking the fingerprint.`, lockdown: `${m.name}'s broker locks down within a few seconds.` } as Record<string, string>)[kind] ?? "Done."
      : r.message ?? "That didn't work. Try again.");
    setBusy(""); void load();
  }

  if (state === "loading" || state === "none") return null;
  if (state === "error" || !data) return <div className="ds-card" id="secrets"><div className="ds-cardh">Secrets on your PCs</div><p className="ds-fine">Couldn&apos;t load this right now.</p></div>;
  const open = data.requests.filter((r) => r.status === "open" && new Date(r.expiresAt).getTime() > now);
  const recent = data.requests.filter((r) => r.status !== "open").slice(0, 8);
  return (
    <div className="ds-card" id="secrets">
      <div className="ds-cardh">Secrets on your PCs</div>
      <p className="ds-fine" style={{ marginTop: 0 }}>Agents on your PCs never see a secret: the broker there uses it for them, after your OK. Approve here with your passkey, or at the PC.</p>
      {open.map((r) => (
        <RequestCard key={r.id} r={r} busy={busy} now={now} onApprove={approve} onDeny={deny} needsPasskey={needsPasskey === r.id}
          onPasskeyAdded={() => { setNeedsPasskey(null); void passkeys.reload(); }} />
      ))}
      {open.length === 0 && <p className="ds-fine">No secret requests waiting.</p>}
      <div className="ds-lsec" style={{ paddingLeft: 0 }}>PCs</div>
      {data.machines.map((m) => <MachineRow key={m.agentId} m={m} busy={busy} onJob={job} />)}
      {recent.length > 0 && (
        <>
          <div className="ds-lsec" style={{ paddingLeft: 0 }}>Recent</div>
          {recent.map((r) => (
            <div key={r.id} className="ds-item" style={{ display: "block" }}>
              <div className="ds-iname">{r.name} on {r.machine}</div>
              <div className="ds-imeta">{({ approved: "Approved here", denied: "Denied here", expired: "Expired", closed: "Answered at the PC" } as Record<string, string>)[r.status] ?? r.status}{r.status === "approved" && r.option !== null && r.options[r.option] ? ` (${r.options[r.option].label})` : ""} · {ago(r.decidedAt ?? r.raisedAt)} · code {r.code}</div>
            </div>
          ))}
        </>
      )}
      {message && <p className="ds-fine" style={{ marginTop: 12 }} aria-live="polite">{message}</p>}
    </div>
  );
}
