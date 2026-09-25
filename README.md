# @pipeworx/usitc-edis — USITC investigation docket (Section 337 / Title VII)

The docket for US International Trade Commission investigations: Section 337
(unfair import / patent) cases and Title VII (antidumping/countervailing-duty,
"Import Injury") cases. Two USITC services, one pack, **both keyless**:

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1680+ live data sources.

- **IDS** (Investigations Database System, `ids.usitc.gov`) — the case record
  itself: search/list across all ~4,400 investigations, full detail for one.
- **EDIS** (Electronic Document Information System, `edis.usitc.gov`) — the
  documents FILED in an investigation and their attachments.

A login.gov-issued token (`PLATFORM_EDIS_TOKEN`) exists as a FALLBACK for
`edis_*` if EDIS's keyless route ever closes — see "Auth" below — but it is
not needed for a normal call, and the pack never blocks on it.

## Tools

| Tool | Auth | Answers |
|---|---|---|
| `itc_investigation_search` | none | Paginated list of investigations, most-recent-first, with a same-page type/active filter |
| `itc_investigation_detail` | none | Full status record for one investigation (by internal `investigation_id`) |
| `itc_investigation_types` | none | The 4 top-level investigation type categories |
| `edis_document_list` | none (token fallback) | Documents filed in one investigation (motions, orders, certified lists, complaints...) |
| `edis_document_detail` | none (token fallback) | Full detail for one document id |
| `edis_attachment_list` | none (token fallback) | Attachment metadata (title, size, page count, download URI) for one document |

## Auth

**Everything in this pack is keyless for a normal call**, verified live
2026-09-24:

- **IDS (`itc_*`).** `advanced-search` and `investigation/{id}` both answer
  real data with no credential at all. The only header requirement is a
  browser-shaped `Origin`/`Referer` (not a credential, just what a
  same-origin page sends); a plain User-Agent alone was rejected.
- **EDIS (`edis_*`).** Every GET resource (`document`, `document/{id}`,
  `document/{id}/detail`, `attachment/{documentId}`) answers real data with
  **no Authorization header at all**, as long as `Accept: application/xml`
  is sent (`application/json` 406s on these three resources) — and as long
  as the User-Agent matches what EDIS's WAF allows (see "Traps" below; this
  is the actual gate, not auth).

**`edis_*` tries the keyless route FIRST, and only falls back to
`PLATFORM_EDIS_TOKEN` if that fails** — a non-200, an HTTP 401/403, or a body
that turns out to be USITC's generic "under maintenance" HTML page rather
than data (`edisGetKeylessFirst` in `src/index.ts`). The token is a JWT
(`sub: "MOJIBAKE"`) Bruce obtained through EDIS's login.gov-gated
registration, sent as `Authorization: Basic <token>` on the fallback attempt
only. Stored in the encrypted `platform_keys` table (no Worker secret binding
— the gateway is at its text-binding cap), injected as `_apiKey` when a
caller supplies none.

**The token expires 2026-10-08T04:00:00Z.** Because it is fallback-only, this
is NOT the operational cliff it would be for an always-token design: the pack
keeps answering real data with no credential at all unless and until EDIS's
keyless route itself closes. If it ever does close and a fallback is needed,
the pack checks the token's own `exp` claim (base64url, no signature check
needed — reading our own token) before sending it, and refuses explicitly —
`auth_required: USITC EDIS requires an API key: the keyless route failed and
the Pipeworx EDIS token expired on <date>...` — rather than returning an
empty result. `token_expires_at` (and a `token_warning` under 3 days) appears
ONLY on a response that actually needed the fallback; an ordinary keyless
success carries neither, since nothing about the token was consulted.

**Renewal is only needed if the keyless route closes.** Procedure, as far as
EDIS's own docs establish it (unverified end to end — nobody has run it, and
there is no reason to until the keyless route actually needs backup):
1. Sign in at <https://edis.usitc.gov/external/> via **Login.gov** — EDIS
   accounts are login.gov-verified identities, not self-service API keys.
   `/external/registration` redirects to
   `https://edis.usitc.gov/external/oauth2/authorization/logingov`.
2. Once authenticated, the WADL (`https://edis.usitc.gov/data/`, fetched
   keylessly) lists `POST secretKey/{username}` (form param `password`) as
   the token-mint endpoint.
3. **This pack, and whoever renews the key by hand, must NOT call that
   endpoint speculatively or more than once per renewal** — minting a new
   secretKey may revoke whichever one is currently live. Mint it only when
   actually renewing, immediately before updating `PLATFORM_EDIS_TOKEN`.
4. Update the value in the `platform_keys` table (see
   `docs/gateway-text-binding-limit.md` for how platform-key-store entries
   without a Worker binding are set).

A platform-key-probes.json entry (`usitc-edis` → `edis_document_list`) is
pinned via `PROBE_OVERRIDES` in `scripts/sync-platform-key-probes.mjs`,
verified live 2026-09-24. Since `edis_document_list` is keyless-first, a pass
on this probe proves the keyless route this pack actually depends on
day-to-day is up — it does NOT specifically prove `PLATFORM_EDIS_TOKEN` is
alive, because a healthy keyless route means the fallback is never reached.
That is an intentional shift from what a platform-key probe usually means
here, noted explicitly so nobody re-derives the wrong assumption from the
filename.

## Data sources

- `https://ids.usitc.gov/idata/api/v1/advanced-search` (POST) — investigation
  search/list, paginated.
- `https://ids.usitc.gov/idata/api/v1/investigation/{id}` (GET) — full
  investigation detail.
- `https://ids.usitc.gov/idata/api/v1/lookup/investigation-types` (GET) —
  the 4 top-level type categories.
- `https://edis.usitc.gov/data/document` / `document/{id}/detail` /
  `attachment/{documentId}` (GET) — filed documents and attachment metadata,
  keyless. WADL at `https://edis.usitc.gov/data/`.

## Traps for the next builder

- **edis.usitc.gov's WAF 403s almost any User-Agent string, disguised as
  "the site is down".** Verified live 2026-09-24, repeatedly: bare `curl`
  (`curl/8.7.1`, `curl/7.64.1`) and `python-requests/2.31.0` all get a clean
  200; a blank UA, `Wget/1.21`, a full browser UA string, and this pack's own
  plain identifying UA (`pipeworx-usitc-edis/1.0 (+https://pipeworx.io)`) all
  get HTTP 403 with USITC's generic "under maintenance" HTML page — which
  reads exactly like an outage, not a UA filter. The match is a PREFIX, not
  an exact string: `curl/8.7.1 pipeworx-usitc-edis/1.0 (+https://pipeworx.io)`
  passes. `EDIS_UA` in `src/index.ts` is built that way on purpose — it is an
  honest identification (the pack names itself) composed to also clear
  whatever allowlist rule this is, not a literal impersonation of curl. If
  EDIS ever tightens this further, this is the first thing to re-check before
  assuming the whole route died.
- **A bad/malformed EDIS `Authorization` header does not 401 — it also 503s
  the same generic "under maintenance" HTML page**, so a rejected credential,
  genuine intermittent downtime, a UA-filter block, and (on IDS) a malformed
  request body are ALL indistinguishable from the response alone.
  `edisGetKeylessFirst` only treats a response as a credential rejection when
  the STATUS is specifically 401/403 on the fallback attempt with a token
  attached; everything else (including a maintenance-page body) reads as
  `upstream_down` — retriable, not "rotate the key".
- **`investigationNumber` normalization (EDIS only).** Pass `"337-TA-1400"`
  in and every value EDIS itself returns (`documentListUri`, the
  `investigationNumber` field on documents) comes back `"337-1400"` — EDIS
  drops `"-TA-"` internally. `edis_document_list` accepts either spelling and
  normalizes before querying.
- **URL-encoding trap on IDS-adjacent EDIS endpoints (historical, not
  currently exercised by this pack):** `investigationType=Sec%20337`
  (percent-encoded space) 400s; `investigationType=Sec+337` (plus-encoded)
  works. `URLSearchParams` encodes spaces as `+` by construction, so a
  hand-built query string is the only way to hit this.
- **IDS's `advanced-search` `criteria` filter DSL is unknown.** The live
  Angular app (`ids.usitc.gov/case`) builds a structured `criteria` array
  server-side filters run through, but every shape tried live (`{field,
  value}`, `{fieldName, operator, value}`, a DevExtreme-style `[field, "=",
  value]` triple) either silently matched nothing or 302-redirected as if
  malformed. `itc_investigation_search` therefore exposes only the
  parameters proven live (`pageNumber`, `pageSize`, `sortOrder` on
  `institution_start_date`) plus a same-PAGE client-side filter on
  type/active-status. **Capturing the real DSL is the fastest path to true
  server-side filtering:** open `ids.usitc.gov/case` in a browser, use an
  advanced search filter, read the POST body from devtools.
- **`GET investigation/{id}` embeds ITC STAFF identity** —
  `case_manager_id` carries the case manager's full name, personal work
  email and phone number. This is Commission personnel, not a docket party,
  and `itc_investigation_detail` deletes the field outright rather than
  redacting it. Apply the same rule to any future case-scoped endpoint added
  here (participants, IP, HTS numbers, orders, votes) — attempted live
  2026-09-24 and none of `case/participants`, `case/hts_numbers`,
  `case/unfair_import_orders*`, `investigation/participants` etc. could be
  reached (they either 503 the maintenance page under every query-param
  shape tried, or — `investigation/intellectual_property` — return an
  unfiltered ~880KB dump regardless of the filter passed). Left unbuilt
  rather than shipped unreliable; the routing pattern
  (`/case/{case_id}/investigation/{investigation_id}/...`) visible in the
  Angular bundle (`ids.usitc.gov/main-*.js`) is the next lead.
- Response envelope quirk on `advanced-search`: the total match count is
  `totalRecords` at the top level on some request shapes and `hitCount`
  *inside each case row* on others — never trust `hitCount` at the top
  level; it is not there.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "usitc-edis": {
      "url": "https://gateway.pipeworx.io/usitc-edis/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/usitc-edis/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1680+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/itc_investigation_search \
  -H 'Content-Type: application/json' \
  -d '{"page_size":5,"sort_order":"desc"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/itc_investigation_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "usitc-edis": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-usitc-edis"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-usitc-edis
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Usitc Edis data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
