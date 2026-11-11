# Account identity API

`GET /api/account/identity` is the minimal bearer-authenticated identity
contract for trusted service adapters.

```http
GET /api/account/identity
Authorization: Bearer bc_...
```

Success is `200` with exactly one JSON property:

```json
{"accountId":"<stable Back Channel account id>"}
```

The response includes `Cache-Control: no-store`. Missing, malformed, invalid,
or revoked bearer credentials return `401 {"error":"unauthorized"}`. Browser
`bc_session` cookies are ignored. Authentication delegates to the canonical
bearer resolver, so its existing throttled `AgentToken.lastUsedAt` metadata
touch may occur; the endpoint does not log or return credentials or profile
fields.

This endpoint identifies the Back Channel account only. AppBridge relay
entitlements remain an operator-owned staging concern keyed by this account ID;
the endpoint does not inspect or assert a Back Channel billing plan.
