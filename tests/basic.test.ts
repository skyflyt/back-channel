/**
 * Back Channel — Core tests.
 *
 * Happy-path tests proving the Phase 1 building blocks work. Heavier
 * security/property/fuzz tests come in later phases.
 */

import { describe, it, expect } from "vitest";
import {
  HostAgent,
  VisitorAgent,
  createInMemoryTransportPair,
  InMemoryTranscript,
  newSessionId,
  validateScopes,
  isBlockedScope,
  type RegisteredCapability,
  type SessionInvite,
  type Scope,
} from "../src/index.js";

function makeInvite(scopes: Scope[]): SessionInvite {
  return {
    sessionId: newSessionId(),
    hostId: "host@test",
    visitorId: "visitor@test",
    scopes,
    expiresAt: new Date(Date.now() + 60 * 1000),
  };
}

function makeCaps(): RegisteredCapability[] {
  return [
    {
      name: "config.read-test",
      description: "Read a thing",
      scope: "config.read",
      requiresApproval: false,
      async handler() {
        return { ok: true };
      },
    },
    {
      name: "config.suggest-test",
      description: "Suggest a thing",
      scope: "config.suggest",
      requiresApproval: true,
      async handler() {
        return { changeId: "x1" };
      },
    },
  ];
}

describe("scope validation", () => {
  it("rejects hard-blocked scopes", () => {
    expect(() => validateScopes(["memory.read"])).toThrow();
    expect(() => validateScopes(["email.read"])).toThrow();
  });

  it("identifies blocked scopes", () => {
    expect(isBlockedScope("memory.read")).toBe(true);
    expect(isBlockedScope("config.read")).toBe(false);
  });

  it("accepts known scopes", () => {
    expect(() => validateScopes(["config.read", "config.suggest"])).not.toThrow();
  });

  it("rejects unknown scopes", () => {
    expect(() => validateScopes(["bogus.scope"])).toThrow();
  });
});

describe("end-to-end session", () => {
  it("discovers only granted-scope capabilities", async () => {
    const t = createInMemoryTransportPair();
    const invite = makeInvite(["config.read"]);

    const host = new HostAgent({
      hostId: "h",
      transport: t.host,
      capabilities: makeCaps(),
      approve: async () => true,
      transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);

    const visitor = new VisitorAgent({
      visitorId: "v",
      transport: t.visitor,
      transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);

    const caps = await visitor.discoverCapabilities();
    expect(caps.map((c) => c.name)).toEqual(["config.read-test"]);
  });

  it("invokes a read capability and gets a result", async () => {
    const t = createInMemoryTransportPair();
    const invite = makeInvite(["config.read"]);
    const host = new HostAgent({
      hostId: "h", transport: t.host, capabilities: makeCaps(),
      approve: async () => true, transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);
    const visitor = new VisitorAgent({
      visitorId: "v", transport: t.visitor, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);
    const result = await visitor.invoke("config.read-test");
    expect(result).toEqual({ ok: true });
  });

  it("denies a capability outside the granted scope set", async () => {
    const t = createInMemoryTransportPair();
    const invite = makeInvite(["config.read"]);
    const host = new HostAgent({
      hostId: "h", transport: t.host, capabilities: makeCaps(),
      approve: async () => true, transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);
    const visitor = new VisitorAgent({
      visitorId: "v", transport: t.visitor, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);
    await expect(visitor.invoke("config.suggest-test")).rejects.toThrow(/denied/);
  });

  it("requires approval for write-tier capabilities", async () => {
    const t = createInMemoryTransportPair();
    const invite = makeInvite(["config.suggest"]);
    let approvalCalled = false;
    const host = new HostAgent({
      hostId: "h", transport: t.host, capabilities: makeCaps(),
      approve: async () => { approvalCalled = true; return true; },
      transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);
    const visitor = new VisitorAgent({
      visitorId: "v", transport: t.visitor, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);
    await visitor.invoke("config.suggest-test");
    expect(approvalCalled).toBe(true);
  });

  it("rejects invocation if the host human says no", async () => {
    const t = createInMemoryTransportPair();
    const invite = makeInvite(["config.suggest"]);
    const host = new HostAgent({
      hostId: "h", transport: t.host, capabilities: makeCaps(),
      approve: async () => false, transcript: new InMemoryTranscript(),
    });
    await host.accept(invite);
    const visitor = new VisitorAgent({
      visitorId: "v", transport: t.visitor, transcript: new InMemoryTranscript(),
    });
    await visitor.openSession(invite);
    await expect(visitor.invoke("config.suggest-test")).rejects.toThrow(/rejected/);
  });
});
