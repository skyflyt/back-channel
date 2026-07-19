# Back Channel crypto-v1 interop test vectors

Frozen known-answer tests (KATs) for Back Channel's v1 end-to-end crypto.

- **Canonical copy (this repo):** [`vectors/crypto-v1.json`](../vectors/crypto-v1.json)
- **Published copy:** <https://back-channel.app/interop/crypto-v1.json>

The two are byte-identical, and a test enforces it. Your implementation is
crypto-v1 compatible **iff** it passes every vector in this file.

## What v1 crypto is

| Layer | Definition |
|---|---|
| Handshake | ECDH on `prime256v1` (P-256 / secp256r1). Public keys are the **uncompressed point**, base64 on the wire. |
| KDF | HKDF-SHA-256 over the raw ECDH shared secret. **Salt = 32 zero bytes**, **info = `back-channel/v1/session-key`**, **L = 32**. |
| AEAD | AES-256-GCM, **12-byte IV**, **16-byte tag**, **no AAD**. |
| Plaintext | UTF-8 bytes of the JSON-serialized frame. |
| Envelope | `{ "type": "enc", "v": 1, "iv": b64, "ct": b64, "tag": b64 }` |

## The compatibility contract has two layers

JSON serialization is not canonical — key order and whitespace vary by runtime —
so "byte-compatible" needs to be stated carefully. The vectors certify two
distinct things, and a conforming implementation must not blur them:

**Layer 1 — byte-exact cipher path.** Given a vector's exact `plaintext_json`
**string bytes**, its `key_hex`, and its `iv_b64`, you MUST produce exactly the
recorded `ct` and `tag`; and decrypting that envelope MUST recover exactly those
bytes. This pins the KDF, the AEAD, and the UTF-8 encoding byte-for-byte.

> ⚠️ For Layer-1 checks, encrypt the `plaintext_json` **string**, never a
> re-serialization of the `plaintext` value. Python's `json.dumps` inserts a
> space after `:` and `,` by default and would produce different bytes — and
> therefore a different, wrongly-failing ciphertext.

**Layer 2 — semantic JSON interop.** A conforming **receiver** parses the
decrypted bytes as JSON and compares **by value**: key order and whitespace are
explicitly *not* part of the contract. A conforming **sender** in production may
serialize however its runtime does. Receivers must never depend on a peer's
byte-level serialization choices.

Layer 1 is testable through `JSON.stringify` only because every `envelope`
vector satisfies, and the generator asserts before writing:

- `JSON.stringify(JSON.parse(plaintext_json)) === plaintext_json`, and
- `JSON.stringify(vector.plaintext) === plaintext_json`.

In practice that means: object keys are non-integer-like strings (JS preserves
insertion order for those), no floats with unstable formatting, and
`plaintext_json` is compact `JSON.stringify` style with no added whitespace.

## File format

```jsonc
{
  "_meta": { "name": ..., "version": 1, "spec": {...}, "generator": ..., "published": ... },

  "hkdf": [                       // KDF in isolation
    { "name": ..., "ikm_hex": ..., "session_key_hex": ... }
  ],

  "ecdh_p256": [                  // the whole handshake path
    { "name": ...,
      "alice_private_hex": ..., "alice_public_b64": ...,
      "bob_private_hex": ...,   "bob_public_b64": ...,
      "shared_secret_hex": ..., // raw ECDH output, pre-HKDF
      "session_key_hex": ...    // post-HKDF — the actual AES key
    }
  ],

  "envelope": [                   // used in BOTH directions
    { "name": ..., "key_hex": ..., "iv_b64": ...,
      "plaintext": { ... },       // parsed JSON value  (Layer 2)
      "plaintext_json": "{...}",  // exact canonical bytes (Layer 1)
      "envelope": { "type": "enc", "v": 1, "iv": ..., "ct": ..., "tag": ... }
    }
  ],

  "envelope_reject": [            // every one MUST be refused
    { "name": ..., "key_hex": ..., "envelope": {...}, "reason": ... }
  ]
}
```

Key material is **hex**; wire-format fields are **base64**, matching how each
appears in the protocol. Private keys are raw P-256 scalars — the values
recorded are the actual scalars in use, so consumers never re-derive them.

`envelope_reject` covers: a flipped tag byte, a flipped ciphertext byte, a
correct envelope under the wrong key, an 8-byte IV, and `"v": 2`.

## Consuming the vectors

Fetch <https://back-channel.app/interop/crypto-v1.json> (or read the repo copy)
and, for each section:

1. **`hkdf`** — run your HKDF over `ikm_hex`; expect `session_key_hex`.
2. **`ecdh_p256`** — load both private scalars, check the public keys match the
   recorded base64, do the exchange both directions, check both sides agree with
   `shared_secret_hex`, then HKDF to `session_key_hex`.
3. **`envelope`** — encrypt the `plaintext_json` bytes under `key_hex` + `iv_b64`
   and expect exactly `ct` + `tag`; decrypt and expect exactly those bytes, then
   parse and compare semantically to `plaintext`.
4. **`envelope_reject`** — every entry must raise/refuse. Silently returning
   garbage here is a security bug, not a compatibility nit.

Note for AEAD libraries that take a single concatenated buffer (Python's
`AESGCM`, Go's `gcm.Open`): pass `ct || tag`.

### Reference verifiers

- **JavaScript/TypeScript** — [`tests/vectors.test.ts`](../tests/vectors.test.ts)
  runs both in-repo implementations (the library and the `.mcpb` bridge) against
  every vector in both directions. Runs as part of `npm test`.
- **Python** — [`interop/verify_vectors.py`](../interop/verify_vectors.py),
  a standalone verifier built on the `cryptography` package:

  ```sh
  pip install cryptography
  python interop/verify_vectors.py                 # defaults to vectors/crypto-v1.json
  python interop/verify_vectors.py path/to/file.json
  ```

  It prints per-section pass/fail and exits non-zero on any mismatch. It is
  deliberately **not** wired into `npm test` or CI, since CI images aren't
  guaranteed to have Python plus `cryptography`.

## How the expected values are generated (and why that matters)

[`scripts/generate-vectors.ts`](../scripts/generate-vectors.ts) — run with
`npx tsx scripts/generate-vectors.ts`.

The design rule is **independence**: no expected value is computed by the code
the vectors certify.

- HKDF values come from `node:crypto`'s OpenSSL-backed `hkdfSync`, not the
  library's hand-rolled HMAC expand loop.
- Ciphertexts come from `createCipheriv` directly, not from `seal()`.
- The library and the bridge appear only in a **post-generation self-check**
  phase, as assertions. Any self-check failure aborts before writing — such a
  failure means a real implementation bug, which is precisely the point.

This matters because the repo's other crypto tests can't catch a **mirrored**
bug: `tests/crypto.test.ts` seals and opens with the same code, and
`tests/mcpb-crypto-interop.test.ts` checks two implementations that were written
in this repo from the same reading of the spec. A shared misreading of, say, the
HKDF expand step would pass both. It cannot pass these vectors.

**Honest caveat on ECDH.** The EC point-multiply primitive is OpenSSL in both
the generator and the library, so for `ecdh_p256` what the vectors independently
pin is the *composition* — uncompressed-point base64 encoding, shared-secret
handling, and every HKDF parameter — not the curve arithmetic itself.
Primitive-level independence comes from `interop/verify_vectors.py`, which runs
the same vectors through the `cryptography` package's own stack.

The generator is fully deterministic (no `randomBytes` anywhere); re-running it
must produce byte-identical output.

## Compatibility policy — regenerating is a compatibility event

While `v: 1` crypto is live:

- **Existing vectors are immutable.** Never edit a value in `crypto-v1.json`. If
  a change to the code makes a vector fail, the code is wrong, not the vector.
- **New vectors may be appended.** Adding coverage is always safe.
- **A breaking crypto change ships as `crypto-v2.json`**, alongside an envelope
  `v: 2` — never by editing v1 vectors.

Both copies must stay byte-identical; `.gitattributes` pins them to LF so a
Windows checkout can't rewrite them to CRLF and false-fail the byte comparison.
If the byte-identity test ever fails with only end-of-line differences, fix the
checkout, not the test.
