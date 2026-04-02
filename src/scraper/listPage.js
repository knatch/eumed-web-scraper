'use strict';

const config = require('../config.js');
const logger = require('../utils/logger.js');
const selectors = require('./selectors.js');

/**
 * Builds the list page URL for the given page index and country code.
 * @param {number} pageIndex
 * @param {string} countryCode
 * @returns {string}
 */
function buildListUrl(pageIndex, countryCode) {
  const base = `${config.BASE_URL}/#/screen/search-eo`;
  const paging = JSON.stringify({ pageSize: config.PAGE_SIZE, pageIndex });
  const sorting = JSON.stringify({ sortField: 'srn', sortDirection: 'asc' });
  return (
    `${base}` +
    `?countryIso2Code=${encodeURIComponent(countryCode)}` +
    `&paging=${encodeURIComponent(paging)}` +
    `&sorting=${encodeURIComponent(sorting)}` +
    `&submitted=true`
  );
}

/**
 * Navigates to the list page for the given pageIndex and countryCode.
 *
 * Strategy (Angular SPA):
 *   1. Register response interceptor BEFORE navigation so we never miss the
 *      /api/eos call even if Angular fires it during page load.
 *   2. Navigate and wait for domcontentloaded.
 *   3. Wait up to 10s for Angular to bootstrap (app-root / ng-version).
 *   4. Wait 2s for Angular's router to process URL params.
 *   5. If no API data yet, check whether a Search button exists and click it,
 *      then wait up to 20s for the table or the API intercept.
 *   6. If still nothing, wait the full selector timeout — then throw to retry.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} pageIndex
 * @param {string} countryCode
 * @returns {Promise<object[]>} Array of row objects extracted from the page
 */
async function navigateToListPage(page, pageIndex, countryCode) {
  const url = buildListUrl(pageIndex, countryCode);
  logger.info(`Navigating to list page ${pageIndex}`);

  // interceptedActors: null = no API response yet, [] = empty result (end of data),
  // [...] = actual rows. The distinction between null and [] is critical for termination.
  let interceptedActors = null;

  // ── Step 1: register response interceptor BEFORE navigation ──────────────
  const responseHandler = async (response) => {
    try {
      const reqUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      // Log all non-asset JSON responses (helps identify real API path)
      if (
        contentType.includes('application/json') &&
        !reqUrl.match(/\.(js|css|woff2?|ttf|png|svg|ico)(\?|$)/)
      ) {
        logger.info(`[list intercept] JSON response: ${reqUrl}`);
      }

      // Match /api/eos list endpoint; exclude /api/eos/{uuid} detail calls
      const isActorsList =
        reqUrl.includes('/api/eos') &&
        !reqUrl.match(/\/api\/eos\/[a-f0-9-]{8,}/i);

      if (isActorsList && contentType.includes('application/json')) {
        const json = await response.json().catch(() => null);
        if (json && (Array.isArray(json) || typeof json === 'object')) {
          const actors =
            json.content ||
            json.actors ||
            json.data ||
            json.results ||
            json.items ||
            json.records ||
            (Array.isArray(json) ? json : null);
          if (actors && actors.length > 0) {
            interceptedActors = actors;
            logger.info(
              `Intercepted /api/eos from ${reqUrl}: ${actors.length} actors. ` +
              `First record keys: ${Object.keys(actors[0]).join(', ')}`
            );
          } else if (Array.isArray(actors) && actors.length === 0) {
            // API returned a valid response with an empty array — end of data.
            interceptedActors = [];
            logger.info(
              `[list intercept] API returned empty array from ${reqUrl} — end of data`
            );
          } else if (json && typeof json === 'object') {
            // Check if this is a paginated response with totalPages/totalElements
            // that indicates we are past the last page
            const totalElements = json.totalElements ?? json.total ?? json.count ?? -1;
            if (totalElements === 0) {
              interceptedActors = [];
              logger.info(
                `[list intercept] API reports totalElements=0 from ${reqUrl} — end of data`
              );
            } else {
              logger.info(
                `[list intercept] actor-like URL returned JSON but no array. ` +
                `Keys: ${Object.keys(json).join(', ')} | URL: ${reqUrl}`
              );
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[list intercept] error processing response: ${err.message}`);
    }
  };

  page.on('response', responseHandler);

  try {
    // ── Step 2: navigate ────────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // ── Step 3: wait for Angular to bootstrap ───────────────────────────────
    // Angular sets [ng-version] on app-root once it is fully bootstrapped.
    await page
      .waitForSelector('app-root, [ng-version], eudamed-root', { timeout: 10000 })
      .catch(() => {
        logger.warn(`[list page ${pageIndex}] Angular root selector not found after 10s`);
      });

    // ── Step 4: give Angular's router time to parse URL params ──────────────
    // 2s is sufficient for router.navigate + initial change detection
    await new Promise(r => setTimeout(r, 2000));

    // ── Step 4b: if API returned an empty array, short-circuit ─────────────
    if (Array.isArray(interceptedActors) && interceptedActors.length === 0) {
      logger.info(`[list page ${pageIndex}] API returned empty result set — end of data`);
      return [];
    }

    // ── Step 5: if no API data yet, look for a Search/Apply button ──────────
    if (!interceptedActors) {
      const clicked = await _tryClickSearchButton(page, pageIndex);

      if (clicked) {
        // After clicking, wait up to 20s for the API call or the table rows
        logger.info(`[list page ${pageIndex}] Search button clicked — waiting up to 20s for results`);
        await _waitForResultsOrApi(page, pageIndex, 20000, () => interceptedActors);
      } else {
        // No button found — Angular may have auto-submitted.
        // Wait up to 20s for table rows to appear.
        logger.info(`[list page ${pageIndex}] No search button found — waiting up to 20s for auto-rendered rows`);
        await _waitForResultsOrApi(page, pageIndex, 20000, () => interceptedActors);
      }
    }

    // ── Step 6: final guard ─────────────────────────────────────────────────
    // Check once more whether the selector appeared (covers API-less DOM path)
    if (!interceptedActors) {
      const rowsPresent = await page
        .$(selectors.LIST_TABLE_ROW)
        .then(el => !!el)
        .catch(() => false);

      if (!rowsPresent) {
        const noResultsPresent = await page
          .$(selectors.LIST_NO_RESULTS)
          .then(el => !!el)
          .catch(() => false);

        if (!noResultsPresent) {
          throw new Error(
            `Page ${pageIndex} failed to render: no API data and no table rows after full wait`
          );
        }
        // no-results indicator is valid — return empty array (end of pagination)
        logger.info(`[list page ${pageIndex}] No-results indicator found — end of data`);
        return [];
      }
    }
  } finally {
    // Always remove the listener to prevent accumulation across retries
    page.off('response', responseHandler);
  }

  return extractListRows(page, interceptedActors);
}

/**
 * Looks for a Search/Apply/Submit button on the current page and clicks it.
 * Returns true if a button was clicked, false otherwise.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} pageIndex
 * @returns {Promise<boolean>}
 */
async function _tryClickSearchButton(page, pageIndex) {
  try {
    const clicked = await page.evaluate(() => {
      // Priority 1: explicit type="submit" buttons
      const submitBtns = Array.from(document.querySelectorAll('button[type="submit"]'));
      if (submitBtns.length > 0) {
        const visible = submitBtns.find(b => !b.disabled && b.offsetParent !== null);
        if (visible) { visible.click(); return true; }
      }

      // Priority 2: buttons whose text matches search/apply/find
      const allBtns = Array.from(document.querySelectorAll('button'));
      const searchBtn = allBtns.find(b =>
        !b.disabled &&
        b.offsetParent !== null &&
        /search|apply|find|submit/i.test(b.textContent)
      );
      if (searchBtn) { searchBtn.click(); return true; }

      // Priority 3: mat-icon-button inside a search form
      const iconSearchBtn = document.querySelector(
        'form button[mat-icon-button], form button[mat-raised-button], form button[mat-flat-button]'
      );
      if (iconSearchBtn && !iconSearchBtn.disabled) { iconSearchBtn.click(); return true; }

      return false;
    });

    if (clicked) {
      logger.info(`[list page ${pageIndex}] Search button found and clicked`);
    } else {
      logger.info(`[list page ${pageIndex}] No clickable search button found`);
    }
    return clicked;
  } catch (err) {
    logger.warn(`[list page ${pageIndex}] _tryClickSearchButton error: ${err.message}`);
    return false;
  }
}

/**
 * Waits up to `timeoutMs` for either:
 *   - The API interceptor to capture data (checked via `getIntercepted()`), or
 *   - The LIST_TABLE_ROW or LIST_NO_RESULTS selector to appear in the DOM.
 *
 * Polls every 500ms so we exit as soon as either condition is true.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} pageIndex
 * @param {number} timeoutMs
 * @param {() => object[]|null} getIntercepted - closure returning the current interceptedActors value
 * @returns {Promise<void>}
 */
async function _waitForResultsOrApi(page, pageIndex, timeoutMs, getIntercepted) {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (Date.now() < deadline) {
    // Check API intercept first (zero DOM cost)
    if (getIntercepted()) return;

    // Check DOM
    try {
      const found = await page.evaluate((rowSel, noResSel) => {
        return (
          !!document.querySelector(rowSel) ||
          !!document.querySelector(noResSel)
        );
      }, selectors.LIST_TABLE_ROW, selectors.LIST_NO_RESULTS);

      if (found) {
        logger.info(`[list page ${pageIndex}] DOM selector found during poll`);
        return;
      }
    } catch (_) {
      // Page context may have closed — let the outer try/finally handle it
      return;
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  logger.warn(`[list page ${pageIndex}] Timed out waiting for results after ${timeoutMs}ms`);
}

/**
 * Extracts row data from the current list page.
 * Uses intercepted API data if available, otherwise falls back to DOM scraping.
 *
 * @param {import('puppeteer').Page} page
 * @param {object[]|null} interceptedActors - Pre-intercepted API actors array
 * @returns {Promise<Array<{ srn: string, name: string, abbreviatedName: string, city: string, uuid: string }>>}
 */
async function extractListRows(page, interceptedActors = null) {
  // Primary: use intercepted API response
  if (interceptedActors && interceptedActors.length > 0) {
    return interceptedActors.map((actor) => {
      // Log the raw actor object on first record to help diagnose field names
      if (interceptedActors.indexOf(actor) === 0) {
        logger.info(`[extractListRows] First actor raw: ${JSON.stringify(actor)}`);
      }
      // UUID: try every plausible field name EUDAMED might use
      const uuid =
        actor.uuid ||
        actor.actorUuid ||
        actor.actorId ||
        actor.eudamedId ||
        actor.id ||
        actor.actorGuid ||
        actor.guid ||
        actor.uniqueId ||
        actor.eoId ||
        // Some APIs use an embedded object for the identifier
        (actor.identifier && (actor.identifier.uuid || actor.identifier.value || actor.identifier)) ||
        '';
      return {
        srn: actor.srn || actor.srnCode || actor.actorSrn || '',
        name: actor.name || actor.actorName || actor.fullName || '',
        abbreviatedName: actor.abbreviatedName || actor.abbreviation || actor.shortName || '',
        city: actor.cityName || actor.city || '',
        uuid: typeof uuid === 'string' ? uuid : String(uuid || ''),
        // Fields confirmed available directly from the list API — no detail page needed
        email: actor.electronicMail || actor.email || actor.emailAddress || '',
        phone: actor.telephone || actor.phone || actor.phoneNumber || '',
        actorAddress: actor.geographicalAddress || actor.actorAddress || actor.address || '',
      };
    });
  }

  // Fallback: DOM scraping
  logger.info('Falling back to DOM scraping for list rows');

  const rows = await page.evaluate((sel) => {
    const results = [];

    // Try Angular Material mat-row pattern first, then standard tr
    const rowEls = Array.from(document.querySelectorAll(sel.LIST_TABLE_ROW));
    if (rowEls.length === 0) return results;

    for (const row of rowEls) {
      // Try mat-cell selectors
      const getCell = (columnKey) => {
        // Multiple selector patterns for Angular Material
        const patterns = [
          `[matcolumndef="${columnKey}"] .mat-cell`,
          `td.mat-column-${columnKey}`,
          `.mat-column-${columnKey}`,
          `[class*="column-${columnKey}"]`,
        ];
        for (const pat of patterns) {
          // Try within the row first
          const el = row.querySelector(pat);
          if (el) return el.textContent.trim();
        }
        return '';
      };

      const srn = getCell('srn');
      const name = getCell('name');
      const abbreviatedName = getCell('abbreviatedName');
      const city = getCell('cityName');

      // Extract UUID — try multiple strategies in order of reliability

      let uuid = '';

      // Strategy 1: any element with ng-reflect-router-link containing a UUID pattern
      // Angular renders routerLink directives as ng-reflect-router-link on the element
      const ngReflectEls = Array.from(row.querySelectorAll('[ng-reflect-router-link]'));
      for (const el of ngReflectEls) {
        const val = el.getAttribute('ng-reflect-router-link') || '';
        // Look for a 36-char UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        const match = val.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (match) { uuid = match[1]; break; }
        // Also check if the value itself is short path like "/screen/search-eo/uuid"
        const pathMatch = val.match(/\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
        if (pathMatch) { uuid = pathMatch[1]; break; }
      }

      // Strategy 2: anchor with href containing a UUID-like path segment
      if (!uuid) {
        const anchors = Array.from(row.querySelectorAll('a[href]'));
        for (const anchor of anchors) {
          const match = anchor.href.match(/\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
          if (match) { uuid = match[1]; break; }
        }
      }

      // Strategy 3: "View detail" button data attributes
      if (!uuid) {
        const detailBtn =
          row.querySelector('button[aria-label="View detail"]') ||
          row.querySelector('button[aria-label*="detail"]') ||
          row.querySelector('button[aria-label*="Detail"]');
        if (detailBtn) {
          uuid =
            detailBtn.getAttribute('data-uuid') ||
            detailBtn.getAttribute('data-id') ||
            detailBtn.getAttribute('data-actor-id') ||
            '';
        }
      }

      // Strategy 4: row-level data attributes
      if (!uuid) {
        uuid =
          row.getAttribute('data-uuid') ||
          row.getAttribute('data-id') ||
          row.getAttribute('data-actor-id') ||
          '';
      }

      // Strategy 5: any attribute on any element in the row that looks like a UUID
      if (!uuid) {
        const allEls = Array.from(row.querySelectorAll('*'));
        for (const el of allEls) {
          for (const attr of el.attributes) {
            if (attr.value.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
              uuid = attr.value;
              break;
            }
          }
          if (uuid) break;
        }
      }

      // Only add row if we have at least an SRN or name
      if (srn || name) {
        results.push({ srn, name, abbreviatedName, city, uuid });
      }
    }

    return results;
  }, selectors);

  if (rows.length === 0) {
    logger.info('No rows found on list page — end of pagination or no results');
  }

  return rows;
}

module.exports = {
  navigateToListPage,
  extractListRows,
};
