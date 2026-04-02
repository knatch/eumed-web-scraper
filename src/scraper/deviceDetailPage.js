'use strict';

const fs = require('fs');
const path = require('path');
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
 * Navigates from the current actor detail page to the first device's detail
 * page and extracts device-level fields.
 *
 * Flow:
 *   1. Find h2#devices section and click "View Economic Operator devices" link.
 *   2. On the device list page, click the first row's "View detail" button.
 *   3. On the device detail page, extract device fields via API intercept or DOM.
 *
 * If the actor has no devices section or link, returns empty strings for all fields.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page currently on the actor detail page
 * @param {string} uuid - Actor UUID (for logging)
 * @returns {Promise<object>} Device detail fields
 */
async function scrapeDeviceDetail(page, uuid) {
  const result = emptyDeviceDetail();

  try {
    // ── Step 1: Find and click the "View Economic Operator devices" link ───
    const devicesLinkFound = await page.evaluate(() => {
      // Look for h2#devices or any heading with id containing "devices"
      const devicesHeading =
        document.querySelector('h2#devices') ||
        document.querySelector('[id*="devices"]') ||
        null;

      if (!devicesHeading) return false;

      // Search within the devices section (heading + its siblings/parent container)
      // for an anchor whose text matches "View Economic Operator devices"
      const container = devicesHeading.parentElement || document.body;
      const anchors = Array.from(container.querySelectorAll('a'));
      const link = anchors.find((a) =>
        /view\s+economic\s+operator\s+devices/i.test(a.textContent)
      );

      if (!link) {
        // Broader search: look in the entire page for the link
        const allAnchors = Array.from(document.querySelectorAll('a'));
        const fallbackLink = allAnchors.find((a) =>
          /view\s+economic\s+operator\s+devices/i.test(a.textContent)
        );
        if (fallbackLink) {
          fallbackLink.click();
          return true;
        }
        return false;
      }

      link.click();
      return true;
    });

    if (!devicesLinkFound) {
      logger.info(`[device] No "View Economic Operator devices" link found for UUID ${uuid} — skipping device scraping`);
      return result;
    }

    logger.info(`[device] Clicked "View Economic Operator devices" for UUID ${uuid}`);

    // ── Step 2: Wait for device list page to load ──────────────────────────
    // Set up API intercept for device list data
    let interceptedDeviceList = null;

    const deviceListHandler = async (response) => {
      try {
        const reqUrl = response.url();
        const contentType = response.headers()['content-type'] || '';

        if (!contentType.includes('application/json')) return;
        if (reqUrl.match(/\.(js|css|woff2?|ttf|png|svg|ico)(\?|$)/)) return;

        // Device list API — typically /api/devices or similar with query params
        if (reqUrl.includes('/api/devices') && !interceptedDeviceList) {
          const json = await response.json().catch(() => null);
          if (json) {
            const items = json.content || json.data || json.results || json.items ||
              (Array.isArray(json) ? json : null);
            if (items && items.length > 0) {
              interceptedDeviceList = items;
              logger.info(`[device] Intercepted device list API: ${items.length} devices. URL: ${reqUrl}`);
            }
          }
        }
      } catch (err) {
        // Non-fatal
      }
    };

    page.on('response', deviceListHandler);

    try {
      // Wait for navigation to device list page
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
        // Navigation may have already completed if it was a client-side route change
        logger.info('[device] waitForNavigation timed out — page may have already navigated');
      });

      // Wait for either the table to render or the API intercept to fire
      await page.waitForSelector('table tbody tr, mat-row, .no-results, [class*="no-result"]', { timeout: 20000 }).catch(() => {
        logger.error('[device] Device list table selector not found within 20s');
      });

      // Give Angular a moment to finish rendering
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      page.off('response', deviceListHandler);
    }

    // ── Step 3: Click the first row's "View detail" button ─────────────────
    // If we got the device list from the API, we can try to extract the UUID
    // and navigate directly. Otherwise, click the DOM button.
    let deviceUuid = null;

    if (interceptedDeviceList && interceptedDeviceList.length > 0) {
      const firstDevice = interceptedDeviceList[0];
      deviceUuid =
        firstDevice.uuid ||
        firstDevice.deviceUuid ||
        firstDevice.deviceId ||
        firstDevice.id ||
        '';
      logger.info(`[device] First device UUID from API: ${deviceUuid}`);
    }

    // NOTE: API intercept for device detail was removed — the heuristic
    // field-name guessing was unreliable and overwrote result fields with
    // empty strings. DOM-only extraction is used in Step 4 below.

    // ── Step 3b: Click "View detail" and wait for device detail page ──────
    // Click the "View detail" button on the first row
    const clickedDetail = await page.evaluate(() => {
      // Try table rows first
      const rows = document.querySelectorAll('table tbody tr, mat-row');
      if (rows.length === 0) return false;

      const firstRow = rows[0];
      const btn =
        firstRow.querySelector('button[aria-label="View detail"]') ||
        firstRow.querySelector('button[aria-label*="detail"]') ||
        firstRow.querySelector('button[aria-label*="Detail"]');

      if (btn) {
        btn.click();
        return true;
      }

      // Fallback: click any anchor/button in the first row
      const anyLink = firstRow.querySelector('a[href], button');
      if (anyLink) {
        anyLink.click();
        return true;
      }

      return false;
    });

    if (!clickedDetail) {
      logger.error(`[device] Could not click "View detail" on first device row for UUID ${uuid}`);
      return result;
    }

    logger.info(`[device] Clicked "View detail" on first device row`);

    // Wait for device detail page to load
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      logger.info('[device] waitForNavigation for device detail timed out — may have already navigated');
    });

    // Wait for device detail content to render
    await page.waitForSelector(
      [
        'app-device-detail',
        'app-udi-di-detail',
        '[class*="device-detail"]',
        'mat-card',
        'mat-tab-group',
        'h1', 'h2', 'h3',
      ].join(', '),
      { timeout: 20000 }
    ).catch(() => {
      logger.error('[device] Device detail page selectors not found within 20s');
    });

    // Give Angular time to render
    await new Promise((r) => setTimeout(r, 2000));

    // ── Debug dump: capture full page content for the first device ────────
    if (!_deviceDetailDumped) {
      try {
        const { innerText, innerHTML } = await page.evaluate(() => ({
          innerText: document.body.innerText || '',
          innerHTML: document.body.innerHTML || '',
        }));
        const dumpPath = path.resolve(__dirname, '../../output/device_detail_dump.txt');
        // Also write the filtered lines array so we can verify label matching offline
        const filteredLines = innerText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const filteredSection = filteredLines
          .map((l, i) => `[${i}] ${l}`)
          .join('\n');
        fs.writeFileSync(
          dumpPath,
          innerText +
            '\n--- FILTERED LINES (' + filteredLines.length + ') ---\n' +
            filteredSection +
            '\n--- HTML ---\n' +
            innerHTML,
          'utf8'
        );
        logger.info(`[device] Debug dump written to ${dumpPath} (${filteredLines.length} filtered lines)`);
        _deviceDetailDumped = true;
      } catch (dumpErr) {
        logger.error(`[device] Debug dump failed: ${dumpErr.message}`);
      }
    }

    // ── Step 4: Extract device fields ──────────────────────────────────────
    // DOM-only extraction via filtered line-based innerText parsing.
    // The API intercept path has been removed — the heuristic field-name
    // guessing was unreliable and could silently overwrite result fields
    // with empty strings before DOM extraction ran.
    //
    // Strategy: split document.body.innerText into non-blank trimmed lines,
    // find known label strings, take the value at index+1.
    //
    // Label matching uses multiple strategies (exact, startsWith, includes)
    // to handle minor rendering variations across different device pages.
    const currentUrl = page.url();
    logger.error(`[device] About to extract device fields — current URL: ${currentUrl}`);
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
        // Filter out blank lines so label is always immediately followed by value
        const lines = rawText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        res._debug_lineCount = lines.length;
        // Capture lines around expected label positions for diagnostics
        res._debug_sampleLabels = lines.slice(40, 55).join(' | ');

        // Helper: find a label in the lines array using cascading match strategies.
        // Returns { index, label, nextLine } or null.
        // Strategies tried in order:
        //   1. Exact case-insensitive match (lowercased comparison)
        //   2. startsWith (for labels that may have trailing content)
        //   3. includes (for labels embedded in longer text)
        const matchLog = [];
        function findLabel(exactText) {
          const lower = exactText.toLowerCase();
          // Strategy 1: exact match after lowercasing
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
        if (legMatch && legMatch.nextLine) {
          res.applicableLegislation = legMatch.nextLine;
        }

        // -- Risk class --
        const riskMatch = findLabel('Risk class');
        if (riskMatch && riskMatch.nextLine) {
          res.riskClass = riskMatch.nextLine;
        }

        // -- Device name --
        const nameMatch = findLabel('Device name');
        if (nameMatch && nameMatch.nextLine) {
          res.deviceName = nameMatch.nextLine;
        }

        // -- Presence of human tissues or cells --
        const tissueMatch = findLabel('Presence of human tissues or cells or their derivatives');
        if (tissueMatch && tissueMatch.nextLine) {
          res.humanTissues = tissueMatch.nextLine;
        }

        // -- Nomenclature code(s) — multi-line collection --
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

      // Log diagnostics — use error level so it persists to the log file
      logger.error(
        `[device] DOM extraction diagnostics — UUID=${uuid} ` +
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
          `[device] DOM extraction returned empty for all fields for UUID=${uuid}! ` +
          `First sample lines: ${domDevice._debug_sampleLabels}`
        );
      }

      // Merge into result — DOM values overwrite the N/A defaults
      if (domDevice.applicableLegislation) result.applicableLegislation = domDevice.applicableLegislation;
      if (domDevice.riskClass) result.riskClass = domDevice.riskClass;
      if (domDevice.deviceName) result.deviceName = domDevice.deviceName;
      if (domDevice.humanTissues) result.humanTissues = domDevice.humanTissues;
      if (domDevice.nomenclatureCodes) result.nomenclatureCodes = domDevice.nomenclatureCodes;
    } catch (err) {
      logger.error(`[device] DOM scraping for device detail failed for UUID=${uuid}: ${err.message}\n${err.stack}`);
    }
  } catch (err) {
    logger.error(`[device] Device detail scraping failed for UUID ${uuid}: ${err.message}`);
  }

  // Ensure no field is left as an empty string — use "N/A" as the fallback
  for (const key of Object.keys(result)) {
    if (!result[key] || result[key].trim() === '') {
      result[key] = 'N/A';
    }
  }

  return result;
}

module.exports = {
  scrapeDeviceDetail,
  emptyDeviceDetail,
};
