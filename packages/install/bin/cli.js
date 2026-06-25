#!/usr/bin/env node
// Back Channel installer — npm CLI (backchannel-cli)
// ---------------------------------------------------------------------------
// Behavior-identical to apps/broker/public/install.sh: installs the Back Channel
// agent skill into your Claude Code skills folder so it persists across
// conversations, and can optionally connect this agent with a one-time code.
//
// It contacts exactly one host (https://back-channel.app). No sudo, no shell-rc
// edits, no PATH/crontab changes, no telemetry, no second host, no baked creds.
// Zero runtime dependencies (Node stdlib only).
//
// Source (audit it): https://github.com/skyflyt/back-channel
//   -> packages/install/bin/cli.js
// License: MIT, by Skylar Pearce (@skyflyt)
//
// Usage:
//   npx -y backchannel-cli
//   npx -y backchannel-cli --pair BCX-XXXX-XXXX
// ---------------------------------------------------------------------------
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CANONICAL_HOST = "https://back-channel.app";
const PROG = "bc-install";
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp("^BCX-[" + CODE_CHARS + "]{4}-[" + CODE_CHARS + "]{4}$");

// ── Node version gate (fail clean, point at the curl path) ──────────────────
const major = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(major) || major < 20) {
  process.stderr.write(
    PROG + ": needs Node >= 20 (found " + process.versions.node + "). " +
      "Use the shell installer instead:\n  curl -fsSL " + CANONICAL_HOST + "/install.sh | sh\n",
  );
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  const log = (...a) => { if (!opts.quiet) process.stdout.write(a.join(" ") + "\n"); };
  const warn = (m) => process.stderr.write(PROG + ": " + m + "\n");
  const die = (m) => { warn(m); process.exit(1); };

  // ── host pinning (M4 / §7) ───────────────────────────────────────────────
  const host = (opts.host || CANONICAL_HOST).replace(/\/+$/, "");
  if (!opts.allowHost && host !== CANONICAL_HOST) {
    die("refusing to use host '" + host + "' — expected " + CANONICAL_HOST + ". Pass --allow-host to override.");
  }
  if (!/^https:\/\//.test(host) && !opts.allowHost) {
    die("refusing non-https host '" + host + "'. Pass --allow-host to override.");
  }

  // ── resolve skills dir (§3) ──────────────────────────────────────────────
  const home = os.homedir();
  let skillsDir;
  if (opts.skillsDir) skillsDir = opts.skillsDir;
  else if (process.env.BC_SKILLS_DIR) skillsDir = process.env.BC_SKILLS_DIR;
  else if (process.env.CLAUDE_CONFIG_DIR) skillsDir = path.join(process.env.CLAUDE_CONFIG_DIR, "skills");
  else skillsDir = path.join(home, ".claude", "skills");
  const dest = path.join(skillsDir, "back-channel");

  run({ opts, host, home, skillsDir, dest, log, warn, die }).catch((e) => {
    die(e && e.message ? e.message : String(e));
  });
}

async function run(ctx) {
  const { opts, host, home, skillsDir, dest, log, warn, die } = ctx;

  // ── runtime enum (S1); server coerces unknowns to "other" ────────────────
  const RUNTIMES = ["cowork", "codex", "claude_code", "chatgpt", "other"];
  const runtime = RUNTIMES.includes(opts.runtime) ? opts.runtime : "other";

  // ── revision check (M3: equality = skip; any mismatch = server wins) ──────
  let localRev = "";
  const installJsonPath = path.join(dest, "install.json");
  if (fileReadable(installJsonPath)) {
    localRev = jsonStr(readFileSafe(installJsonPath), "revision");
  }
  if (!localRev && fileReadable(path.join(dest, "SKILL.md"))) {
    localRev = yamlField(readFileSafe(path.join(dest, "SKILL.md")), "revision");
  }

  let remoteRev = "";
  const revRes = await httpGet(host + "/skill/revision").catch(() => null);
  if (revRes && revRes.ok) remoteRev = jsonStr(revRes.body, "revision");

  const skipSkill = !opts.force && localRev && remoteRev && localRev === remoteRev;

  let installedRev = "";
  let installedVer = "";

  if (skipSkill) {
    log("Back Channel skill is already installed and up to date (revision " + localRev + ").");
    installedRev = localRev;
    if (fileReadable(path.join(dest, "SKILL.md"))) {
      installedVer = yamlField(readFileSafe(path.join(dest, "SKILL.md")), "version");
    }
  } else {
    // ── fetch + validate SKILL.md (M1) ─────────────────────────────────────
    const skillRes = await httpGet(host + "/skill").catch((e) => ({ ok: false, error: e }));
    if (!skillRes.ok) {
      die("could not fetch the skill from " + host + "/skill (the host may be down or mid-deploy). Nothing was written.");
    }
    // M1: a 200 can still be an error page (404 skill_not_bundled during a redeploy).
    if (!skillRes.body || !/^name:\s*back-channel/m.test(skillRes.body)) {
      die("the skill served by " + host + "/skill didn't look valid (no 'name: back-channel'). Nothing was written. Try again shortly.");
    }
    installedRev = yamlField(skillRes.body, "revision");
    installedVer = yamlField(skillRes.body, "version");

    // REFERENCE.md is best-effort — a hiccup here must not block the P0 install.
    let refBody = null;
    const refRes = await httpGet(host + "/skill/reference").catch(() => null);
    if (refRes && refRes.ok && refRes.body && !/Not bundled/.test(refRes.body.slice(0, 200))) {
      refBody = refRes.body;
    }

    // ── commit atomically (write temp, rename into place) ──────────────────
    fs.mkdirSync(dest, { recursive: true });
    atomicWrite(path.join(dest, "SKILL.md"), skillRes.body);
    if (refBody != null) {
      atomicWrite(path.join(dest, "REFERENCE.md"), refBody);
    } else {
      warn("could not fetch REFERENCE.md (non-fatal) — the skill points at " + host + "/skill/reference and will fetch it on demand.");
    }

    if (opts.force && localRev) log("Reinstalled Back Channel skill (revision " + installedRev + ").");
    else if (localRev) log("Upgraded Back Channel skill: " + localRev + " -> " + installedRev + ".");
    else log("Installed Back Channel skill (revision " + installedRev + ").");
  }

  // ── --pair: redeem connect code (M2, §5) ──────────────────────────────────
  let paired = false;
  let pairFailed = false;
  let pairHandle = "";
  let pairAgent = "";
  let pairAgentId = "";

  if (opts.pairRequested) {
    // M2: normalize then strictly validate BEFORE the code touches any request.
    const code = String(opts.pair).replace(/\s+/g, "").toUpperCase();
    if (!CODE_RE.test(code)) {
      die("that connect code doesn't look right (expected BCX-XXXX-XXXX). The skill is installed; grab a fresh code from " + host + "/account and re-run with --pair.");
    }

    const exRes = await httpPostJson(host + "/api/auth/exchange", { code: code, runtime_type: runtime }).catch(
      () => ({ status: 0, body: "" }),
    );
    const rbody = exRes.body || "";
    // The regex itself enforces the bc_ prefix + base64url-safe charset.
    const m = rbody.match(/"api_key"\s*:\s*"(bc_[A-Za-z0-9_-]+)"/);
    const apiKey = m ? m[1] : "";

    if (apiKey) {
      pairHandle = jsonStr(rbody, "handle");
      pairAgent = sanitize(jsonStr(rbody, "agent_name"));
      pairAgentId = jsonStr(rbody, "agent_id");
      const bcDir = path.join(home, ".bc");
      fs.mkdirSync(bcDir, { recursive: true });
      // printf '%s' semantics: no trailing newline; mode 0600.
      fs.writeFileSync(path.join(bcDir, "token"), apiKey, { mode: 0o600 });
      try { fs.chmodSync(path.join(bcDir, "token"), 0o600); } catch { /* best effort */ }
      paired = true;
    } else if (/invalid_or_expired_code/.test(rbody)) {
      warn("that connect code didn't work — it may be expired or already used (codes are single-use and last 15 minutes). Grab a fresh one from " + host + "/account and run the command again.");
      pairFailed = true;
    } else if (/rate_limited/.test(rbody)) {
      warn("too many connect attempts from this network right now — wait a bit, then re-run with a fresh code from " + host + "/account.");
      pairFailed = true;
    } else {
      warn("the skill is installed, but connecting failed (server said: " + (exRes.status || "no response") + "). Re-run with your code: --pair " + code);
      pairFailed = true;
    }
  }

  // ── install.json (metadata only — never a secret) ─────────────────────────
  fs.mkdirSync(dest, { recursive: true });
  const meta = {
    revision: installedRev,
    version: installedVer,
    installed_at: new Date().toISOString(),
    source: host,
    skills_dir: skillsDir,
  };
  if (paired) {
    meta.agent_id = pairAgentId;
    meta.handle = pairHandle;
  }
  fs.writeFileSync(installJsonPath, JSON.stringify(meta, null, 2) + "\n");

  // ── summary (failure transparency / §7) ───────────────────────────────────
  log("");
  log("Back Channel — done. Here is exactly what happened:");
  log("  - Skill folder : " + dest + "/");
  log("      - SKILL.md       (the agent skill)");
  if (fileReadable(path.join(dest, "REFERENCE.md"))) log("      - REFERENCE.md   (full API reference)");
  log("      - install.json   (metadata: revision/version/source - no secrets)");
  if (paired) {
    if (pairAgent) log("  - Connected as : " + pairHandle + " (this agent: " + pairAgent + ")");
    else log("  - Connected as : " + (pairHandle || "your account"));
    log("  - Token file   : " + path.join(home, ".bc", "token") + " (mode 0600 - never printed)");
  }
  log("  - Host contacted: " + host + "  (the only host this tool touches)");
  if (!paired && !pairFailed) {
    log("");
    log("To connect this agent, ask the user for a connect code (looks like BCX-XXXX-XXXX,");
    log("from " + host + "/account -> Connect a new agent), then run:");
    log("  npx -y backchannel-cli --pair BCX-XXXX-XXXX");
  }
  log("");
  log("Restarting your agent will pick the skill up if it isn't visible yet.");

  // Non-zero exit if a requested pairing failed, so the agent reports honestly.
  if (pairFailed) process.exit(3);
}

// ── helpers ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { force: false, quiet: false, allowHost: false, help: false, pairRequested: false, runtime: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) { process.stderr.write(PROG + ": " + a + " needs a value\n"); process.exit(1); } return v; };
    if (a === "--pair") { o.pair = val(); o.pairRequested = true; }
    else if (a.startsWith("--pair=")) { o.pair = a.slice(7); o.pairRequested = true; }
    else if (a === "--skills-dir") o.skillsDir = val();
    else if (a.startsWith("--skills-dir=")) o.skillsDir = a.slice(13);
    else if (a === "--runtime") o.runtime = val();
    else if (a.startsWith("--runtime=")) o.runtime = a.slice(10);
    else if (a === "--host") o.host = val();        // testing/advanced; pairs with --allow-host
    else if (a.startsWith("--host=")) o.host = a.slice(7);
    else if (a === "--force") o.force = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--allow-host") o.allowHost = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else { process.stderr.write(PROG + ": unknown option: " + a + " (try --help)\n"); process.exit(1); }
  }
  return o;
}

function printHelp() {
  process.stdout.write(
    [
      "backchannel-cli - install the Back Channel agent skill (persists across conversations).",
      "",
      "Usage:",
      "  npx -y backchannel-cli [--pair BCX-XXXX-XXXX] [options]",
      "",
      "Options:",
      "  --pair <code>        Redeem a BCX-XXXX-XXXX connect code after installing.",
      "  --skills-dir <path>  Install into <path>/back-channel instead of auto-detect.",
      "  --runtime <name>     Label this agent's token (cowork|codex|claude_code|chatgpt|other).",
      "  --force              Reinstall even if already up to date.",
      "  --quiet              Only print errors and the final summary.",
      "  --allow-host         Permit a non-canonical host (advanced / testing).",
      "  -h, --help           Show this help.",
      "",
      "It contacts exactly one host (https://back-channel.app) and writes only the skill",
      "folder (+ ~/.bc/token with --pair). Source: github.com/skyflyt/back-channel (MIT).",
      "",
    ].join("\n"),
  );
}

function fileReadable(p) { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } }
function readFileSafe(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }

function atomicWrite(target, content) {
  const tmp = target + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function jsonStr(s, key) {
  const m = String(s).match(new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"'));
  return m ? m[1] : "";
}
function yamlField(s, field) {
  const m = String(s).match(new RegExp("^" + field + ":\\s*(.*)$", "m"));
  return m ? m[1].trim() : "";
}
// Strip control chars for safe printing of free-text (S2 / agent_name).
function sanitize(s) { let o = ""; for (const ch of String(s)) { const c = ch.charCodeAt(0); if (c >= 32 && c !== 127) o += ch; } return o; }

async function httpGet(url) {
  const res = await fetch(url, { redirect: "follow" });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body };
}
async function httpPostJson(url, obj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body: body };
}

main();
