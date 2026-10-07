/**
 * The path src/proxy.ts sends everyone but the owner to when they ask for
 * /admin: a path with no route, so they get the app's ordinary 404.
 *
 * Next marks a rewritten response with headers naming where it was rewritten
 * to (its client router uses them). On this one rewrite those headers are the
 * only thing left that tells /admin apart from a URL that does not exist, so
 * the HTTP server (server.mjs) takes them off before the response leaves.
 * Only this rewrite is touched; any other keeps its markers.
 *
 * Plain .mjs because server.mjs runs outside the Next build.
 */

/** No route, and never one: the leading underscore keeps a folder of this name out of the app router. */
export const NO_SUCH_PAGE = "/_no-such-page";

const MARKERS = ["x-middleware-rewrite", "x-nextjs-rewrite", "x-nextjs-rewritten-path", "x-nextjs-rewritten-query"];
// The path as Next writes it: as is, or wrapped as a data request (/_next/data/<build>/_no-such-page.json).
const NOWHERE = /^(?:\/_next\/data\/[^/]+)?\/_no-such-page(?:\.json)?$/;
const isMarker = (name) => typeof name === "string" && MARKERS.includes(name.toLowerCase());

/** Does this header value (a path or a full URL) name the unrouted path? */
function pointsNowhere(value) {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return false;
  try {
    return NOWHERE.test(new URL(v, "http://localhost").pathname);
  } catch {
    return false;
  }
}

/**
 * Make `res` drop the rewrite markers if, when its head is written, they name
 * NO_SUCH_PAGE. Call once per response, before handing it to Next. Covers both
 * ways a header reaches the wire: setHeader() and the arguments of writeHead()
 * (Node calls writeHead itself when headers are sent implicitly).
 */
export function hideRefusalMarkers(res) {
  const writeHead = res.writeHead;
  res.writeHead = function (statusCode, ...rest) {
    const given = rest.length && typeof rest.at(-1) === "object" && rest.at(-1) !== null ? rest.at(-1) : null;
    // Header pairs passed to writeHead: an object, a flat [name, value, ...] list, or [[name, value], ...].
    const pairs = !given ? []
      : !Array.isArray(given) ? Object.entries(given)
      : Array.isArray(given[0]) ? given
      : given.flatMap((_, i) => (i % 2 ? [] : [[given[i], given[i + 1]]]));
    const refused = MARKERS.some((m) => pointsNowhere(res.getHeader(m))) || pairs.some(([k, v]) => isMarker(k) && pointsNowhere(v));
    if (refused) {
      for (const m of MARKERS) res.removeHeader(m);
      if (given) {
        // Handed back in the shape it came in: Node rejects a mix of the two list forms.
        const kept = pairs.filter(([k]) => !isMarker(k));
        rest[rest.length - 1] = !Array.isArray(given) ? Object.fromEntries(kept) : Array.isArray(given[0]) ? kept : kept.flat();
      }
    }
    return writeHead.call(this, statusCode, ...rest);
  };
  return res;
}
