# @pipeworx/usitc-edis — USITC investigation docket (Section 337 / Title VII)

The case docket for US International Trade Commission investigations: Section
337 (unfair import / patent) cases and Title VII (antidumping/countervailing-
duty, "Import Injury") cases, via **IDS** (Investigations Database System,
`ids.usitc.gov`) — search/list across all ~4,400 investigations, full detail
for one. **Keyless.**

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1684+ live data sources.

## What's NOT here: filed documents (EDIS)

This pack does not serve **EDIS** (Electronic Document Information System,
`edis.usitc.gov`) — the documents filed in an investigation and their
attachments. EDIS's WAF returns a 403 (disguised as its generic "under
maintenance" HTML page) to any User-Agent that isn't a recognized generic
HTTP-client signature, **even when a valid API key is sent** — verified live
2026-09-24. An earlier version of this pack cleared that block by prefixing
its User-Agent with `curl/8.7.1 `, impersonating a different client. Bruce
ruled against that (2026-09-25), reversing an earlier case ruling that had
allowed it, so the `edis_*` tools were removed along with the token/curl
plumbing that only existed to serve them.

**Filed documents at EDIS await a USITC allowlist of our honest User-Agent**
(`pipeworx-usitc-edis/1.0 (+https://pipeworx.io)`). Re-adding an EDIS path
here needs either that allowlisting or some other non-impersonating route
past the WAF — not a re-add of the curl prefix.

## Tools

| Tool | Auth | Answers |
|---|---|---|
| `itc_investigation_search` | none | Paginated list of investigations, most-recent-first, with a same-page type/active filter |
| `itc_investigation_detail` | none | Full status record for one investigation (by internal `investigation_id`) |
| `itc_investigation_types` | none | The 4 top-level investigation type categories |

## Auth

**Everything in this pack is keyless**, verified live 2026-09-24. `IDS`
(`advanced-search`, `investigation/{id}`, `lookup/investigation-types`) all
answer real data with no credential at all. The only header requirement is a
browser-shaped `Origin`/`Referer` (not a credential, just what a same-origin
page sends); a plain User-Agent alone was rejected.

## Data sources

- `https://ids.usitc.gov/idata/api/v1/advanced-search` (POST) — investigation
  search/list, paginated.
- `https://ids.usitc.gov/idata/api/v1/investigation/{id}` (GET) — full
  investigation detail.
- `https://ids.usitc.gov/idata/api/v1/lookup/investigation-types` (GET) —
  the 4 top-level type categories.

## Traps for the next builder

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
- Response envelope quirk on `advanced-search`: the total match count is
  `totalRecords` at the top level on some request shapes and `hitCount`
  *inside each case row* on others — never trust `hitCount` at the top
  level; it is not there.
- **EDIS (`edis.usitc.gov`) is a separate, credential-gated service with a
  UA-filtering WAF.** It is deliberately not served here — see "What's NOT
  here" above. Do not re-add it with a spoofed User-Agent.

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

Both URLs reach the same gateway and the same 1684+ data sources. The
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
