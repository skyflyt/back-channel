import { describe, it, expect } from "vitest";
import {
  HostAgent,
  VisitorAgent,
  InMemoryTranscript,
  createWebSocketHostTransport,
  createWebSocketVisitorTransport,
  newSessionId,
  type RegisteredCapability,
  type SessionInvite,
  type Scope,
} from "../src/index.js";

function port(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

function makeInvite(scopes: Scope[]): SessionInvite {
  return {
    sessionId: newSessionId(),
    hostId: "host@test",
    visitorId: "visitor@test",
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
      return { ok: true, value: 42 };
    },
  },
  {
    name: "config.suggest-test",
    description: "Suggest",
    scope: "config.suggest",
    requiresApproval: true,
    async handler() {
      return { changeId: "x1" };
    },
  },
];

describe("websocket transport e2e", () => {
  it("handshake + discovery + invoke + close", async () => {
    const p = port();
    const invite = makeInvite(["config.read"]);

    const [hostTransport, visitorTransport] = await Promise.all([
      createWebSocketHostTransport(p),
      createWebSocketVisitorTransport(`ws://localhost:${p}`),
    ]);

    const host = new HostAgent({
      hostId: "h", transport: hostTransport, capabilities: caps,
      approve: async () => true, transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);

    const visitor = new VisitorAgent({
      visitorId: "v", transport: visitorTransport, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);

    const discovered = await visitor.discoverCapabilities();
    expect(discovered.map((c) => c.name)).toEqual(["config.read-test"]);

    const result = await visitor.invoke<{ ok: boolean; value: number }>("config.read-test");
    expect(result).toEqual({ ok: true, value: 42 });

    await visitor.endSession("natural");
    await visitorTransport.close();
    await hostTransport.close();
  }, 10000);

  it("approval-required capability works over the wire", async () => {
    const p = port();
    const invite = makeInvite(["config.suggest"]);
    let approveCalled = false;

    const [hostTransport, visitorTransport] = await Promise.all([
      createWebSocketHostTransport(p),
      createWebSocketVisitorTransport(`ws://localhost:${p}`),
    ]);

    const host = new HostAgent({
      hostId: "h", transport: hostTransport, capabilities: caps,
      approve: async () => { approveCalled = true; return true; },
      transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);

    const visitor = new VisitorAgent({
      visitorId: "v", transport: visitorTransport, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);

    const result = await visitor.invoke<{ changeId: string }>("config.suggest-test");
    expect(approveCalled).toBe(true);
    expect(result.changeId).toBe("x1");

    await visitor.endSession();
    await visitorTransport.close();
    await hostTransport.close();
  }, 10000);

  it("denies out-of-scope over the wire", async () => {
    const p = port();
    const invite = makeInvite(["config.read"]);

    const [hostTransport, visitorTransport] = await Promise.all([
      createWebSocketHostTransport(p),
      createWebSocketVisitorTransport(`ws://localhost:${p}`),
    ]);

    const host = new HostAgent({
      hostId: "h", transport: hostTransport, capabilities: caps,
      approve: async () => true, transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);

    const visitor = new VisitorAgent({
      visitorId: "v", transport: visitorTransport, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);

    await expect(visitor.invoke("config.suggest-test")).rejects.toThrow(/denied/);

    await visitor.endSession();
    await visitorTransport.close();
    await hostTransport.close();
  }, 10000);
});
