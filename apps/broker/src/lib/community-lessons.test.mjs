/**
 * Schema-validation test for community/lessons.json (WS-B, Link Lessons
 * epic). Two things this test proves:
 *
 *  1. The REAL file at community/lessons.json (repo root) is valid today —
 *     if a PR edits it into a bad shape, this test fails and CI goes red.
 *  2. The validator actually catches bad shapes — proven against fixture
 *     files in __fixtures__/, never by breaking the real lessons.json.
 *
 * Zero-dependency, mirrors rate-limit.test.mjs / inbox-bus.test.mjs. Run
 * from apps/broker with: node --test src/lib/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateLessonsDocument, validateLessonEntry } from "./community-lessons.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../../../"); // src/lib -> broker -> apps -> repo root
const REAL_LESSONS_PATH = path.join(REPO_ROOT, "community", "lessons.json");
const FIXTURES_DIR = path.join(here, "__fixtures__");

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

test("community/lessons.json (the real file) is valid", () => {
  const doc = loadJson(REAL_LESSONS_PATH);
  const problems = validateLessonsDocument(doc);
  assert.deepEqual(problems, [], `lessons.json has schema problems:\n${problems.join("\n")}`);
});

test("community/lessons.json (the real file) has 3-5 seed entries", () => {
  const doc = loadJson(REAL_LESSONS_PATH);
  assert.ok(Array.isArray(doc), "must be an array");
  assert.ok(doc.length >= 3 && doc.length <= 5, `expected 3-5 seed entries, got ${doc.length}`);
});

test("every real entry has a unique, non-empty url", () => {
  const doc = loadJson(REAL_LESSONS_PATH);
  const urls = doc.map((e) => e.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate url in lessons.json");
});

test("fixture: non-array top level is rejected", () => {
  const doc = loadJson(path.join(FIXTURES_DIR, "lessons.not-an-array.json"));
  const problems = validateLessonsDocument(doc);
  assert.ok(problems.length > 0, "expected validation problems for a non-array document");
  assert.match(problems[0], /must be an array/);
});

test("fixture: malformed entries are rejected with specific reasons", () => {
  const doc = loadJson(path.join(FIXTURES_DIR, "lessons.malformed.json"));
  const problems = validateLessonsDocument(doc);
  assert.ok(problems.length > 0, "expected validation problems for the malformed fixture");

  // entry 0: missing description/submitted_by, javascript: scheme, bad source, bad date
  assert.ok(problems.some((p) => p.includes('missing required field "description"')));
  assert.ok(problems.some((p) => p.includes('missing required field "submitted_by"')));
  assert.ok(problems.some((p) => p.includes("not a valid URL") || p.includes("scheme")));
  assert.ok(problems.some((p) => p.includes('must be one of')));
  assert.ok(problems.some((p) => p.includes("must be YYYY-MM-DD")));

  // entry 1: empty title
  assert.ok(problems.some((p) => p.includes("entry[1].title") && p.includes("must not be empty")));
});

test("validateLessonEntry: rejects data: and file: URL schemes", () => {
  const base = {
    title: "x",
    source: "web",
    description: "x",
    submitted_by: "x",
    added: "2026-01-01",
  };
  const dataUrl = validateLessonEntry({ ...base, url: "data:text/html,evil" }, 0);
  const fileUrl = validateLessonEntry({ ...base, url: "file:///etc/passwd" }, 0);
  assert.ok(dataUrl.some((p) => p.includes("scheme")));
  assert.ok(fileUrl.some((p) => p.includes("scheme")));
});

test("validateLessonEntry: accepts a well-formed entry", () => {
  const problems = validateLessonEntry(
    {
      title: "Example",
      url: "https://github.com/example/example",
      source: "github",
      description: "An example lesson.",
      submitted_by: "octocat",
      added: "2026-07-03",
    },
    0,
  );
  assert.deepEqual(problems, []);
});