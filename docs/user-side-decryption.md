# User-side conversation visibility & control (browser-only decryption)

**Status:** Design v2.1 — second-pass review edits landed. **Ready for final spot-check.**
**Do not start Phase 2 until that spot-check signs off.**
**Author:** Loby (Claude) · **v1:** 2026-06-22 · **v2:** 2026-06-23 · **v2.1 (2nd-pass edits):** 2026-06-23

> **v2 changelog** is at the end (§19) — it maps every review finding (B1–B5,
> S1–S8, nits) to the section that resolves it, and records the one push-back.

---

## 1. Goal

Today only an **agent** can read a Back Channel conversation: the two agents do an
ECDH handshake, derive a session content key, and seal every content frame. The
broker is content-blind; the human never sees the transcript except through their
agent's narration.

Skylar's ask, verbatim:

> "users in the account section should be able to have control of their
> conversations just like the agent… they should be able to see both sides… it
> should only be decrypting locally in their browser though."
>
> "users… should be able to DRIVE the conversation from /account, not just view it."

So, from `/account`, **in the browser only**: **read** both sides of any of the
user's sessions, and **write** a message that is sealed in-browser and relayed to
the peer exactly as if it came from the user's own agent ("user takes the wheel").

## 2. Hard invariants

- **I1 — Broker content-blindness.** Server stores only: sealed ciphertexts,
  wrapped keys it cannot open, public keys, PRF salts, KDF params, opaque hashes,
  routing metadata. Never: a content key in clear, a frame plaintext, the KEK, the
  passkey/PRF secret, the recovery mnemonic, or a passphrase.
- **I2 — Local-only decryption.** All unwrap/decrypt/encrypt is in the browser.
- **I3 — Minimal metadata, honestly bounded.** *(revised — see S1)* This feature adds
  exactly one new observable to the broker: **whether an account has enrolled
  browser access** (the presence of `mirrorPub`). It does **not** reveal per-session
  whether a wrap was generated (decoys, S1), nor any content. We accept and document
  the coarse "enrolled?" capability flag; everything else stays blind.
- **I4 — Backwards compatible.** Pre-feature sessions stay agent-only until/unless an
  agent back-wraps the current key once the user enrolls (S5).
- **I5 — Loss is honest.** Lose every passkey *and* the recovery mnemonic → past
  content is unrecoverable, and we say so.

## 3. Core idea

Session content key `K = HKDF(ECDH(myAgent_eph_priv, peerAgent_eph_pub))`. Neither
broker nor browser has an agent's ephemeral private key — but the user's **own
agent** derives `K` normally. So the agent **mirrors** `K` to the user: it seals `K`
to a per-account **mirror public key** and posts the blob as `session.userWrap`. The
browser unlocks the **mirror private key** with a KEK derived locally (WebAuthn PRF,
§4), then unwraps `K` and can read/write. The broker only ever holds `K` sealed to a
key it lacks. (I1)

```
agent:   K          = HKDF(ECDH(a_priv, b_pub))
agent:   user_wrap  = HPKE.seal(mirror_pub, K, aad="userwrap|<sessionId>|<accountId>")
broker:  stores user_wrap (opaque) keyed by accountId + mirrorPubVersion
browser: KEK        = derive (§4)             # local, biometric or passphrase
browser: mirror_priv= AEAD.open(KEK, wrapped_mirror_priv, aad="mirror-priv-v1|<accountId>")
browser: K          = HPKE.open(mirror_priv, user_wrap)
```

**Crypto choices (resolved, not open):**
- **Wrap/seal:** HPKE (RFC 9180), `DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
  ChaCha20-Poly1305`, via a vetted `hpke-js`-class lib. (resolves §16.1)
- **At-rest AEAD** (wrapping `mirror_priv`): AES-256-GCM (WebCrypto native), random
  96-bit IV (one-shot, fresh random key per wrap → no reuse concern), **AAD =
  `"mirror-priv-v1" || accountId`** (nit §3).
- **Frame AEAD:** AES-256-GCM (unchanged from the existing protocol), with a
  **structured IV** to make the two-writer case collision-proof (§10, resolves B3 /
  §16.3).
- **Mirror keypair:** X25519, per-account, versioned, rotatable (§12).

## 4. KEK derivation

Primary is a **WebAuthn passkey PRF**; no user-typed passphrase on the happy path.

### 4.1 Primary: WebAuthn passkey + PRF — *best-effort cross-device, not invariant* (B1)

- **Enroll (a device):** `navigator.credentials.create({publicKey:{…extensions:{prf:{}}}})`
  → discoverable passkey for `back-channel.app`; server stores `credential_id`
  (public) + a per-user `prf_salt` (32B, public input). Then `get({…prf:{eval:{first:
  prf_salt}}}})` → 32-byte PRF output → HKDF → **KEK**.
- **Daily:** one biometric tap → same PRF output → same KEK → unwrap.

**Cross-device reality (corrected from v1).** WebAuthn PRF maps to CTAP2.1
`hmac-secret`, computed by the authenticator from a per-credential secret
(`CredRandom`). Whether a *synced* passkey yields the *same* PRF output on another
device depends on the platform syncing `CredRandom`, which is a **platform
commitment, not a WebAuthn/CTAP guarantee**:
- **Apple** (iCloud Keychain): passkey PRF support since iOS/macOS 18 (2024); Apple's
  platform syncs the credential such that `prf` outputs match across the user's Apple
  devices. Ref: Apple Developer — "Passkeys" / WWDC24 "Streamline sign-in with
  passkey upgrades and credential managers" (2024).
- **Google** (Google Password Manager): PRF supported in Chrome ≥ 116; synced-passkey
  PRF parity across Android/Chrome per Google's passkey docs (2024–2025).
- **Known divergence cases (must handle, not assume):**
  - A passkey copied into / created on a **hardware or roaming authenticator** does
    **not** preserve `CredRandom` → PRF differs.
  - **Hybrid/caBLE** cross-device flows show vendor-inconsistent PRF behavior as of
    2026.
  - Safari < 18 and older Chromium had post-sync PRF re-derivation bugs.

**Therefore the "just works across devices" claim is best-effort.** Behavior on
divergence: every unlock attempts `AEAD.open(KEK, wrapped_mirror_priv)`; an **AEAD
auth-tag failure** (not a separate stored oracle — see B2) means "this device's KEK
doesn't match." We then prompt the user to **enroll this device** — either add a
passkey whose PRF we re-key against (add a new wrap, §4.4) or use **recovery** (§4.2)
to bootstrap a fresh per-device wrap. We never silently fail or lock them out.

### 4.2 Recovery: 256-bit key → BIP39 24-word mnemonic (encouraged; hold at 24 — S3)

At enroll, generate a random **256-bit `RK`** (this *is* the BIP39 entropy — the 24
words encode `RK` directly).
- Store `recovery_wrap = AEAD.seal(HKDF(RK), mirror_priv, aad="recovery-v1|<acct>")`.
- Render the 24 words once for the user to write down. We never store `RK` or the
  words.
- `recovery_code_hash = Argon2id(mnemonic)` is **only a UI typo/confirmation check
  and a server-side "is this the right mnemonic" gate — it is NOT a security
  control** (anyone holding the 24 words already has `RK` directly). Stated plainly
  (S3).
- **24 words / 256-bit, fixed.** Not reducing to 128-bit (resolves §16.6).
- Behind a "Set up recovery" affordance — strongly encouraged, not blocking.
- **Rotation note (B4):** `recovery_wrap` seals `mirror_priv`, so any mirror-key
  rotation MUST re-wrap `recovery_wrap` too, or recovery breaks. Enforced in §12.

### 4.3 Fallback: passphrase — hardened, with an honest residual (B2)

When PRF is unavailable (corporate-locked Hello, old browser, no platform
authenticator; detected at enroll):

- KEK = `HKDF( HMAC-pepper( Argon2id(passphrase, salt, high-cost) ) )`, where
  **`pepper` is a server-side HMAC key held in Cloud KMS / Secret Manager — NOT in
  the application DB.** Consequence: a **DB-only dump cannot mount the offline
  Argon2 guess-and-verify attack** that v1 was vulnerable to, because the pepper is
  required to compute candidate KEKs and it never lives in the DB.
- **Remove the server-side `kek_check` oracle entirely** (v1 §4.3/§6). Unlock is
  verified locally by AEAD-opening `wrapped_mirror_priv` (its auth tag is the check).
- **Entropy floor:** reject passphrases with zxcvbn score < 4 at enroll.
- The pepper is applied **server-side at unlock** via a tiny authenticated endpoint
  `POST /api/account/kek-pepper` that returns `HMAC_pepper(clientArgon2Output)` for
  the signed-in account — the server never sees the passphrase or the final KEK, only
  the Argon2 output, and applies the KMS HMAC. (This also gives us server-side
  **rate-limiting / lockout** on guess attempts, which a purely-local scheme cannot.)
- **Residual risk (documented in §14):** if **both** the DB **and** the KMS pepper
  are exfiltrated, passphrase users revert to offline-attackable (Argon2-slowed). PRF
  users are unaffected (hardware-entropy KEK).
- **Push-back / judgment call for the reviewer:** the review offered OPAQUE (PAKE) as
  option 1. OPAQUE's `export_key` would also defeat DB-only offline attack, but it's a
  substantially heavier dependency for a **fallback path used by a minority of
  users**. I chose **KMS-pepper + zxcvbn≥4 + server-side lockout** as an equivalent
  DB-dump defense at far lower complexity, and documented the both-systems-compromised
  residual. **If the reviewer wants OPAQUE specifically, I'll switch** — flagging this
  as the one place I diverged from a suggested option on cost grounds.

### 4.4 Multiple unlock methods per account (S8)

A user may have a PRF Mac *and* a PRF-incapable work laptop, or want a passphrase
backup. So `wrapped_mirror_priv` is **not a single column** — it is a set of wraps,
one per method/device (§6, `MirrorKeyWrap`). Adding a passphrase to a PRF account, or
enrolling a new device, **adds a wrap** of the same `mirror_priv` under that method's
KEK **without invalidating** the others. Unlock tries the wraps available to the
current device.

## 5. The user mirror keypair

KEK (symmetric) can't be used by the agent to wrap `K` (agent must not hold the KEK),
so the KEK protects an **asymmetric mirror keypair**; agents wrap to the public half.

- X25519 keypair generated in-browser at enroll. `mirror_pub` + `mirrorPubVersion`
  stored plaintext; `mirror_priv` stored only as `MirrorKeyWrap` blobs (§4.4).
- Long-lived, per-account, **versioned** (`mirrorPubVersion`, B4).

## 6. Schema

```prisma
model Account {
  // … existing …
  mirrorPub        String?   // X25519 public key (base64); agents wrap to this
  mirrorPubVersion Int       @default(0)   // bumped on rotation (B4); agents tag wraps with it
  prfSalt          String?   // 32B PRF salt (base64, public input)
  recoveryWrap     String?   // mirror_priv sealed under HKDF(RK) — NEVER returned except in recovery flow
  recoveryCodeHash String?   // Argon2id(mnemonic) — UI typo check only, not a security control (S3)
  mirrorRotatedAt  DateTime?
}

// One row per unlock method/device (S8). KEK never leaves the browser.
model MirrorKeyWrap {
  id               String   @id @default(uuid())
  accountId        String
  method           String   // "prf" | "passphrase"
  label            String?  // "MacBook (Touch ID)", "passphrase", …
  credentialId     String?  // WebAuthn credential id (public) for prf
  kdfParams        Json?    // passphrase: { algo:"argon2id", m,t,p, salt }  (NO kek_check — B2)
  wrappedMirrorPriv String  // AEAD(KEK, mirror_priv, aad="mirror-priv-v1|accountId")
  createdAt        DateTime @default(now())
  lastUsedAt       DateTime?
  account          Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  @@index([accountId])
}

model Session {
  // … existing …
  // Map keyed by accountId -> sealed K. ALWAYS populated (real or decoy) when the
  // participant has mirrorPub, so presence doesn't leak per-session enrollment (S1).
  userWrap        Json?   // { [accountId]: { v:<mirrorPubVersion>, enc:<hpke b64>, decoy?:true } }
}
```

- `userWrap` entry capped server-side at **256 bytes** (HPKE output ~100B; reject
  larger) (nit §6).
- No `kek_check` column anywhere (B2).

## 7. Agent-side wrap flow (skill change)

### 7.1 Wrap on handshake **and re-check on every send** (S5, B4)

After deriving/holding `K`, and **on every send thereafter**, the agent:
1. `GET /api/account/mirror-pub` (own account) → `{ mirror_pub, version }`. Cache with
   an **ETag**; revalidate via `If-None-Match`; TTL ≤ 5 min; invalidate on a 409 (nit
   §7.1, B4). If no `mirror_pub` → skip (I4); **but keep checking on later sends**, so
   a session whose user enrolls mid-life gets the current `K` back-wrapped as soon as
   it's available (S5). **Explicit (v2.1):** on the **first send after `mirror_pub`
   becomes available**, the agent posts a `user_wrap` for the **CURRENT** session `K`
   — existing/in-flight sessions are retro-wrapped, not just future ones — so a user
   who enrolls mid-conversation can immediately read that conversation's history
   going forward from `K` (frames sealed under the same `K` before enrollment are
   covered, since `K` is per-session, not per-frame).
2. `user_wrap = HPKE.seal(mirror_pub, K, aad="userwrap|<sessionId>|<accountId>")`.
3. `POST /api/sessions/:id/user-wrap { wrap, version }`. Broker stores it under the
   caller's accountId **iff `version == account.mirrorPubVersion`**, else **409
   stale_mirror_version** → agent refetches pub and retries (B4). Only **own** user's
   pub; never the peer's.
4. Idempotent; re-posting the same/newer wrap is fine.

### 7.2 Skill/reference additions (new revision)
- "Mirror the session key to your human (recommended)" with the seal/POST recipe,
  ETag caching, the 409-retry, and the every-send re-check.
- **Structured-IV mandate** for frame encryption (§10) — agents set origin bit = 0.
- **Hands-off on human handoff:** respect an encrypted `meta.handoff{until}` frame
  (§10, S4) — surface quietly, don't auto-reply while the human holds the wheel.

## 8. Broker endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/account/key-mirror` | cookie+CSRF + **step-up** | One-time/append enroll: store `mirrorPub`(+version), a `MirrorKeyWrap`, `prfSalt`, recovery. **Refuses to overwrite an existing mirror without step-up re-auth** (nit §14). |
| `GET /api/account/key-mirror` | cookie | Returns `mirrorPub`, `mirrorPubVersion`, the caller's `MirrorKeyWrap`s + `prfSalt`. **Never returns `recoveryWrap`** unless `?recovery=1` in an authenticated recovery flow (nit §8). |
| `POST /api/account/kek-pepper` | cookie+CSRF, rate-limited | Passphrase path only: input = client Argon2 output; returns KMS-HMAC(peppered). Server-side lockout on repeated failures (B2). |
| `GET /api/account/mirror-pub` | bearer | Agent fetches own user's `{mirror_pub, version}`; ETag. |
| `POST /api/sessions/:id/user-wrap` | bearer | Agent posts sealed `K` for own account; rejects stale `version` (409, B4). Participant-checked. **Rate-limited (v2.1): ≤ 10 wrap-writes/min/account/session** — a wrap is written once per session (twice across a rotation), so a tight cap stops a compromised agent token from log-flooding `userWrap` rewrites. |
| `GET /api/sessions/:id/wrapped` | cookie | Browser pulls `userWrap[myAccountId]`; 404 (opaque) if none/decoy/legacy. Participant-checked. |
| `GET /api/sessions/:id/frames?cursor=` | cookie | Browser streams sealed ciphertexts (both roles), paginated. **Ciphertext only.** Participant-checked. |
| `POST /api/sessions/:id/frames` | cookie+CSRF | Browser posts a sealed frame it composed (§10). **Participant-checked; per-author counter checked (B5).** |

**Participant check (B5):** every `/api/sessions/:id/*` browser route verifies the
cookie account is the host or visitor on that session (the same check the agent
`/api/poll` already does by role); else opaque 404.

**Write rate-limit (B5):** `POST …/frames` is limited like the **agent _send_** path
(the right analog — a write, not a poll): e.g. **60 frames/min/account/session**,
64 KiB/frame (existing `MAX_FRAME_BYTES`). v1's "like the poll path" was wrong.
`POST …/user-wrap` gets its own tight cap (table above).

**"Step-up" re-auth, defined (v2.1, nit §14).** Overwriting an existing key-mirror
(`POST /api/account/key-mirror` on an account that already has `mirrorPub`) requires
step-up = **a fresh WebAuthn user-verification assertion** (a biometric re-tap of an
existing passkey, proving live possession). **For accounts with no passkey enrolled**
(passphrase-only), step-up = **a single-use email confirmation link** clicked within
a short TTL. Either way, the server refuses a silent overwrite from a merely-valid
session cookie — so a stolen session / compromised OAuth can't replace the mirror and
hijack future wraps. *Appending* a new `MirrorKeyWrap` (adding a device/method, §4.4)
does **not** require step-up; only replacing `mirrorPub` does.

## 9. Browser read flow (transcript) — lazy, paginated, worker-threaded (S6)

1. **List view shows metadata only** (peer, goal, timestamps, whose-turn) — **no
   decryption.** (S6)
2. On **"View conversation"**: unlock KEK (§4) → `mirror_priv` → `K` (HPKE.open of
   `…/wrapped`).
3. `GET …/frames?cursor=` first page only; decrypt that page's `{type:"enc"}` frames
   with `AES-256-GCM.open(K,…)` **in a Web Worker** so the main thread stays
   responsive; render as bubbles (left=peer, right=you); skip control frames.
4. Paginate older frames on scroll.

**Ordering trust (nit §9):** `seq` is **broker-assigned and not authenticated** — the
UI must order by the **inner, AEAD-protected** signal (sender timestamp + per-author
counter inside the sealed frame), using `seq` only as a coarse fetch cursor.

**Perf budget (S6):** target < 80 ms to first rendered bubble on conversation open;
50-session list view does **zero** crypto. A 200-frame transcript decrypts
incrementally in a worker (~1 s total, off main thread, paginated so the user sees
the tail immediately).

## 10. Browser write flow — "user takes the wheel" (B3, B5, S4)

Browser has `K`, so writing is symmetric — but two writers (agent + browser) share
`K`, so nonce uniqueness is mandatory.

**Structured 96-bit IV (resolves B3 / §16.3), AES-256-GCM retained:**
```
IV = [ 1 bit: origin (agent=0, human=1) ][ 31 bits: random ][ 64 bits: per-origin counter ]
```
- The **origin bit partitions** the IV space so agent and human writers can never
  collide with each other.
- The **64-bit counter** is **persisted per (origin, session)** — browser in
  IndexedDB, agent in its key store — guaranteeing within-origin uniqueness across
  restarts. **Reject/abort on counter rollover** (never wraps in practice at 2⁶⁴).
- The 31 random bits defend against a buggy/rolled-back counter store.
- **Counter-store loss (v2.1 — cleared IndexedDB / private mode / storage pressure):**
  do **not** silently restart at 0 (would reuse IVs). On send, the writer uses
  `counter = max(localPersisted, brokerHighestSeenForThisAuthor) + 1`, then persists
  it. The broker already tracks the highest per-author counter for replay defense
  (B5), so on a wiped store the browser **reseeds above the broker's high-water mark**
  (fetched with the wrapped key), guaranteeing it never reuses a `(K, counter)` it
  already burned. If the broker reports none (genuinely fresh), start at a coarse
  time-based floor and persist. Net: collisions stay impossible without trusting
  local storage to survive; the 31 random bits cover the sub-millisecond reseed
  window.
- This is a small **agent-side change** (set origin bit 0 + counter); flagged for the
  skill/library rollout. Until an agent adopts it, human writes are still safe
  (origin bit 1 + counter); agent-vs-agent legacy random-IV collision risk is the
  pre-existing ~2³² bound, unchanged.

**Replay/counter check (B5):** the **same per-author counter** is included
(authenticated) in the frame and **checked broker-side**: the broker tracks the
highest counter seen per (session, authorAccount) and **rejects non-monotonic
counters** → defeats ciphertext replay / log-ballooning, independent of `seq`.

**Compose:** build inner content frame (`meta.dialog`, `origin:"human"`) →
`AES-256-GCM.seal(K,…)` with the IV above → `POST …/frames`. **Content type (v2.1):**
human-composed frames are **plain text by default**; the renderer treats bodies as
text (sanitized, never raw HTML — §14, S7). Rich/structured human frame types are
**deferred to Phase 2** scoping. Peer's agent receives a
normal sealed content frame; the `origin:"human"` hint lets a courteous peer agent
attribute it to the person.

**Handoff coordination stays encrypted (S4, resolves §16.2):** when the human starts
driving, the composer emits an **encrypted** `meta.handoff{ until: <ts> }` control
frame. The user's **own** agent decrypts it on its next check and stays hands-off
until `until` (surfacing quietly). **No broker-visible `human_driving_until`** — the
broker stays blind; coordination lives inside the sealed envelope.

This makes the dashboard a first-class endpoint, especially when the user's agent is
offline/stale (ties to the agent-health work): the user keeps talking with no agent.

## 11. KEK lifetime in the browser

- Default: KEK + unwrapped `mirror_priv` in **memory only**, zeroized on tab close.
- **Zeroize on idle (nit §11):** clear after **15 min of `visibilitychange`-hidden**
  and on `pagehide`. Re-unlock (one tap) to resume.
- Opt-in "remember on this device": keep the `MirrorKeyWrap` in IndexedDB and
  re-derive KEK per session (still a tap). Never persist raw KEK / `mirror_priv` to
  disk; never `localStorage`; never logged.

## 12. Key rotation (B4 — versioned, atomic-ordered, non-retroactive)

**Mirror keypair rotation** (suspected compromise):
1. Browser generates new keypair; **bumps `mirrorPubVersion` and writes new
   `mirrorPub` first.** From this instant agents posting against the old version get
   **409** and refetch — closing the concurrent-write race (B4).
2. Re-wrap **all `MirrorKeyWrap`s** and **`recoveryWrap`** to the new key under the
   current KEK(s) (B4: recovery must be re-wrapped or recovery breaks).
3. Re-seal existing sessions' `userWrap[me]` to the new pub (browser holds old
   `mirror_priv` during rotation), tagging the new version. Sessions not yet
   re-sealed are readable via the still-held old `mirror_priv` until done; if the old
   `mirror_priv` is lost mid-rotation, fall back to recovery (now re-wrapped).
4. **Explicitly NOT retroactive (B4):** a compromise that exfiltrated the old
   `mirror_priv` already exposed every prior `K`. Rotation protects **future**
   sessions only — no forward-secrecy claim for past content.

**KEK rotation / method change** (passphrase→passkey, new passphrase, **or post-
compromise `prf_salt` rotation — S2**): generate new KEK (new method and/or new
`prfSalt`), re-wrap `mirror_priv` into a new/updated `MirrorKeyWrap`, retire the old.
Mirror keypair unchanged → all `userWrap`s stay valid. (Resolves §16.4: salt rotation
*is* part of KEK rotation; the v1 "never" note is removed.)

## 13. Lost device / recovery

- **Lost one synced device, others remain:** nothing to do.
- **Lost all passkeys, has mnemonic:** enter 24 words → derive `RK` →
  `mirror_priv = open(HKDF(RK), recoveryWrap)` → enroll a fresh device wrap. Past
  content recovered.
- **Lost all passkeys AND mnemonic:** **past content gone forever** (I5); account and
  agent still work; new sessions wrap under a freshly enrolled mirror key.
- **Note (nit §13):** recovery does **not** auto-revoke the lost device's passkey on
  the platform (Apple/Google) side — we tell the user to remove it there; we can
  revoke its `MirrorKeyWrap`/`credentialId` on our side.

## 14. Threat model (deltas from `docs/threat-model.md`)

| Adversary | Mitigation |
|---|---|
| Broker / DB dump | Sees ciphertext, public keys, salts, opaque hashes, decoy-padded `userWrap`. No KEK, no `K`, no plaintext. **PRF users: fully mitigated.** **Passphrase users: DB-only dump is NOT enough** — the KMS pepper (separate trust domain) is required to mount any guess, and server-side lockout caps online attempts (B2). |
| DB **and** KMS pepper both exfiltrated | Passphrase users revert to offline Argon2-slowed guessing (zxcvbn≥4 raises cost). PRF users unaffected. **Documented residual** (B2). |
| **Live-server compromise during a passphrase unlock** (v2.1) | The `kek-pepper` endpoint sees the client Argon2 output in transit, and the server holds the pepper — so an attacker with live code-execution on the broker can **log Argon2 outputs as they arrive and mount an offline guess** (no DB dump needed). The KMS-pepper scheme does **not** close this; **OPAQUE would** (the OPRF output never lets the server reconstruct an offline-attackable artifact). Honest residual of the chosen fallback: passphrase users are exposed to a *live* server compromise; PRF users are not (their KEK never transits the server in any form). Mitigations: pepper endpoint is lockout-rate-limited and the passphrase path is opt-in/minority. If this residual is unacceptable, switch the fallback to OPAQUE (§4.3 push-back). |
| Network MITM | TLS + content already E2E-sealed; `user_wrap` sealed to a key never on the wire. |
| Stolen `prf_salt` / `credential_id` | Useless without the authenticator's hardware PRF secret. |
| Stolen recovery mnemonic | Full past-content access — **same trade as Signal Desktop**; write-down-only, never stored, optional-but-encouraged. |
| **Compromised primary auth / OAuth** (new row, nit §14) | An attacker with a session must NOT be able to silently replace the key-mirror. `POST /api/account/key-mirror` **requires step-up re-auth** to overwrite an existing mirror; refuses silent overwrite. |
| Replay / log-flood on browser write | Per-author monotonic counter checked broker-side; participant-only; send-rate-limited (B5). |
| **XSS in the dashboard** (elevated — S7) | The dashboard is now a decryption surface. **Hard requirements:** strict CSP (no inline scripts), **Trusted Types** enforced, **no `dangerouslySetInnerHTML`** anywhere in frame rendering, decrypted frame bodies rendered **only through an allow-list sanitizer (never raw HTML)**, SRI on bundles, KEK zeroization (§11). CSP/Trusted-Types audit is a **Phase 2 entry criterion** (§17). |
| Malicious browser extension | Out of scope (can read any page secret); documented. |

## 15. Edge cases

- **Legacy / pre-enroll sessions:** no real `userWrap[me]` → "View conversation"
  disabled with a one-line explanation; agent back-wraps once enrolled (S5).
- **Decoy wraps (S1):** when a participant has `mirrorPub` but a given session has no
  real wrap yet, store a random same-size `decoy:true` entry so presence never leaks
  per-session state; `GET …/wrapped` returns opaque 404 for decoys.
- **Two humans drive at once:** frames interleave by the inner authenticated
  timestamp+counter (not `seq`); agents stay hands-off per the encrypted handoff (§10).
- **Frame log cap / TTL:** browser transcript bounded by the same `POLL_LOG_CAP` /
  retention as agents; no infinite history promised.

## 16. Resolved design decisions (formerly "open questions")

A sign-off doc shouldn't carry open questions; all are now resolved:
1. **Seal scheme** → HPKE RFC 9180 (§3).
2. **Handoff signal** → encrypted `meta.handoff` frame, not a broker field (§10, S4).
3. **Frame nonce** → structured 96-bit IV, AES-256-GCM retained (§10, B3).
4. **`prf_salt` rotation** → part of KEK rotation (§12, S2).
5. **Multi-account passkeys on one browser** → discoverable-credential selection;
   `MirrorKeyWrap.label` disambiguates; minor UX, not a blocker. **Wrong-passkey
   selected (v2.1):** its PRF output yields a KEK that fails the AEAD auth-tag when
   opening `wrappedMirrorPriv` → handled by the same divergence path as §4.1,
   surfaced as "that passkey doesn't match this account — pick another or recover."
   Never a silent wrong-key decrypt (AEAD prevents it).
6. **Recovery length** → 24 words / 256-bit, fixed (§4.2, S3).
7. **Passphrase hardening** → KMS-pepper + zxcvbn≥4 + lockout; OPAQUE noted as the
   heavier alternative pending reviewer preference (§4.3, B2 — the one push-back).

## 17. Implementation phases (do NOT start until second-pass sign-off)

- **Phase 1 — this doc.** ✋ second-pass review.
- **Phase 2 — crypto core + enrollment.** Schema (`MirrorKeyWrap`, `mirrorPub*`,
  `userWrap`); browser PRF enrollment + mirror keypair; multi-method wraps;
  KMS-pepper endpoint + lockout; recovery setup. **Entry criteria (S7):** CSP +
  Trusted Types + sanitizer harness landed and audited first. Flagged; no agent
  changes yet.
- **Phase 3 — agent wrap + read path.** Skill revision (wrap-on-handshake + every-send
  re-check + ETag + 409 retry); `user-wrap`/`mirror-pub`/`wrapped`/`frames`(GET)
  endpoints with participant checks; lazy worker-threaded transcript renderer.
- **Phase 4 — write path.** `POST …/frames` with participant + monotonic-counter
  checks; structured-IV composer; encrypted `meta.handoff`; agent hands-off rollout.
- **Phase 5 — recovery + FAQ + rotation.** Lost-device/passphrase flows; versioned
  rotation incl. `recoveryWrap` re-wrap; FAQ on the lose-keys→lose-content trade.

## 18. What the server can NEVER see / what it holds

**Never:** KEK · raw passkey/PRF secret · recovery mnemonic / `RK` · `mirror_priv`
plaintext · `K` plaintext · any frame plaintext · passphrase.
**Holds (all safe):** `mirrorPub`(+version) · `MirrorKeyWrap` blobs · `prfSalt` ·
`credentialId` · `kdfParams` · `recoveryWrap` (recovery-flow only) ·
`recoveryCodeHash` · decoy-padded `Session.userWrap` · sealed frame ciphertexts. The
**one** new coarse signal: whether an account enrolled browser access (I3).

---

## 19. v2 changelog — review responses

**Blockers**
- **B1 (PRF cross-device):** §4.1 rewritten — cites Apple iOS/macOS 18 + Google
  Chrome 116 platform commitments (dated, named), enumerates divergence cases
  (hardware/roaming, hybrid/caBLE, Safari<18), defines divergence handling (AEAD-tag
  failure → re-enroll/recovery), demotes "just works" to best-effort.
- **B2 (kek_check oracle):** removed server-side `kek_check`; passphrase KEK now folds
  a **KMS-held pepper** (not in DB) + zxcvbn≥4 + server-side lockout, so DB-only dump
  can't offline-attack; residual (DB+KMS both lost) documented in §14. One push-back:
  chose pepper over full OPAQUE for the minority fallback path (§4.3, §16.7) — will
  switch if required.
- **B3 (nonce):** resolved — structured 96-bit IV `[origin|random|counter]`,
  per-origin persisted counter, rollover-reject, AES-256-GCM retained (§10).
- **B4 (rotation):** added `mirrorPubVersion`; agents tag wraps with version, broker
  409s stale; rotation re-wraps `recoveryWrap`; write-first-then-reseal ordering;
  explicit non-retroactive call-out (§6, §7.1, §12).
- **B5 (write ACL/replay):** participant check on all browser session routes;
  broker-checked per-author monotonic counter; write rate-limit = agent-send analog
  with a concrete number (§8, §10).

**Significant**
- **S1:** decoy `userWrap` entries; I3 amended to own the coarse "enrolled?" leak.
- **S2:** `prf_salt` rotation folded into KEK rotation; §16.4 removed.
- **S3:** `recovery_code_hash` explicitly a typo/UX check, not a security control; 24
  words fixed.
- **S4:** handoff via encrypted `meta.handoff` frame; no broker field (§10).
- **S5:** agents re-check `mirror_pub` on every send and back-wrap current `K` (§7.1).
- **S6:** lazy/paginated/worker-threaded decryption; list view does zero crypto; perf
  budget (§9).
- **S7:** XSS hardened to hard requirements (CSP/Trusted Types/sanitizer/no raw HTML);
  audit is a Phase 2 entry criterion (§14, §17).
- **S8:** `MirrorKeyWrap` child table — multiple methods/devices, additive, no single
  `wrapped_mirror_priv` column (§4.4, §6).

**Nits:** AAD specified (§3); `userWrap` 256B cap (§6); `mirrorPubVersion` added (§6);
mirror-pub cache ETag/TTL/invalidation (§7.1); `recoveryWrap` never returned outside
recovery flow (§8); `seq` not authenticated → inner timestamp+counter for ordering
(§9); idle zeroization defined (§11); lost-device passkey not auto-revoked platform-
side (§13); compromised-primary-auth row + step-up overwrite (§14); §16 open questions
all resolved; CSP/Trusted-Types audit moved to Phase 2 entry (§17).

### v2.1 — second-pass review edits
1. **Live-server-compromise residual (passphrase):** new §14 row — honest that a live
   broker compromise can log Argon2 outputs and offline-attack without a DB dump;
   OPAQUE closes it, the chosen path doesn't; PRF users unaffected.
2. **Counter-store loss:** §10 — reseed `counter = max(localPersisted,
   brokerHighestSeen)+1` (broker already tracks the high-water mark for B5), never
   silent-restart at 0.
3. **S5 retro-wrap explicit:** §7.1 — first send after `mirror_pub` appears wraps the
   **current** session `K`, not only future ones.
4. **"Step-up" defined:** §8 — WebAuthn user-verification re-tap; email-link for
   passphrase-only accounts; append-a-wrap doesn't need it, replacing `mirrorPub` does.
5. **`user-wrap` rate-limit:** §8 — ≤ 10 writes/min/account/session.
- *Nice-to-haves:* human frames plain-text-by-default, rich types deferred (§10);
  wrong-passkey = AEAD-tag-failure path, never silent (§16.5).
