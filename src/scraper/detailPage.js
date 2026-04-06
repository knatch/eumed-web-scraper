'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config.js');
const logger = require('../utils/logger.js');
const selectors = require('./selectors.js');

/** Fires only once per process — saves the first raw API response for inspection. */
let _apiSampleSaved = false;

/** @returns {object} An empty detail record with all fields set to '' */
function emptyDetail() {
  return {
    actorAddress: '',
    email: '',
    phone: '',
    website: '',
    caName: '',
    caAddress: '',
    caCountry: '',
    caEmail: '',
    caPhone: '',
    arName: '',
    arPhone: '',
    arEmail: '',
    importerName: '',
    importerEmail: '',
  };
}

/**
 * Flattens a structured address object or array into a single string.
 * Handles the EUDAMED actorAddress shape:
 *   { streetName, buildingNumber, complement, cityName, postalZone, country: { name } }
 * @param {any} addr
 * @returns {string}
 */
function flattenAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr.trim();
  if (Array.isArray(addr)) return addr.map(flattenAddress).filter(Boolean).join(', ');
  if (typeof addr === 'object') {
    // EUDAMED structured address shape
    const street = [
      addr.streetName || addr.street || addr.addressLine1 || addr.line1 || '',
      addr.buildingNumber || '',
    ]
      .map((s) => s.toString().trim())
      .filter(Boolean)
      .join(' ');

    const parts = [
      street,
      addr.complement || addr.addressLine2 || addr.line2 || '',
      addr.cityName || addr.city || '',
      addr.postalZone || addr.postalCode || addr.zipCode || addr.zip || '',
      // Country: prefer nested country.name, fall back to flat fields
      (addr.country && (addr.country.name || addr.country.iso2Code)) ||
        addr.countryName ||
        addr.countryIso2Code ||
        '',
    ];
    return parts.map((p) => (p || '').toString().trim()).filter(Boolean).join(', ');
  }
  return String(addr).trim();
}

/**
 * Calls the EUDAMED public actor information API for the given UUID.
 * Uses page.evaluate so the request piggybacks on the browser session/cookies.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} uuid
 * @returns {Promise<object|null>} Raw API JSON or null on failure
 */
async function fetchPublicInformation(page, uuid) {
  const apiUrl = `${config.BASE_URL}/api/actors/${uuid}/publicInformation?languageIso2Code=en`;

  try {
    const json = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return res.json();
    }, apiUrl);

    if (!json || typeof json !== 'object') {
      logger.warn(`[publicInformation API] Empty or non-object response for UUID ${uuid}`);
      return null;
    }

    // Save the first response as a sample for inspection
    if (!_apiSampleSaved) {
      _apiSampleSaved = true;
      try {
        const outputDir = path.resolve(__dirname, '../../output');
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(
          path.join(outputDir, 'api_response_sample.json'),
          JSON.stringify(json, null, 2),
          'utf8'
        );
        logger.info(`[publicInformation API] Sample response saved to output/api_response_sample.json`);
      } catch (writeErr) {
        logger.warn(`[publicInformation API] Failed to save sample: ${writeErr.message}`);
      }
    }

    return json;
  } catch (err) {
    logger.warn(`[publicInformation API] fetch failed for UUID ${uuid}: ${err.message}`);
    return null;
  }
}

/**
 * Parses the publicInformation API response into detail fields.
 *
 * API shape (confirmed 2026-04-04):
 *   {
 *     importers: [{ actor: { name, electronicMail, telephone, geographicalAddress } }],
 *     actorDataPublicView: {
 *       electronicMail, telephone, website,
 *       actorAddress: { streetName, buildingNumber, complement, cityName, postalZone, country: { name } },
 *       authorisedRepresentatives: [{ name, email, telephone, address, countryName }],
 *       validatorName, validatorAddress, validatorEmail, validatorTelephone,
 *     }
 *   }
 *
 * @param {object} json
 * @returns {object} Partial detail record
 */
function parsePublicInformation(json) {
  const result = {};

  const view = json.actorDataPublicView || {};

  // Actor contact fields
  result.email = view.electronicMail || '';
  result.phone = view.telephone || '';
  result.website = view.website || '';
  result.actorAddress = flattenAddress(view.actorAddress || null);

  // Competent Authority (validator fields on actorDataPublicView)
  result.caName = view.validatorName || '';
  result.caAddress = flattenAddress(view.validatorAddress || null);
  result.caCountry =
    (view.validatorAddress &&
      view.validatorAddress.country &&
      (view.validatorAddress.country.name || view.validatorAddress.country.iso2Code)) ||
    '';
  result.caEmail = view.validatorEmail || '';
  result.caPhone = view.validatorTelephone || '';

  // Authorised Representative — take the first active entry
  const arList = Array.isArray(view.authorisedRepresentatives)
    ? view.authorisedRepresentatives
    : [];
  const ar = arList[0] || null;
  if (ar) {
    result.arName = ar.name || '';
    result.arEmail = ar.email || '';
    result.arPhone = ar.telephone || '';
  } else {
    result.arName = '';
    result.arEmail = '';
    result.arPhone = '';
  }

  // Importer — filter by actorType.code to avoid picking up non-importer entries
  const importerList = Array.isArray(json.importers) ? json.importers : [];
  const importer =
    importerList.find(
      (entry) =>
        entry &&
        entry.actor &&
        entry.actor.actorType &&
        entry.actor.actorType.code === 'refdata.actor-type.importer'
    ) || null;
  if (importer) {
    result.importerName = (importer.actor && importer.actor.name) || '';
    result.importerEmail = (importer.actor && importer.actor.electronicMail) || '';
  } else {
    result.importerName = '';
    result.importerEmail = '';
  }

  return result;
}

/**
 * Navigates to the detail page for the given UUID, calls the publicInformation
 * API directly, and falls back to DOM scraping for any fields the API did not
 * provide.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} uuid
 * @returns {Promise<object>} Detail data object
 */
async function navigateToDetailPage(page, uuid) {
  const url = `${config.BASE_URL}/#/screen/search-eo/${uuid}`;
  logger.info(`Navigating to detail page for UUID ${uuid}`);

  let selectorFound = true;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for Angular to render the detail content. Primary anchor is
  // #competent-authority-person; fall back to broader component selectors.
  await page
    .waitForSelector('#competent-authority-person', { timeout: config.RENDER_TIMEOUT_MS })
    .catch(async () => {
      logger.warn(`#competent-authority-person not found for UUID ${uuid}, trying broader selectors`);
      await page
        .waitForSelector(
          [
            'app-eo-detail',
            'app-actor-detail',
            'app-search-eo-detail',
            'app-eo-public-info',
            'app-economic-operator-detail',
            '[class*="eo-detail"]',
            '[class*="actor-detail"]',
            selectors.DETAIL_ADDRESS,
            selectors.DETAIL_EMAIL,
            selectors.DETAIL_PHONE,
            selectors.DETAIL_SECTION_CA,
            'mat-tab-group',
            'mat-expansion-panel',
            '.detail-container',
            '[class*="detail-container"]',
          ].join(', '),
          { timeout: config.RENDER_TIMEOUT_MS }
        )
        .catch(() => {
          selectorFound = false;
          logger.warn(`Timeout waiting for detail content for UUID ${uuid}`);
        });
    });

  // Call the public information API directly — no response interception needed.
  // The page is already on the same origin so the browser session/cookies are shared.
  const apiData = await fetchPublicInformation(page, uuid);

  if (!selectorFound && !apiData) {
    throw new Error(
      `Detail page for UUID ${uuid} failed to render and API call returned no data`
    );
  }

  return extractDetailData(page, apiData);
}

/**
 * Extracts detail data from the current detail page.
 * API data (from publicInformation) is the primary source for all fields.
 * DOM scraping runs as a fallback for any field the API left empty.
 *
 * @param {import('puppeteer').Page} page
 * @param {object|null} apiData - Parsed output of fetchPublicInformation, or null
 * @returns {Promise<object>}
 */
async function extractDetailData(page, apiData = null) {
  const detail = emptyDetail();

  // Step 1: populate from API response (authoritative for all fields)
  if (apiData) {
    try {
      const parsed = parsePublicInformation(apiData);
      Object.assign(detail, parsed);

      logger.info(
        `[API] UUID data parsed — ` +
          `arName="${detail.arName}" importerName="${detail.importerName}" ` +
          `caName="${detail.caName}" email="${detail.email}"`
      );
    } catch (err) {
      logger.warn(`Failed to parse publicInformation API data: ${err.message}`);
    }
  }

  // Step 2: DOM scraping — always runs.
  // Website is always extracted from DOM (API website field is frequently null).
  // For all other fields the DOM result is only applied if the API left them empty.
  const needsDomFallback =
    !detail.actorAddress ||
    !detail.email ||
    !detail.phone ||
    !detail.caName ||
    !detail.arName ||
    !detail.importerName ||
    apiData === null;

  if (needsDomFallback) {
    logger.info('Running DOM scraping (some fields still empty after API)');
  } else {
    logger.info('Running DOM scraping for website field');
  }

  try {
    const domData = await page.evaluate(() => {
      const result = {
        actorAddress: '',
        email: '',
        phone: '',
        website: '',
        caName: '',
        caAddress: '',
        caCountry: '',
        caEmail: '',
        caPhone: '',
        arName: '',
        arPhone: '',
        arEmail: '',
        importerName: '',
        importerEmail: '',
      };

      // Website: innerText regex first
      const allText = document.body.innerText || '';
      const websiteMatch = allText.match(/Web\s*site\s*\n\s*([^\n]+)/i);
      if (websiteMatch) {
        result.website = websiteMatch[1].trim();
      } else {
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));
        const websiteAnchor = allAnchors.find((a) => {
          const href = (a.href || '').toLowerCase();
          return (
            href.startsWith('http') &&
            !href.startsWith('mailto:') &&
            !href.startsWith('tel:') &&
            !href.includes('ec.europa.eu/tools/eudamed')
          );
        });
        if (websiteAnchor) result.website = websiteAnchor.href.trim();
      }

      // Email fallback
      const emailEl = document.querySelector('a[href^="mailto:"]');
      if (emailEl) result.email = emailEl.href.replace('mailto:', '').trim();

      // Phone fallback
      const phoneEl = document.querySelector('a[href^="tel:"]');
      if (phoneEl) result.phone = phoneEl.href.replace('tel:', '').trim();

      // Address fallback
      const addrSelectors = [
        'app-actor-address',
        '[class*="address"]',
        'address',
        '[class*="location"]',
      ];
      for (const sel of addrSelectors) {
        const addrEl = document.querySelector(sel);
        if (addrEl) {
          result.actorAddress = addrEl.innerText.replace(/\s+/g, ' ').trim();
          break;
        }
      }

      // Competent Authority section
      const caSection =
        document.querySelector('#competent-authority-person + div') ||
        (document.querySelector('#competent-authority-person') &&
          document.querySelector('#competent-authority-person').nextElementSibling) ||
        null;

      if (caSection) {
        const caText = caSection.innerText || caSection.textContent || '';
        const extractField = (label) => {
          const r = new RegExp(label + '\\s*\\n\\s*([^\\n]+)', 'i');
          const m = caText.match(r);
          return m ? m[1].trim() : '';
        };

        result.caName    = extractField('Name');
        result.caAddress = extractField('Address');
        result.caCountry = extractField('Country');
        result.caEmail   = extractField('Email');
        result.caPhone   = extractField('Telephone number');

        if (!result.caName) {
          const LABELS = ['name', 'address', 'country', 'email', 'telephone number'];
          const leaves = Array.from(caSection.querySelectorAll('*'))
            .filter((el) => el.children.length === 0)
            .map((el) => (el.textContent || '').trim())
            .filter((t) => t.length > 0);

          for (let i = 0; i < leaves.length - 1; i++) {
            const lower = leaves[i].toLowerCase();
            if (!LABELS.includes(lower)) continue;
            const key = lower.replace(/\s+/g, '');
            if (key === 'name')            result.caName    = result.caName    || leaves[i + 1];
            if (key === 'address')         result.caAddress = result.caAddress || leaves[i + 1];
            if (key === 'country')         result.caCountry = result.caCountry || leaves[i + 1];
            if (key === 'email')           result.caEmail   = result.caEmail   || leaves[i + 1];
            if (key === 'telephonenumber') result.caPhone   = result.caPhone   || leaves[i + 1];
          }
        }
      }

      // AR and Importer: dl/dt/dd extraction
      function extractDlFields_el(el, fieldMap) {
        if (!el) return {};
        const extracted = {};
        el.querySelectorAll('dl').forEach((dl) => {
          dl.querySelectorAll('dt').forEach((dt) => {
            const label = dt.innerText.trim();
            if (fieldMap[label] && dt.nextElementSibling) {
              extracted[fieldMap[label]] = dt.nextElementSibling.innerText.trim();
            }
          });
        });
        if (Object.keys(extracted).length === 0) {
          el.querySelectorAll('dt').forEach((dt) => {
            const label = dt.innerText.trim();
            if (fieldMap[label] && dt.nextElementSibling) {
              extracted[fieldMap[label]] = dt.nextElementSibling.innerText.trim();
            }
          });
        }
        return extracted;
      }

      function extractDlFields(sectionSelector, fieldMap) {
        const section = document.querySelector(sectionSelector);
        return extractDlFields_el(section, fieldMap);
      }

      const arH2 = document.querySelector('h2#authorised-representative-person');
      const arSiblingEl = arH2 ? arH2.nextElementSibling : null;

      const arData = extractDlFields('h2#authorised-representative-person + div', {
        'Organisation name': 'arName',
        'Telephone number': 'arPhone',
        'Email': 'arEmail',
      });

      if (!arData.arName && !arData.arPhone && !arData.arEmail && arSiblingEl) {
        const fallbackAr = extractDlFields_el(arSiblingEl, {
          'Organisation name': 'arName',
          'Telephone number': 'arPhone',
          'Email': 'arEmail',
        });
        if (fallbackAr.arName || fallbackAr.arPhone || fallbackAr.arEmail) {
          arData.arName  = fallbackAr.arName;
          arData.arPhone = fallbackAr.arPhone;
          arData.arEmail = fallbackAr.arEmail;
        }
      }

      result.arName  = arData.arName  || '';
      result.arPhone = arData.arPhone || '';
      result.arEmail = arData.arEmail || '';

      const impH2 = document.querySelector('h2#importers-person');
      const impSiblingEl = impH2 ? impH2.nextElementSibling : null;

      const importerData = extractDlFields('h2#importers-person + div', {
        'Organisation name': 'importerName',
        'Email': 'importerEmail',
      });

      if (!importerData.importerName && !importerData.importerEmail && impSiblingEl) {
        const fallbackImp = extractDlFields_el(impSiblingEl, {
          'Organisation name': 'importerName',
          'Email': 'importerEmail',
        });
        if (fallbackImp.importerName || fallbackImp.importerEmail) {
          importerData.importerName  = fallbackImp.importerName;
          importerData.importerEmail = fallbackImp.importerEmail;
        }
      }

      result.importerName  = importerData.importerName  || '';
      result.importerEmail = importerData.importerEmail || '';

      return result;
    });

    // Merge: API values take priority; DOM fills any gaps.
    // Website is always taken from DOM (API field is frequently null).
    detail.website = domData.website || detail.website;
    if (!detail.actorAddress) detail.actorAddress = domData.actorAddress;
    if (!detail.email) detail.email = domData.email;
    if (!detail.phone) detail.phone = domData.phone;
    // CA: API is authoritative; DOM fills gaps
    if (!detail.caName)    detail.caName    = domData.caName;
    if (!detail.caAddress) detail.caAddress = domData.caAddress;
    if (!detail.caCountry) detail.caCountry = domData.caCountry;
    if (!detail.caEmail)   detail.caEmail   = domData.caEmail;
    if (!detail.caPhone)   detail.caPhone   = domData.caPhone;
    // AR: API is authoritative; DOM fills gaps
    if (!detail.arName)  detail.arName  = domData.arName;
    if (!detail.arPhone) detail.arPhone = domData.arPhone;
    if (!detail.arEmail) detail.arEmail = domData.arEmail;
    // Importer: API is authoritative; DOM fills gaps
    if (!detail.importerName)  detail.importerName  = domData.importerName;
    if (!detail.importerEmail) detail.importerEmail = domData.importerEmail;
  } catch (err) {
    logger.warn(`DOM scraping for detail page failed: ${err.message}`);
  }

  return detail;
}

module.exports = {
  navigateToDetailPage,
  extractDetailData,
};
