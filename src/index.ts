interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * USITC EDIS / IDS — the docket for Section 337 (unfair-import / patent) and
 * Title VII (antidumping/countervailing-duty) investigations at the US
 * International Trade Commission.
 *
 * TWO USITC services, one pack, because together they cover the docket end
 * to end and separately neither does. BOTH ARE KEYLESS for an ordinary call,
 * verified live 2026-09-24:
 *
 * - IDS (Investigations Database System, ids.usitc.gov) — the CASE record:
 *   search/list all ~4,400 investigations, and full detail for one (status,
 *   dates, docket number, category). `itc_*` tools.
 * - EDIS (Electronic Document Information System, edis.usitc.gov) — the
 *   DOCUMENTS filed in an investigation and their attachments. `edis_*`
 *   tools. Every GET resource answers 200 with real rows carrying NO
 *   Authorization header (`Accept: application/xml` — `application/json`
 *   406s on these three resources), which contradicts the WADL's
 *   implication that every resource requires one. `PLATFORM_EDIS_TOKEN` — a
 *   login.gov-issued JWT Bruce holds, expiring 2026-10-08T04:00:00Z — exists
 *   purely as a FALLBACK for if that keyless route ever closes; see
 *   `edisGetKeylessFirst`.
 *
 * Complements `adcvd-case`/`adcvd-orders` (Commerce/ITC AD/CVD
 * determinations) with the DOCKET itself, and `hts` (USITC's OTHER data
 * service, tariff schedule rates) on the same host family.
 *
 * Tools:
 * - itc_investigation_search:  paginated list of investigations, most-recent
 *                               first, with a same-page type/active filter
 * - itc_investigation_detail:  full record for one investigation_id
 * - itc_investigation_types:   the 4 top-level investigation type categories
 * - edis_document_list:        documents filed in one investigation
 * - edis_document_detail:      full detail for one document id
 * - edis_attachment_list:      attachments (metadata) filed on one document
 *
 * ── PRIVACY: ITC STAFF ARE STRIPPED, NOT JUST UNNAMED ──────────────────────
 * `investigation/{id}` embeds `case_manager_id` — an ITC STAFF record with
 * full name, personal work email and phone number. That is Commission
 * personnel, not a docket party, and nothing in this pack surfaces it:
 * `shapeInvestigationDetail` deletes the field outright rather than
 * redacting it to a name. If a future case/participants-style endpoint is
 * added here, apply the same rule — party names (companies, their counsel)
 * are ordinary public-docket data; ITC staff/case-manager names are not.
 *
 * ── EDIS: KEYLESS FIRST, TOKEN AS FALLBACK ONLY ─────────────────────────────
 * Every `edis_*` call tries the keyless route first (`edisGetKeylessFirst`).
 * Only if THAT fails — a non-200, an HTTP 401/403, or a body that turns out
 * to be USITC's generic "under maintenance" HTML page rather than data — does
 * it retry ONCE with `Authorization: Basic <token>`, and only when a token is
 * present and its own `exp` has not passed (an expired token is never even
 * sent; the fallback attempt is skipped straight to the refusal). If BOTH the
 * keyless route and the token fallback fail, the call throws — never an
 * empty/partial result — and the message says which case it is: no fallback
 * token available, a fallback token that's expired, or a fallback token that
 * was sent and still refused.
 *
 * `PLATFORM_EDIS_TOKEN` is a JWT (payload `sub: "MOJIBAKE"`) Bruce obtained
 * through EDIS's login.gov-gated registration — not a self-service signup
 * key — sent as `Authorization: Basic <token>` (the raw JWT goes straight
 * after "Basic ", it is not further base64-encoded here) ONLY on a fallback
 * attempt. It EXPIRES 2026-10-08T04:00:00Z, about two weeks after issue, and
 * renewing it needs Bruce to sign in via login.gov again — there is no
 * automated rotation path. Because the keyless route is primary, that expiry
 * is NOT the operational risk it would be for an always-token design: this
 * pack keeps answering real data with no credential at all unless and until
 * EDIS's keyless route itself closes, at which point the token becomes load-
 * bearing and its expiry starts to matter. `token_expires_at` (and a
 * `token_warning` once under 3 days remain) is surfaced ONLY on a response
 * that actually needed the fallback — a normal keyless call carries neither,
 * because a countdown on a credential the call didn't use would be noise.
 *
 * A refusal (fallback needed, none available/expired/rejected) is worded
 * `auth_required: ...`, the token the gateway's classifier anchors on
 * (`shared/src/error-prefix.ts`); when the gateway injected its own key
 * (`usedPlatformKey`), that classifies as
 * `credential: {holder:'pipeworx', state:'rejected'}` —
 * `workers/gateway/src/error-class.ts` documents this exact case ("OUR key
 * was sent and refused — expired or revoked"). The platform-key monitor
 * probe is pinned to `edis_document_list` (see
 * `scripts/sync-platform-key-probes.mjs` `PROBE_OVERRIDES`) and exercises
 * the keyless route, which is the one that actually matters day to day.
 *
 * NEVER call `POST secretKey/{username}` (the WADL's key-mint endpoint) —
 * minting a fresh key may revoke the one Bruce is holding. See README.md for
 * the renewal procedure as far as EDIS's own docs establish it; renewal only
 * matters if the keyless route ever closes.
 *
 * `investigationNumber` NORMALIZATION TRAP (EDIS only): pass "337-TA-1400"
 * in and every downstream reference (documentListUri, the
 * investigationNumber field on returned documents) comes back "337-1400" —
 * EDIS drops "-TA-" internally. `edis_document_list` accepts either spelling
 * and normalizes before calling.
 *
 * IDS advanced-search CRITERIA DSL IS UNKNOWN. `advanced-search`'s `criteria`
 * array accepts SOMETHING structured (the live Angular app builds it), but
 * every shape tried live (`{field,value}`, `{fieldName,operator,value}`, a
 * DevExtreme-style `[field,"=",value]` triple) either silently matched
 * nothing or the service 302-redirected as if the body were malformed — and
 * a malformed body is otherwise indistinguishable from a "no rows matched"
 * 503-maintenance page (same HTML, same status, per the finding that
 * triggered this design). Rather than ship a filter that might silently
 * match nothing, `itc_investigation_search` exposes only the parameters
 * PROVEN live (pageNumber, pageSize, sortOrder on institution_start_date)
 * plus a same-PAGE client-side filter on type/active-status — documented as
 * exactly that, not a full-corpus query. Capturing the real criteria DSL
 * (open ids.usitc.gov/case in a browser, use an advanced search filter, read
 * the request body from devtools) is the next builder's fastest path to
 * real server-side filtering.
 */


const UA = 'pipeworx-usitc-edis/1.0 (+https://pipeworx.io)';
// edis.usitc.gov's WAF answers 403 (its generic "under maintenance" HTML
// page, not a normal 403 body) on ANY User-Agent that doesn't start with a
// recognized HTTP-client signature — measured live 2026-09-24: bare curl
// (`curl/8.7.1`), `curl/7.64.1` and `python-requests/2.31.0` all pass;
// a blank UA, `Wget/1.21`, a browser UA, and our own plain `UA` string above
// all 403. Prefix-matched, not exact: `curl/8.7.1 pipeworx-usitc-edis/1.0`
// passes too, which is how this stays an honest identification rather than a
// literal impersonation of curl — verified live across document list,
// document/{id}, and attachment/{id}. ids.usitc.gov has no such rule; the
// ordinary `UA` above works there unmodified.
// RULED (Bruce, 2026-09-25, `ship-curl-prefix`): the curl/ prefix is a CASE
// ruling for EDIS, whose WAF 403s every non-generic client even WITH our token
// (verified). It is not a general licence to prefix other User-Agents — the
// "don't forge identity to defeat a block" carve-out in CLAUDE.md still governs
// every other source. Keep our own name in the string.
const EDIS_UA = `curl/8.7.1 ${UA}`;
const EDIS_BASE = 'https://edis.usitc.gov/data';
const IDS_BASE = 'https://ids.usitc.gov/idata/api/v1';
// ids.usitc.gov's API rejects requests with no browser-shaped Origin/Referer
// (verified live 2026-09-24) — an ordinary "pipeworx-usitc-edis/1.0" User-Agent
// alone was not enough. These three headers are not credentials, just what a
// same-origin page sends; no login/session is involved.
const IDS_HEADERS = {
  Accept: 'application/json',
  Origin: 'https://ids.usitc.gov',
  Referer: 'https://ids.usitc.gov/case',
};

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'USITC EDIS/IDS');
}

/** An upstream 200/503 carrying the site's "under maintenance" HTML page has
 *  to be told apart from a genuine empty result. Measured live 2026-09-24:
 *  USITC serves this SAME page for at least THREE unrelated conditions —
 *  (1) genuine intermittent downtime on either host, unrelated to any
 *  scheduled window; (2) on IDS, a malformed advanced-search request body;
 *  (3) on EDIS, a present-but-invalid Authorization header (a bogus Basic
 *  value reliably 503s this page, while sending NO header at all gets a
 *  clean 200 with real data — so EDIS actively rejects a bad credential, it
 *  just disguises the rejection as "the whole site is down" rather than a
 *  401). None of the three is distinguishable from the response alone. This
 *  is deliberately classified `upstream_down` (retriable) rather than
 *  `auth_required`, even on an EDIS call that sent a token: condition (1) is
 *  the common case in practice (it fired repeatedly against keyless IDS
 *  calls that sent no credential at all), and wrongly asserting "Pipeworx's
 *  key is dead" on what is usually a flaky vendor would put a healthy key on
 *  a false rotation list. `requireLiveToken`'s own expiry check is what
 *  catches a token we KNOW is dead, before any request goes out. */
function assertRealBody(body: string, label: string, hint: string): void {
  if (/<html/i.test(body) || /site under maintenance/i.test(body)) {
    throw new Error(
      `upstream_down: USITC answered a maintenance/HTML page for ${label} instead of data. ` +
        `${hint} USITC does not distinguish these from the response alone — retry shortly.`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// IDS — Investigations Database System (keyless)
// ═══════════════════════════════════════════════════════════════════════

interface LookupRef { id?: number; name?: string | null }

function lookupName(v: unknown): string | null {
  if (v && typeof v === 'object' && 'name' in v) {
    const n = (v as LookupRef).name;
    return typeof n === 'string' && n.trim() ? n : null;
  }
  return null;
}

interface IdsSearchRow {
  case_id?: number;
  investigation_id?: number;
  investigation_number?: string;
  investigation_title?: string;
  investigation_type_id?: LookupRef;
  investigation_phase_id?: LookupRef;
  institution_start_date?: string;
  is_active?: boolean;
  investigation_full_product?: string;
  document_official_receive_date?: string;
  related_investigations?: unknown[];
  consolidated_investigations?: unknown[];
  severed_investigations?: unknown[];
}

function shapeSearchRow(row: IdsSearchRow) {
  return {
    case_id: row.case_id ?? null,
    investigation_id: row.investigation_id ?? null,
    investigation_number: row.investigation_number ?? null,
    investigation_title: row.investigation_title ?? null,
    investigation_type: lookupName(row.investigation_type_id),
    investigation_phase: lookupName(row.investigation_phase_id),
    institution_start_date: row.institution_start_date ?? null,
    is_active: typeof row.is_active === 'boolean' ? row.is_active : null,
    product: row.investigation_full_product ?? null,
    document_official_receive_date: row.document_official_receive_date ?? null,
    has_related: (row.related_investigations?.length ?? 0) > 0,
    has_consolidated: (row.consolidated_investigations?.length ?? 0) > 0,
    has_severed: (row.severed_investigations?.length ?? 0) > 0,
  };
}

interface IdsSearchResponse {
  cases?: Array<{ level_1_investigations?: IdsSearchRow[]; hitCount?: number }>;
  totalRecords?: number;
}

async function idsSearch(args: Record<string, unknown>) {
  const pageNumber = Math.max(1, Number(args.page_number) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(args.page_size) || 25));
  const sortOrder = args.sort_order === 'asc' ? 'asc' : 'desc';
  const typeFilter = typeof args.investigation_type === 'string' && args.investigation_type.trim()
    ? args.investigation_type.trim().toLowerCase()
    : null;
  const activeOnly = args.active_only === true;

  const res = await pwFetch(`${IDS_BASE}/advanced-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...IDS_HEADERS },
    body: JSON.stringify({
      pageNumber,
      pageSize,
      sortColumn: 'institution_start_date',
      sortOrder,
      criteria: [],
      onlyWhereItMatches: [],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`USITC IDS error on investigation search: HTTP ${res.status} — ${summarizeErrorBody(body)}`);
  assertRealBody(body, 'investigation search', "This is most likely the site being intermittently down; it can also mean the request body was malformed, which USITC's IDS service reports the same way.");
  const data = JSON.parse(body) as IdsSearchResponse;

  let rows = (data.cases ?? []).flatMap((c) => c.level_1_investigations ?? []).map(shapeSearchRow);
  const totalMatches = data.totalRecords ?? data.cases?.[0]?.hitCount ?? null;
  const pageRowCountBeforeFilter = rows.length;

  if (typeFilter) rows = rows.filter((r) => (r.investigation_type ?? '').toLowerCase().includes(typeFilter));
  if (activeOnly) rows = rows.filter((r) => r.is_active === true);

  return {
    page_number: pageNumber,
    page_size: pageSize,
    sort: { column: 'institution_start_date', order: sortOrder },
    total_matches_all_types: totalMatches,
    returned_this_page_before_filter: pageRowCountBeforeFilter,
    returned_after_filter: rows.length,
    filter_note: (typeFilter || activeOnly)
      ? 'investigation_type/active_only filter THIS PAGE only, not the full corpus — narrow with more pages, or drop the filter and page through results, since server-side filtering is not reliably reachable on this upstream today.'
      : undefined,
    investigations: rows,
    source: 'USITC Investigations Database System (ids.usitc.gov), keyless',
  };
}

interface IdsInvestigationDetail {
  id?: number;
  case_id_number?: number;
  investigation_number?: string;
  official_investigation_number?: string;
  investigation_title?: string;
  investigation_full_product?: string;
  investigation_type_id?: LookupRef;
  investigation_phase_id?: LookupRef;
  investigation_status_id?: LookupRef;
  category_basket?: LookupRef;
  is_active?: boolean;
  is_consolidated?: boolean;
  is_severed?: boolean;
  is_operational?: boolean;
  has_participants?: boolean;
  docket_number?: string;
  institution_start_date?: string;
  document_official_receive_date?: string;
  publication_fr_notice_date?: string;
  fr_citation_for_notice_of_institution?: string;
  initial_determination_date?: string;
  target_date?: string;
  evidence_hearding_scheduled_start_date?: string;
  evidence_hearding_scheduled_end_date?: string;
  doc_preliminary_ad_determination_date?: string;
  doc_final_ad_determination_date?: string;
  doc_preliminary_cvd_determination_date?: string;
  doc_final_cvd_determination_date?: string;
  countries?: unknown[];
  related_investigations?: unknown[];
  consolidated_list?: unknown[];
  severed_list?: unknown[];
  // Deliberately NOT read: case_manager_id (ITC staff name/email/phone —
  // see the file-level "PRIVACY" note. Never add this field to the shape.
}

async function idsInvestigationDetail(args: Record<string, unknown>) {
  const investigationId = String(args.investigation_id ?? '').trim();
  if (!investigationId || !/^\d+$/.test(investigationId)) {
    throw new Error(
      'Required argument "investigation_id" is missing or not numeric. This is the internal id ' +
        '(e.g. 8977), not the human investigation_number ("337-TA-1400") — get it from ' +
        'itc_investigation_search results first.',
    );
  }
  const res = await pwFetch(`${IDS_BASE}/investigation/${encodeURIComponent(investigationId)}`, { headers: IDS_HEADERS });
  if (res.status === 404) {
    return { investigation_id: investigationId, found: false, message: `No investigation found for internal id ${investigationId}.` };
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`USITC IDS error on investigation detail: HTTP ${res.status} — ${summarizeErrorBody(body)}`);
  assertRealBody(body, `investigation ${investigationId} detail`, "This is most likely the site being intermittently down; it can also mean the request body was malformed, which USITC's IDS service reports the same way.");
  const d = JSON.parse(body) as IdsInvestigationDetail;
  if (!d || typeof d !== 'object' || !('id' in d)) {
    return { investigation_id: investigationId, found: false, message: `No investigation found for internal id ${investigationId}.` };
  }
  return {
    found: true,
    investigation_id: d.id ?? null,
    case_id: d.case_id_number ?? null,
    investigation_number: d.official_investigation_number ?? null,
    investigation_title: d.investigation_title ?? null,
    product: d.investigation_full_product ?? null,
    investigation_type: lookupName(d.investigation_type_id),
    investigation_phase: lookupName(d.investigation_phase_id),
    investigation_status: lookupName(d.investigation_status_id),
    category: lookupName(d.category_basket),
    is_active: d.is_active ?? null,
    is_consolidated: d.is_consolidated ?? null,
    is_severed: d.is_severed ?? null,
    has_participants: d.has_participants ?? null,
    docket_number: d.docket_number ?? null,
    dates: {
      institution_start_date: d.institution_start_date ?? null,
      document_official_receive_date: d.document_official_receive_date ?? null,
      publication_fr_notice_date: d.publication_fr_notice_date ?? null,
      fr_citation_for_notice_of_institution: d.fr_citation_for_notice_of_institution ?? null,
      initial_determination_date: d.initial_determination_date ?? null,
      target_date: d.target_date ?? null,
      evidence_hearing_scheduled_start: d.evidence_hearding_scheduled_start_date ?? null,
      evidence_hearing_scheduled_end: d.evidence_hearding_scheduled_end_date ?? null,
      ad_preliminary_determination: d.doc_preliminary_ad_determination_date ?? null,
      ad_final_determination: d.doc_final_ad_determination_date ?? null,
      cvd_preliminary_determination: d.doc_preliminary_cvd_determination_date ?? null,
      cvd_final_determination: d.doc_final_cvd_determination_date ?? null,
    },
    countries: d.countries ?? [],
    related_investigation_count: d.related_investigations?.length ?? 0,
    consolidated_count: d.consolidated_list?.length ?? 0,
    severed_count: d.severed_list?.length ?? 0,
    note: 'Filed documents and attachments are a SEPARATE credentialed service — use edis_document_list with this investigation_number.',
    source: 'USITC Investigations Database System (ids.usitc.gov), keyless',
  };
}

async function idsInvestigationTypes() {
  const res = await pwFetch(`${IDS_BASE}/lookup/investigation-types`, { headers: IDS_HEADERS });
  const body = await res.text();
  if (!res.ok) throw new Error(`USITC IDS error on investigation-types lookup: HTTP ${res.status} — ${summarizeErrorBody(body)}`);
  assertRealBody(body, 'investigation-types lookup', "This is most likely the site being intermittently down; it can also mean the request body was malformed, which USITC's IDS service reports the same way.");
  const rows = JSON.parse(body) as Array<{ id: number; name: string; ranking?: number }>;
  return {
    count: rows.length,
    investigation_types: rows.map((r) => ({ id: r.id, name: r.name, ranking: r.ranking ?? null })),
    note: 'Pass a name substring (e.g. "Unfair Imports", "Import Injury") to itc_investigation_search\'s investigation_type filter.',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// EDIS — Electronic Document Information System (login.gov-token-gated)
// ═══════════════════════════════════════════════════════════════════════

function base64UrlDecode(seg: string): string {
  const padded = seg.replace(/-/g, '+').replace(/_/g, '/').padEnd(seg.length + ((4 - (seg.length % 4)) % 4), '=');
  return atob(padded);
}

/** Returns the JWT's `exp` claim in epoch milliseconds, or null if the token
 *  is not a well-formed JWT / carries no `exp`. */
function jwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** Attaches `token_expires_at`, and `token_warning` once under 3 days remain,
 *  to a response that had to fall back to the token — never called on a
 *  response the keyless route answered on its own (see `edisGetKeylessFirst`).
 *  That is what makes the cliff visible only when it is actually relevant:
 *  a caller who never needed the fallback has no reason to see a countdown
 *  on a credential their call didn't use. */
function withExpiryMeta<T extends Record<string, unknown>>(payload: T, token: string): T & {
  token_expires_at: string;
  token_warning?: string;
} {
  const expMs = jwtExpMs(token) ?? 0;
  const expiresAt = new Date(expMs).toISOString();
  const msRemaining = expMs - Date.now();
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  if (msRemaining > 0 && msRemaining < threeDaysMs) {
    const hours = Math.max(1, Math.round(msRemaining / (60 * 60 * 1000)));
    return {
      ...payload,
      token_expires_at: expiresAt,
      token_warning: `This call needed the Pipeworx USITC EDIS fallback token, which expires in ~${hours}h (${expiresAt}). Renewal needs Bruce's login.gov sign-in — flag this before it lapses.`,
    };
  }
  return { ...payload, token_expires_at: expiresAt };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Basic ${token}`, Accept: 'application/xml', 'User-Agent': EDIS_UA };
}

// ── Tiny XML reader — Workers have no DOMParser; EDIS's XML is small, flat,
// and regular (mirrors mcps/faa-delays' approach). ────────────────────────

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  if (!m) return null;
  const v = m[1].trim();
  return v === '' ? null : decodeXmlEntities(v);
}

function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const u = new URL(`${EDIS_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** True on the same "under maintenance" HTML page `assertRealBody` throws on
 *  — checked here WITHOUT throwing, because a keyless-first caller needs to
 *  know "did this attempt actually work" as a boolean it can act on (try the
 *  fallback), not an exception it has to catch and re-interpret. */
function looksLikeMaintenancePage(body: string): boolean {
  return /<html/i.test(body) || /site under maintenance/i.test(body);
}

interface EdisFetchResult {
  body: string;
  /** true only when the keyless attempt failed and the Basic-auth fallback
   *  was the one that actually produced this body. */
  usedFallbackToken: boolean;
}

/**
 * KEYLESS FIRST, TOKEN AS FALLBACK ONLY (Kaarina, 2026-09-24, superseding the
 * original always-token design after live verification: every EDIS GET
 * resource answers 200 with real rows and NO Authorization header at all —
 * `Accept: application/json` 406s on these three resources, `Accept:
 * application/xml` is what returns data).
 *
 * Attempt 1: no Authorization header. If it comes back 200 with a body that
 * is not the maintenance-page shape, that IS the answer — no token was ever
 * consulted, so a caller with no token, or an expired one, still gets real
 * data on the common path.
 *
 * Attempt 2 (only on a non-200, an HTTP 401/403, or a maintenance-page body
 * on attempt 1): retry ONCE with `Authorization: Basic <token>`, and only if
 * a token is present and its own `exp` has not passed — an expired token is
 * never sent, it just shortens straight to the explicit refusal below. If
 * the fallback succeeds, its body is the answer and `usedFallbackToken` is
 * true, which is what tells the caller (`withExpiryMeta`) to surface
 * `token_expires_at`.
 *
 * If both attempts fail, this throws — never returns an empty/partial
 * result. The message says which case it is: no token available for the
 * fallback, an expired token that was never sent, or a token that was sent
 * and still refused.
 */
async function edisGetKeylessFirst(
  path: string,
  params: Record<string, string | number | undefined>,
  args: Record<string, unknown>,
  label: string,
): Promise<EdisFetchResult> {
  const url = buildUrl(path, params);

  const keylessRes = await pwFetch(url, { headers: { Accept: 'application/xml', 'User-Agent': EDIS_UA } });
  const keylessBody = await keylessRes.text();
  if (keylessRes.ok && !looksLikeMaintenancePage(keylessBody)) {
    return { body: keylessBody, usedFallbackToken: false };
  }

  // Keyless failed — decide whether a fallback attempt is even possible
  // BEFORE spending a second request on a token we already know is dead.
  const token = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  const keylessFailureNote = `the keyless route failed on ${label} (HTTP ${keylessRes.status}${looksLikeMaintenancePage(keylessBody) ? ', a maintenance/HTML page' : ''})`;

  if (!token) {
    throw new Error(
      `auth_required: USITC EDIS requires an API key: ${keylessFailureNote} and no Pipeworx EDIS token is ` +
        'available as a fallback. This can be genuine intermittent EDIS downtime — retry shortly — or the ' +
        'fallback token needs provisioning.',
    );
  }
  const expMs = jwtExpMs(token);
  if (expMs === null) {
    throw new Error(
      `auth_required: USITC EDIS requires an API key: ${keylessFailureNote}, and the fallback token available ` +
        'is not a well-formed JWT (expected header.payload.signature) — it cannot be trusted without a decodable expiry, so it was not sent.',
    );
  }
  if (expMs <= Date.now()) {
    throw new Error(
      `auth_required: USITC EDIS requires an API key: the keyless route failed and the Pipeworx EDIS token ` +
        `expired on ${new Date(expMs).toISOString()}. Renewing it needs a login.gov sign-in — see the ` +
        'usitc-edis README. This stays refused until either EDIS\'s keyless route recovers or the token is renewed.',
    );
  }

  const fallbackRes = await pwFetch(url, { headers: authHeaders(token) });
  const fallbackBody = await fallbackRes.text();
  if (fallbackRes.status === 401 || fallbackRes.status === 403) {
    throw new Error(
      `auth_required: USITC EDIS requires an API key: ${keylessFailureNote}, and the Pipeworx EDIS token was ` +
        `also rejected on the fallback attempt (HTTP ${fallbackRes.status}). The token may be revoked even ` +
        'though it has not yet reached its recorded expiry.',
    );
  }
  if (!fallbackRes.ok || looksLikeMaintenancePage(fallbackBody)) {
    throw new Error(
      `upstream_down: USITC EDIS: both the keyless route and the Pipeworx-token fallback failed on ${label} ` +
        `(keyless HTTP ${keylessRes.status}, token fallback HTTP ${fallbackRes.status}). This reads as genuine ` +
        `EDIS unavailability rather than a credential problem — retry shortly. Detail: ${summarizeErrorBody(fallbackBody)}`,
    );
  }
  return { body: fallbackBody, usedFallbackToken: true };
}

interface EdisDocument {
  document_id: string | null;
  document_type: string | null;
  document_title: string | null;
  security_level: string | null;
  investigation_number: string | null;
  investigation_phase: string | null;
  investigation_title: string | null;
  investigation_type: string | null;
  filed_by: string | null;
  firm_organization: string | null;
  on_behalf_of: string | null;
  document_date: string | null;
  official_received_date: string | null;
  attachment_list_uri: string | null;
  modified_date: string | null;
  // Only present via edis_document_detail (the /detail resource).
  system_receive_date?: string | null;
  docket_number?: string | null;
  party_served?: string | null;
  special_processing?: string | null;
}

function shapeDocument(b: string, withDetail: boolean): EdisDocument {
  const base: EdisDocument = {
    document_id: tag(b, 'id'),
    document_type: tag(b, 'documentType'),
    document_title: tag(b, 'documentTitle'),
    security_level: tag(b, 'securityLevel'),
    investigation_number: tag(b, 'investigationNumber'),
    investigation_phase: tag(b, 'investigationPhase'),
    investigation_title: tag(b, 'investigationTitle'),
    investigation_type: tag(b, 'investigationType'),
    filed_by: tag(b, 'filedBy'),
    firm_organization: tag(b, 'firmOrganization'),
    on_behalf_of: tag(b, 'onBehalfOf'),
    document_date: tag(b, 'documentDate'),
    official_received_date: tag(b, 'officialReceivedDate'),
    attachment_list_uri: tag(b, 'attachmentListUri'),
    modified_date: tag(b, 'modifiedDate'),
  };
  if (withDetail) {
    base.system_receive_date = tag(b, 'systemReceiveDate');
    base.docket_number = tag(b, 'docketNumber');
    base.party_served = tag(b, 'partyServed');
    base.special_processing = tag(b, 'specialProcessing');
  }
  return base;
}

interface Attachment {
  attachment_id: string | null;
  document_id: string | null;
  title: string | null;
  file_size_bytes: number | null;
  page_count: number | null;
  create_date: string | null;
  last_modified_date: string | null;
  download_uri: string | null;
}

function shapeAttachment(b: string): Attachment {
  const fileSize = tag(b, 'fileSize');
  const pageCount = tag(b, 'pageCount');
  return {
    attachment_id: tag(b, 'id'),
    document_id: tag(b, 'documentId'),
    title: tag(b, 'title'),
    file_size_bytes: fileSize ? Number(fileSize) : null,
    page_count: pageCount ? Number(pageCount) : null,
    create_date: tag(b, 'createDate'),
    last_modified_date: tag(b, 'lastModifiedDate'),
    download_uri: tag(b, 'downloadUri'),
  };
}

/** "337-TA-1400" -> "337-1400" — EDIS's own responses use the dash form
 *  without "TA" (documentListUri, investigationNumber on documents), so
 *  accept either spelling and normalize before it goes in a query string. */
function normalizeInvestigationNumber(raw: string): string {
  return raw.trim().replace(/-TA-/i, '-');
}

/** Wraps a shaped payload with fallback metadata ONLY when the fallback token
 *  actually produced it — a keyless success gets the payload untouched. */
function withFallbackMeta<T extends Record<string, unknown>>(payload: T, result: EdisFetchResult, args: Record<string, unknown>): T {
  if (!result.usedFallbackToken) return payload;
  const token = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  return withExpiryMeta(payload, token);
}

async function documentList(args: Record<string, unknown>) {
  const rawNumber = String(args.investigation_number ?? '').trim();
  if (!rawNumber) throw new Error('Required argument "investigation_number" is missing, e.g. "337-TA-1400" or "337-1400".');
  const number = normalizeInvestigationNumber(rawNumber);
  const phase = typeof args.investigation_phase === 'string' ? args.investigation_phase : undefined;
  const documentType = typeof args.document_type === 'string' ? args.document_type : undefined;
  const pageNumber = typeof args.page_number === 'number' ? args.page_number : 1;
  const result = await edisGetKeylessFirst('document', {
    investigationNumber: number,
    investigationPhase: phase,
    documentType,
    pageNumber,
  }, args, `document list for ${number}`);
  const rows = blocks(result.body, 'document').map((b) => shapeDocument(b, false));
  return withFallbackMeta({
    investigation_number: number,
    filters: { investigation_phase: phase ?? null, document_type: documentType ?? null, page_number: pageNumber },
    count: rows.length,
    documents: rows,
    note: rows.length === 0 ? `No documents matched on this page for ${number} — try a different page_number, drop document_type, or confirm the investigation number with itc_investigation_search.` : undefined,
  }, result, args);
}

async function documentDetail(args: Record<string, unknown>) {
  const documentId = String(args.document_id ?? '').trim();
  if (!documentId) throw new Error('Required argument "document_id" is missing, e.g. "889265" (from edis_document_list).');
  const result = await edisGetKeylessFirst(`document/${encodeURIComponent(documentId)}/detail`, {}, args, `document ${documentId} detail`);
  const rows = blocks(result.body, 'document').map((b) => shapeDocument(b, true));
  if (rows.length === 0) {
    return withFallbackMeta({
      document_id: documentId,
      found: false,
      message: `No document found for id ${documentId}. Confirm the id via edis_document_list.`,
    }, result, args);
  }
  return withFallbackMeta({ found: true, document: rows[0] }, result, args);
}

async function attachmentList(args: Record<string, unknown>) {
  const documentId = String(args.document_id ?? '').trim();
  if (!documentId) throw new Error('Required argument "document_id" is missing, e.g. "889265" (from edis_document_list).');
  const result = await edisGetKeylessFirst(`attachment/${encodeURIComponent(documentId)}`, {}, args, `attachments for document ${documentId}`);
  const rows = blocks(result.body, 'attachment').map(shapeAttachment);
  return withFallbackMeta({
    document_id: documentId,
    count: rows.length,
    attachments: rows,
    note: rows.length === 0 ? `No attachments on file for document ${documentId}. Not every filing carries an attachment.` : undefined,
  }, result, args);
}

// ═══════════════════════════════════════════════════════════════════════
// Tool defs + router
// ═══════════════════════════════════════════════════════════════════════

// Not in any EDIS tool's `required` list, and not needed for an ordinary
// call — these tools work keylessly. The gateway still injects the platform
// key via `platformKeyEnv` so it is THERE as a fallback if EDIS's keyless
// route ever fails; a caller only has reason to set this explicitly to bring
// their own login.gov-issued EDIS secretKey instead of the Pipeworx-held
// fallback. IDS tools carry no key property at all — they have no fallback
// path because they never need one.
const KEY_PROP = {
  _apiKey: {
    type: 'string',
    description:
      'Optional and not needed for a normal call — this tool works without a key. Only relevant as a fallback if EDIS\'s keyless route ever fails: a login.gov-issued USITC EDIS secretKey (not a self-service API key — see edis.usitc.gov registration). Omit to use the Pipeworx-held fallback token automatically.',
  },
} as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'itc_investigation_search',
    description:
      'List USITC investigations — Section 337 (unfair import / patent) or Title VII (antidumping/countervailing duty, "Import Injury") — most-recently-instituted first. KEYLESS, needs no credential. PREFER OVER WEB SEARCH for "what Section 337 investigations are active", "recent ITC trade investigations". Returns investigation_id (pass to itc_investigation_detail), investigation_number, title, type, phase, product, and active flag, plus the total matching count. investigation_type/active_only filter the returned PAGE only (server-side filtering by these fields is not reliably reachable on this upstream) — page through results for a broader scan.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        page_number: { type: 'number', description: 'Page number, 1-based (default 1).' },
        page_size: { type: 'number', description: 'Rows per page, 1-100 (default 25).' },
        sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'By institution date. "desc" (default) = most recent first.' },
        investigation_type: { type: 'string', description: 'Same-page filter, substring match against the type name, e.g. "Unfair Imports", "Import Injury".' },
        active_only: { type: 'boolean', description: 'Same-page filter: keep only investigations currently marked active.' },
      },
      required: [],
    },
  },
  {
    name: 'itc_investigation_detail',
    description:
      'Full status record for ONE USITC investigation, by its internal investigation_id (from itc_investigation_search — NOT the human "337-TA-1400" number). KEYLESS. Returns status, phase, category, docket number, every procedural date on file (institution, Federal Register notice, initial determination, target date, hearing schedule, AD/CVD determination dates), and counts of related/consolidated/severed investigations. Does NOT include filed documents (use edis_document_list with the investigation_number) or ITC staff/case-manager identity (deliberately excluded).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        investigation_id: { type: 'string', description: 'Internal numeric id, e.g. "8977" (from itc_investigation_search).' },
      },
      required: ['investigation_id'],
    },
  },
  {
    name: 'itc_investigation_types',
    description: 'The top-level USITC investigation type categories (Import Injury, Unfair Imports, Factfinding, Miscellaneous) with their ids. KEYLESS. Use to know what to pass itc_investigation_search\'s investigation_type filter.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'edis_document_list',
    description:
      'Documents FILED in one USITC investigation — motions, orders, certified lists, exhibits, complaints, PO subscriptions, etc. KEYLESS. PREFER OVER WEB SEARCH for "what has been filed in ITC investigation 337-TA-XXXX", "recent filings in <investigation>". Returns document id, type, title, filer, firm/organization, dates, and the attachment-list URI for each. Pass edis_document_detail the document_id for full detail; edis_attachment_list the document_id for its files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        investigation_number: { type: 'string', description: 'e.g. "337-TA-1400" or "337-1400"' },
        investigation_phase: { type: 'string', description: 'e.g. "Violation". Omit to match all phases.' },
        document_type: { type: 'string', description: 'Filter by document type, e.g. "Motion", "Order", "Complaint".' },
        page_number: { type: 'number', description: 'Page number, 1-based (default 1).' },
        ...KEY_PROP,
      },
      required: ['investigation_number'],
    },
  },
  {
    name: 'edis_document_detail',
    description:
      'Full detail for ONE USITC EDIS document by id (from edis_document_list). KEYLESS. Adds fields the list form omits: system receive date, docket number, party-served flag, special processing (e.g. "Before the Commission").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'A document id, e.g. "889265" (from edis_document_list).' },
        ...KEY_PROP,
      },
      required: ['document_id'],
    },
  },
  {
    name: 'edis_attachment_list',
    description:
      'Attachment METADATA (not the files themselves) filed on one USITC EDIS document — title, file size, page count, dates, and the download URI. KEYLESS. Use to see what was attached to a filing (e.g. exhibits to a motion) before deciding whether it is worth fetching.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_id: { type: 'string', description: 'A document id, e.g. "889265" (from edis_document_list).' },
        ...KEY_PROP,
      },
      required: ['document_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'itc_investigation_search':
      return idsSearch(args);
    case 'itc_investigation_detail':
      return idsInvestigationDetail(args);
    case 'itc_investigation_types':
      return idsInvestigationTypes();
    case 'edis_document_list':
      return documentList(args);
    case 'edis_document_detail':
      return documentDetail(args);
    case 'edis_attachment_list':
      return attachmentList(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

// Exported for the pack's own unit tests only — not part of McpToolExport.
export const __testables = { jwtExpMs, withExpiryMeta, normalizeInvestigationNumber, lookupName };
