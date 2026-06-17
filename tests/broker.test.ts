/**
 * Back Channel — End-to-end broker test.
 *
 * Spins up a minimal in-process WebSocket "broker" that mimics the production
 * broker's pairing + buffering behavior, then runs visitor and host agents
 * through it. Validates the full Phase 3 wire pattern without needing the
 * real Next.js / Prisma broker running.
 */

import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket as WS } from "ws";
import { createServer } from "node:http";
import {
  HostAgent,
  VisitorAgent,
  InMemoryTranscript,
  createBrokerTransport,
  newSessionId,
  type RegisteredCapability,
  type SessionInvite,
  type Scope,
} from "../src/index.js";

function port(): number {
  return 30000 + Math.floor(Math.random() * 25000);
}

/**
 * Stand up a minimal "broker" that pairs two clients by sessionId and
 * forwards frames between them (buffering if peer not present yet).
 */
function startMockBroker(p: number): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    interface Slot {
      visitor?: WS;
      host?: WS;
      buffer: Array<{ from: "visitor" | "host"; data: WS.RawData | string }>;
    }
    const sessions = new Map<string, Slot>();

    const httpServer = createServer();
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = url.pathname.match(/^\/relay\/([^/]+)$/);
      if (!m) return socket.destroy();
      const sessionId = m[1];
      const role = url.searchParams.get("role") as "visitor" | "host" | null;
      if (!role || (role !== "visitor" && role !== "host")) return socket.destroy();

      wss.handleUpgrade(req, socket, head, (ws) => {
        const slot = sessions.get(sessionId) ?? { buffer: [] };
        slot[role] = ws;
        sessions.set(sessionId, slot);

        // Flush frames buffered for the arriving role
        const otherSenderRole = role === "visitor" ? "host" : "visitor";
        const remaining: typeof slot.buffer = [];
        for (const f of slot.buffer) {
          if (f.from === otherSenderRole) ws.send(f.data);
          else remaining.push(f);
        }
        slot.buffer = remaining;

        ws.on("message", (data) => {
          const peer = role === "visitor" ? slot.host : slot.visitor;
          if (peer && peer.readyState === WS.OPEN) {
            peer.send(data);
          } else {
            slot.buffer.push({ from: role, data });
          }
        });

        ws.on("close", () => {
          slot[role] = undefined;
          if (!slot.visitor && !slot.host) sessions.delete(sessionId);
        });
      });
    });

    httpServer.on("error", reject);
    httpServer.listen(p, () => {
      resolve({
        close: () => new Promise<void>((res) => {
          for (const s of sessions.values()) {
            try { s.visitor?.close(); } catch {}
            try { s.host?.close(); } catch {}
          }
          wss.close();
          httpServer.close(() => res());
        }),
      });
    });
  });
}

function makeInvite(scopes: Scope[], sessionId: string): SessionInvite {
  return {
    sessionId,
    hostId: "host@bc",
    visitorId: "visitor@bc",
    scopes,
    expiresAt: new Date(Date.now() + 60 * 1000),
  };
}

const caps: RegisteredCapability[] = [
  {
    name: "config.read-test",
    description: "Read",
    scope: "config.read",
    requiresApproval: false,
    async handler() {
      return { ok: true, value: 99 };
    },
  },
  {
    name: "config.suggest-test",
    description: "Suggest",
    scope: "config.suggest",
    requiresApproval: true,
    async handler() {
      return { changeId: "approved" };
    },
  },
];

describe("broker transport e2e (via mock broker)", () => {
  it("full session: handshake + discovery + invoke through broker relay", async () => {
    const p = port();
    const broker = await startMockBroker(p);
    const sessionId = newSessionId();
    const invite = makeInvite(["config.read"], sessionId);

    const hostUrl = `ws://localhost:${p}/relay/${sessionId}?role=host&token=t`;
    const visitorUrl = `ws://localhost:${p}/relay/${sessionId}?role=visitor&token=t`;

    const [hostTransport, visitorTransport] = await Promise.all([
      createBrokerTransport({ relayUrl: hostUrl }),
      createBrokerTransport({ relayUrl: visitorUrl }),
    ]);

    const host = new HostAgent({
      hostId: "h",
      transport: hostTransport,
      capabilities: caps,
      approve: async () => true,
      transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);

    const visitor = new VisitorAgent({
      visitorId: "v",
      transport: visitorTransport,
      transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);

    const discovered = await visitor.discoverCapabilities();
    expect(discovered.map((c) => c.name)).toEqual(["config.read-test"]);

    const result = await visitor.invoke<{ ok: boolean; value: number }>("config.read-test");
    expect(result).toEqual({ ok: true, value: 99 });

    await visitor.endSession("natural");
    await visitorTransport.close();
    await hostTransport.close();
    await broker.close();
  }, 15000);

  it("visitor connects first, host arrives later — frames buffered", async () => {
    const p = port();
    const broker = await startMockBroker(p);
    const sessionId = newSessionId();
    const invite = makeInvite(["config.suggest"], sessionId);

    const visitorUrl = `ws://localhost:${p}/relay/${sessionId}?role=visitor&token=t`;
    const hostUrl = `ws://localhost:${p}/relay/${sessionId}?role=host&token=t`;

    // Visitor connects first and immediately tries to use the session — should
    // wait until host shows up
    const visitorTransportPromise = createBrokerTransport({ relayUrl: visitorUrl });

    // Small delay before host connects (simulates real-world async claim flow)
    await new Promise((r) => setTimeout(r, 200));

    const hostTransportPromise = createBrokerTransport({ relayUrl: hostUrl });

    const [visitorTransport, hostTransport] = await Promise.all([
      visitorTransportPromise,
      hostTransportPromise,
    ]);

    const host = new HostAgent({
      hostId: "h",
      transport: hostTransport,
      capabilities: caps,
      approve: async () => true,
      transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);

    const visitor = new VisitorAgent({
      visitorId: "v",
      transport: visitorTransport,
      transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);

    const result = await visitor.invoke<{ changeId: string }>("config.suggest-test");
    expect(result.changeId).toBe("approved");

    await visitor.endSession();
    await visitorTransport.close();
    await hostTransport.close();
    await broker.close();
  }, 15000);
});
