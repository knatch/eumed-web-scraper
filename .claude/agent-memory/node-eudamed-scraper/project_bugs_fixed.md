---
name: Confirmed bugs fixed in EUDAMED scraper (2026-03-24, updated)
description: All known bugs patched across multiple fix passes — includes API interception failures, wrong URLs, UUID extraction, and CA DOM extraction
type: project
---

## Fix Pass 1 (earlier on 2026-03-24)

**BUG 1 — Listener accumulation**
`page.on('response', handler)` used in both listPage.js and detailPage.js without cleanup. Fixed by keeping `page.on` but ensuring `page.off(responseHandler)` is called in the `finally` block unconditionally.

**Why:** `page.once` only fires on the *first* response (the HTML document), missing the later /api/eos API call. `page.on` + `finally page.off` is the correct pattern.

**BUG 2 — networkidle2 stalls SPAs**
Both files used `waitUntil: 'networkidle2'`. Changed to `waitUntil: 'domcontentloaded'`. Angular SPAs maintain persistent connections; networkidle2 would wait the full 60s timeout.

**BUG 3 — Silent timeout swallowed**
`waitForSelector` timeout was caught by `.catch(() => logger.warn(...))` which let execution continue on a blank page. Fixed by setting a `selectorFound = false` flag and throwing if both the selector timed out AND no API data was intercepted.

**BUG 4 (index.js) — Double detail extraction**
`index.js` called `navigateToDetailPage()` then discarded its return value and called `extractDetailData(page, null)` a second time — losing all intercepted API data. Fixed by using the return value of `navigateToDetailPage` directly.

---

## Fix Pass 2 (2026-03-24, second session)

**BUG 5 — Wrong DETAIL_BASE_URL**
`detailPage.js` had `DETAIL_BASE_URL = '#/screen/actor'`. The confirmed correct URL from the task spec's example is `#/screen/search-eo/{uuid}`. Fixed to `#/screen/search-eo`.

Evidence: Task description provides example detail URL `https://ec.europa.eu/tools/eudamed/#/screen/search-eo/51fd1857-427d-467d-ada7-188ae4240510`.

**BUG 6 (RESOLVED in Fix Pass 3) — isActorsList matched wrong URL**
The `/actors` API interception filter never fired because the real endpoint is `/api/eos` (Economic Operators = EOs), not `/actors`. See Fix Pass 3.

**BUG 7 — index.js wastes 3 retries on empty UUID**
When UUID is empty, navigating to `#/screen/search-eo/` (no UUID) just reloads the search page — guaranteed 3-retry failure. Fixed by adding an early guard in `index.js` that logs an error and skips the row immediately when `row.uuid` is empty.

---

## Fix Pass 3 (2026-03-24, third session)

**BUG 6 RESOLVED — isActorsList never fired (wrong endpoint pattern)**

Root cause confirmed from logs: The real EUDAMED list API endpoint is:
  `https://ec.europa.eu/tools/eudamed/api/eos?page=0&pageSize=50&...`

The old filter matched URLs containing "actor" — this never matched `/api/eos`.

**Fixes applied:**

1. `src/scraper/listPage.js` — `isActorsList` now:
   ```javascript
   const isActorsList = reqUrl.includes('/api/eos') && !reqUrl.match(/\/api\/eos\/[a-f0-9-]{8,}/i);
   ```

2. `src/scraper/detailPage.js` — `isActorDetailPath` now:
   ```javascript
   const isActorDetailPath = uuid && reqUrl.includes('/api/eos/') && reqUrl.includes(uuid);
   ```

3. `src/scraper/selectors.js` — API path constants updated:
   ```javascript
   API_ACTORS_PATH: '/api/eos',
   API_ACTOR_DETAIL_PATH: '/api/eos/',
   ```

**FIELD NAMES — UNKNOWN, AWAITING dry-run OUTPUT**
The `/api/eos` response wrapper key and actor field names are not yet confirmed from a live run.
Field name extraction in `extractListRows` already tries all common candidates:
- UUID: `uuid`, `actorUuid`, `actorId`, `eudamedId`, `id`, `actorGuid`, `guid`, `uniqueId`, `eoId`
- Wrapper: `content`, `data`, `results`, `items`, `records` (+ root array)
- SRN: `srn`, `srnCode`, `actorSrn`
- Name: `name`, `actorName`, `fullName`
- City: `cityName`, `city`
- Address (list): `geographicalAddress`, `actorAddress`, `address`
- Email (list): `electronicMail`, `email`, `emailAddress`
- Phone (list): `telephone`, `phone`, `phoneNumber`

The dry-run logs `[extractListRows] First actor raw:` and `[detail intercept] Full JSON (first capture):` — paste those to confirm field names.

---

## Fix Pass 4 (2026-03-24, fourth session)

**BUG 8 — detailPage.js still matched wrong detail endpoint**

Despite Fix Pass 3 updating `selectors.js` and memory, the actual `isActorDetailPath` condition in `detailPage.js` was never updated — it still checked:
```javascript
reqUrl.includes('/api/actors/') && reqUrl.includes('/publicInformation')
```
This never matches the real endpoint `/api/eos/{uuid}`. Fixed to:
```javascript
const isActorDetailPath = uuid && reqUrl.includes('/api/eos/') && reqUrl.includes(uuid);
```

Also added `geographicalAddress` as first candidate in `extractDetailData` address lookup (matches the list-page field name), and `electronicMail` as a candidate in `extractContacts`.

---

## Fix Pass 5 (2026-03-24, fifth session)

**Root cause confirmed from dry-run output:** `/api/eos` never fired because the Angular search form requires an explicit user interaction (clicking Search) or the `submitted=true` URL param alone is insufficient to auto-dispatch the query.

**Three bugs addressed:**

**BUG 9 — Angular form never auto-submits from URL params alone**

The EUDAMED search page at `#/screen/search-eo?...&submitted=true` does NOT auto-fire `/api/eos`. After navigation and Angular bootstrap, the user must click a Search button (or the app has a mat-form submit handler that only triggers on click).

Fix: `navigateToListPage` now implements a full Angular SPA strategy:
1. Register response interceptor BEFORE `page.goto()`
2. Wait for domcontentloaded
3. Wait up to 10s for `app-root, [ng-version], eudamed-root` to confirm Angular is bootstrapped
4. Wait 2s for Angular router to process URL params
5. If no API data yet: call `_tryClickSearchButton()` which tries `button[type="submit"]`, then text-match `/search|apply|find|submit/i`, then `form button[mat-*]`
6. After click (or without): poll every 500ms up to 20s for API intercept OR DOM row/no-results selector via `_waitForResultsOrApi()`
7. Final guard: if still no data and no DOM selector, throw (triggers retry)

**BUG 10 — "Session closed" crash cascades through all retries**

When `page.goto()` destroys the page context (Angular route changes in some Puppeteer versions), retrying `navigateToListPage(page, ...)` on the same dead page object fails instantly with "Protocol error: Session closed".

Fix: `src/browser.js` gains `getOrCreatePage(browser, existingPage)` — checks `existingPage.isClosed()` (with catch for when even that throws) and returns a fresh page if needed.

In `src/index.js`:
- `const page` changed to `let page`
- The `withRetry` lambda for list pages now calls `page = await getOrCreatePage(browser, page)` before each attempt

**BUG 11 — Selector timeout fired after only ~12s (not 30s)**

The old code used `page.waitForSelector(..., { timeout: 30000 })`. Because the Angular app rendered (domcontentloaded fired) but never showed data, some internal Puppeteer/CDP timeout fired earlier. Replaced with the poll-based `_waitForResultsOrApi` which has explicit control and exits immediately when either the API intercept or DOM selector is satisfied.

---

---

## Fix Pass 6 (2026-03-24, sixth session)

**BUG 12 — CA fields always empty: API response has no CA data, but extractDetailData returned early before DOM scraping**

**Root cause confirmed from DOM investigation:**
- The `/api/eos/{uuid}` response does NOT contain CA data. It has importer/nonEuManufacturer relations only.
- CA data is rendered exclusively in the DOM.
- Website is also in DOM only, under label "Web site" (with space), as plain text (may not be an `<a>` tag).

**Fixes applied to `src/scraper/detailPage.js`:**

1. `extractDetailData` no longer returns early after API extraction. Two explicit steps:
   - Step 1: parse API data for actorAddress, email, phone only.
   - Step 2: DOM scraping ALWAYS runs — extracts website and CA fields.

2. Merge strategy:
   - actorAddress, email, phone: DOM fills in only if still empty (API values preferred).
   - website, caName, caAddress, caCountry, caEmail, caPhone: DOM is always authoritative.

---

## Fix Pass 7 (2026-03-24, seventh session)

**BUG 13 — CA extraction used wrong anchor: mat-expansion-panel does not contain CA data**

**Root cause (confirmed by user inspecting live HTML):**
- The CA data is NOT inside a `mat-expansion-panel`.
- The real DOM structure: there is an `h2` element with `id="competent-authority-person"`, and the CA data is in the **immediately following sibling element** (a `div`).
- Selector: `#competent-authority-person + div` (CSS adjacent sibling combinator).

**Fixes applied to `src/scraper/detailPage.js`:**

1. CA extraction block (in `page.evaluate()`) replaced entirely:
   - Old: iterated `mat-expansion-panel` elements, checked header for "Competent Authority"
   - New:
     ```javascript
     const caSection =
       document.querySelector('#competent-authority-person + div') ||
       document.querySelector('#competent-authority-person')?.nextElementSibling || null;
     ```
   - Strategy 1: `innerText` newline regex — `extractField(label)` uses `/label\s*\n\s*([^\n]+)/i`
   - Strategy 2 fallback: leaf-node label→value scan (for collapsed/hidden sections)
   - Key normalisation: `lower.replace(/\s+/g, '')` so "telephone number" → "telephonenumber"

2. `waitForSelector` in `navigateToDetailPage` changed:
   - Old primary: `mat-expansion-panel` (20s timeout)
   - New primary: `#competent-authority-person` (20s timeout) — directly anchors to the CA section
   - Fallback list kept the same (mat-expansion-panel is now in the fallback list, not primary)

**CA field expected structure (label\nvalue layout in innerText):**
```
Name\n<ca name>\nAddress\n<ca address>\nCountry\n<ca country>\nEmail\n<ca email>\nTelephone number\n<ca phone>
```

---

---

## Fix Pass 8 (2026-03-25) — Resume logic bugs in index.js

**BUG 14 — No checkpoint synthesised when staging exists but progress.json is absent**

Root cause: if the process crashes between `appendToStaging(record)` (synchronous, fires immediately) and `saveCheckpoint(...)` (fires only every 50 records), staging accumulates records but `progress.json` is never written. On the next run `loadCheckpoint()` returns `null`, `startPage = 0`, `resumeFromRow = 0` — the entire run replays from page 0, re-scraping all already-written records and writing them a second time to both the workbook and staging.

Fix: after `loadCheckpoint()` and `loadStaging()`, if `checkpoint === null && stagingRecords.length > 0`, synthesise a checkpoint:
```js
const lastIdx = stagingRecords.length - 1;
checkpoint = {
  lastCompletedPageIndex: Math.floor(lastIdx / config.PAGE_SIZE),
  lastCompletedRowIndex:  lastIdx % config.PAGE_SIZE,
  totalRecordsWritten:    stagingRecords.length,
  synthesised: true,
};
```
This correctly positions the loop to start at the next unprocessed row.

**BUG 15 — catch block always saved lastCompletedRowIndex: 0**

The outer `try/catch` (unexpected error path) hardcoded `lastCompletedRowIndex: 0`. On resume this caused the first row of the crashed page to be skipped and all remaining rows replayed as duplicates.

Fix: track `let lastWrittenRowIndex` (initialised to `resumeFromRow - 1` or `-1`), updated to `i` after every successful `appendToStaging`. Use it in both the catch block and SIGINT/SIGTERM handler.

**BUG 16 — No SIGINT/SIGTERM handler**

Ctrl+C killed the process without saving a checkpoint. On resume: no `progress.json` → hit Bug 14 (now fixed by synthesis), but also the last partial-page progress since the last periodic checkpoint would always be lost.

Fix: register `process.once('SIGINT', ...)` and `process.once('SIGTERM', ...)` inside `main()` (closure over `pageIndex`, `lastWrittenRowIndex`, `totalRecords`, `workbook`, `csvStream`, `browser`) that saves checkpoint, flushes workbook/CSV, closes browser, and exits cleanly.

---

## Fix Pass 9 (2026-03-25) — Scraper never terminates at end of data

**BUG 17 — API interceptor discarded empty arrays (end-of-data signal)**

The `responseHandler` in `listPage.js` only set `interceptedActors` when `actors.length > 0`. When the API returned a valid paginated response with an empty `content: []` array (no more records), `interceptedActors` stayed `null`. The code then fell through to DOM checks, found no rows, threw an error, retried 3 times, returned `null` — and the outer loop in `index.js` incremented `pageIndex` and continued forever.

Fix (listPage.js):
- Added `else if (Array.isArray(actors) && actors.length === 0)` branch that sets `interceptedActors = []`
- Added check for `totalElements === 0` in the response object
- Added early return before Step 5: if `interceptedActors` is `[]`, return `[]` immediately

**BUG 18 — Outer loop had no termination for consecutive page failures**

When `withRetry` returned `null` (all retries exhausted), `index.js` incremented `pageIndex` and looped forever. There was no upper bound.

Fix (index.js):
- Added `consecutivePageFailures` counter, reset to 0 on any successful page load
- After `MAX_CONSECUTIVE_FAILURES` (3) consecutive null results, break the loop

**BUG 19 — No partial-page (last page) detection**

When the last page contained fewer rows than `PAGE_SIZE`, the scraper would successfully process them, then advance to the next page (which would be empty/fail). This wasted time and relied on the empty-page detection working correctly.

Fix (index.js):
- After inner row loop, if `rows.length < config.PAGE_SIZE`, break immediately (this is the last page)

---

## Fix Pass 10 (2026-03-29) — AR, Importer, and Device field extraction rewrite

**BUGS 20-22 — AR/Importer fields empty due to speculative API extraction blocking DOM values**

Root cause: `extractDetailData` Step 1 (API intercept) speculatively extracted AR and Importer fields using guessed property names (`authorisedRepresentatives`, `importers`, etc.). When the API response happened to have any truthy value at these paths, the merge logic (`if (!detail.arName) detail.arName = domData.arName`) would not overwrite with the correct DOM-extracted value. Additionally, within the DOM `page.evaluate()` block, AR dt/dd extraction used `result.arName = result.arName || value` which also prevented proper assignment.

Fixes (detailPage.js):
1. Removed all speculative API extraction for AR and Importer fields (lines 222-252 replaced with a comment)
2. Rewrote AR DOM extraction to use clean `extractDtDdPairs()` helper: queries all `dl` elements in `#authorised-representative-person + div`, iterates dt/dd pairs, matches labels via regex
3. Rewrote Importer DOM extraction with same pattern, trying `#importer + div`, `#importers + div`, `[id*="importer"]`, and text-based heading search
4. Changed merge logic: AR and Importer fields now always take DOM values (same as CA/website), not conditional on empty

**BUGS 23-27 — Device fields (deviceName, nomenclatureCodes, applicableLegislation, riskClass, humanTissues) unreliable**

Root cause: DOM extraction used fragile leaf-node scanning (collecting ALL text nodes, matching by position) which broke when Angular injected extra elements. The "collecting" state machine for nomenclature codes was especially brittle.

Fixes (deviceDetailPage.js):
1. Replaced entire DOM extraction block with clean `extractDtDd()` helper that queries `dl > dt + dd` pairs
2. Device Name: extracted from `#basic-udi-data + div` dt/dd pairs, matching "device name"/"trade name"/"product name"
3. Nomenclature Codes: extracted from `#udi-di-data + div` dt/dd pairs, with multi-value concatenation (same label = newline-joined)
4. Risk Class, Applicable Legislation, Human Tissues: extracted from same UDI-DI section dt/dd pairs
5. All fields have clean innerText regex fallback scoped to the correct section, then a final full-page fallback
6. Removed all leaf-node scanning code

---

## Fix Pass 11 (2026-03-29) — Device detail merge priority bug

**BUG 28 — API values overriding correct DOM values in deviceDetailPage.js**

Root cause: The merge logic at lines 423-427 used `if (!result.field) result.field = domDevice.field` — meaning API-extracted values (populated via heuristic property-name guessing) took priority over DOM-extracted values. When the API response contained a truthy value at a guessed property name (e.g., `d.name` returning the manufacturer name instead of the device name), the correct DOM-extracted value was ignored.

Fix: Flipped merge priority so DOM always wins when it has a value:
```javascript
result.deviceName = domDevice.deviceName || result.deviceName;
```
(Same pattern for all 5 fields.)

---

## Fix Pass 12 (2026-03-29) — Device detail API intercept removed entirely

**BUG 29 — API intercept for device detail silently blanked all fields before DOM extraction**

Root cause (two-part failure):
1. The `deviceDetailHandler` intercepted JSON from `/api/devices/{uuid}`. When `interceptedDeviceDetail` was non-null, the API extraction block ran. It tried heuristic property names (`d.deviceName || d.name || d.tradeName || ...`). When none matched, every field fell to `|| ''`. Then line 320 (`result[key] = String(result[key] || '').trim()`) iterated ALL keys of `result`, converting the initial `'N/A'` defaults to empty strings.
2. The DOM extraction kept blank lines in the `lines` array (`split('\n').map(l => l.trim())` without filtering). If a blank line separated a label from its value, `lines[i + 1].length > 0` would be false and the field stayed empty.

Fixes applied to `src/scraper/deviceDetailPage.js`:
1. **Removed the entire API intercept path** — deleted `deviceDetailHandler`, `interceptedDeviceDetail` variable, `page.on/off('response')` for detail, and all API-based field extraction (lines 152-327 of old file). The heuristic property-name guessing was unreliable and actively harmful.
2. **Replaced DOM extraction with filtered-line approach** — `lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0)` removes blank lines so the label is always at index `i` and value at `i+1`.
3. **Added diagnostic logging** — `_debug_lineCount` and `_debug_sampleLabels` logged on every extraction; warning logged if all fields are empty.
4. **Simplified merge** — uses `if (domDevice.x) result.x = domDevice.x` instead of `domDevice.x || result.x`.
5. **Removed orphaned try block** — the `try/finally` that only existed to clean up the removed handler was replaced with flat sequential code.

---

## Fix Pass 13 (2026-03-30) — Device detail extraction diagnostics and resilient label matching

**BUG 30 — Device detail DOM extraction returns empty despite correct page content**

Root cause: UNKNOWN (under investigation). The dump file (`output/device_detail_dump.txt`) proves `document.body.innerText` contains the correct labels and values. The old `findValue()` used regex with `^...$` anchors which should match. But all 5 device fields came back as empty strings (converted to N/A by the fallback).

Possible causes under investigation:
- Invisible unicode characters (zero-width spaces etc.) in label text that survive `.trim()` but break `^...$` anchors
- Page navigating between dump capture and extraction
- `page.evaluate()` throwing silently (only logged at `warn` level which doesn't persist to log file)

**Fixes applied to `src/scraper/deviceDetailPage.js`:**

1. **Replaced regex-based `findValue()` with cascading `findLabel()` using `.toLowerCase()` string comparison:**
   - Strategy 1: exact match (`lines[i].toLowerCase() === lower`)
   - Strategy 2: `startsWith` (handles trailing content)
   - Strategy 3: `includes` (handles embedded labels)
   - Each match logs which strategy hit and at which index

2. **Nomenclature stop-labels changed from regex to lowercase string comparison** — same cascading approach

3. **All `logger.warn()` calls elevated to `logger.error()`** — the file transport only logs `error` level, so all previous device diagnostic messages were lost to console output only

4. **Added comprehensive diagnostics:**
   - `_debug_matchInfo`: logs which strategy matched each label and at which filtered-line index (or NOT_FOUND)
   - `_debug_url`: captures `window.location.href` inside `page.evaluate()` to detect page navigation
   - `_debug_sampleLabels`: shows filtered lines 40-54 (around expected label positions)
   - `currentUrl = page.url()` logged before extraction
   - All diagnostics logged at `error` level so they persist to `logs/errors.log`

5. **Enhanced debug dump:** now also writes a `--- FILTERED LINES (N) ---` section showing the indexed filtered-line array, enabling offline verification of label matching

**Why:** The previous regex approach with `^...$` anchors was theoretically correct for the dump content, but something at runtime prevented matches. The cascading string-based approach is more resilient to invisible characters, trailing whitespace, or minor label variations. The real root cause should be visible in the next run's `errors.log` via the diagnostic output.

---

---

## Fix Pass 14 (2026-04-04) — AR and Importer replaced with direct API call to /publicInformation

**CHANGE — Replaced DOM-scraping for AR/Importer with direct `publicInformation` API call**

The endpoint `GET /api/actors/{uuid}/publicInformation?languageIso2Code=en` was confirmed live and returns ALL fields needed for AR, Importer, CA, actorAddress, email, phone, and website in a single call.

**Confirmed API response structure (2026-04-04, UUID `1ef1bf51-8416-46a7-9d80-9f037bad0946`):**
```
{
  importers: [{
    relatedActorName: string|null,    // prefer this
    relatedActorEmail: string|null,   // prefer this
    actor: {
      name: string,                   // fallback
      electronicMail: string,         // fallback
    }
  }],
  actorDataPublicView: {
    electronicMail: string,
    telephone: string|null,
    website: string|null,             // often null even when page shows one — always supplement with DOM
    actorAddress: {
      streetName, buildingNumber, complement, cityName, postalZone,
      country: { name, iso2Code }
    },
    authorisedRepresentatives: [{
      name: string,
      email: string,
      telephone: string|null,
      address: string,
      countryName: string,
    }],
    validatorName: string,            // CA name
    validatorAddress: { streetName, buildingNumber, cityName, postalZone, country: { name, iso2Code } },
    validatorEmail: string,
    validatorTelephone: string,
  }
}
```

**Implementation changes to `src/scraper/detailPage.js`:**
1. Removed response intercept (`page.on('response', responseHandler)`) — no longer needed.
2. Added `fetchPublicInformation(page, uuid)` — calls API via `page.evaluate(fetch(...))` to piggyback browser session.
3. Added `parsePublicInformation(json)` — maps confirmed field names to detail record fields.
4. First API call saves raw JSON to `output/api_response_sample.json`.
5. `navigateToDetailPage` now: navigates to page, waits for Angular render, then calls API directly.
6. Removed `_detailDumped` HTML/text dump code (`detail_dump_text.txt`, `detail_dump_html.txt`).
7. DOM scraping still runs for ALL fields — API values take priority, DOM fills gaps. Website always taken from DOM (API website field is frequently null).
8. Merge strategy: API → DOM fallback for all fields except website (DOM always wins for website).

**Importer field note:** `relatedActorName`/`relatedActorEmail` are null when the importer is not registered in EUDAMED as a separate actor. In that case fall back to `importers[0].actor.name` and `.electronicMail`.

---

**How to apply:** When modifying scraper navigation or interception logic, always verify:
1. `DETAIL_BASE_URL` is `https://ec.europa.eu/tools/eudamed/#/screen/search-eo` (not `#/screen/actor`)
2. `isActorsList` in listPage.js matches `/api/eos` (not `/actors`)
3. AR, Importer, CA fields come from `/api/actors/{uuid}/publicInformation` — NOT from the old `/api/eos/{uuid}` endpoint
4. The call site in `index.js` uses the return value of `navigateToDetailPage` directly (not a second call to `extractDetailData`)
5. Website is NOT reliably in `/publicInformation` API — always supplement with DOM
6. `extractDetailData` must NOT return early after API extraction — DOM scraping must always run
7. Angular bootstrap is confirmed with `app-root, [ng-version]` — never assume `domcontentloaded` means Angular is ready
8. `page` must be `let` in index.js (not `const`) so `getOrCreatePage` can reassign it on session-closed errors
9. DOM extraction primary strategy is `dl > dt + dd` pairs inside `heading + div` sections — never use leaf-node scanning as primary
10. Merge logic: API is authoritative for AR/Importer/CA/email/phone/actorAddress; DOM is authoritative for website; DOM fills gaps for all others
