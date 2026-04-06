'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config.js');
const logger = require('../utils/logger.js');

// Debug flag — dump device detail page content only once (first device encountered)
let _deviceDetailDumped = false;

/**
 * Returns an empty device detail object with all fields set to 'N/A'.
 * Used when an actor has no devices or the device link doesn't exist.
 * @returns {object}
 */
function emptyDeviceDetail() {
  return {
    deviceName: 'N/A',
    nomenclatureCodes: 'N/A',
    applicableLegislation: 'N/A',
    riskClass: 'N/A',
    humanTissues: 'N/A',
  };
}

/**
 * Extracts a device UUID from a raw device API item object.
 * Tries common field name variations.
 *
 * @param {object} item
 * @returns {string|null}
 */
function _extractDeviceUuid(item) {
  return (
    item.uuid ||
    item.deviceUuid ||
    item.udiDiUuid ||
    item.id ||
    item.deviceId ||
    (item.udiDi && (item.udiDi.uuid || item.udiDi.id)) ||
    null
  );
}

/**
 * Extracts a risk class string from a raw device API item object.
 * Returns empty string if not found (will be compared after DOM extraction).
 *
 * @param {object} item
 * @returns {string}
 */
function _extractApiRiskClass(item) {
  // Try the most common field names used across EUDAMED API responses
  return (
    item.riskClass ||
    item.riskClassCode ||
    item.riskClassName ||
    (item.classification && (item.classification.riskClass || item.classification.name)) ||
    ''
  );
}

/**
 * Fetches up to pageSize devices for the given actor UUID directly from the
 * EUDAMED API. Returns an array of { uuid, apiRiskClass } objects.
 *
 * Known EUDAMED device list endpoints (tried in order):
 *   1. /api/eos/{uuid}/devices          — confirmed for most actors
 *   2. /api/eos/{uuid}/devices (pageIndex param variant)
 *   3. /api/devices?actorUuid={uuid}    — alternative query-param form
 *   4. /api/udis?manufacturerUuid={uuid} — UDI-based endpoint
 *
 * @param {import('puppeteer').Page} page
 * @param {string} actorUuid
 * @param {number} [pageSize=10]
 * @returns {Promise<Array<{uuid: string, apiRiskClass: string}>|null>}
 *   Array of device entries, empty array if actor has no devices, null on total failure.
 */
async function fetchDeviceList(page, actorUuid, pageSize = 10) {
  const endpoints = [
    `${config.BASE_URL}/api/eos/${actorUuid}/devices?page=0&pageSize=${pageSize}`,
    `${config.BASE_URL}/api/eos/${actorUuid}/devices?pageIndex=0&pageSize=${pageSize}`,
    `${config.BASE_URL}/api/devices?actorUuid=${actorUuid}&page=0&pageSize=${pageSize}`,
    `${config.BASE_URL}/api/udis?manufacturerUuid=${actorUuid}&page=0&pageSize=${pageSize}`,
  ];

  for (const url of endpoints) {
    try {
      const result = await page.evaluate(async (fetchUrl) => {
        try {
          const res = await fetch(fetchUrl, { headers: { Accept: 'application/json' } });
          if (!res.ok) return { ok: false, status: res.status, url: fetchUrl };
          const json = await res.json();
          return { ok: true, json, url: fetchUrl };
        } catch (e) {
          return { ok: false, error: e.message, url: fetchUrl };
        }
      }, url);

      if (!result.ok) {
        logger.info(`[device API] ${url} → status=${result.status || 'fetch-error'} (${result.error || ''})`);
        continue;
      }

      const json = result.json;
      logger.info(`[device API] ${url} → OK, keys=${Object.keys(json).join(',')}`);

      // Extract the items array from various wrapper shapes
      const items =
        json.content ||
        json.data ||
        json.results ||
        json.items ||
        json.records ||
        (Array.isArray(json) ? json : null);

      if (!items || items.length === 0) {
        logger.info(`[device API] ${url} → empty result set (totalElements=${json.totalElements ?? '?'})`);
        // If the API says totalElements=0 this actor has no registered devices
        if ((json.totalElements ?? json.total ?? json.count) === 0) return [];
        continue;
      }

      // Log the first item's keys to help future debugging
      logger.info(`[device API] First device keys: ${Object.keys(items[0]).join(', ')}`);

      // Map items to { uuid, apiRiskClass } entries
      const devices = [];
      for (const item of items) {
        const uuid = _extractDeviceUuid(item);
        if (!uuid) {
          logger.error(
            `[device API] Could not extract UUID from device item. ` +
            `Keys: ${Object.keys(item).join(', ')} | Raw: ${JSON.stringify(item).slice(0, 300)}`
          );
          continue;
        }
        devices.push({ uuid: String(uuid), apiRiskClass: _extractApiRiskClass(item) });
      }

      if (devices.length > 0) {
        logger.info(
          `[device API] Fetched ${devices.length} device(s) for actor UUID=${actorUuid} (from ${url})`
        );
        return devices;
      }

      // All items failed UUID extraction — fall through to next endpoint
    } catch (err) {
      logger.error(`[device API] Exception fetching ${url}: ${err.message}`);
    }
  }

  logger.error(`[device API] All device list endpoints failed for actor UUID=${actorUuid}`);
  return null;
}

/**
 * Backwards-compatible wrapper: returns the first device UUID, or null.
 * Used internally by scrapeDeviceDetail.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} actorUuid
 * @returns {Promise<string|null>}
 */
async function fetchFirstDeviceUuid(page, actorUuid) {
  const devices = await fetchDeviceList(page, actorUuid, 1);
  if (!devices || devices.length === 0) return null;
  return devices[0].uuid;
}

/**
 * Navigates from the current actor detail page to the first device's detail
 * page and extracts device-level fields.
 *
 * Flow (revised — API-first, no waitForNavigation):
 *   1. Call the EUDAMED device list API directly to get the first device's UUID.
 *      This avoids the unreliable "click link → waitForNavigation → click View detail"
 *      flow that fails for actors with many devices (paginated lists, Angular routing).
 *   2. Navigate directly to the device detail page via the UUID.
 *   3. Wait for Angular to render the device detail content.
 *   4. Extract device fields via filtered-line innerText parsing (DOM only).
 *
 * Fallback: if the API call fails, attempt the legacy DOM-click flow.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page currently on the actor detail page
 * @param {string} uuid - Actor UUID (for logging)
 * @returns {Promise<object>} Device detail fields
 */
async function scrapeDeviceDetail(page, uuid) {
  const result = emptyDeviceDetail();

  try {
    // ── Step 1: Fetch first device UUID via API ────────────────────────────
    logger.info(`[device] Fetching device list via API for actor UUID=${uuid}`);
    const deviceUuid = await fetchFirstDeviceUuid(page, uuid);

    if (!deviceUuid) {
      // API exhausted — try the legacy DOM click flow as a last resort
      logger.error(
        `[device] API returned no device UUID for actor UUID=${uuid}. ` +
        `Attempting legacy DOM click flow.`
      );
      return await _legacyDomClickFlow(page, uuid, result);
    }

    // ── Step 2: Navigate directly to the device detail page ──────────────
    // EUDAMED device detail URL: /#/screen/search-udi-di/{deviceUuid}
    const deviceDetailUrl = `${config.BASE_URL}/#/screen/search-udi-di/${deviceUuid}`;
    logger.info(`[device] Navigating directly to device detail: ${deviceDetailUrl}`);

    await page.goto(deviceDetailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Angular to render — the device detail page renders inside app-root.
    // Primary anchor: 'eudamed-udi-di-details' or a heading containing "EUDAMED DI details".
    // Fallback to broader selectors if the primary is not found.
    await page
      .waitForSelector(
        [
          'app-device-detail',
          'app-udi-di-detail',
          'eudamed-udi-di-details',
          '[class*="device-detail"]',
          'mat-tab-group',
          'mat-card',
          'h1', 'h2',
        ].join(', '),
        { timeout: 20000 }
      )
      .catch((err) => {
        logger.error(
          `[device] Device detail Angular selector not found within 20s ` +
          `for device UUID=${deviceUuid} (actor=${uuid}): ${err.message}`
        );
      });

    // Give Angular a moment to finish rendering all panels
    await new Promise((r) => setTimeout(r, 2000));

    // ── Step 3: Extract device fields ─────────────────────────────────────
    return await _extractDeviceFields(page, uuid, deviceUuid, result);
  } catch (err) {
    logger.error(`[device] Device detail scraping failed for actor UUID=${uuid}: ${err.message}\n${err.stack}`);
  }

  // Ensure no field is left as an empty string — use "N/A" as the fallback
  _applyNaFallback(result);
  return result;
}

/**
 * Legacy DOM click flow — used only when the API-first path fails entirely.
 *
 * Original approach: find "View Economic Operator devices" link on the actor
 * detail page, click it, wait for the device list table, click "View detail"
 * on the first row, then extract fields.
 *
 * This flow is unreliable for actors with many devices because:
 * - waitForNavigation does not fire for Angular client-side route changes.
 * - The device list table selector may differ from the actor list table.
 * - The "View detail" button aria-label may differ on the device list page.
 *
 * Kept as fallback so the function degrades gracefully rather than always
 * returning N/A when the API is unavailable.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} uuid - Actor UUID
 * @param {object} result - emptyDeviceDetail() object to populate
 * @returns {Promise<object>}
 */
async function _legacyDomClickFlow(page, uuid, result) {
  try {
    // Find and click the "View Economic Operator devices" link
    const devicesLinkFound = await page.evaluate(() => {
      const allAnchors = Array.from(document.querySelectorAll('a'));
      const link = allAnchors.find((a) =>
        /view\s+economic\s+operator\s+devices/i.test(a.textContent)
      );
      if (link) { link.click(); return true; }

      // Fallback: any anchor near h2#devices
      const heading =
        document.querySelector('h2#devices') ||
        document.querySelector('[id*="devices"]');
      if (!heading) return false;
      const container = heading.parentElement || document.body;
      const nearLink = container.querySelector('a');
      if (nearLink) { nearLink.click(); return true; }
      return false;
    });

    if (!devicesLinkFound) {
      logger.error(
        `[device] Legacy flow: No "View Economic Operator devices" link found for actor UUID=${uuid}`
      );
      _applyNaFallback(result);
      return result;
    }

    logger.info(`[device] Legacy flow: clicked "View Economic Operator devices" for UUID=${uuid}`);

    // Wait up to 20s for the device list table — no waitForNavigation (Angular SPA)
    await page
      .waitForSelector(
        'table tbody tr, mat-row, .no-results, [class*="no-result"]',
        { timeout: 20000 }
      )
      .catch((err) => {
        logger.error(
          `[device] Legacy flow: device list table not found within 20s for UUID=${uuid}: ${err.message}`
        );
      });

    await new Promise((r) => setTimeout(r, 1500));

    // Click "View detail" on the first row
    const clickedDetail = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr, mat-row');
      if (rows.length === 0) return false;
      const firstRow = rows[0];
      const btn =
        firstRow.querySelector('button[aria-label="View detail"]') ||
        firstRow.querySelector('button[aria-label*="detail" i]') ||
        firstRow.querySelector('button[aria-label*="Detail" i]') ||
        firstRow.querySelector('a[href], button');
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clickedDetail) {
      logger.error(
        `[device] Legacy flow: could not click "View detail" on first device row for actor UUID=${uuid}`
      );
      _applyNaFallback(result);
      return result;
    }

    logger.info(`[device] Legacy flow: clicked "View detail", waiting for device detail page`);

    // Wait for device detail content — no waitForNavigation
    await page
      .waitForSelector(
        [
          'app-device-detail',
          'app-udi-di-detail',
          '[class*="device-detail"]',
          'mat-card',
          'mat-tab-group',
          'h1', 'h2',
        ].join(', '),
        { timeout: 20000 }
      )
      .catch((err) => {
        logger.error(`[device] Legacy flow: device detail selectors not found within 20s: ${err.message}`);
      });

    await new Promise((r) => setTimeout(r, 2000));

    return await _extractDeviceFields(page, uuid, null, result);
  } catch (err) {
    logger.error(`[device] Legacy DOM click flow failed for UUID=${uuid}: ${err.message}`);
    _applyNaFallback(result);
    return result;
  }
}

/**
 * Extracts device fields from the currently rendered device detail page.
 * Uses filtered-line innerText parsing — the same approach as Fix Pass 12/13.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} actorUuid - For logging
 * @param {string|null} deviceUuid - For logging
 * @param {object} result - emptyDeviceDetail() object to populate
 * @returns {Promise<object>}
 */
async function _extractDeviceFields(page, actorUuid, deviceUuid, result) {
  const currentUrl = page.url();
  logger.error(
    `[device] Extracting device fields — actorUUID=${actorUuid} deviceUUID=${deviceUuid} url=${currentUrl}`
  );

  // ── Debug dump: capture full page content for the first device ────────
  if (!_deviceDetailDumped) {
    try {
      const { innerText, innerHTML } = await page.evaluate(() => ({
        innerText: document.body.innerText || '',
        innerHTML: document.body.innerHTML || '',
      }));
      const dumpPath = path.resolve(__dirname, '../../output/device_detail_dump.txt');
      const filteredLines = innerText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const filteredSection = filteredLines.map((l, i) => `[${i}] ${l}`).join('\n');
      fs.writeFileSync(
        dumpPath,
        innerText +
          '\n--- FILTERED LINES (' + filteredLines.length + ') ---\n' +
          filteredSection +
          '\n--- HTML ---\n' +
          innerHTML,
        'utf8'
      );
      logger.info(
        `[device] Debug dump written to ${dumpPath} (${filteredLines.length} filtered lines)`
      );
      _deviceDetailDumped = true;
    } catch (dumpErr) {
      logger.error(`[device] Debug dump failed: ${dumpErr.message}`);
    }
  }

  try {
    const domDevice = await page.evaluate(() => {
      const res = {
        deviceName: '',
        nomenclatureCodes: '',
        applicableLegislation: '',
        riskClass: '',
        humanTissues: '',
        _debug_lineCount: 0,
        _debug_sampleLabels: '',
        _debug_matchInfo: '',
        _debug_url: window.location.href,
      };

      const rawText = document.body.innerText || '';
      const lines = rawText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      res._debug_lineCount = lines.length;
      res._debug_sampleLabels = lines.slice(40, 55).join(' | ');

      const matchLog = [];
      function findLabel(exactText) {
        const lower = exactText.toLowerCase();
        // Strategy 1: exact match
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase() === lower) {
            matchLog.push(exactText + ':exact@' + i);
            return { index: i, label: lines[i], nextLine: lines[i + 1] || '' };
          }
        }
        // Strategy 2: startsWith
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().startsWith(lower)) {
            matchLog.push(exactText + ':startsWith@' + i);
            return { index: i, label: lines[i], nextLine: lines[i + 1] || '' };
          }
        }
        // Strategy 3: includes
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lower)) {
            matchLog.push(exactText + ':includes@' + i);
            return { index: i, label: lines[i], nextLine: lines[i + 1] || '' };
          }
        }
        matchLog.push(exactText + ':NOT_FOUND');
        return null;
      }

      // -- Applicable legislation --
      const legMatch = findLabel('Applicable legislation');
      if (legMatch && legMatch.nextLine) res.applicableLegislation = legMatch.nextLine;

      // -- Risk class --
      const riskMatch = findLabel('Risk class');
      if (riskMatch && riskMatch.nextLine) res.riskClass = riskMatch.nextLine;

      // -- Device name --
      const nameMatch = findLabel('Device name');
      if (nameMatch && nameMatch.nextLine) res.deviceName = nameMatch.nextLine;

      // -- Presence of human tissues or cells --
      const tissueMatch = findLabel('Presence of human tissues or cells or their derivatives');
      if (tissueMatch && tissueMatch.nextLine) res.humanTissues = tissueMatch.nextLine;

      // -- Nomenclature code(s) — may span multiple lines --
      const nomMatch = findLabel('Nomenclature code(s)');
      if (nomMatch) {
        const stopLabels = [
          'name/trade name',
          'reference',
          'additional',
          'risk class',
          'applicable legislation',
          'presence of',
          'implantable',
          'measuring function',
          'active device',
          'certificates',
          'udi-di details',
          'status',
          'device name',
        ];
        const values = [];
        for (let j = nomMatch.index + 1; j < lines.length; j++) {
          const lineLower = lines[j].toLowerCase();
          if (stopLabels.some((sl) => lineLower === sl || lineLower.startsWith(sl))) break;
          values.push(lines[j]);
        }
        res.nomenclatureCodes = values.join('\n');
      }

      res._debug_matchInfo = matchLog.join('; ');
      return res;
    });

    logger.error(
      `[device] DOM extraction diagnostics — actorUUID=${actorUuid} ` +
      `url=${domDevice._debug_url}, ` +
      `lineCount=${domDevice._debug_lineCount}, ` +
      `matches=[${domDevice._debug_matchInfo}], ` +
      `sampleLines=[${domDevice._debug_sampleLabels}]`
    );
    logger.info(
      `[device] DOM extraction result — ` +
      `deviceName="${domDevice.deviceName}", ` +
      `riskClass="${domDevice.riskClass}", ` +
      `legislation="${domDevice.applicableLegislation}", ` +
      `humanTissues="${domDevice.humanTissues}", ` +
      `nomenclature="${domDevice.nomenclatureCodes}"`
    );

    if (!domDevice.deviceName && !domDevice.riskClass) {
      logger.error(
        `[device] DOM extraction returned empty for all fields — actorUUID=${actorUuid} ` +
        `deviceUUID=${deviceUuid} url=${domDevice._debug_url}. ` +
        `First sample lines: ${domDevice._debug_sampleLabels}`
      );
    }

    if (domDevice.applicableLegislation) result.applicableLegislation = domDevice.applicableLegislation;
    if (domDevice.riskClass) result.riskClass = domDevice.riskClass;
    if (domDevice.deviceName) result.deviceName = domDevice.deviceName;
    if (domDevice.humanTissues) result.humanTissues = domDevice.humanTissues;
    if (domDevice.nomenclatureCodes) result.nomenclatureCodes = domDevice.nomenclatureCodes;
  } catch (err) {
    logger.error(
      `[device] DOM extraction threw for actorUUID=${actorUuid} deviceUUID=${deviceUuid}: ` +
      `${err.message}\n${err.stack}`
    );
  }

  _applyNaFallback(result);
  return result;
}

/**
 * Replaces any empty-string field in result with 'N/A'.
 * @param {object} result
 */
function _applyNaFallback(result) {
  for (const key of Object.keys(result)) {
    if (!result[key] || result[key].trim() === '') {
      result[key] = 'N/A';
    }
  }
}

module.exports = {
  scrapeDeviceDetail,
  emptyDeviceDetail,
};
