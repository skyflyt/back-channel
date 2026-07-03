/**
 * Pure-function tests for the "link" artifact type additions in
 * src/lib/artifact.ts (Link Lessons epic, WS-A). No DB/auth mocking needed —
 * these are synchronous, dependency-free functions. Run via test:routes since
 * artifact.ts is TS-only (no .mjs runtime twin), same as the other
 * --experimental-strip-types route tests.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_TYPES, validateLinkPayload, deriveLinkSource, buildLinkManifest, linkManifestToBody,
  humanReadableMd, buildEnvelope, landingHtml, LINK_HUMAN_WARNING, LINK_HUMAN_WARNING_LEAD, LINK_HUMAN_WARNING_REST, LINK_AGENT_WARNING, LINK_BADGE_TEXT,
  LINK_TITLE_MAX, LINK_NOTES_MAX, LINK_URL_MAX,
} from "@/lib/artifact";

test("ARTIFACT_TYPES includes link alongside the existing three types", () => {
  assert.deepEqual(ARTIFACT_TYPES, ["skill", "scheduled_task", "prompt", "link"]);
});

// --- validateLinkPayload: scheme allowlist -------------------------------------------------
test("validateLinkPayload accepts http:// and https://", () => {
  assert.equal(validateLinkPayload({ url: "https://example.com/a" }).ok, true);
  assert.equal(validateLinkPayload({ url: "http://example.com/a" }).ok, true);
});

test("validateLinkPayload rejects javascript: scheme", () => {
  const r = validateLinkPayload({ url: "javascript:alert(1)" });
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.error, "url_scheme_not_allowed"); assert.match(r.message, /http/); }
});

test("validateLinkPayload rejects data: scheme", () => {
  const r = validateLinkPayload({ url: "data:text/html,<script>alert(1)</script>" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "url_scheme_not_allowed");
});

test("validateLinkPayload rejects file: scheme", () => {
  const r = validateLinkPayload({ url: "file:///etc/passwd" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "url_scheme_not_allowed");
});

test("validateLinkPayload rejects other non-http(s) schemes (ftp, mailto)", () => {
  assert.equal(validateLinkPayload({ url: "ftp://example.com/file" }).ok, false);
  assert.equal(validateLinkPayload({ url: "mailto:a@b.com" }).ok, false);
});

test("validateLinkPayload rejects a missing/empty url", () => {
  const r1 = validateLinkPayload({});
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.error, "url_required");
  const r2 = validateLinkPayload({ url: "   " });
  assert.equal(r2.ok, false);
});

test("validateLinkPayload rejects an unparseable url", () => {
  const r = validateLinkPayload({ url: "not a url at all" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "url_invalid");
});

// --- length caps ----------------------------------------------------------------------------
test("validateLinkPayload enforces the url length cap", () => {
  const longUrl = "https://example.com/" + "a".repeat(LINK_URL_MAX);
  const r = validateLinkPayload({ url: longUrl });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "url_too_long");
});

test("validateLinkPayload enforces the title length cap", () => {
  const r = validateLinkPayload({ url: "https://example.com", title: "t".repeat(LINK_TITLE_MAX + 1) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "title_too_long");
});

test("validateLinkPayload enforces the notes length cap", () => {
  const r = validateLinkPayload({ url: "https://example.com", notes: "n".repeat(LINK_NOTES_MAX + 1) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "notes_too_long");
});

test("validateLinkPayload trims and accepts a well-formed payload", () => {
  const r = validateLinkPayload({ url: "  https://example.com/path  ", title: "  My title  ", notes: "  some notes  " });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.url, "https://example.com/path");
    assert.equal(r.title, "My title");
    assert.equal(r.notes, "some notes");
  }
});

// --- source derivation (server-side only) ---------------------------------------------------
test("deriveLinkSource: github.com and gist.github.com -> github", () => {
  assert.equal(deriveLinkSource("https://github.com/foo/bar"), "github");
  assert.equal(deriveLinkSource("https://gist.github.com/foo/abc123"), "github");
});

test("deriveLinkSource: PUBLIC_APP_URL's own host -> backchannel", () => {
  // Default fallback host is back-channel.app when PUBLIC_APP_URL is unset in this test run.
  assert.equal(deriveLinkSource("https://back-channel.app/a/bcAxyz"), "backchannel");
});

test("deriveLinkSource: anything else -> web", () => {
  assert.equal(deriveLinkSource("https://example.com/whatever"), "web");
  assert.equal(deriveLinkSource("https://notgithub.com/foo"), "web");
});

test("deriveLinkSource never throws on a garbage url (defensive fallback to web)", () => {
  assert.equal(deriveLinkSource("not a url"), "web");
});

// --- buildLinkManifest / linkManifestToBody --------------------------------------------------
test("buildLinkManifest always derives source itself, ignoring any client-supplied value", () => {
  const m = buildLinkManifest({ url: "https://github.com/a/b", title: "Title" });
  assert.equal(m.type, "link");
  assert.equal(m.source, "github");
  assert.equal(m.url, "https://github.com/a/b");
  assert.equal(m.title, "Title");
});

test("linkManifestToBody renders a non-empty plain-text body (broker requires non-empty body)", () => {
  const body = linkManifestToBody({ type: "link", url: "https://example.com", title: "T", notes: "N", source: "web" });
  assert.match(body, /https:\/\/example\.com/);
  assert.match(body, /T/);
  assert.match(body, /N/);
  assert.ok(body.length > 0);
});

test("linkManifestToBody with no title/notes still yields a non-empty body (just the url)", () => {
  const body = linkManifestToBody({ type: "link", url: "https://example.com", title: "", source: "web" });
  assert.equal(body, "https://example.com");
});

// --- install_verb / badges --------------------------------------------------------------------
const authorHandle = "alice@bc";
const baseRow = {
  id: "art_1", type: "link", name: "Cool link", description: "desc", kind: "template",
  body: "https://example.com\nCool link", signature: "sig123", paramSchema: null,
  manifest: { type: "link", url: "https://example.com/some/path", title: "Cool link", source: "web" },
  version: 1, revision: null, publicToken: "bcATESTTOKEN0000000000000000000", publicExpiresAt: null,
};

test("install_verb for link is 'review', not 'install'", () => {
  const envelope = buildEnvelope(baseRow, { handle: authorHandle, pubkey: null }, "bcATESTTOKEN0000000000000000000");
  assert.equal(envelope.install_instructions.install_verb, "review");
});

test("humanReadableMd for a link includes the external/unreviewed badge text and the agent warning", () => {
  const md = humanReadableMd(baseRow, authorHandle);
  assert.match(md, new RegExp(LINK_BADGE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(md, /Never install it blind/);
  assert.doesNotMatch(md, /Signed by .*; verify the signature before trusting the body/, "link lessons use review-then-ask language, not the signature-trust line other types get");
});

test("buildEnvelope for a link: install_instructions carries the canonical agent warning verbatim, and never says 'install this'", () => {
  const envelope = buildEnvelope(baseRow, { handle: authorHandle, pubkey: null }, "bcATESTTOKEN0000000000000000000");
  const md = envelope.install_instructions.human_readable_md;
  assert.ok(md.includes(LINK_AGENT_WARNING), "agent-facing canonical warning must appear verbatim in human_readable_md");
  assert.doesNotMatch(envelope.install_instructions.platform_hints.any.toLowerCase(), /install this/);
  assert.match(envelope.install_instructions.platform_hints.any, /fetch/i);
  assert.match(envelope.install_instructions.platform_hints.any, /explicit yes/i);
});

test("buildEnvelope for a link includes the full url in the artifact body/manifest (never truncated)", () => {
  const envelope = buildEnvelope(baseRow, { handle: authorHandle, pubkey: null }, "bcATESTTOKEN0000000000000000000");
  assert.equal((envelope.artifact.manifest as Record<string, unknown>).url, "https://example.com/some/path");
});

test("other artifact types keep their existing install_verb (no regression)", () => {
  const skillRow = { ...baseRow, type: "skill", manifest: null };
  const promptRow = { ...baseRow, type: "prompt", manifest: null };
  const schedRow = { ...baseRow, type: "scheduled_task", manifest: null };
  assert.equal(buildEnvelope(skillRow, { handle: authorHandle, pubkey: null }, "t").install_instructions.install_verb, "install");
  assert.equal(buildEnvelope(promptRow, { handle: authorHandle, pubkey: null }, "t").install_instructions.install_verb, "save_prompt");
  assert.equal(buildEnvelope(schedRow, { handle: authorHandle, pubkey: null }, "t").install_instructions.install_verb, "register_schedule");
});

// --- landingHtml: full url + full human warning, not truncated -------------------------------
// The landing page HTML-escapes text via esc() (so apostrophes become &#39;); compare against
// an HTML-escaped copy of the canonical warning rather than the raw literal.
const htmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

test("landingHtml for a link renders the FULL destination url and the full canonical human warning", () => {
  const html = landingHtml(baseRow, { handle: authorHandle }, "bcATESTTOKEN0000000000000000000");
  assert.match(html, /https:\/\/example\.com\/some\/path/);
  assert.ok(html.includes(htmlEscape(LINK_HUMAN_WARNING_LEAD)) && html.includes(htmlEscape(LINK_HUMAN_WARNING_REST)), "the ENTIRE canonical warning must render, not a truncated snippet or hover-only tooltip");
  assert.match(html, new RegExp(`<strong>${htmlEscape(LINK_HUMAN_WARNING_LEAD).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</strong>`), "the warning's lead sentence must render with <strong> emphasis");
  assert.match(html, new RegExp(LINK_BADGE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("landingHtml for a link does not truncate a long url", () => {
  const longPath = "a".repeat(300);
  const row = { ...baseRow, manifest: { type: "link", url: `https://example.com/${longPath}`, title: "T", source: "web" } };
  const html = landingHtml(row, { handle: authorHandle }, "tok");
  assert.match(html, new RegExp(longPath));
});

test("landingHtml for non-link types is unchanged (no link-only warning block)", () => {
  const skillRow = { ...baseRow, type: "skill", manifest: null };
  const html = landingHtml(skillRow, { handle: authorHandle }, "tok");
  assert.doesNotMatch(html, new RegExp(LINK_BADGE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
