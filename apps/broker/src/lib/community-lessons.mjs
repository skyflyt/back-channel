/**
 * Schema validator for community/lessons.json — the PR-curated external
 * lessons list. Zero-dependency (matches rate-limit.mjs / inbox-bus.mjs):
 * no schema library, just explicit checks so a malformed PR fails CI with a
 * readable error instead of a runtime crash on the /lessons page.
 *
 * Kept framework-agnostic (plain .mjs) so it can be imported both by the
 * Node test runner (community-lessons.test.mjs) and, if ever needed, by a
 * standalone `node scripts/check-community-lessons.mjs` invocation.
 */

const ALLOWED_SOURCES = new Set(["github", "backchannel", "web"]);
const REQUIRED_FIELDS = ["title", "url", "source", "description", "submitted_by", "added"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one lesson entry. Returns an array of human-readable problem
 * strings; empty array means the entry is valid.
 * @param {unknown} entry
 * @param {number} index
 * @returns {string[]}
 */
export function validateLessonEntry(entry, index) {
  const problems = [];
  const where = `entry[${index}]`;

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return [`${where}: must be an object`];
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in entry)) {
      problems.push(`${where}: missing required field "${field}"`);
    }
  }

  const e = /** @type {Record<string, unknown>} */ (entry);

  for (const field of ["title", "url", "source", "description", "submitted_by", "added"]) {
    if (field in e && typeof e[field] !== "string") {
      problems.push(`${where}.${field}: must be a string`);
    }
  }

  if (typeof e.title === "string" && e.title.trim().length === 0) {
    problems.push(`${where}.title: must not be empty`);
  }

  if (typeof e.description === "string" && e.description.trim().length === 0) {
    problems.push(`${where}.description: must not be empty`);
  }

  if (typeof e.url === "string") {
    let parsed;
    try {
      parsed = new URL(e.url);
    } catch {
      problems.push(`${where}.url: "${e.url}" is not a valid URL`);
    }
    if (parsed && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      problems.push(`${where}.url: scheme "${parsed.protocol}" not allowed — http(s) only`);
    }
  }

  if (typeof e.source === "string" && !ALLOWED_SOURCES.has(e.source)) {
    problems.push(`${where}.source: "${e.source}" must be one of ${[...ALLOWED_SOURCES].join(", ")}`);
  }

  if (typeof e.submitted_by === "string" && e.submitted_by.trim().length === 0) {
    problems.push(`${where}.submitted_by: must not be empty`);
  }

  if (typeof e.added === "string" && !DATE_RE.test(e.added)) {
    problems.push(`${where}.added: "${e.added}" must be YYYY-MM-DD`);
  }

  return problems;
}

/**
 * Validate the whole lessons.json document (must be an array of entries).
 * Returns an array of human-readable problem strings; empty array means the
 * whole document is valid.
 * @param {unknown} doc
 * @returns {string[]}
 */
export function validateLessonsDocument(doc) {
  if (!Array.isArray(doc)) {
    return ["lessons.json: top level must be an array"];
  }
  return doc.flatMap((entry, i) => validateLessonEntry(entry, i));
}