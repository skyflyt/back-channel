/**
 * A stand-in for @simplewebauthn/server at the library boundary, for route tests of the passkey step-up
 * (src/lib/passkeys.ts, src/lib/step-up.ts). Real WebAuthn needs an authenticator, so the browser's answer here
 * carries its client data as JSON (challenge, origin, type) and a fake authenticator data object (RP ID, user
 * verification, counter, signature) that this fake checks the way the library does: the expected challenge, origin
 * and RP ID, required user verification, the right credential, a good signature, and a counter that moves on.
 *
 * Use: const fake = fakeWebAuthn(); mock.module("@simplewebauthn/server", { namedExports: fake.lib });
 * then build answers with fake.registration(...) and fake.authentication(...).
 */
import { randomBytes } from "node:crypto";

type Opts = Record<string, any>;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

export function fakeWebAuthn() {
  const calls: Array<[string, Opts]> = [];
  let n = 0;
  const challenge = () => `c${++n}${randomBytes(16).toString("base64url")}`;

  /** What the library checks on every answer. Throws like the library does. */
  function check(o: Opts, type: string) {
    const r = o.response;
    const client = unb64(r.response.clientDataJSON);
    const auth = unb64(r.response.authenticatorData ?? r.response.attestationObject);
    if (client.type !== type) throw new Error(`Unexpected type ${client.type}`);
    if (client.challenge !== o.expectedChallenge) throw new Error("Unexpected authentication response challenge");
    if (client.origin !== o.expectedOrigin) throw new Error(`Unexpected origin ${client.origin}`);
    if (auth.rpId !== o.expectedRPID) throw new Error("Unexpected RP ID hash");
    if (o.requireUserVerification !== false && !auth.uv) throw new Error("User verification required, but user could not be verified");
    return auth;
  }

  const lib = {
    generateRegistrationOptions: async (o: Opts) => {
      calls.push(["generateRegistrationOptions", o]);
      return {
        challenge: challenge(), rp: { name: o.rpName, id: o.rpID }, user: { id: "dXNlcg", name: o.userName, displayName: o.userDisplayName },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: o.timeout, attestation: o.attestationType,
        excludeCredentials: (o.excludeCredentials ?? []).map((c: Opts) => ({ ...c, type: "public-key" })), authenticatorSelection: o.authenticatorSelection,
      };
    },
    verifyRegistrationResponse: async (o: Opts) => {
      calls.push(["verifyRegistrationResponse", o]);
      const auth = check(o, "webauthn.create");
      if (auth.bad) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          fmt: "none", aaguid: "00000000-0000-0000-0000-000000000000", credentialType: "public-key", attestationObject: new Uint8Array(1),
          userVerified: true, credentialDeviceType: "singleDevice", credentialBackedUp: false, origin: o.expectedOrigin, rpID: o.expectedRPID,
          credential: { id: o.response.id, publicKey: new Uint8Array(auth.publicKey ?? [165, 1, 2, 3, 38]), counter: auth.counter ?? 0, transports: o.response.response.transports },
        },
      };
    },
    generateAuthenticationOptions: async (o: Opts) => {
      calls.push(["generateAuthenticationOptions", o]);
      return {
        challenge: challenge(), rpId: o.rpID, timeout: o.timeout, userVerification: o.userVerification,
        allowCredentials: (o.allowCredentials ?? []).map((c: Opts) => ({ ...c, type: "public-key" })),
      };
    },
    verifyAuthenticationResponse: async (o: Opts) => {
      calls.push(["verifyAuthenticationResponse", o]);
      const auth = check(o, "webauthn.get");
      if (o.credential.id !== o.response.id) throw new Error("credential id mismatch");
      const info = { credentialID: o.response.id, newCounter: auth.counter ?? 0, userVerified: !!auth.uv, credentialDeviceType: "singleDevice", credentialBackedUp: false, origin: o.expectedOrigin, rpID: o.expectedRPID };
      if (auth.signature !== "good") return { verified: false, authenticationInfo: info };
      // The library refuses a counter that didn't move on (a cloned authenticator), unless both are zero.
      if ((info.newCounter > 0 || o.credential.counter > 0) && info.newCounter <= o.credential.counter) throw new Error("Response counter value was lower than expected");
      return { verified: true, authenticationInfo: info };
    },
  };

  /** A browser's answer to a registration prompt. */
  function registration(id: string, challenge: string, over: { origin?: string; rpId?: string; uv?: boolean; bad?: boolean; attachment?: string; transports?: string[] } = {}) {
    return {
      id, rawId: id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: over.attachment ?? "platform",
      response: {
        clientDataJSON: b64({ type: "webauthn.create", challenge, origin: over.origin ?? "https://back-channel.app" }),
        attestationObject: b64({ rpId: over.rpId ?? "back-channel.app", uv: over.uv ?? true, bad: !!over.bad }),
        transports: over.transports ?? ["internal", "hybrid"],
      },
    };
  }

  /** A browser's answer to a step-up prompt. */
  function authentication(id: string, challenge: string, over: { origin?: string; rpId?: string; uv?: boolean; signature?: string; counter?: number } = {}) {
    return {
      id, rawId: id, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64({ type: "webauthn.get", challenge, origin: over.origin ?? "https://back-channel.app" }),
        authenticatorData: b64({ rpId: over.rpId ?? "back-channel.app", uv: over.uv ?? true, counter: over.counter ?? 0, signature: over.signature ?? "good" }),
        signature: "c2ln",
      },
    };
  }

  return { lib, calls, registration, authentication };
}
