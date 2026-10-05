/**
 * Back Channel bridge — the inbox doorbell, client side.
 *
 * GET /api/inbox/check is metadata only by design (docs/inbox-doorbell.md): a
 * count and which categories contributed to it. No frame content, no handles,
 * nothing a peer wrote. Everything the bridge says unprompted — the
 * session-start note (hooks/session-start.mjs) and channel events (lib.js) —
 * is built from this and nothing else, so neither can carry text an outside
 * party controls into the model's context.
 */

const KIND_LABEL = { frame: "new messages", invite: "a session request", payload: "something sent to this agent" };
const KNOWN_KINDS = Object.keys(KIND_LABEL);

/**
 * One doorbell request. Never throws: resolves to
 *   { ok: true, pendingCount, kinds, waitedSeconds }  or  { ok: false, status, error }
 * where status is the HTTP status (0 = no response at all).
 */
export async function fetchPending({ mcpUrl, token, waitSeconds = 0, fetchImpl = fetch, timeoutMs = 10_000, signal } = {}) {
  let url;
  try {
    url = new URL("/api/inbox/check", mcpUrl);
  } catch {
    return { ok: false, status: 0, error: "bad endpoint URL" };
  }
  url.searchParams.set("wait", String(waitSeconds));
  // One controller for both the deadline and the caller's cancel. Not
  // AbortSignal.any — that needs Node 20.3 and the manifest promises 18.
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), waitSeconds * 1000 + timeoutMs);
  const onCancel = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener("abort", onCancel, { once: true });
  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    const text = (await res.text().catch(() => "")).trim();
    if (!res.ok || !text) return { ok: false, status: res.status, error: `doorbell HTTP ${res.status}` };
    const body = JSON.parse(text);
    return {
      ok: true,
      pendingCount: Number.isInteger(body.pending_count) && body.pending_count > 0 ? body.pending_count : 0,
      // Only the categories we know: `kinds` is rendered into model-visible text.
      kinds: Array.isArray(body.kinds) ? body.kinds.filter((k) => KNOWN_KINDS.includes(k)) : [],
      waitedSeconds: Number.isFinite(body.waited_seconds) ? body.waited_seconds : 0,
    };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onCancel);
  }
}

/** "3 unread items (new messages, a session request)" — counts and fixed labels only. */
export function describePending(pendingCount, kinds = []) {
  const labels = kinds.filter((k) => KNOWN_KINDS.includes(k)).map((k) => KIND_LABEL[k]);
  const what = labels.length ? ` (${labels.join(", ")})` : "";
  return `${pendingCount} unread item${pendingCount === 1 ? "" : "s"}${what}`;
}
