"use client";

import { useState } from "react";

// Full CRUD for library artifacts, authored directly in the browser (the agent-push
// path stays primary). The broker holds no private key, so UI-authored artifacts are
// created UNSIGNED: fully manageable + privately shareable, but a PUBLIC link needs the
// author's agent to sign first (see the public-share panel's lock state).

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export type EditorArtifact = {
  id: string; name: string; description: string | null; kind: string;
  type?: string; manifest?: Record<string, unknown> | null; body?: string;
};

type ArtType = "prompt" | "scheduled_task" | "skill";
const TYPES: { key: ArtType; icon: string; label: string; blurb: string }[] = [
  { key: "prompt", icon: "💬", label: "Prompt", blurb: "A reusable prompt your agent saves. Nothing runs automatically — you invoke it when you want." },
  { key: "scheduled_task", icon: "⏰", label: "Scheduled Task", blurb: "A recurring job that runs on your own agent on a schedule until you remove it." },
  { key: "skill", icon: "📜", label: "Skill", blurb: "A SKILL.md your agent can run. Paste the skill content; full bundle upload comes later." },
];

// Best-effort human-readable cron (common shapes only; falls back gracefully).
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function describeCron(cron: string): { ok: boolean; text: string } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, text: "A cron schedule has 5 fields: minute hour day-of-month month day-of-week (e.g. 0 9 * * 1)." };
  const [min, hr, dom, mon, dow] = parts;
  const tok = /^(\*|(\d+)(-\d+)?(\/\d+)?(,\d+)*)$/;
  if (![min, hr, dom, mon, dow].every((p) => tok.test(p))) return { ok: false, text: "That doesn't look like a valid cron expression." };
  const time = (/^\d+$/.test(min) && /^\d+$/.test(hr)) ? (() => { const h = +hr, m = +min; const ap = h < 12 ? "am" : "pm"; const h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}:${String(m).padStart(2, "0")}${ap}`; })() : null;
  let when = "";
  if (dow !== "*" && /^\d+$/.test(dow)) when = `every ${DOW[+dow % 7]}`;
  else if (dom !== "*" && /^\d+$/.test(dom)) when = `on day ${dom} of each month`;
  else when = "every day";
  return { ok: true, text: time ? `Runs ${when} at ${time}.` : `Runs ${when} (schedule: ${cron}).` };
}

const sLabel: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, margin: "12px 0 4px" };
const sInput: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border, #ccc)", font: "inherit", background: "var(--bg, #fff)", color: "inherit" };
const sMono: React.CSSProperties = { ...sInput, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 };
const sHint: React.CSSProperties = { fontSize: 12, color: "#888", marginTop: 4 };
const sBtn: React.CSSProperties = { font: "inherit", fontWeight: 600, padding: "9px 16px", borderRadius: 8, border: 0, background: "#4351e8", color: "#fff", cursor: "pointer" };
const sBtnGhost: React.CSSProperties = { ...sBtn, background: "transparent", color: "inherit", border: "1px solid var(--border,#ccc)" };

export function ArtifactEditor({ mode, initial, onClose, onSaved }: { mode: "create" | "edit"; initial?: EditorArtifact; onClose: () => void; onSaved: (msg: string) => void }) {
  const initType = (initial?.type as ArtType) || "prompt";
  const m = (initial?.manifest ?? {}) as Record<string, unknown>;
  const [type, setType] = useState<ArtType | null>(mode === "edit" ? initType : null);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [tags, setTags] = useState(Array.isArray(m.tags) ? (m.tags as string[]).join(", ") : "");
  const [invocation, setInvocation] = useState(typeof m.suggested_invocation === "string" ? m.suggested_invocation : "");
  const [cron, setCron] = useState(typeof m.cron === "string" ? m.cron : "0 9 * * 1");
  const runTarget = typeof m.run_target === "string" ? m.run_target : "self"; // runs on the user's own agent
  const [shareAllowed, setShareAllowed] = useState(m.public_share_allowed === true);
  const [bundleUrl, setBundleUrl] = useState(typeof m.bundle_url === "string" ? m.bundle_url : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const cronDesc = type === "scheduled_task" ? describeCron(cron) : { ok: true, text: "" };

  const save = async () => {
    setErr("");
    if (!name.trim()) return setErr("Give it a name.");
    if (!body.trim()) return setErr(type === "scheduled_task" ? "Describe what the task should do." : type === "skill" ? "Paste the SKILL.md content." : "Write the prompt.");
    if (type === "scheduled_task" && !cronDesc.ok) return setErr(cronDesc.text);

    let manifest: Record<string, unknown>;
    if (type === "prompt") manifest = { type: "prompt", title: name.trim(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean), suggested_invocation: invocation.trim() || undefined };
    else if (type === "scheduled_task") manifest = { type: "scheduled_task", cron: cron.trim(), prompt: body.trim(), run_target: runTarget, public_share_allowed: shareAllowed };
    else manifest = { type: "skill", kind: "template", bundle_url: bundleUrl.trim() || undefined };

    setBusy(true);
    try {
      const payload = mode === "create"
        ? { type, name: name.trim(), description: description.trim() || undefined, body: body.trim(), manifest, kind: type === "skill" ? "template" : undefined }
        : { name: name.trim(), description: description.trim(), body: body.trim(), manifest };
      const r = await fetch(mode === "create" ? "/api/skills" : `/api/skills/${initial!.id}`, {
        method: mode === "create" ? "POST" : "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setBusy(false); return setErr(j.message || `Couldn't save (${j.error || r.status}).`); }
      setBusy(false);
      onSaved(mode === "create" ? `Added “${name.trim()}” to your library.` : `Saved “${name.trim()}”.${j.public_revoked ? " Its public link was cleared — re-share once your agent re-signs it." : ""}`);
    } catch {
      setBusy(false); setErr("Network error — try again.");
    }
  };

  const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 1000, overflowY: "auto" };
  const panel: React.CSSProperties = { width: "100%", maxWidth: 560, background: "var(--card-bg, #fff)", color: "inherit", borderRadius: 14, padding: "22px 24px", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{mode === "edit" ? "Edit artifact" : "New artifact"}</h2>
          <button onClick={onClose} aria-label="Close" style={{ ...sBtnGhost, padding: "4px 10px" }}>✕</button>
        </div>

        {/* Type picker (create only) */}
        {!type ? (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: "#888", fontSize: 14 }}>What do you want to add?</p>
            {TYPES.map((t) => (
              <button key={t.key} onClick={() => { setType(t.key); if (t.key === "scheduled_task") setBody(""); }}
                style={{ display: "block", width: "100%", textAlign: "left", margin: "8px 0", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border,#ddd)", background: "transparent", color: "inherit", cursor: "pointer" }}>
                <div style={{ fontWeight: 700 }}>{t.icon} {t.label}</div>
                <div style={{ fontSize: 13, color: "#888", marginTop: 2 }}>{t.blurb}</div>
              </button>
            ))}
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 13, color: "#888", margin: "10px 0 2px" }}>{TYPES.find((t) => t.key === type)?.icon} {TYPES.find((t) => t.key === type)?.label}{mode === "create" && <button onClick={() => setType(null)} style={{ ...sBtnGhost, padding: "2px 8px", marginLeft: 8, fontSize: 12 }}>change</button>}</div>

            <label style={sLabel}>{type === "scheduled_task" ? "Task name" : "Title"}</label>
            <input style={sInput} value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "prompt" ? "Polite rewrite" : type === "scheduled_task" ? "Morning inbox digest" : "My skill"} />

            <label style={sLabel}>Description <span style={{ fontWeight: 400, color: "#aaa" }}>(optional)</span></label>
            <input style={sInput} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line on what it's for" />

            {type === "scheduled_task" && (<>
              <label style={sLabel}>Schedule (cron)</label>
              <input style={sMono} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1" />
              <div style={{ ...sHint, color: cronDesc.ok ? "#3a8a3a" : "#c0392b" }}>{cronDesc.ok ? "🗓 " : "⚠ "}{cronDesc.text}</div>
            </>)}

            <label style={sLabel}>{type === "skill" ? "SKILL.md content" : type === "scheduled_task" ? "What should it do? (the prompt that runs)" : "Prompt"}</label>
            <textarea style={{ ...sMono, minHeight: type === "skill" ? 220 : 130, resize: "vertical" }} value={body} onChange={(e) => setBody(e.target.value)}
              placeholder={type === "skill" ? "---\nname: my-skill\n---\n\n# My skill\n..." : type === "scheduled_task" ? "Summarize my unread email and surface anything urgent." : "Rewrite the following text to be warm and concise:"} />

            {type === "prompt" && (<>
              <label style={sLabel}>Tags <span style={{ fontWeight: 400, color: "#aaa" }}>(comma-separated, optional)</span></label>
              <input style={sInput} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="writing, email" />
              <label style={sLabel}>When to use it <span style={{ fontWeight: 400, color: "#aaa" }}>(optional)</span></label>
              <input style={sInput} value={invocation} onChange={(e) => setInvocation(e.target.value)} placeholder="When I ask you to make something more polite" />
            </>)}

            {type === "scheduled_task" && (
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14, fontSize: 13 }}>
                <input type="checkbox" checked={shareAllowed} onChange={(e) => setShareAllowed(e.target.checked)} style={{ marginTop: 3 }} />
                <span>Allow public sharing of this scheduled task. <span style={{ color: "#888" }}>Off by default — a public link would install this recurring job on a stranger's agent, so it's opt-in.</span></span>
              </label>
            )}

            {type === "skill" && (<>
              <label style={sLabel}>Full bundle URL <span style={{ fontWeight: 400, color: "#aaa" }}>(optional)</span></label>
              <input style={sInput} value={bundleUrl} onChange={(e) => setBundleUrl(e.target.value)} placeholder="https://… where the full skill bundle can be fetched" />
              <div style={sHint}>Inline SKILL.md is enough for most skills. Use this if the skill needs extra files.</div>
            </>)}

            {err && <div style={{ marginTop: 14, padding: "9px 12px", borderRadius: 8, background: "rgba(192,57,43,0.1)", color: "#c0392b", fontSize: 13 }}>{err}</div>}

            <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end" }}>
              <button style={sBtnGhost} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={{ ...sBtn, opacity: busy ? 0.6 : 1 }} onClick={save} disabled={busy}>{busy ? "Saving…" : mode === "edit" ? "Save changes" : "Add to library"}</button>
            </div>
            <p style={{ ...sHint, marginTop: 12 }}>Saved to your library. To share it with a <em>public</em> link, your agent signs it first — you&apos;ll see that option once it has.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Read-only inspector for a library artifact. */
export function ArtifactInspector({ artifact, onClose }: { artifact: EditorArtifact; onClose: () => void }) {
  const m = (artifact.manifest ?? {}) as Record<string, unknown>;
  const type = artifact.type || "skill";
  const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", zIndex: 1000, overflowY: "auto" };
  const panel: React.CSSProperties = { width: "100%", maxWidth: 560, background: "var(--card-bg, #fff)", color: "inherit", borderRadius: 14, padding: "22px 24px", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" };
  const pre: React.CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word", background: "rgba(0,0,0,0.05)", padding: 12, borderRadius: 8, fontSize: 13, fontFamily: "ui-monospace, monospace", maxHeight: 320, overflowY: "auto" };
  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{artifact.name}</h2>
          <button onClick={onClose} aria-label="Close" style={{ ...sBtnGhost, padding: "4px 10px" }}>✕</button>
        </div>
        <div style={{ fontSize: 13, color: "#888", marginTop: 4 }}>{type === "scheduled_task" ? "⏰ Scheduled Task" : type === "prompt" ? "💬 Prompt" : "📜 Skill"}</div>
        {artifact.description && <p style={{ marginTop: 10 }}>{artifact.description}</p>}
        {type === "scheduled_task" && typeof m.cron === "string" && <p style={{ fontSize: 13 }}><strong>Schedule:</strong> <code>{m.cron}</code> — {describeCron(m.cron).text}</p>}
        {type === "prompt" && Array.isArray(m.tags) && (m.tags as string[]).length > 0 && <p style={{ fontSize: 13 }}><strong>Tags:</strong> {(m.tags as string[]).join(", ")}</p>}
        <label style={{ ...sLabel, marginTop: 14 }}>{type === "skill" ? "SKILL.md" : type === "scheduled_task" ? "What it runs" : "Prompt"}</label>
        <div style={pre}>{artifact.body || "(empty)"}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}><button style={sBtnGhost} onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
