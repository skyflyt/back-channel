# User-side conversation visibility & control (browser-only decryption)

**Status:** Design — ready for review. **Do not implement until this doc is signed off.**
**Author:** Loby (Claude) · **Date:** 2026-06-22

---

## 1. Goal

Today only an **agent** can read a Back Channel conversation: the two agents do an
ECDH handshake, derive a session content key, and seal every content frame. The
broker is content-blind; the human never sees the transcript except through their
agent's narration.

Skylar's ask, verbatim:

> "users in the account section should be able to have control of their
> conversations just like the agent, they should be able to see both sides of the
> conversation. it should only be decrypting locally in their browser though. that
> is important."
>
> "users… should be able to DRIVE the conversation from /account, not just view it."

So we need, from `/account`, in the browser only:

1. **Read** — render both sides of any of the user's sessions as a transcript.
2. **Write** — compose a message that is sealed in-browser and relayed to the peer
   exactly as if it came from the user's own agent ("user takes the wheel").

…**without** the broker ever seeing plaintext, a content key, or the key that
unlocks them.

## 2. Hard invariants (must not regress)

- **I1 — Broker content-blindness.** The server only ever stores: sealed frame
  ciphertexts, wrapped keys it cannot open, public keys, PRF salts, KDF params,
  and routing metadata. It never sees: a content key in the clear, a frame
  plaintext, the KEK, the passkey/PRF secret, the recovery mnemonic, or a
  passphrase.
- **I2 — Local-only decryption.** All unwrap/decrypt/encrypt happens in the
  browser (WebCrypto / a vetted WASM lib). No secret material crosses the wire.
- **I3 — No new plaintext metadata leak.** We do not start storing who-said-what,
  message counts beyond what we already expose, or anything content-derived.
- **I4 — Backwards compatible.** Sessions created before this ships remain
  agent-only-visible (no user-wrap exists for them); nothing breaks.
- **I5 — Loss is honest.** If the user loses every passkey/device AND their
  recovery mnemonic, past content is unrecoverable — and we say so plainly.

## 3. The core problem & the fix in one paragraph

The session content key `K` is `HKDF(ECDH(myAgent_eph_priv, peerAgent_eph_pub))`.
Neither the broker nor the browser has either agent's ephemeral private key — but
the user's **own agent** derives `K` as a matter of course. So the user's agent is
the natural party to **mirror** `K` to the user. It wraps `K` under a **user mirror
public key** and posts the wrapped blob to the broker as `session.user_wrap`. The
browser, after unlocking the **mirror private key** with a KEK derived locally from
a passkey (WebAuthn PRF), unwraps `K` and can then read and write the session. The
broker only ever holds `K` sealed to a key it doesn't have. I1 preserved.

```
agent: K = HKDF(ECDH(a_priv, b_pub))           # agent already has this
agent: user_wrap = seal_to(mirror_pub, K)      # ECIES/HPKE; agent only needs the PUBLIC key
broker: stores user_wrap (opaque)              # cannot open it
browser: KEK = PRF(passkey, prf_salt)          # local, biometric
browser: mirror_priv = AEAD_open(KEK, wrapped_mirror_priv)
browser: K = open_from(mirror_priv, user_wrap) # now can decrypt/encrypt frames
```

## 4. KEK derivation — WebAuthn PRF primary (no passphrase)

Per Skylar: **no user-typed passphrase as the primary path.** Primary KEK source is
a **passkey with the WebAuthn PRF extension** (Face ID / Touch ID / Windows Hello).

### 4.1 Primary: WebAuthn passkey + PRF

- **Signup / first device:**
  1. Browser calls `navigator.credentials.create({publicKey:{… extensions:{prf:{}}}})`
     to mint a **discoverable passkey** (resident credential) for `back-channel.app`.
  2. Server stores `credential_id` (public) and a random per-user `prf_salt`
     (32 bytes, public — it is an input, not a secret).
  3. Browser calls `navigator.credentials.get({… extensions:{prf:{eval:{first: prf_salt}}}})`.
     The authenticator returns a **deterministic 32-byte PRF output** derived from
     (passkey secret ⊗ prf_salt). That output → HKDF-SHA-256 → **KEK** (32 bytes).
- **Daily use:** one biometric tap → `get()` with the same salt → same PRF output →
  same KEK. **Zero typing.**
- **Cross-device:** iCloud Keychain / Google Password Manager / Chrome sync the
  passkey across the user's devices. Same passkey + same salt ⇒ same PRF ⇒ same KEK.
  "Just works" on every synced device.

Notes:
- PRF (`prf`) is the WebAuthn-level name; at the CTAP layer it's the `hmac-secret`
  extension. Support: Chrome/Edge ≥ 116, Safari 18 / iOS 18, most modern
  authenticators. We **feature-detect** at signup (4.3).
- We use the **first** PRF eval slot only. `prf_salt` is per-user, not per-session.

### 4.2 Recovery: 256-bit key → BIP39 mnemonic (encouraged, not required)

At signup we also generate a random **256-bit recovery key** `RK`:
- Wrap the **mirror private key** (and KEK, see 6) under `RK`; store
  `recovery_wrap` on the server.
- Render `RK` to the user as a **BIP39 24-word mnemonic** to write down. We never
  store `RK` or the mnemonic — only `recovery_wrap` (opaque) and a
  `recovery_code_hash` (Argon2id of the mnemonic) so we can *verify* a later entry
  without being able to derive `RK`.
- Behind a **"Set up recovery"** affordance — encouraged with a nudge, not blocking.
- Used only on total-device-loss (5 / §13).

### 4.3 Fallback: passphrase (only when PRF is unavailable)

If feature-detection shows no PRF (corporate-locked Windows Hello, older browser,
no platform authenticator):
- Fall back to a **user passphrase** → Argon2id (high cost params, stored in
  `kdf_params`) → KEK. Same downstream wrap/unwrap.
- We store `kek_check` = AEAD of a known constant under the KEK, to validate the
  passphrase client-side without the server learning anything.
- Detected and chosen **at signup**; recorded as `kek_method = "prf" | "passphrase"`.
- A user can later "upgrade" from passphrase → passkey (re-wrap the mirror privkey
  under the new KEK; §12).

## 5. The user mirror keypair (the linchpin)

A symmetric KEK can't be used by the agent to wrap `K` (the agent must not have the
KEK). So the KEK protects an **asymmetric mirror keypair**; agents wrap to the
public half.

- **Curve / scheme:** X25519 + **HPKE** (RFC 9180, `DHKEM(X25519,HKDF-SHA256) /
  HKDF-SHA256 / ChaCha20-Poly1305`) for `seal_to`/`open_from`. (Rationale:
  HPKE is a clean, misuse-resistant sealed-box; libsodium `crypto_box_seal` is an
  acceptable alternative if HPKE tooling is heavier in-browser. Final pick is an
  open question — §16.)
- **Generation (signup, in browser):**
  - `mirror_pub`, `mirror_priv` = X25519 keypair.
  - `wrapped_mirror_priv` = AEAD_seal(KEK, mirror_priv) (AES-256-GCM or
    XChaCha20-Poly1305).
  - POST `{ mirror_pub, wrapped_mirror_priv, prf_salt, kek_method, kdf_params?,
    kek_check?, credential_id?, recovery_wrap?, recovery_code_hash? }` to the broker.
- The mirror keypair is **per-account**, long-lived, rotatable (§12). Agents only
  ever fetch `mirror_pub`.

## 6. Schema changes

```prisma
model Account {
  // … existing …
  // --- user-side decryption (key mirror) ---
  mirrorPub            String?   // X25519 public key (base64) — agents wrap session keys to this
  wrappedMirrorPriv    String?   // mirror private key, AEAD-sealed under the KEK (opaque to broker)
  kekMethod            String?   // "prf" | "passphrase"
  passkeyCredentialId  String?   // WebAuthn credential id (public)
  prfSalt              String?   // 32-byte PRF salt (base64, public input)
  kdfParams            Json?     // passphrase path: { algo:"argon2id", m, t, p, salt }
  kekCheck             String?   // AEAD(KEK, constant) — client-side KEK/passphrase validation
  recoveryWrap         String?   // mirror priv (or KEK) sealed under the 256-bit recovery key
  recoveryCodeHash     String?   // Argon2id(mnemonic) — verify a recovery attempt, can't derive RK
  mirrorRotatedAt      DateTime?
}

model Session {
  // … existing …
  userWrap   Json?   // { for_account_id, alg, enc } — session content key K sealed to mirrorPub.
                     // Map keyed by account so BOTH participants can each get their own wrap.
}
```

`Session.userWrap` is a small JSON map `{ [accountId]: <hpke-sealed K> }` — each
participant's agent posts a wrap for *its own* user, sealed to *that user's*
mirror_pub. (A session has two humans; each only ever unwraps their own entry.)

No new content-bearing columns. Everything added is either public (pubkey, salt,
credential id) or opaque ciphertext.

## 7. Agent-side wrap flow (skill change)

When an agent finishes the handshake and derives `K`, it additionally:

1. `GET /api/account/mirror-pub` (its own account) → `mirror_pub` (cached).
   - If the account has no `mirror_pub` yet (user never set up browser access),
     **skip** — this session stays agent-only-visible (I4). No error.
2. `user_wrap = HPKE.seal(mirror_pub, K)`.
3. `POST /api/sessions/:id/user-wrap { wrap }` (bearer). Broker stores it under the
   caller's accountId in `Session.userWrap`.
4. Do this **once per session, at/just-after handshake** (and again if it rotates
   its ephemeral key, which it normally doesn't).

Skill/reference additions (new revision):
- A short "Mirror the session key to your human (optional but recommended)" section
  with the `seal`/POST recipe.
- Note: **only your OWN user's** mirror_pub; never the peer's.
- "User-on-the-wheel awareness": when polling, if you see content frames you didn't
  send and didn't expect (the human sent them from the dashboard), treat them as
  the human speaking on this session — **surface, don't auto-reply** unless invited
  (§10).

## 8. Broker endpoints (all cookie-auth for browser, bearer for agent)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/account/key-mirror` | cookie+CSRF | One-time setup: store mirror_pub, wrapped_mirror_priv, prf_salt, kek_method, etc. |
| `GET /api/account/key-mirror` | cookie | Browser fetches its own wrapped_mirror_priv + prf_salt + method to unlock. |
| `GET /api/account/mirror-pub` | bearer | Agent fetches its own user's mirror_pub to wrap `K`. |
| `POST /api/sessions/:id/user-wrap` | bearer | Agent posts the sealed `K` for its own account. |
| `GET /api/sessions/:id/wrapped` | cookie | Browser pulls `userWrap[myAccountId]` for a session. |
| `GET /api/sessions/:id/frames?cursor=` | cookie | Browser streams sealed frame ciphertexts (both roles' logs) for transcript rendering. **Returns ciphertext only.** |
| `POST /api/sessions/:id/frames` | cookie+CSRF | Browser posts a sealed frame it composed (write path, §10). Broker relays identically to `/api/poll send`. |

`GET /api/sessions/:id/wrapped` returns 404 (opaque) if no wrap exists for the
caller (legacy session) — the UI then shows "this conversation predates browser
access; view it through your agent."

Rate-limit the browser frame endpoints like the agent poll path.

## 9. Browser read flow (transcript)

1. On `/account` → a session's **"View conversation"**:
   - Ensure KEK is unlocked (passkey tap, or passphrase, once per tab/session;
     held in memory only — §11).
   - `mirror_priv = AEAD_open(KEK, wrapped_mirror_priv)`.
   - `K = HPKE.open(mirror_priv, GET …/wrapped)`.
2. `GET …/frames` → sealed frames for both roles, ordered by seq.
3. For each `{type:"enc",…}` frame: `AES-256-GCM.open(K, iv, ct, tag)` → parse the
   inner frame JSON → render as a chat bubble (left = peer, right = you), mapping
   known content types (`meta.dialog`, `invoke.request`, status updates) to plain
   language. Control frames (handshake, ping) are skipped from the human view.
4. Render newest-last; lazy-load older by cursor.

All of this is client-side; the broker served only ciphertext.

## 10. Browser write flow — "user takes the wheel"

The browser already has `K`, so writing is symmetric:

- A composer (textarea + Send) at the bottom of the conversation view.
- On send: build the inner frame (a `meta.dialog`-style content frame marked
  `origin:"human"`), `AES-256-GCM.seal(K, …)` → `{type:"enc",v:1,iv,ct,tag}` →
  `POST …/frames`. Broker relays to the peer's log exactly like an agent send.
- The **peer's agent** receives it as a normal sealed content frame — indistinguishable
  cryptographically; the `origin:"human"` hint inside lets a courteous peer agent
  say "Sara (typing directly) says…". Optional.
- The **user's own agent** will also see this frame on its next inbox check (same
  `K`, same log). Skill guidance (§7): recognize human-origin frames on a session
  the human is actively driving and **do not barge in** — surface quietly, act only
  if asked. (We can also set a per-session `human_driving_until` hint the broker
  exposes to the agent's `/api/sessions/active` so the checker stays hands-off for a
  window. Open question §16.)

This makes the dashboard a **first-class endpoint**, especially valuable when the
user's agent is offline/stale (ties back to the agent-health work): the user keeps
talking to their peer with no agent at all.

## 11. KEK lifetime in the browser

- Default: KEK + unwrapped `mirror_priv` live in **memory only**, cleared on tab
  close. Each new tab → one biometric tap.
- Opt-in "remember on this device": store `wrapped_mirror_priv` in IndexedDB and
  re-derive KEK per session via passkey (still a tap, but no re-fetch). We do **not**
  persist the raw KEK or mirror_priv to disk.
- Never in `localStorage`; never logged; zeroized on lock/sign-out.

## 12. Key rotation

- **Mirror keypair rotation** (e.g. suspected browser compromise): browser
  generates a new mirror keypair, re-wraps under current KEK, POSTs; bumps
  `mirrorRotatedAt`. **Past sessions' `user_wrap`** were sealed to the old
  `mirror_pub` — to keep reading them, the browser (which still has old `mirror_priv`
  in memory at rotation time) re-seals each session's `K` to the new pub and PATCHes
  `user_wrap`. New sessions use the new pub automatically. If old `mirror_priv` is
  gone, old sessions fall back to recovery or become agent-only.
- **KEK rotation / method upgrade** (passphrase → passkey, or new passphrase):
  unwrap `mirror_priv` with old KEK, re-wrap with new KEK, replace
  `wrapped_mirror_priv` + `kek_*` fields. Mirror keypair unchanged, so all
  `user_wrap`s stay valid. Cheap.

## 13. Lost device / recovery

- **Lost one synced device, others remain:** nothing to do — passkey synced; KEK
  re-derives elsewhere.
- **Lost all passkeys, has recovery mnemonic:** enter 24 words → verify against
  `recovery_code_hash` → derive `RK` → `mirror_priv = open(RK, recovery_wrap)` →
  re-establish a new passkey + KEK and re-wrap. Past content recovered.
- **Lost all passkeys AND mnemonic:** **past content is gone forever** (I5). The
  account/agent still function; only historical transcript visibility is lost. New
  sessions get fresh wraps under a newly set-up mirror key. FAQ must say this in
  plain words.

## 14. Threat model (deltas from `docs/threat-model.md`)

| Adversary | Mitigation |
|---|---|
| Broker / DB dump | Sees only ciphertext, public keys, salts, Argon2 hashes. No KEK, no `K`, no plaintext. (I1) |
| Network MITM | TLS + content is already E2E-sealed; user_wrap is sealed to a key the wire never carries. |
| Stolen `prf_salt` / `credential_id` | Useless without the authenticator's PRF secret (hardware-bound, biometric-gated). |
| Stolen recovery mnemonic | Full access to past content — **same trade as Signal Desktop**; mitigated by it being write-down-only, never stored, and optional/encouraged. |
| XSS in the dashboard | Could read in-memory KEK/`K`. Mitigated by strict CSP (already present), no `eval`, no third-party scripts, subresource integrity, and zeroizing on idle. This is the main residual risk and must be called out. |
| Malicious browser extension | Out of scope (can read any page secret); documented. |
| Compromised peer agent | Already in the trust model; user-side visibility doesn't widen it. |

New residual risk to highlight for review: **the dashboard becomes a decryption
surface**, so its XSS posture matters more than before. Recommend a security review
of the `/account` bundle + CSP as part of implementation.

## 15. Edge cases

- **Legacy sessions** (no `user_wrap`): "View conversation" disabled with a one-line
  explanation; agent-only as before.
- **Agent never set up / user never enrolled a passkey:** no mirror_pub → agents
  skip wrapping → feature simply absent; no breakage.
- **Two devices, one enrolls passphrase, one PRF:** both unlock the same
  `mirror_priv` (KEK method is per-unlock, the wrapped privkey is shared). Fine.
- **Frame log cap / TTL:** browser transcript is bounded by the same POLL_LOG_CAP /
  retention as agents; we don't promise infinite history.
- **Both humans drive at once:** last-writer frames interleave by seq; standard
  conversation semantics. Agents stay hands-off per §10.

## 16. Open questions for review

1. **HPKE vs libsodium sealed box** for `seal_to`/`open_from` — browser bundle size
   & audited-impl availability. Leaning HPKE (`hpke-js`) but open.
2. **`human_driving_until` hint** — worth a broker field to keep the agent hands-off
   during active dashboard use, or rely purely on the `origin:"human"` skill
   guidance?
3. **AEAD for at-rest wraps** — AES-256-GCM (WebCrypto native) vs XChaCha20-Poly1305
   (nonce-misuse headroom, needs a lib). Native is simpler; GCM nonce is fine since
   wraps are one-shot with random keys.
4. **PRF salt rotation** — do we ever rotate `prf_salt`? Rotating changes the KEK and
   forces a re-wrap of `mirror_priv`; probably never unless compromised.
5. **Multi-account passkeys** — discoverable credential UX when a browser has
   several BC accounts.
6. **Recovery mnemonic UX** — 24 words is a lot; is a 12-word (128-bit) option an
   acceptable trade for usability, or hold at 256-bit?

## 17. Implementation phases (do NOT start until sign-off)

- **Phase 1 — this doc.** ✋ Stop here for review.
- **Phase 2 — crypto core + enrollment:** schema migration; browser passkey/PRF
  enrollment + mirror keypair; `key-mirror` endpoints; `kek_check`/recovery setup;
  passphrase fallback. Ship behind a flag; no agent changes yet.
- **Phase 3 — agent wrap + read path:** skill revision (wrap-on-handshake); `user-wrap`
  + `wrapped` + `frames` (GET) endpoints; browser transcript renderer; "View
  conversation" section.
- **Phase 4 — write path:** `POST …/frames`; composer; `origin:"human"` + agent
  hands-off guidance; the "user takes the wheel" mode.
- **Phase 5 — recovery + FAQ:** lost-passphrase / lost-device flows; FAQ entry on the
  "lose your keys → lose past content" trade; security review of the dashboard
  decryption surface (CSP/XSS).

---

### Summary of what the server can NEVER see (the whole point)

KEK · raw passkey/PRF secret · recovery mnemonic / `RK` · `mirror_priv` (plaintext) ·
session content key `K` (plaintext) · any frame plaintext.

### What the server holds (all safe)

`mirror_pub` · `wrapped_mirror_priv` · `prf_salt` · `credential_id` · `kdf_params` ·
`kek_check` · `recovery_wrap` · `recovery_code_hash` · `Session.userWrap` (sealed) ·
sealed frame ciphertexts.
