# Feature Plan — Canonical Crypto Test Vectors (Known-Answer Tests)

> Rev 3 — Rev 2 addressed reviewer feedback: independent KAT generation,
> fixed-IV encryption assertions, an explicit two-layer compatibility contract
> (byte-exact cipher path vs. semantic JSON interop), widened CI path filters,
> and a byte-identical published-copy check. Rev 3 adds IV-length validation
> (+ tests) on the bridge's fixed-IV `seal` hook, mirroring the library's
> `sealWithIv`.

**Feature name:** Canonical crypto interop test vectors (`crypto-v1` known-answer tests)

**One-line summary:** Freeze deterministic known-answer test vectors for Back Channel's v1 crypto (HKDF-SHA-256 session-key derivation, ECDH P-256 handshake, AES-256-GCM envelope), verify **both** in-repo implementations against them in vitest — in both the encrypt and decrypt directions — and publish the vectors as a static file at `https://back-channel.app/interop/crypto-v1.json` so third-party implementations can prove conformance.

---

## 1. Problem / why it's worth doing

The README's "Not yet / known limitations" section explicitly lists: *"Canonical interop test harness (a broker-side echo bot / test vectors) is not yet built."* This plan delivers the **test-vectors half** of that gap (the echo bot is out of scope).

Today's crypto test coverage has a structural blind spot:

- `tests/crypto.test.ts` is **self-consistent only** — it seals with the library and opens with the library. It proves internal round-tripping, not correctness of the primitives.
- `tests/mcpb-crypto-interop.test.ts` is **pairwise only** — it proves `src/` and the `.mcpb` bridge (`apps/broker/connector/server/crypto.js`) interoperate with each other. A bug **mirrored in both** implementations (e.g., a shared misreading of the HKDF expand step, since both were written in this repo) passes every existing test.
- The skill ships copy-paste **Node and Python crypto recipes**, and the MCP connector does its crypto locally — but there is no fixture anywhere that a Python (or any third-party) implementation can run against to prove it produces conforming output.

Frozen known-answer vectors fix all three at once:

1. **Regression pinning** — if anyone ever "refactors" the HKDF info string, salt handling, IV/tag sizes, or JSON encoding, a vector test fails immediately, even if both in-repo implementations change in lockstep. Crucially, the expected values are **generated independently of the library under test** (see §4 step 3), so a mirrored bug cannot self-certify.
2. **A compatibility contract** — third parties (the skill's Python recipe, future community implementations) get an executable spec: "your implementation is compatible iff it passes `crypto-v1.json`."
3. **A testable spec document** — the vectors file pins, in machine-checkable form, exactly what "Back Channel v1 crypto" means: curve `prime256v1`, HKDF-SHA-256 with zero salt and info `back-channel/v1/session-key`, AES-256-GCM with 12-byte IV / 16-byte tag, UTF-8 JSON plaintext.

### The compatibility contract, precisely (two layers)

"Byte-compatible" needs care because plaintexts are JSON, and JSON serialization is not canonical (key order, whitespace). The vectors therefore certify two distinct layers, and the tests must not blur them:

- **Layer 1 — byte-exact cipher path.** Given the exact canonical plaintext **bytes** recorded in a vector (`plaintext_json`, a string field), a fixed key, and a fixed IV, a conforming implementation MUST produce the exact expected `ct` and `tag` when encrypting, and MUST recover those exact bytes when decrypting. This pins the KDF, the AEAD, and the UTF-8 encoding byte-for-byte.
- **Layer 2 — semantic JSON interop.** A conforming *receiver* parses the decrypted bytes as JSON and compares **semantically** (deep equality; key order and whitespace are NOT part of the contract). A conforming *sender* in production may serialize JSON however its runtime does — receivers never depend on byte-level serialization choices.

Vectors are constructed so that both layers are testable against the in-repo implementations without weakening either (see §3, "canonical plaintext" rules).

This is additive-only: **no existing crypto behavior changes.** The small library/bridge additions below (a fixed-IV seal entry point for KAT use, two derivation helpers) are thin, clearly-fenced extensions.

## 2. Files to add / change

### New files

| Path | What it is |
|---|---|
| `vectors/crypto-v1.json` | The frozen vectors (committed generator output; canonical copy) |
| `scripts/generate-vectors.ts` | Deterministic generator — run manually via `npx tsx scripts/generate-vectors.ts`; computes all expected values **independently of the library under test** (see §4 step 3) |
| `tests/vectors.test.ts` | Vitest known-answer suite — runs **both** `src/` and the `.mcpb` bridge implementation against every vector, in both encrypt and decrypt directions; also asserts the published broker copy is byte-identical |
| `apps/broker/public/interop/crypto-v1.json` | Published copy, byte-identical content, served automatically by Next at `/interop/crypto-v1.json` |
| `interop/verify_vectors.py` | Standalone Python verifier (mirrors the skill's Python recipe; manual, not part of `npm test`) |
| `docs/interop-vectors.md` | Spec of the vector file format, the two-layer contract, and how to consume it |
| `.github/workflows/library.yml` | Root library CI (`npm ci`, `npm run lint`, `npm test`) — today only the broker and install CLI have workflows, so the new test would otherwise never gate a PR. Path filters in §4 step 8. |
| `.gitattributes` | (New, or extend if one exists) `vectors/crypto-v1.json eol=lf` and `apps/broker/public/interop/crypto-v1.json eol=lf` — keeps the two copies byte-stable across Windows/macOS/Linux checkouts so the byte-identical test (§5) can't false-fail on CRLF normalization |

### Changed files (small, additive)

| Path | Change |
|---|---|
| `src/crypto/envelope.ts` | Add `sealWithIv(plaintext: unknown, sessionKey: Buffer, iv: Buffer): SealedEnvelope` — the existing `seal()` body with the IV supplied by the caller (validated to 12 bytes); refactor `seal()` to `sealWithIv(plaintext, key, randomBytes(IV_BYTES))`. Carries a loud doc-comment: **KAT/testing entry point only — IV reuse under GCM is catastrophic; production code must use `seal()`.** Deliberately **NOT re-exported from `src/index.ts`** (kept off the public npm surface); tests import it from `../src/crypto/envelope.js` directly. |
| `src/crypto/session-key.ts` | Add `loadEphemeralKeypair(privateKeyB64: string): EphemeralKeypair` (mirror of the bridge's `loadKeypair` — `createECDH(CURVE)`, `setPrivateKey`, return `{publicKey, _handle}`). Add `deriveSessionKeyFromSharedSecret(sharedSecret: Buffer): Buffer` — a public wrapper around the existing private `hkdf(ikm, 32)`, useful for implementations whose ECDH API yields a raw shared secret (e.g. WebCrypto). Neither touches existing functions. **These are conveniences under test — expected vector values are never computed with them** (§4 step 3). |
| `src/index.ts` | Export `loadEphemeralKeypair` and `deriveSessionKeyFromSharedSecret` (not `sealWithIv`). |
| `apps/broker/connector/server/crypto.js` | Give the bridge's `seal(frame, key)` an optional third parameter: `seal(frame, key, iv = randomBytes(12))` — same KAT-only warning comment. **The supplied `iv` must be validated: `iv.length === 12` or throw**, mirroring the library's `sealWithIv` validation — Node's AES-GCM would otherwise accept a non-12-byte IV and emit an envelope the bridge's own `open()` rejects (`Invalid IV length`). The bridge is internal (ships inside the `.mcpb`), so this is not a public API surface. No behavior change when the param is omitted. |
| `README.md` | In "Not yet / known limitations", change the interop-harness bullet to note test vectors now exist (echo bot still open); add one line under Encryption pointing at `vectors/crypto-v1.json` and the published URL. |

**Explicitly do NOT touch:** `skill/SKILL.md`, `skill/REFERENCE.md`, `apps/broker/public/install.sh`, or `skill.sha256` — the installer cross-checks skill content SHA256 against a GitHub-published manifest, and no skill change is needed for this feature. Also do not change the behavior of `seal()`/`open()`/`deriveSessionKey()`/the private `hkdf()` — `seal()`'s refactor to delegate must be behavior-identical (random 12-byte IV, same output shape).

## 3. Vector file format

Top-level shape of `vectors/crypto-v1.json` (hex for key material, base64 for wire-format fields, matching how each appears in the protocol):

```jsonc
{
  "_meta": {
    "name": "back-channel crypto-v1 known-answer vectors",
    "version": 1,
    "spec": {
      "curve": "prime256v1 (P-256), uncompressed points, base64 on the wire",
      "kdf": "HKDF-SHA-256, salt = 32 zero bytes, info = \"back-channel/v1/session-key\", L = 32",
      "aead": "AES-256-GCM, 12-byte IV, 16-byte tag, plaintext = UTF-8 JSON",
      "envelope": "{ type: \"enc\", v: 1, iv: b64, ct: b64, tag: b64 }",
      "contract": "Layer 1: encrypting the exact plaintext_json bytes with key+iv MUST yield exactly ct+tag (and decrypting MUST yield those bytes). Layer 2: receivers compare decrypted JSON semantically; key order/whitespace are not part of the contract."
    },
    "generator": "scripts/generate-vectors.ts"
  },
  "hkdf": [
    { "name": "all-zero ikm", "ikm_hex": "...", "session_key_hex": "..." }
  ],
  "ecdh_p256": [
    {
      "name": "fixed keypair 1",
      "alice_private_hex": "...", "alice_public_b64": "...",
      "bob_private_hex": "...",   "bob_public_b64": "...",
      "session_key_hex": "..."    // post-ECDH, post-HKDF — the final AES key
    }
  ],
  "envelope": [
    {
      "name": "simple frame",
      "key_hex": "...",
      "iv_b64": "...",                                   // the fixed IV, also inside envelope.iv
      "plaintext": { "type": "meta.dialog", "text": "hello" },  // parsed JSON value (Layer 2)
      "plaintext_json": "{\"type\":\"meta.dialog\",\"text\":\"hello\"}",  // exact canonical bytes (Layer 1)
      "envelope": { "type": "enc", "v": 1, "iv": "b64", "ct": "b64", "tag": "b64" }
    }
  ],
  "envelope_reject": [
    {
      "name": "tampered tag",
      "key_hex": "...",
      "envelope": { "type": "enc", "v": 1, "iv": "b64", "ct": "b64", "tag": "b64" },
      "reason": "auth tag does not verify"
    }
  ]
}
```

### Canonical-plaintext rules (what makes Layer 1 testable through `JSON.stringify`)

Both in-repo implementations encrypt `JSON.stringify(value)`. For the fixed-IV encryption test to be meaningful, every `envelope` vector must satisfy, and the generator must assert before writing:

- `JSON.stringify(JSON.parse(plaintext_json)) === plaintext_json` (round-trip stable in JS), and
- `JSON.stringify(vector.plaintext)` — as parsed from the vectors file — `=== plaintext_json`.

Practically: object keys are non-integer-like strings (JS preserves insertion order for those), no floats with unstable formatting, `plaintext_json` is compact (no added whitespace, `JSON.stringify` style). Third-party verifiers (e.g. Python, whose `json.dumps` inserts spaces by default) MUST encrypt the exact `plaintext_json` **string bytes** — never re-serialize the `plaintext` value — for Layer-1 checks.

### Vector contents (what the generator must produce)

- **`hkdf` — 4 vectors.** `ikm` values: 32 zero bytes; 32 `0xff` bytes; the sequence `0x01..0x20`; one fixed arbitrary value (`sha256("back-channel-hkdf-vector-4")`). Expected output computed **independently** via `node:crypto`'s built-in `hkdfSync` (§4 step 3) — NOT via the library's hand-rolled HKDF. These pin the zero-salt, info-string, and expand behavior in isolation.
- **`ecdh_p256` — 3 vectors.** Private scalars must be fixed and valid (in `[1, n-1]`). Derive them as `sha256("back-channel-vector-alice-1")` etc.; the generator calls `setPrivateKey` (which throws on an invalid scalar — if one ever fails, append a suffix and note it) and then **records the actual resulting scalar + public key in the JSON**, so consumers never re-derive them. The generator must assert Alice-side and Bob-side derivation agree before writing. `session_key_hex` is the **final AES key** (ECDH shared secret → independent `hkdfSync`), pinning the whole handshake path.
- **`envelope` — 4 vectors, used in BOTH directions.** Fixed key + fixed IV per vector (IVs like `000102…0b`, distinct per vector; distinct keys too, so no key+IV pair ever repeats), built by calling `createCipheriv` **directly in the generator** on the canonical `plaintext_json` bytes. Plaintexts to cover: a simple object; a string with multi-byte UTF-8 (emoji + CJK) to pin UTF-8 encoding; a realistic BCMessage-shaped frame (`invoke.request` with nested `args`); an empty object `{}`.
- **`envelope_reject` — 5 vectors.** Start from a valid vector and break it: (1) last tag byte flipped; (2) first ct byte flipped; (3) correct envelope but a different `key_hex`; (4) 8-byte IV (wrong length); (5) `"v": 2`. A conforming implementation must refuse/throw on all five.

## 4. Implementation approach (step by step)

1. **Branch** off fresh `main` (per `AGENTS.md`: never commit to `main` directly), e.g. `feat/crypto-test-vectors`.
2. **Library/bridge additions** per §2: `sealWithIv` in `src/crypto/envelope.ts` (module-level export, not in `index.ts`); `loadEphemeralKeypair` + `deriveSessionKeyFromSharedSecret` in `src/crypto/session-key.ts` (exported from `index.ts`); optional `iv` param on the bridge's `seal` — both fixed-IV entry points reject a wrong-length IV (`length !== 12` → throw) before touching the cipher. Match each file's existing doc-comment style. Note: the JSON stores private scalars as **hex**; `loadEphemeralKeypair` takes **base64** (consistent with the library's wire encodings) — the test/generator converts (`Buffer.from(hex, "hex").toString("base64")`).
3. **Generator** `scripts/generate-vectors.ts` — **independence is the design rule**: expected values MUST NOT be computed by the code being certified.
   - **HKDF expected values:** `Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(32, 0), Buffer.from("back-channel/v1/session-key"), 32))` — Node's built-in (OpenSSL-backed) HKDF, a genuinely independent implementation from the library's hand-rolled HMAC expand loop in `session-key.ts`.
   - **ECDH expected values:** `createECDH("prime256v1")` + `setPrivateKey` + `computeSecret` for the shared secret, then the same independent `hkdfSync` for the final key. (Honest caveat, recorded in `docs/interop-vectors.md`: the EC point-multiply primitive is OpenSSL in both the generator and the library — what the vectors independently pin is the composition: uncompressed-point base64 encoding, shared-secret handling, and every HKDF parameter. Full primitive-level independence comes from the Python verifier, which uses the `cryptography` package's own stack.)
   - **Envelope expected values:** `createCipheriv("aes-256-gcm", key, iv)` directly over the canonical `plaintext_json` UTF-8 bytes — never via `seal()`/`sealWithIv()`.
   - **Library/bridge appear ONLY in a post-generation self-check phase** (assertions, not value sources): every `envelope` vector opens correctly via `openEnvelope` and re-seals to identical `ct`/`tag` via `sealWithIv`; every `envelope_reject` vector throws; every `ecdh_p256` vector reproduces `session_key_hex` via `loadEphemeralKeypair` + `deriveSessionKey`; every `hkdf` vector reproduces via `deriveSessionKeyFromSharedSecret`. Any self-check failure aborts without writing — that failure would mean the generator has found a real library bug, which is the point.
   - Fully deterministic: no `randomBytes` anywhere; all inputs are the fixed constants in §3. Asserts the canonical-plaintext rules (§3) for every envelope vector.
   - Writes `vectors/crypto-v1.json` pretty-printed (2-space, `\n` line endings, trailing newline), then writes the **identical bytes** to `apps/broker/public/interop/crypto-v1.json`.
   - Run **once** by the implementer, output committed; kept in-repo for provenance/regeneration. It sits outside `tsconfig.json`'s `include: ["src/**/*"]`, so it does not affect `npm run build` / `npm run lint`; run with `npx tsx scripts/generate-vectors.ts`.
4. **Vitest suite** `tests/vectors.test.ts` (loads the JSON with `readFileSync` + `JSON.parse`):
   - **hkdf:** `deriveSessionKeyFromSharedSecret(Buffer.from(ikm_hex, "hex"))` equals `session_key_hex` — for every vector. (This is where the library's hand-rolled HKDF meets the OpenSSL-derived expected value — the mirrored-bug detector.)
   - **ecdh_p256:** for every vector, derive both directions through the *library* (`loadEphemeralKeypair` + `deriveSessionKey`) **and** both directions through the *bridge* (`loadKeypair` + `deriveSessionKey` from `../apps/broker/connector/server/crypto.js`, imported exactly as `tests/mcpb-crypto-interop.test.ts` already does); all four results equal `session_key_hex`. Also assert the recorded `*_public_b64` values match what each implementation reconstitutes.
   - **envelope, decrypt direction (Layer 1 + 2):** for both implementations, opening the vector's envelope yields a value deep-equal (`toEqual`) to `plaintext`; additionally, decrypting via raw `createDecipheriv` in the test yields exactly the `plaintext_json` bytes (pins the byte layer without depending on either implementation's parse step).
   - **envelope, ENCRYPT direction (Layer 1) — both implementations:** first assert the canonical precondition `JSON.stringify(vector.plaintext) === vector.plaintext_json`; then `sealWithIv(vector.plaintext, key, iv)` (library, imported from `../src/crypto/envelope.js`) and `bridgeSeal(vector.plaintext, key, iv)` (bridge, fixed-IV param) must each produce `ct` and `tag` **exactly equal** to the vector's — proving each implementation serializes and encrypts byte-for-byte with the supplied fixed IV.
   - **envelope_reject:** both implementations throw for every vector.
   - **Fixed-IV hooks reject wrong-length IVs:** the bridge's `seal(frame, key, iv)` throws when `iv` is not exactly 12 bytes (test with an 8-byte and a 16-byte IV), and the library's `sealWithIv` does the same — a wrong-length caller-supplied IV must fail loudly at seal time, never produce an envelope that `open()` would then reject.
   - **Published copy BYTE-identical:** `readFileSync` both `vectors/crypto-v1.json` and `apps/broker/public/interop/crypto-v1.json` as Buffers and assert `canonical.equals(published)` — raw bytes, not parsed equality — enforcing the generator's identical-bytes contract. (The `.gitattributes` `eol=lf` entries from §2 make this safe on Windows checkouts; if the byte check ever fails with only-EOL differences, the fix is the checkout/attributes, not loosening the test.)
   - **`seal()` random-IV path unchanged:** `openEnvelope(seal(pt, key), key)` equals `pt`, and two `seal()` calls produce different IVs — confirms the refactor to `sealWithIv` delegation kept production behavior.
5. **Python verifier** `interop/verify_vectors.py`:
   - Stdlib + `cryptography` package only (same primitives the skill's Python recipe uses: `ec.derive_private_key` / `ECDH`, `HKDF`, `AESGCM`) — this supplies the primitive-level independent confirmation noted in step 3.
   - Reads a vectors file path from argv (default `vectors/crypto-v1.json`), runs every section **in both directions for `envelope`** (encrypt the exact `plaintext_json` bytes with key+iv → expect exact ct+tag; decrypt → expect exact `plaintext_json` bytes, then `json.loads` deep-equal to `plaintext`), prints per-section pass/fail, exits non-zero on any mismatch. For `envelope_reject`, `AESGCM.decrypt` raising `InvalidTag` (or a length/version check failing) counts as pass. Note: `AESGCM` takes `ct || tag` concatenated — join the envelope's `ct` and `tag`.
   - Manual tool, not wired into `npm test` or CI (CI images aren't guaranteed Python + `cryptography`). Document the run command in `docs/interop-vectors.md`.
6. **Docs:** write `docs/interop-vectors.md` (format spec ≈ §3, the two-layer contract, the ECDH-primitive-independence caveat, consumption instructions, published URL, and "how to regenerate" with a warning that regenerating is a **compatibility event** — vectors should only ever be *added*, never changed, while `v: 1` crypto is live). Make the README edits from §2.
7. **`.gitattributes`** entries from §2 (create the file if absent). Verify after commit that a fresh clone on Windows yields byte-identical vector files (`git ls-files --eol` shows `lf` for both).
8. **CI workflow** `.github/workflows/library.yml`, modeled on `broker.yml`: Node 22, `npm ci`, `npm run lint`, `npm test`. Path filters (push to `main` + pull_request) must cover every input to the vector suite: `src/**`, `tests/**`, `vectors/**`, `scripts/**`, `interop/**`, **`apps/broker/connector/server/crypto.js`**, **`apps/broker/public/interop/**`**, `package.json`, **`package-lock.json`**, and the workflow file itself — the bridge and published-copy paths matter because broker CI does **not** run root vitest, so without them a bridge-crypto or published-copy edit would bypass the vector suite entirely. The existing root test suites (`basic`, `broker`, `websocket`, etc.) are hermetic — confirm the full suite passes on a clean `npm ci` locally before adding the workflow. If any existing test turns out to be environment-dependent in CI, do **not** make the test step non-blocking; skip that specific test explicitly (`it.skip` with a comment) and call it out in the PR.
9. **PR** per `AGENTS.md`: CI green before merge; two-strike rule on repeated failures.

## 5. Test plan

- `npm test` at the repo root (vitest) — the new `tests/vectors.test.ts` plus all existing suites (`crypto`, `mcpb-crypto-interop`, `basic`, `broker`, `websocket`) must pass.
- `npm run lint` (`tsc --noEmit`) must pass — the compiled surfaces changed are `src/crypto/envelope.ts`, `src/crypto/session-key.ts`, `src/index.ts`.
- Manual: `npx tsx scripts/generate-vectors.ts` run twice produces byte-identical output (determinism check), and the two written copies are byte-identical to each other.
- Manual: `python interop/verify_vectors.py` passes locally, both directions (documented, not CI-gated).
- Negative checks during development (do not commit): (a) flip one hex char in a committed vector → vitest fails loudly; (b) edit one byte of the published copy only → the byte-identical test fails; (c) revert both.

## 6. API / interface changes

- **Library (npm public surface via `src/index.ts`):** two new exports, both additive — `loadEphemeralKeypair(privateKeyB64: string): EphemeralKeypair` and `deriveSessionKeyFromSharedSecret(sharedSecret: Buffer): Buffer`. No signature or behavior change to anything existing. No wire-format change.
- **Library (module-level, NOT on the public index):** `sealWithIv(plaintext, sessionKey, iv)` exported from `src/crypto/envelope.ts` only, with a KAT-only warning; `seal()` now delegates to it with a random IV (behavior-identical).
- **Bridge (internal to the `.mcpb`):** `seal(frame, key, iv?)` gains an optional fixed-IV third parameter, default `randomBytes(12)` (behavior-identical when omitted).
- **Broker HTTP surface:** one new **static** public asset, `GET /interop/crypto-v1.json` (served by Next's `public/` dir — no route code, no auth, no DB). Nothing else.
- **No changes** to the skill, the installer, the MCP connector's protocol behavior, Prisma schema, or any authenticated API.

## 7. Deploy / release considerations

- **No ServiceDesk wrap** — Back Channel deploys via manual `gcloud builds submit` to Cloud Run (see `AGENTS.md`); merging to `main` changes nothing in production by itself. (Note: `apps/broker/DEPLOY.md` still describes an older trigger-based deployment and is stale — the manual `gcloud builds submit` path in `AGENTS.md` is authoritative. Updating DEPLOY.md is out of scope for this feature.)
- The published vectors file goes live on the **next routine broker deploy** (standard `gcloud builds submit --config=apps/broker/cloudbuild.yaml "--substitutions=_TAG=<tag>,_CLOUDSQL_INSTANCE=backchannel-skyflyt:us-west1:backchannel-db"`). There is zero urgency: the repo copy is canonical, and nothing running depends on the URL. No env-var, DB, or `service.yaml` changes.
- The `.mcpb` bundle: the bridge's `crypto.js` change is signature-compatible and behavior-identical at runtime; it ships whenever the connector is next rebuilt/versioned — no forced release needed for this feature.
- No skill revision bump (skill untouched), so no `skill.sha256` / install-integrity-manifest churn.
- Versioning: this is a docs/tests-level addition to the library; a patch bump of the root `package.json` version is fine but optional (the library isn't currently published to npm on a cadence).
- **Compatibility policy going forward** (recorded in `docs/interop-vectors.md`): existing vectors in `crypto-v1.json` are immutable; new vectors may be appended; a breaking crypto change would ship as `crypto-v2.json` alongside an envelope `v: 2` — never by editing v1 vectors.

## 8. Size estimate

~8 new files + 5 small edits; roughly 200 lines of generator, 200 lines of tests, 150 lines of Python, 40 lines of library/bridge additions, plus docs. One focused implementation pass.
