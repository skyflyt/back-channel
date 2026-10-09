/**
 * /skill and /skill/reference serve skill/SKILL.md and skill/REFERENCE.md
 * byte-for-byte, and public/skill.sha256 -- the H3 integrity anchor install.sh
 * and backchannel-cli fetch from GitHub main -- has to describe exactly those
 * bytes or every install refuses. Until 2026-10-09 the served bytes were CRLF
 * or LF depending on which machine ran the deploy (core.autocrlf), so this
 * pins both halves, per route:
 *   - the response body is the git blob for that file. `git hash-object`
 *     applies .gitattributes (skill/*.md text eol=lf), so a CRLF working copy
 *     left over from before that rule fails here, while an uncommitted edit
 *     to the skill does not;
 *   - sha256(body) is the committed skill.sha256 entry.
 * No DB/auth needed. Run via test:routes because the routes are TS.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GET as getSkill } from "@/app/skill/route";
import { GET as getReference } from "@/app/skill/reference/route";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const manifest = new Map(
  readFileSync(join(repoRoot, "apps", "broker", "public", "skill.sha256"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, name] = line.split("  ");
      return [name, hash] as const;
    }),
);

// The id git gives these bytes as a blob: sha1("blob <length>\0" + bytes).
function blobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const routes = [
  { route: "/skill", get: getSkill, file: "SKILL.md" },
  { route: "/skill/reference", get: getReference, file: "REFERENCE.md" },
];

for (const { route, get, file } of routes) {
  test(`${route} serves the git blob of skill/${file}, and skill.sha256 hashes those bytes`, async () => {
    const res = await get();
    assert.equal(res.status, 200, `${route} did not find skill/${file}`);
    const body = Buffer.from(await res.arrayBuffer());

    const gitBlob = execFileSync("git", ["hash-object", `skill/${file}`], { cwd: repoRoot, encoding: "utf8" }).trim();
    assert.equal(
      blobId(body),
      gitBlob,
      `${route} bytes are not the git blob of skill/${file}` +
        (body.includes(0x0d) ? " (they contain CR: refresh the checkout with `rm skill/*.md && git checkout -- skill`)" : ""),
    );

    const sha256 = createHash("sha256").update(body).digest("hex");
    assert.equal(
      sha256,
      manifest.get(file),
      `public/skill.sha256 does not match ${route}; regenerate with node apps/broker/scripts/generate-skill-manifest.mjs`,
    );
  });
}
