# Back Channel Remote: remote access through the relay (broker side)

Back Channel Remote (developed as AppBridge, repo `skyflyt/appbridge`) lets your phone reach your
PC's apps. At home it connects directly. Away from home, both ends connect **out** to a small relay
(`backchannel-relay`, a Cloudflare Worker with one Durable Object per PC), which passes the bytes along. This broker does
not relay anything. It decides whether a phone may reach a PC through the relay right now, and it
issues and renews the passes that say so.

The AppBridge session inside the relay stays end-to-end encrypted between the two devices, with their
own pinned certificates and device grants. The broker and the relay never see screens, keystrokes,
clipboard, app names or commands.

The relay's half of this contract is `docs/REMOTE_ACCESS_BROKER_API.md` in the AppBridge repo
(its `src/relay-cloudflare`). Code: `apps/broker/src/lib/appbridge.ts` and
`src/app/api/appbridge/v1/**`. Tests: `route-tests/appbridge.routetest.mts`.

## Rules

1. **Separate credentials.** Devices use their own `ab_` bearer credential (only the SHA-256 is
   stored). `deviceContext()` is the only resolver for it, and it refuses a `bc_` agent key, the
   dashboard cookie and anything else. No Back Channel route accepts an `ab_` credential.
   - An agent key can never obtain a pass, register a device or set an entitlement.
   - Registering a device needs the signed-in dashboard: a cookie plus CSRF mints the code.
2. **The gate** is read fresh inside one serializable transaction every time a pass is issued,
   redeemed or renewed. All of these must hold:
   - the rollout flag is on;
   - the account's `appbridge.remote_access` entitlement is active: an admin grant **or** an
     entitling Remote subscription, both read in the same transaction (docs/remote-paid-tier.md);
   - the host exists, is enabled and not revoked, and its relay switch is on;
   - for a session: the remote is enabled and not revoked, and that host attested this enrollment for
     that remote and has not withdrawn it;
   - everything is in one account.
3. **Privacy.**
   - No IP, user agent, URL query or body is stored or logged. Audit rows for these routes carry no
     IP.
   - Passes and leases are deleted within minutes of expiry.
   - The only history is the owner's **7-day log of connection attempts**: which device was let
     through to which PC, and when. A row is written when the broker admits the pair at redemption,
     so an attempt the relay then fails to complete still appears; the dashboard calls these
     "connection attempts". It has no duration, bytes or address, and rows older than 7 days are
     deleted.
4. **Conventions.**
   - JSON bodies with exactly the specified members, at most 4 KiB.
   - `Cache-Control: no-store`, errors as `{ "error": "<code>" }`.
   - The broker keys its rate limits by device, account, lease, presented connector key or a global
     budget, never by IP, and stores no IP. The relay Worker additionally rate-limits client connects
     by client IP, in memory only, before it signs anything for the broker (see **Rate limits**).
   - Identifiers are `[A-Za-z0-9_-]{1,128}`.
   - Connector keys are P-256, sent as base64 DER SubjectPublicKeyInfo and identified by the
     uppercase hex SHA-256 of that DER.

## Proofs

A device proves it holds its connector key with an ECDSA P-256 / SHA-256 signature in IEEE P1363
form (r‖s, 64 bytes), base64url without padding, over a UTF-8 message:

| When | Message | Signed by |
|---|---|---|
| Registering | `appbridge-device-exchange-v1:<code>` | the new key |
| Rotating the key | `appbridge-connector-rotate-v1:<deviceId>:<new key's fingerprint>` | the old key (`proofOld`) **and** the new key (`proofNew`) |

## Routes

All routes are under `/api/appbridge/v1`.

### Account (dashboard session; mutations need the `x-bc-csrf` header)

| Route | Request | Response |
|---|---|---|
| `POST /account/device-codes` | `{ role: "host"\|"remote", label? }` | `{ code: "ABD-XXXX-XXXX", expiresAt }`, one-use, 10 minutes. Needs a verified email. |
| `GET /account/devices` | — | `{ rollout, entitled, devices: [{ id, role, label, relayEnabled, enabled, connectorSpkiSha256, createdAt, revokedAt }] }` |
| `DELETE /account/devices/{id}` | — | `204`. In one transaction: revokes the device and its credentials, withdraws its pairings and deletes its live leases (as host or remote), so the relay's next renewal is `404` and a live session ends within about a minute. |
| `GET /account/connections` | — | `{ connections: [{ hostDeviceId, remoteDeviceId, at }] }`, connection attempts in the last 7 days |
| `PUT /admin/entitlements` | `{ handle, active }` | Admin only, dashboard session only. |
| `/billing/*` | — | The paid tier: checkout, portal, status and the Stripe webhook. See docs/remote-paid-tier.md. |

### Device (`Authorization: Bearer ab_…`)

| Route | Scope | Request | Response |
|---|---|---|---|
| `POST /devices/exchange` | none (the code) | `{ code, role, connectorSpki, proof }` | `{ deviceId, credential, expiresAt, scopes }`, valid for a year |
| `GET /devices/self` | `appbridge.device` | — | `{ deviceId, role, label, relayEnabled, connectorSpkiSha256, remoteAccess: "available"\|"rollout_off"\|"not_entitled" }` |
| `DELETE /devices/self` | `appbridge.device` | — | `204`. The device unregisters itself (host or remote): see below. |
| `POST /devices/self/credential` | `appbridge.device` | — | `{ credential, expiresAt }`. The old credential keeps working until the new one is first used, or 24 h at most: see below. |
| `PUT /devices/self/connector` | `appbridge.device` | `{ connectorSpki, proofOld, proofNew }` | `{ connectorSpkiSha256 }` |
| `PUT /hosts/self/relay` | `appbridge.host.relay` | `{ enabled }` | `{ enabled }`. Off never touches pairings. |
| `PUT /hosts/self/pairings/{enrollmentId}` | `appbridge.host.relay` | `{ remoteDeviceId }` | `204`. Idempotent; a withdrawn enrollment is never revived (`409`). Host devices only (`403 scope` otherwise, whatever the credential's scopes). |
| `DELETE /hosts/self/pairings/{enrollmentId}` | `appbridge.host.relay` | — | `204`. Host devices only. |
| `POST /relay/presence-passes` | `appbridge.relay.presence` | `{}` | `{ pass, expiresAt, relay }` |
| `POST /relay/passes` | `appbridge.relay.pass` | `{ hostDeviceId, enrollmentId }` | `{ pass, expiresAt, relay }` |

Scopes:
- **host:** `appbridge.device`, `appbridge.host.relay`, `appbridge.relay.presence`.
- **remote:** `appbridge.device`, `appbridge.relay.pass`.

Details:
- A pass is 64 uppercase hex characters and lasts 60 seconds.
- **Unregistering** (`DELETE /devices/self`, `Authorization: Bearer ab_…` exactly as the other device
  routes): in one transaction the device is revoked, every credential it holds is revoked, its
  pairings are withdrawn and its live leases are deleted. `204` with no body. Idempotent: a retry with
  the credential that made the call (any credential that was live when the device was revoked) is
  `204` again. Any other credential (unknown, malformed, a `bc_` key, or one that was already dead
  before the device was revoked, such as a rotated-away credential) is `401`, so a stale credential
  can never unregister a live device. The Windows host calls this on Unregister.
- **Credential rotation is crash-safe.** `POST /devices/self/credential` returns a new credential and
  keeps the calling one valid until the new one is first used on any device route (at that moment the
  old one is revoked), or for 24 hours from the first rotation, whichever comes first. A device that
  crashed before saving the reply retries with its old credential: that rotation revokes the unused
  successor and issues another, and never extends the 24 hours. Revoking or unregistering the device
  ends every credential, including one in its grace period.
- A refused gate is `403` with one of `rollout_off`, `not_entitled`, `relay_off`, `device_revoked` or
  `not_paired`. A PC outside the caller's account is `404`.

### Relay (requests signed with the relay's Ed25519 key only)

The relay runs on Cloudflare, where no Google identity exists, so it signs every request with its
own Ed25519 key. The private half is the Worker secret `RELAY_SIGNING_KEY`. The broker holds only the
public half, `APPBRIDGE_RELAY_PUBLIC_KEY`, as base64 DER SubjectPublicKeyInfo.

```
Authorization: AppBridge-Relay v1.<unix seconds>.<22-char base64url nonce>.<base64url signature>
signed: "appbridge-relay-broker-v1\n" METHOD "\n" PATH "\n" seconds "\n" nonce "\n" hex(SHA-256(raw body))
```

`relayRequest()` verifies the signature over the exact bytes received, then:
- refuses a timestamp more than 60 s from now;
- refuses a nonce already seen in the last 2 minutes. The cache is in memory, because the broker runs
  as exactly one instance.

No device or agent credential is accepted here. A device's `ab_` credential, a `bc_` key or the
dashboard cookie all get `401`.

| Route | Request | Response |
|---|---|---|
| `POST /relay/redeem` | `{ pass, purpose, connectorSpkiSha256 }` | `{ leaseId, accountId, hostDeviceId, clientDeviceId, enrollmentId, hostConnectorSpkiSha256, clientConnectorSpkiSha256 }`. The `client*` and `enrollmentId` members are `null` for presence. |
| `POST /relay/renew` | `{ leaseId }` | `{ hostConnectorSpkiSha256, clientConnectorSpkiSha256 }`; extends the lease by 120 s |
| `POST /relay/release` | `{ leaseId }` | `204`, idempotent. The relay ended the pair or presence, so the lease and the account's slot are freed at once rather than when the lease runs out. |

- **Redeem** always consumes the pass first, whatever follows. It returns its refusals as values
  inside the transaction, so the consumption commits.
- It then checks the purpose, that the presented key is the one registered for the device the pass
  was issued to (the remote for a session, the host for presence), and the gate.
- **Cost guard** (Skylar, 2026-09-24): a session is refused with `409` when
  - the account already has 3 remotes (phones or laptops) relayed, and this is a fourth;
  - this remote already holds 4 live connections to this PC: its workspace socket plus pooled HTTPS
    connections; or
  - this remote already holds 8 live connections across all PCs, so a laptop can use two PCs at once.

  The pass is still consumed. The relay answers the device `429`. All three limits are counted from the
  account's live leases in the redeem's serializable transaction; racing redeems conflict and are re-run,
  so they cannot overshoot a limit.
- **Presence cap:** a presence redemption is refused with `409` when the account already holds 4 live
  presence leases (one per PC, plus spares for a PC that reconnects before the relay has released its
  old lease). Checked in the same serializable transaction as the other caps; the pass is still
  consumed.
- A session redemption writes one connection-log row: a record that the broker admitted the attempt,
  written even if the relay then fails to complete the pair.
- Any other refusal is `403 { "error": "refused" }`, with no detail.
- **Renew** rechecks the gate. A refusal deletes the lease (`403`); an expired lease is `410`, an
  unknown one `404`.
- The relay compares the keys that renew returns and ends the pair if either changed.

### Rate limits

All limits are in memory (one broker instance), per minute, and answer `429 { "error": "rate_limited" }`
with `Retry-After`. Redeem, renew and release have **separate** budgets: anyone can make the relay
sign a redeem (a client connect with a throwaway key and a junk pass), and when all three shared one
bucket such a flood made renewals fail and tore down every live session.

| Route | Budget |
|---|---|
| `POST /relay/renew`, `POST /relay/release` | 30 per lease. Nothing else spends it; the relay renews each lease about once a minute. |
| `POST /relay/redeem`, every attempt | 60 per presented `connectorSpkiSha256` (pass issuance allows 30 per device). |
| `POST /relay/redeem`, refusals (`403`, malformed `400`) | 10 per presented key and 600 globally, checked before any database work; a success spends neither. Once the global budget is spent, a redemption gets through only if its presented key belongs to a live registered device (one indexed read), so a flood is shed while real devices keep connecting. The relay checks that the client holds the presented key, so only its holder can spend a key's budget. |
| `POST /devices/exchange` | Only failed exchanges count: 1000 globally. Registrations are never blocked by others' failures until that whole budget is spent, and a shed request never burns its code. Codes are one of 31^8, one-use and live 10 minutes; minting stays limited to 15 per account per hour. |
| Device routes | 60 per device; passes 30 per device. |

The relay Worker also limits client connects per client IP, in memory, before it signs a redeem. The
broker never sees or stores that IP.

## Configuration

| Variable | Meaning |
|---|---|
| `APPBRIDGE_REMOTE_ACCESS` | `on` enables relay access. Anything else is the relay-wide kill switch (`rollout_off`). |
| `APPBRIDGE_RELAY_PUBLIC_KEY` | The relay's Ed25519 public key, as base64 DER SubjectPublicKeyInfo. When it is unset or not Ed25519, the relay routes answer `503`, which the relay treats as an outage and a refusal. |
| `APPBRIDGE_RELAY_URL` | Optional; the informational `relay` member; defaults to `wss://relay.back-channel.app/v1/connect`. |

`cloudbuild.yaml` uses `--set-env-vars`, which **replaces the whole list**. Add these to that list
when the relay is deployed, not before. Until then the routes stay dark: `rollout_off`, and `503`
on the relay side.

## Data

The migration `20260924030000_appbridge_remote_access` is purely additive: it creates eight new
`AppBridge*` tables with their indexes, foreign keys and enum checks. Before applying it to prod,
read its header: it covers the Cloud SQL backup, checking migration tracking, and applying it by
hand.

`20260924210000_appbridge_credential_rotation_grace` adds one nullable column,
`AppBridgeCredential.replacesKeyHash` (the credential a rotated one replaced; cleared at first use).
Apply it before deploying the code that uses it.
