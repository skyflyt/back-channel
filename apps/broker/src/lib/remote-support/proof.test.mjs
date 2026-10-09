import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { parseP256Spki, proofValid } from "./proof.mjs";
import { allowMessage, receiptMessage, redeemMessage } from "./rules.mjs";

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { spki: der.toString("base64"), fp: createHash("sha256").update(der).digest("hex").toUpperCase(), sign: (m) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

test("a P-256 key, identified by the uppercase SHA-256 of its DER; anything else is refused", () => {
  const k = p256();
  const parsed = parseP256Spki(k.spki);
  assert.equal(parsed.sha256, k.fp);
  assert.equal(parsed.spki, k.spki);
  const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  for (const bad of [ed, p384, "not base64!", k.spki.slice(0, -4), "", null, 7, k.spki + "\n"]) assert.equal(parseP256Spki(bad), null, String(bad).slice(0, 20));
});

test("proofs: ECDSA P-256 / SHA-256, P1363, base64url, over the exact domain-separated message", () => {
  const k = p256(); const other = p256();
  const id = "33333333-3333-4333-8333-333333333333";
  assert.equal(proofValid(k.spki, allowMessage(id), k.sign(allowMessage(id))), true, "a stored SPKI");
  assert.equal(proofValid(parseP256Spki(k.spki).key, redeemMessage("BCS-ABCD-EFGH"), k.sign(redeemMessage("BCS-ABCD-EFGH"))), true, "a parsed key");
  assert.equal(proofValid(k.spki, allowMessage(id), other.sign(allowMessage(id))), false, "another key");
  assert.equal(proofValid(k.spki, receiptMessage(id, "removed"), k.sign(receiptMessage(id, "in_memory"))), false, "another message");
  assert.equal(proofValid(k.spki, allowMessage(id), k.sign(redeemMessage(id))), false, "a proof for one purpose is never valid for another");
  for (const bad of [undefined, "", "x".repeat(86), k.sign(allowMessage(id)) + "A", 12]) assert.equal(proofValid(k.spki, allowMessage(id), bad), false);
  assert.equal(proofValid("garbage", allowMessage(id), k.sign(allowMessage(id))), false);
});
