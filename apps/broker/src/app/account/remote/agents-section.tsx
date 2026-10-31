"use client";

/**
 * "Agents": the Devices page's first section (docs/web-ia.md). The agents connected to the account, each with its
 * health (when Back Channel last heard from it), Check status, Reconnect, Rename and Revoke; then the connect flow:
 * the MCP connector (the browser mints the agent's key after the person's passkey, and the person wires it into
 * their client's own settings; the agent never runs anything to establish trust), the one-time agent code for
 * runtimes without MCP, and the developer-key escape hatch for scripting by hand.
 *
 * Moved from the dashboard's Agents tab on 2026-10-31; the data and API paths are unchanged (/api/account/agents,
 * /api/auth/exchange-code, /api/account/bootstrap-prompt, all cookie + bc_csrf). The Add flow on the Devices page
 * opens the connect form through `connectOpen`.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip, EmptyState, HealthDot } from "@/components/ui/primitives";
import { DEMO_ACCOUNT } from "@/lib/demo-data";
import { AddPasskeyInline, usePasskeys } from "../passkeys";
import { sendWithStepUp, type Guarded } from "../passkey-client";
import { agentHealth, csrf, RUNTIME_LABEL, when, type AgentRow } from "../shared";

const RUNTIME_OPTIONS = [["other", "Other / not sure"], ["cowork", "Cowork (Claude desktop)"], ["claude_code", "Claude Code (CLI)"], ["codex", "Codex (CLI)"], ["chatgpt", "ChatGPT (web)"], ["claude_web", "Claude.ai web (chat tab)"]] as const;
// Runtimes that can read a URL but can't POST: they can install read-only tools but cannot connect an account.
const CHAT_TAB_RUNTIMES = ["chatgpt", "claude_web"];
type McpClient = "claude_desktop" | "claude_code" | "codex" | "other";
const MCP_CLIENT_RUNTIME: Record<McpClient, string> = { claude_desktop: "cowork", claude_code: "claude_code", codex: "codex", other: "other" };
const MCP_CLIENT_LABEL: Record<McpClient, string> = { claude_desktop: "Claude Desktop", claude_code: "Claude Code", codex: "Codex app / CLI", other: "Other MCP client" };

// A failed code mint, in plain words.
const exchangeErrorMessage = (status: number, j: { error?: unknown; message?: unknown }) =>
  status === 429 ? "You've generated a lot of codes recently — wait a few minutes, or use one you already copied."
  : status === 403 && (j.error === "step_up_required" || j.error === "passkey_required") && typeof j.message === "string" ? j.message
  : status === 403 ? "Your sign-in session expired. Refresh the page and try again."
  : status === 409 ? "Your email isn't verified yet — check your inbox for the sign-in link."
  : ((typeof j.message === "string" && j.message) || `Couldn't generate a code (error ${status}). Try again in a moment.`);
// A mint that went through the passkey step-up: the server's answer, or the prompt's own (cancelled, no network).
const mintError = (r: Guarded) => (r.status ? exchangeErrorMessage(r.status, r.body) : r.message ?? "Couldn't reach Back Channel. Check your connection and try again.");

export default function AgentsSection({ demo, connectOpen, onConnectOpenChange, onAgents }: {
  /** Non-production, signed out: the fixture, with actions disabled. */
  demo: boolean;
  /** The connect form, opened by the page's Add flow ("An agent"). */
  connectOpen: boolean;
  onConnectOpenChange: (open: boolean) => void;
  /** The agents as loaded, for the page's other sections. */
  onAgents?: (agents: AgentRow[]) => void;
}) {
  const [agents, setAgents] = useState<AgentRow[]>(demo ? (DEMO_ACCOUNT.agents as AgentRow[]) : []);
  const [agentName, setAgentName] = useState("");
  const [agentRuntime, setAgentRuntime] = useState("other");
  const [mcpToken, setMcpToken] = useState<string | null>(null); // the agent's key, shown once
  const [mcpClient, setMcpClient] = useState<McpClient>("claude_desktop");
  const [mcpOs, setMcpOs] = useState<"windows" | "mac">("windows");
  const [mcpErr, setMcpErr] = useState("");
  const [mcpCopied, setMcpCopied] = useState("");
  // The agent-code flow, behind a disclosure: still the only path for runtimes without MCP support.
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [legacyFormOpen, setLegacyFormOpen] = useState(false);
  const [connectTrack, setConnectTrack] = useState<"guided" | "quick">("guided");
  const [copiedStep, setCopiedStep] = useState("");
  const [agentCheck, setAgentCheck] = useState<Record<string, string>>({});
  const [exCode, setExCode] = useState<string | null>(null);
  const [exPrompt, setExPrompt] = useState("");
  const [exExpiry, setExExpiry] = useState(0); // epoch ms
  const [exCopied, setExCopied] = useState(false);
  const [exErr, setExErr] = useState("");
  // The developer-key escape hatch, behind an explainer.
  const [bootstrap, setBootstrap] = useState<string | null>(null);
  const [bootstrapCopied, setBootstrapCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState("");
  // Minting a key needs a passkey step-up; with no passkey yet, "Add a passkey" shows in place, then retries.
  const passkeys = usePasskeys(!demo);
  const [passkeyFor, setPasskeyFor] = useState<{ retry: () => void } | null>(null);

  const loadAgents = useCallback(async () => {
    if (demo) return;
    try {
      const r = await fetch("/api/account/agents", { credentials: "include" });
      if (r.ok) { const list: AgentRow[] = (await r.json()).agents ?? []; setAgents(list); onAgents?.(list); }
    } catch { /* leave as-is */ }
  }, [demo, onAgents]);
  useEffect(() => { loadAgents(); }, [loadAgents]);
  useEffect(() => { if (demo) onAgents?.(DEMO_ACCOUNT.agents as AgentRow[]); }, [demo, onAgents]);

  // Hide the revealed developer-key prompt after 30 s (it contains the full key).
  useEffect(() => {
    if (!bootstrap) return;
    const t = setTimeout(() => { setBootstrap(null); setBootstrapCopied(false); }, 30000);
    return () => clearTimeout(t);
  }, [bootstrap]);

  // Clear an agent code once it expires (no countdown: the 15-minute life is calm by design).
  useEffect(() => {
    if (!exCode || !exExpiry) return;
    const left = exExpiry - Date.now();
    if (left <= 0) { setExCode(null); setExPrompt(""); setExCopied(false); return; }
    const t = setTimeout(() => { setExCode(null); setExPrompt(""); setExCopied(false); }, left);
    return () => clearTimeout(t);
  }, [exCode, exExpiry]);

  const openConnect = () => { setAgentName(""); setMcpClient("claude_desktop"); onConnectOpenChange(true); };

  const mintMcpToken = async () => {
    setBusy("mcp-mint"); setMcpErr(""); setPasskeyFor(null);
    const r = await sendWithStepUp("connect_agent", null, (h) => fetch("/api/account/agents", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-bc-csrf": csrf(), ...h },
      body: JSON.stringify({ agent_name: agentName.trim() || MCP_CLIENT_LABEL[mcpClient], runtime_type: MCP_CLIENT_RUNTIME[mcpClient] }),
    }), passkeys.connectHint);
    if (r.ok && typeof r.body.api_key === "string") { setMcpToken(r.body.api_key); onConnectOpenChange(false); setMcpCopied(""); loadAgents(); }
    else if (r.needsPasskey) setPasskeyFor({ retry: () => { void passkeys.reload(); void mintMcpToken(); } });
    else setMcpErr(mintError(r));
    setBusy("");
  };

  const connectNewAgent = async (plugin = false) => {
    setBusy("exchange"); setExErr(""); setPasskeyFor(null);
    if (plugin) setLegacyOpen(true);
    const r = await sendWithStepUp("connect_agent", null, (h) => fetch("/api/auth/exchange-code", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-bc-csrf": csrf(), ...h },
      body: JSON.stringify({ agent_name: agentName.trim() || (plugin ? "Codex" : "New agent"), runtime_type: plugin ? "codex" : agentRuntime === "claude_web" ? "other" : agentRuntime }),
    }), passkeys.connectHint);
    const j = r.body as { code?: string; paste_prompt?: string; expires_at?: string };
    if (r.ok && j.code) {
      setExCode(j.code); setExPrompt(plugin ? `Connect Back Channel with code ${j.code} using the installed Back Channel plugin.` : j.paste_prompt ?? "");
      setExExpiry(new Date(j.expires_at ?? 0).getTime()); setExCopied(false); setLegacyFormOpen(false);
      if (plugin) { setConnectTrack("quick"); setLegacyOpen(true); onConnectOpenChange(false); }
    }
    else if (r.needsPasskey) setPasskeyFor({ retry: () => { void passkeys.reload(); void connectNewAgent(plugin); } });
    else setExErr(mintError(r));
    setBusy("");
  };

  const revokeAgent = async (id: string, name: string) => {
    if (!confirm(`Revoke "${name}"? This agent will lose access immediately. Your other agents stay connected.`)) return;
    setBusy(`revoke:${id}`);
    await fetch(`/api/account/agents/${id}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadAgents();
  };

  // A fresh agent code carrying this agent's name and runtime, to re-bind a new key (say after its own login died).
  const reconnectAgent = async (a: AgentRow) => {
    setBusy(`reconnect:${a.id}`); setExErr(""); setPasskeyFor(null);
    const r = await sendWithStepUp("connect_agent", null, (h) => fetch("/api/auth/exchange-code", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-bc-csrf": csrf(), ...h },
      body: JSON.stringify({ agent_name: a.name, runtime_type: a.runtime_type }),
    }), passkeys.connectHint);
    const j = r.body as { code?: string; paste_prompt?: string; expires_at?: string };
    setLegacyOpen(true); // reconnect rides the agent-code panel
    if (r.ok && j.code) {
      setExCode(j.code); setExPrompt(a.runtime_type === "codex" ? `Connect Back Channel with code ${j.code} using the installed Back Channel plugin.` : j.paste_prompt ?? ""); setExExpiry(new Date(j.expires_at ?? 0).getTime()); setExCopied(false); setLegacyFormOpen(false);
      if (a.runtime_type === "codex") setConnectTrack("quick");
    } else if (r.needsPasskey) {
      setPasskeyFor({ retry: () => { void passkeys.reload(); void reconnectAgent(a); } });
    } else {
      setExErr(mintError(r));
    }
    setTimeout(() => document.querySelector("#connect-agent")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    setBusy("");
  };

  // "Check status": re-read this agent's freshness and say honestly what Back Channel can tell.
  const checkAgent = async (a: AgentRow) => {
    setBusy(`check:${a.id}`);
    try {
      const r = await fetch("/api/account/agents", { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      const fresh: AgentRow | undefined = (j.agents ?? []).find((x: AgentRow) => x.id === a.id);
      const h = agentHealth(fresh?.last_used_at ?? null);
      let msg: string;
      if (h.key === "active") msg = `✓ Heard from this agent ${when(fresh!.last_used_at!)} — looks healthy.`;
      else if (h.key === "new") msg = "This agent has never checked in. Paste its agent code to finish connecting.";
      else if (h.key === "stale") msg = `⚠ No contact in over a day (last ${when(fresh!.last_used_at!)}). If you expect it to be running, its runtime (Codex/ChatGPT/etc.) likely lost its OWN login — fix that first. If Back Channel itself is stuck, use Reconnect.`;
      else msg = `Last heard from ${when(fresh!.last_used_at!)}. It may just be between checks (agents poll every ~10 min). If you expect it live and it stays quiet, check your agent's runtime login.`;
      setAgentCheck((m) => ({ ...m, [a.id]: msg }));
      if (j.agents) setAgents(j.agents);
    } catch { setAgentCheck((m) => ({ ...m, [a.id]: "Couldn't check just now — try again." })); }
    setBusy("");
  };

  const renameAgent = async (id: string, current: string) => {
    const name = prompt("Rename this agent:", current);
    if (!name || name.trim() === current) return;
    setBusy(`rename:${id}`);
    await fetch(`/api/account/agents/${id}/rename`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ name: name.trim() }) }).catch(() => {});
    setBusy(""); loadAgents();
  };

  const revealBootstrap = async () => {
    setBusy("bootstrap"); setExErr(""); setPasskeyFor(null);
    const r = await sendWithStepUp("connect_agent", null, (h) => fetch("/api/account/bootstrap-prompt", { credentials: "include", headers: h }), passkeys.connectHint);
    if (r.ok && typeof r.body.prompt === "string") setBootstrap(r.body.prompt);
    else if (r.needsPasskey) setPasskeyFor({ retry: () => { void passkeys.reload(); void revealBootstrap(); } });
    else setExErr(mintError(r));
    setBusy("");
  };

  const copyBtn = (id: string, text: string, label = "Copy") => (
    <button className="ds-btn" style={{ fontSize: 12.5 }} onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setMcpCopied(id); setTimeout(() => setMcpCopied(""), 1500); }}>{mcpCopied === id ? "✓ Copied" : label}</button>
  );

  return (
    <div id="agents" style={{ display: "grid", gap: 16 }}>
      <div className="ds-card">
        <div className="ds-cardh">Agents{agents.length ? ` (${agents.length})` : ""}</div>
        <p className="ds-cardsub">The AI assistants connected to your account. Each has its own key; revoke any one without affecting the others.</p>
        {agents.length === 0 && (
          <EmptyState icon="🤖">No agents connected yet. <button className="ds-link" onClick={openConnect}>Add one →</button></EmptyState>
        )}
        {agents.map((a) => {
          const h = agentHealth(a.last_used_at);
          const cold = h.key === "stale" || h.key === "sleeping";
          return (
            <div className="ds-item" key={a.id}>
              <HealthDot color={h.color} label={h.label} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ds-iname">{a.name} <Chip tone={h.key === "active" ? "ok" : cold ? "warn" : undefined}>{h.label}</Chip> <Chip>{RUNTIME_LABEL[a.runtime_type] ?? a.runtime_type}</Chip></div>
                <div className="ds-imeta">added {when(a.created_at)} · {a.last_used_at ? `last heard from ${when(a.last_used_at)}` : "never used yet"}</div>
                {cold && <div className="ds-call warn" style={{ marginTop: 8, padding: "8px 12px", fontSize: 12.5 }}>This agent hasn&apos;t been heard from in a while. If you expect it running, its runtime may have lost its own login — see the FAQ.</div>}
                {agentCheck[a.id] && <div className="ds-call" style={{ marginTop: 8, padding: "8px 12px", fontSize: 12.5, background: "#f8fafc", border: "1px solid var(--ds-line)" }}>{agentCheck[a.id]}</div>}
              </div>
              <div className="ds-iright">
                <button className="ds-link" disabled={busy === `check:${a.id}` || demo} onClick={() => checkAgent(a)}>{busy === `check:${a.id}` ? "checking…" : "Check status"}</button>
                {cold && <button className="ds-link" disabled={busy === `reconnect:${a.id}` || demo} onClick={() => reconnectAgent(a)}>{busy === `reconnect:${a.id}` ? "…" : "Reconnect"}</button>}
                <button className="ds-link" disabled={busy === `rename:${a.id}` || demo} onClick={() => renameAgent(a.id, a.name)}>Rename</button>
                <button className="ds-btn danger" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === `revoke:${a.id}` || demo} onClick={() => revokeAgent(a.id, a.name)}>{busy === `revoke:${a.id}` ? "…" : "Revoke"}</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connect an agent. PRIMARY: the MCP connector, set up in the client's own settings. */}
      {(connectOpen || mcpToken || legacyOpen) && (
      <div className="ds-card" id="connect-agent">
        <h2 className="ds-cardh">Connect an agent</h2>
        <p className="ds-cardsub">Choose your AI client below. The Codex plugin connects with a one-time agent code; other MCP clients can use a key in their settings. Signing in to this website does not connect your assistant.{passkeys.state?.connectStepUp === "on" ? " Because you use Back Channel Remote, getting a key or a code asks for your passkey (Windows Hello or your phone), so an agent working on one of your PCs can't connect itself." : ""}</p>
        {mcpErr && <p className="ds-call danger" style={{ marginBottom: 12 }}>⚠ {mcpErr}</p>}
        {passkeyFor && (
          <div style={{ marginBottom: 12 }}>
            <AddPasskeyInline action="Connecting an agent" onCancel={() => setPasskeyFor(null)} onAdded={() => { const retry = passkeyFor.retry; setPasskeyFor(null); retry(); }} />
          </div>
        )}
        {mcpToken ? (() => {
          const mcpUrl = `${typeof window !== "undefined" ? window.location.origin : "https://back-channel.app"}/api/mcp`;
          const ccCmd = `claude mcp add --transport http back-channel ${mcpUrl} --header "Authorization: Bearer ${mcpToken}" --scope user`;
          const codexEnv = mcpOs === "windows" ? `setx BACKCHANNEL_TOKEN "${mcpToken}"` : `echo 'export BACKCHANNEL_TOKEN="${mcpToken}"' >> ~/.zshrc && source ~/.zshrc`;
          const codexToml = `[mcp_servers.back_channel]\nurl = "${mcpUrl}"\nbearer_token_env_var = "BACKCHANNEL_TOKEN"`;
          return (
            <div className="ds-call acc">
              <p style={{ margin: "0 0 8px", fontWeight: 600 }}>🔑 This agent&apos;s key — copy it now, it won&apos;t be shown again:</p>
              <pre className="ds-pre" style={{ marginBottom: 8 }}>{mcpToken}</pre>
              <div style={{ margin: "0 0 14px" }}>{copyBtn("tok", mcpToken)}</div>
              {mcpClient === "claude_desktop" && (
                <ol style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.7 }}>
                  <li><a href="/back-channel.mcpb" download style={{ color: "var(--ds-acc)", fontWeight: 600 }}>Download the Back Channel extension</a> (.mcpb file).</li>
                  <li>Double-click the downloaded file — Claude Desktop opens an install dialog. Click <strong>Install</strong>.</li>
                  <li>Paste the key above into the <strong>Back Channel agent token</strong> field and save. (Setting up on another machine? Use an agent code from &ldquo;Connect with a code&rdquo; below instead — a <code>BCX-…</code> code works in that same field and the extension redeems it for you.)</li>
                </ol>
              )}
              {mcpClient === "claude_code" && (
                <div style={{ marginBottom: 12 }}>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>Run this once in any terminal (connects Claude Code account-wide):</p>
                  <pre className="ds-pre">{ccCmd}</pre>
                  <div style={{ marginTop: 6 }}>{copyBtn("cc", ccCmd, "Copy command")}</div>
                </div>
              )}
              {mcpClient === "codex" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <button className={mcpOs === "windows" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12 }} onClick={() => setMcpOs("windows")}>Windows</button>
                    <button className={mcpOs === "mac" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12 }} onClick={() => setMcpOs("mac")}>Mac / Linux</button>
                  </div>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>1. Store the key in an environment variable{mcpOs === "windows" ? " (then open a NEW terminal)" : ""}:</p>
                  <pre className="ds-pre">{codexEnv}</pre>
                  <div style={{ margin: "6px 0 10px" }}>{copyBtn("cxe", codexEnv)}</div>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>2. Add this to <code>~/.codex/config.toml</code> (the key stays in the env var, never in the file):</p>
                  <pre className="ds-pre">{codexToml}</pre>
                  <div style={{ marginTop: 6 }}>{copyBtn("cxt", codexToml)}</div>
                </div>
              )}
              {mcpClient === "other" && (
                <div style={{ marginBottom: 12 }}>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>Point any MCP client that supports <strong>remote HTTP servers with custom headers</strong> at:</p>
                  <pre className="ds-pre">{`URL:    ${mcpUrl}\nHeader: Authorization: Bearer ${mcpToken}`}</pre>
                  <div style={{ marginTop: 6 }}>{copyBtn("oth", `${mcpUrl}\nAuthorization: Bearer ${mcpToken}`)}</div>
                  <p className="ds-fine" style={{ marginTop: 8 }}>claude.ai and ChatGPT: add Back Channel as a connector with the URL alone (no key) and sign in when asked. A web connector can&apos;t encrypt, so what it sends is stored readable; see <a href="/privacy" style={{ color: "var(--ds-acc)" }}>Privacy</a>.</p>
                </div>
              )}
              <p className="ds-fine">✅ <strong>Verify:</strong> open a fresh chat and ask <em>&ldquo;What Back Channel tools do you have?&rdquo;</em> — you should see bc_check_inbox and friends.</p>
              <div style={{ marginTop: 10 }}>
                <button className="ds-btn ghost" onClick={() => { setMcpToken(null); setMcpCopied(""); }}>Done — hide key</button>
              </div>
            </div>
          );
        })() : connectOpen ? (
          <div>
            <label className="ds-label">Which client are you connecting?</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              {(["claude_desktop", "claude_code", "codex", "other"] as const).map((c) => (
                <button key={c} className={mcpClient === c ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12.5 }} onClick={() => setMcpClient(c)}>{MCP_CLIENT_LABEL[c]}</button>
              ))}
            </div>
            {mcpClient === "codex" && (
              <div className="ds-call acc" style={{ marginTop: 12 }}>
                <p style={{ margin: "0 0 8px", fontWeight: 600 }}>Connect the Codex app or CLI with the Back Channel plugin</p>
                <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.7 }}>
                  <li>Install the Back Channel plugin from <code>skyflyt/back-channel</code>. If you installed it while Codex was open, restart Codex to load its tools.</li>
                  <li>Generate a one-time agent code below, then paste the connect prompt into your Codex chat. The plugin saves the key securely on your computer.</li>
                  <li>Ask &ldquo;Check my Back Channel inbox&rdquo; to verify the connection. Ask it to send a message when you want to reply.</li>
                </ol>
                <p className="ds-fine" style={{ marginBottom: 0 }}>Only paste the agent code into chat. Keep keys out of chat.</p>
              </div>
            )}
            <label className="ds-label">Name it (so you can tell your agents apart later)</label>
            <input className="ds-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder={`e.g. ${MCP_CLIENT_LABEL[mcpClient]} on my laptop`} />
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="ds-btn" disabled={busy === "mcp-mint" || busy === "exchange" || demo} onClick={() => mcpClient === "codex" ? connectNewAgent(true) : mintMcpToken()}>{busy === "mcp-mint" || busy === "exchange" ? "…" : mcpClient === "codex" ? "Get an agent code →" : "Get the key →"}</button>
              <button className="ds-btn ghost" onClick={() => onConnectOpenChange(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="ds-btn" onClick={openConnect}>Connect an agent</button>
        )}

        {/* The agent-code flow, for runtimes without MCP. */}
        <div style={{ marginTop: 16, borderTop: "1px dashed var(--ds-line)", paddingTop: 12 }}>
          {!legacyOpen ? (
            <button className="ds-link" onClick={() => setLegacyOpen(true)}>Connect with a code or use advanced setup</button>
          ) : (<>
            <p className="ds-cardsub"><strong>One-time agent code</strong> — paste the connect prompt into your assistant. Installed plugins redeem the code and keep the key on your computer. <button className="ds-link" onClick={() => setLegacyOpen(false)}>Hide</button></p>
            {exErr && <p className="ds-call danger" style={{ marginBottom: 12 }}>⚠ {exErr}</p>}
            {exCode ? (
              connectTrack === "guided" ? (() => {
                // Guided: two low-stakes pastes. Step 1 is a pure read; step 2 is one POST.
                const step1 = `Load the Back Channel skill from https://back-channel.app/skill so you know the protocol — it self-describes its provenance (source/author/license in the frontmatter) so you can verify what it is. Do NOT install any recurring job or take any action yet; I'll give you a connect code in a moment.`;
                const step2 = `Redeem Back Channel exchange code ${exCode}: POST it to https://back-channel.app/api/auth/exchange and store the returned key in your secret store as BC_AUTH_TOKEN. Don't install any scheduled inbox check — I'll opt in from the dashboard if I want it. Then tell me you're connected.`;
                const copyBlock = (id: string, label: string, text: string) => (
                  <div key={id} style={{ marginBottom: 14 }}>
                    <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 13 }}>{label}</p>
                    <pre className="ds-pre">{text}</pre>
                    <button className="ds-btn" style={{ marginTop: 6, fontSize: 12.5 }} onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setCopiedStep(id); setTimeout(() => setCopiedStep(""), 1500); }}>{copiedStep === id ? "✓ Copied" : "Copy"}</button>
                  </div>
                );
                return (
                  <div className="ds-call acc">
                    <p className="ds-cardsub" style={{ marginTop: 0 }}>Guided connect — paste these to your assistant one at a time. The code is <strong>good for 15 minutes</strong>.</p>
                    {copyBlock("s1", "Step 1 — paste this first (read-only, no commitments):", step1)}
                    {copyBlock("s2", "Step 2 — once it confirms it read the skill, paste this:", step2)}
                    <button className="ds-btn ghost" onClick={() => { setExCode(null); setExPrompt(""); }}>Done</button>
                  </div>
                );
              })() : (
                <div className="ds-call acc">
                  <p style={{ margin: "0 0 8px", fontWeight: 600 }}>📋 Paste this to your assistant — <strong>good for 15 minutes</strong>, get a fresh one anytime.</p>
                  <pre className="ds-pre">{exPrompt}</pre>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button className="ds-btn" onClick={() => { navigator.clipboard?.writeText(exPrompt).catch(() => {}); setExCopied(true); setTimeout(() => setExCopied(false), 1500); }}>{exCopied ? "✓ Copied" : "Copy"}</button>
                    <button className="ds-btn ghost" onClick={() => { setExCode(null); setExPrompt(""); }}>Done</button>
                  </div>
                </div>
              )
            ) : legacyFormOpen ? (
              <div>
                <label className="ds-label">What&apos;s this agent? (so you can tell them apart later)</label>
                <input className="ds-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. my laptop, Codex at work, ChatGPT on phone" />
                <label className="ds-label">Where does it run?</label>
                <select className="ds-select" value={agentRuntime} onChange={(e) => setAgentRuntime(e.target.value)}>
                  {RUNTIME_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {CHAT_TAB_RUNTIMES.includes(agentRuntime) && (
                  <p className="ds-call warn" style={{ marginTop: 10 }}>
                    ⚠ A web/chat tab can <strong>read Toolkit items</strong> but can&apos;t connect an account with a code (it can&apos;t make the needed request). Add Back Channel as a connector there instead (choose &ldquo;Other MCP client&rdquo; above), or switch to <strong>Claude Code, Cowork, or Codex</strong>.
                  </p>
                )}
                <label className="ds-label">How do you want to connect?</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className={connectTrack === "guided" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12.5 }} onClick={() => setConnectTrack("guided")}>Guided (two pastes) — recommended</button>
                  <button className={connectTrack === "quick" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12.5 }} onClick={() => setConnectTrack("quick")}>Quick (one paste)</button>
                </div>
                <p className="ds-fine" style={{ marginTop: 6 }}>{connectTrack === "guided" ? "You walk your agent through it in two small steps — works with any assistant that can connect, and a cautious agent is happiest with it." : "Your agent does the whole setup from one paste. Best on local runtimes (Cowork, Codex, Claude Code)."}</p>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button className="ds-btn" disabled={busy === "exchange" || demo} onClick={() => connectNewAgent()}>{busy === "exchange" ? "…" : "Get an agent code →"}</button>
                  <button className="ds-btn ghost" onClick={() => setLegacyFormOpen(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="ds-btn ghost" onClick={() => { setAgentName(""); setAgentRuntime("other"); setConnectTrack("guided"); setLegacyFormOpen(true); }}>Connect with a code</button>
            )}
            {/* The developer-key escape hatch, for scripting by hand. */}
            <div style={{ marginTop: 10 }}>
              {!showRaw ? (
                <button className="ds-link" onClick={() => setShowRaw(true)}>Why would I need my developer key?</button>
              ) : bootstrap ? (
                <div className="ds-call acc" style={{ marginTop: 8 }}>
                  <p style={{ margin: "0 0 8px", fontWeight: 600 }}>📋 Setup prompt with your developer key — hides in 30s. Prefer the code above; use this only to script the key by hand.</p>
                  <pre className="ds-pre">{bootstrap}</pre>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button className="ds-btn" onClick={() => { navigator.clipboard?.writeText(bootstrap).catch(() => {}); setBootstrapCopied(true); setTimeout(() => setBootstrapCopied(false), 1500); }}>{bootstrapCopied ? "✓ Copied" : "Copy"}</button>
                    <button className="ds-btn ghost" onClick={() => { setBootstrap(null); setBootstrapCopied(false); }}>Hide</button>
                  </div>
                </div>
              ) : (
                <p className="ds-fine">The code above is the safe way to connect an agent — the key stays out of your chat. If you&apos;re scripting against the API by hand and want the developer key, <button className="ds-link" onClick={revealBootstrap} disabled={busy === "bootstrap" || demo}>{busy === "bootstrap" ? "loading…" : "reveal it"}</button> (shown briefly, then hidden).</p>
              )}
            </div>
          </>)}
        </div>
      </div>
      )}
    </div>
  );
}
