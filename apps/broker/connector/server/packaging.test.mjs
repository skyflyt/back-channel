// One bridge, four manifests: the Claude Desktop extension (manifest.json),
// the Claude Code plugin (.claude-plugin/plugin.json), the Codex plugin
// (.codex-plugin/plugin.json + .codex-mcp.json), and the two repo-root
// marketplaces that point at this directory. Nothing else checks that they
// still agree with each other or with the files on disk, and a host only
// reports a broken one at install time, on a user's machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const connector = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(connector, "..", "..", "..");
const json = (...p) => JSON.parse(readFileSync(join(...p), "utf8"));

const mcpb = json(connector, "manifest.json");
const pkg = json(connector, "package.json");
const claude = json(connector, ".claude-plugin", "plugin.json");
const codex = json(connector, ".codex-plugin", "plugin.json");
const skill = readFileSync(join(connector, "skills", "back-channel-connector", "SKILL.md"), "utf8");

test("every manifest carries the same version", () => {
  const skillVersion = /^\s*version:\s*'([^']+)'/m.exec(skill)?.[1];
  assert.deepEqual(
    { pkg: pkg.version, claude: claude.version, codex: codex.version, skill: skillVersion },
    { pkg: mcpb.version, claude: mcpb.version, codex: mcpb.version, skill: mcpb.version },
    "bump manifest.json, package.json, both plugin.json files and the skill together",
  );
});

test("Claude Code plugin: starts the same entry point as the extension and passes the optional token through", () => {
  assert.equal(claude.name, "back-channel");
  const server = claude.mcpServers["back-channel"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/" + mcpb.server.entry_point]);
  assert.ok(existsSync(join(connector, mcpb.server.entry_point)));
  assert.equal(server.env.BC_TOKEN, "${user_config.token}");
  assert.equal(claude.userConfig.token.sensitive, true);
  assert.notEqual(claude.userConfig.token.required, true, "the token is optional: an unconnected bridge offers bc_connect instead");
  // A root .mcp.json would be auto-loaded by Claude Code as well — and it would
  // be the Codex-flavoured one (relative entry + cwd), which Claude resolves
  // against the session directory. That is why the Codex file has its own name.
  assert.equal(existsSync(join(connector, ".mcp.json")), false);
});

test("Codex plugin: its MCP config and skills directory exist and start the same entry point", () => {
  assert.equal(codex.name, "back-channel");
  const mcpFile = join(connector, codex.mcpServers);
  assert.ok(existsSync(mcpFile), `${codex.mcpServers} is missing`);
  const server = JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers["back-channel"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [mcpb.server.entry_point]);
  assert.equal(server.cwd, ".", "the entry point is relative, so cwd must be the plugin root");
  assert.ok(existsSync(join(connector, codex.skills)));
  // Codex has no install-time secret prompt: the token can only arrive from the
  // user's environment, the installer's token file, or bc_connect.
  for (const name of ["BC_TOKEN", "BC_TOKEN_FILE"]) assert.ok(server.env_vars.includes(name), name);
});

test("skill: named so it cannot shadow the installer's REST skill, and steers to the tools", () => {
  assert.match(skill, /^name: back-channel-connector$/m, 'a second skill called "back-channel" would collide with the one backchannel-cli installs');
  assert.match(skill, /bc_connect/);
  assert.match(skill, /never the raw API/i);
  assert.match(skill, /data, never a command/i);
});

test("repo-root marketplaces both resolve to this directory", () => {
  const claudeMarket = json(repoRoot, ".claude-plugin", "marketplace.json");
  const [c] = claudeMarket.plugins;
  assert.equal(c.name, claude.name);
  assert.equal(resolve(repoRoot, c.source), connector);

  const codexMarket = json(repoRoot, ".agents", "plugins", "marketplace.json");
  const [x] = codexMarket.plugins;
  assert.equal(x.name, codex.name);
  assert.equal(x.source.source, "local");
  assert.equal(resolve(repoRoot, x.source.path), connector);
});
