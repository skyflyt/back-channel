import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  validateMessage,
  isNotification,
  initializeResult,
  rpcResult,
  rpcError,
  toolCallResult,
  PARSE_ERROR,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
} from "@/lib/mcp/protocol.mjs";
import { TOOLS, getTool, validateToolArgs } from "@/lib/mcp/tools.mjs";

// The wrapped route handlers — tools dispatch to these IN-PROCESS (no HTTP
// round-trip, no duplicated logic). Each keeps enforcing its own participant/
// trust/rate-limit rules exactly as it does for direct REST callers.
import { GET as sessionsActiveGET } from "@/app/api/sessions/active/route";
import { POST as pollPOST } from "@/app/api/poll/route";
import { POST as invitesPOST } from "@/app/api/invites/route";
import { POST as claimPOST } from "@/app/api/invites/[code]/claim/route";
import { POST as inboxRequestPOST } from "@/app/api/inbox/request/route";
import { POST as endSessionPOST } from "@/app/api/sessions/[id]/end/route";
import { GET as scopesGET } from "@/app/api/scopes/route";
import { POST as viewTokenSelfPOST } from "@/app/api/account/view-token-self/route";

export const runtime = "nodejs";

/**
 * POST /api/mcp — Back Channel as a remote MCP server. Stateless JSON-RPC 2.0
 * over plain HTTP responses (valid Streamable-HTTP subset — we never open an
 * SSE stream). Authenticated by the SAME per-agent bearer bc_ key as the REST
 * API; the human mints one in Settings → Connect an agent.
 *
 * Handles: initialize, ping, notifications/* (202), tools/list, tools/call.
 * Tools are thin wrappers over already-bearer-authed REST routes (see
 * src/lib/mcp/tools.mjs for the catalog and the v1 honesty caveats).
 */

/** What we forward into synthetic requests: caller identity + the rate-limit
 * keys. x-forwarded-for MUST pass through or every MCP user lands in one
 * shared "unknown" IP bucket on claim/invite limits. Cookies are deliberately
 * NOT forwarded — wrapped routes have cookie+CSRF branches that must not fire. */
function buildForwardHeaders(req: NextRequest, withJsonBody: boolean): Headers {
  const h = new Headers();
  for (const name of ["authorization", "x-forwarded-for", "user-agent"]) {
    const v = req.headers.get(name);
    if (v) h.set(name, v);
  }
  if (withJsonBody) h.set("content-type", "application/json");
  return h;
}

function synth(req: NextRequest, path: string, method: "GET" | "POST", body?: unknown): NextRequest {
  const origin = process.env.PUBLIC_APP_URL ?? req.nextUrl.origin;
  return new NextRequest(new URL(path, origin), {
    method,
    headers: buildForwardHeaders(req, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

type ToolOutcome = { status: number; text: string };

async function fromResponse(res: Response): Promise<ToolOutcome> {
  return { status: res.status, text: await res.text() };
}

/** Filter a JSON body down to the listed keys (drops noisy/irrelevant fields). */
function pick(text: string, keys: string[]): string {
  try {
    const obj = JSON.parse(text);
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in obj) out[k] = obj[k];
    return JSON.stringify(out);
  } catch {
    return text;
  }
}

async function dispatchTool(
  req: NextRequest,
  name: string,
  args: Record<string, unknown>,
  auth: { accountId: string; handle: string; displayName: string | null; agentTokenId: string | null },
): Promise<ToolOutcome> {
  switch (name) {
    case "bc_whoami": {
      const agent = auth.agentTokenId
        ? await prisma.agentToken.findUnique({ where: { id: auth.agentTokenId } })
        : null;
      return {
        status: 200,
        text: JSON.stringify({
          handle: auth.handle,
          display_name: auth.displayName,
          agent_id: agent?.id ?? null,
          agent_name: agent?.name ?? null,
          runtime_type: agent?.runtimeType ?? null,
          connected_via: "mcp",
        }),
      };
    }
    case "bc_check_inbox":
      return fromResponse(await sessionsActiveGET(synth(req, "/api/sessions/active?frames=0", "GET")));
    case "bc_read_messages": {
      const read = await fromResponse(
        await pollPOST(
          synth(req, "/api/poll", "POST", {
            session_id: args.session_id,
            role: args.role,
            cursor: typeof args.cursor === "number" ? args.cursor : 0,
            wait_seconds: 0,
          }),
        ),
      );
      if (read.status !== 200 || args.mark_read === false) {
        return { ...read, text: pick(read.text, ["ended", "end_reason", "frames", "next_cursor", "peer_status", "expires_at"]) };
      }
      // Ack what we just read: a second poll with cursor=next_cursor marks those
      // frames consumed so they stop counting as unread account-wide.
      try {
        const next = JSON.parse(read.text)?.next_cursor;
        if (typeof next === "number" && next > 0) {
          await pollPOST(synth(req, "/api/poll", "POST", { session_id: args.session_id, role: args.role, cursor: next, wait_seconds: 0 }));
        }
      } catch {
        /* ack is best-effort; the frames were still delivered */
      }
      return { ...read, text: pick(read.text, ["ended", "end_reason", "frames", "next_cursor", "peer_status", "expires_at"]) };
    }
    case "bc_send_message": {
      const sent = await fromResponse(
        await pollPOST(
          synth(req, "/api/poll", "POST", {
            session_id: args.session_id,
            role: args.role,
            send: args.frame,
            cursor: 0, // cursor 0 never acks/consumes anything — send stays send-only
            wait_seconds: 0,
          }),
        ),
      );
      // Drop the frame backlog a cursor-0 poll returns; the caller asked to send.
      return { ...sent, text: pick(sent.text, ["ended", "end_reason", "sent_seq", "peer_status", "frames_acknowledged", "expires_at"]) };
    }
    case "bc_create_invite":
      return fromResponse(
        await invitesPOST(
          synth(req, "/api/invites", "POST", {
            host_handle: args.host_handle,
            host_email: args.host_email,
            scopes: args.scopes,
            message: args.message,
            ttl_minutes: args.ttl_minutes,
          }),
        ),
      );
    case "bc_claim_invite": {
      const code = String(args.code).trim().toUpperCase();
      return fromResponse(
        await claimPOST(synth(req, `/api/invites/${encodeURIComponent(code)}/claim`, "POST", {}), {
          params: Promise.resolve({ code }),
        }),
      );
    }
    case "bc_request_session":
      return fromResponse(
        await inboxRequestPOST(
          synth(req, "/api/inbox/request", "POST", {
            peer_handle: args.peer_handle,
            scopes: args.scopes,
            message: args.message,
          }),
        ),
      );
    case "bc_end_session": {
      const id = String(args.session_id);
      return fromResponse(
        await endSessionPOST(synth(req, `/api/sessions/${encodeURIComponent(id)}/end`, "POST", {}), {
          params: Promise.resolve({ id }),
        }),
      );
    }
    case "bc_list_scopes":
      return fromResponse(scopesGET());
    case "bc_dashboard_link":
      return fromResponse(
        await viewTokenSelfPOST(synth(req, "/api/account/view-token-self", "POST", args.purpose ? { purpose: args.purpose } : {})),
      );
    default:
      throw new Error(`unhandled tool: ${name}`); // unreachable — getTool() gates
  }
}

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

export async function POST(req: NextRequest) {
  // Auth once at the top — same bearer path as every REST route. HTTP 401 (not
  // a JSON-RPC error alone) so clients mark the credential bad, not the server.
  const ctx = await getAuthContext(req.headers.get("authorization"));
  if (!ctx) {
    return json(rpcError(null, -32001, "Unauthorized: send Authorization: Bearer <bc_ token> (mint one in Settings → Connect an agent)"), 401);
  }

  const rl = rateLimit("mcp", ctx.account.id, 120, 60_000);
  if (!rl.ok) {
    return NextResponse.json(rpcError(null, -32000, "Rate limited — retry shortly"), {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, PARSE_ERROR, "Body is not valid JSON"));
  }

  const v = validateMessage(body);
  if (!v.ok) return json(v.response);
  const msg = v.msg;

  // Notifications (no id) get 202 + empty body — including notifications/initialized.
  if (isNotification(msg)) return new NextResponse(null, { status: 202 });

  switch (msg.method) {
    case "initialize":
      return json(rpcResult(msg.id, initializeResult(msg.params?.protocolVersion)));
    case "ping":
      // ping is a REQUEST — it needs an empty result, not a 202 (clients poll it for liveness).
      return json(rpcResult(msg.id, {}));
    case "tools/list":
      return json(rpcResult(msg.id, { tools: TOOLS }));
    case "tools/call": {
      const name = msg.params?.name;
      const tool = typeof name === "string" ? getTool(name) : null;
      if (!tool) return json(rpcError(msg.id, INVALID_PARAMS, `Unknown tool: ${String(name)}`));
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const argError = validateToolArgs(tool, args);
      if (argError) return json(rpcError(msg.id, INVALID_PARAMS, argError));
      try {
        const outcome = await dispatchTool(req, tool.name, args, {
          accountId: ctx.account.id,
          handle: ctx.account.handle,
          displayName: ctx.account.displayName,
          agentTokenId: ctx.agentTokenId,
        });
        return json(toolCallResult(msg.id, outcome.status, outcome.text));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error(`[mcp] tool ${tool.name} failed:`, detail);
        return json(rpcResult(msg.id, { content: [{ type: "text", text: `Tool execution failed: ${detail}` }], isError: true }));
      }
    }
    default:
      return json(rpcError(msg.id, METHOD_NOT_FOUND, `Method not supported: ${msg.method}`));
  }
}

// The MCP Streamable-HTTP spec allows servers to refuse GET (no server-push
// stream) and DELETE (no session to end — we're stateless).
export function GET() {
  return NextResponse.json({ error: "method_not_allowed", detail: "POST JSON-RPC 2.0 messages here" }, { status: 405, headers: { Allow: "POST" } });
}
export function DELETE() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
}
