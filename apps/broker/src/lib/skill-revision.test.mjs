// The skill revision lives in three places that must agree: SKILL.md's
// frontmatter (what /skill/revision serves), the revision the relay announces
// on connect and poll (relay.mjs), and the CHANGES map that tells agents what
// changed. relay.mjs once lagged SKILL.md by one; this keeps them together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), "utf8");

const skill = read("..", "..", "..", "..", "skill", "SKILL.md");
const revision = skill.match(/^revision:\s*(.+)$/m)?.[1]?.trim();
const version = skill.match(/^version:\s*(.+)$/m)?.[1]?.trim();

test("SKILL.md carries a revision and a version", () => {
  assert.match(revision ?? "", /^\d{4}-\d{2}-\d{2}-\d+$/);
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/);
});

test("the relay announces the same skill revision as SKILL.md", () => {
  const announced = read("relay.mjs").match(/const CURRENT_SKILL_REVISION = "([^"]+)"/)?.[1];
  assert.equal(announced, revision);
});

test("SKILL.md's freshness note names the current version and revision", () => {
  assert.ok(skill.includes(`\`version: ${version}\` (\`revision: ${revision}\`)`));
});

test("/skill/revision has a CHANGES entry for the current revision", () => {
  const route = read("..", "app", "skill", "revision", "route.ts");
  assert.ok(route.includes(`"${revision}": [`), `CHANGES has no entry for ${revision}`);
});
