'use strict';

const config = require('../config.js');
const logger = require('../utils/logger.js');
const selectors = require('./selectors.js');

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
 * @param {any} addr
 * @returns {string}
 */
function flattenAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr.trim();
  if (Array.isArray(addr)) return addr.map(flattenAddress).filter(Boolean).join(', ');
  if (typeof addr === 'object') {
    const parts = [
      addr.street || addr.streetAddress || addr.addressLine1 || addr.line1 || '',
      addr.addressLine2 || addr.line2 || '',
      addr.city || addr.cityName || '',
      addr.postalCode || addr.zipCode || addr.zip || '',
      addr.country || addr.countryName || addr.countryIso2Code || '',
    ];
    return parts.map((p) => (p || '').toString().trim()).filter(Boolean).join(', ');
  }
  return String(addr).trim();
}

/**
 * Extracts contact fields from an API contact object or array.
 * @param {any} contacts
 * @returns {{ email: string, phone: string, website: string }}
 */
function extractContacts(contacts) {
  const result = { email: '', phone: '', website: '' };
  if (!contacts) return result;

  const list = Array.isArray(contacts) ? contacts : [contacts];
  for (const c of list) {
    if (!c) continue;
    result.email = result.email || c.email || c.emailAddress || c.electronicMail || '';
    result.phone =
      result.phone || c.phone || c.phoneNumber || c.telephone || c.tel || '';
    result.website =
      result.website || c.website || c.url || c.webPage || c.webSite || '';
  }
  return result;
}

/**
 * Navigates to the detail page for the given UUID.
 * Sets up response interception for the /actors/{uuid} API call.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} uuid
 * @returns {Promise<object>} Detail data object
 */
async function navigateToDetailPage(page, uuid) {
  const url = `${config.BASE_URL}/#/screen/search-eo/${uuid}`;
  logger.info(`Navigating to detail page for UUID ${uuid}`);

  let interceptedData = null;

  const responseHandler = async (response) => {
    try {
      const reqUrl = response.url();
      const contentType = response.headers()['content-type'] || '';

      // Log all JSON responses to help identify the actual API path
      if (
        contentType.includes('application/json') &&
        !reqUrl.match(/\.(js|css|woff2?|ttf|png|svg|ico)(\?|$)/)
      ) {
        logger.info(`[detail intercept] JSON response: ${reqUrl}`);
      }

      // Match the confirmed EUDAMED actor detail endpoint: /api/eos/{uuid}
      // The UUID is embedded in the path — match both the /api/eos/ prefix
      // and the uuid to avoid matching list calls (/api/eos?page=...).
      const isActorDetailPath =
        uuid &&
        reqUrl.includes('/api/eos/') &&
        reqUrl.includes(uuid);

      if (isActorDetailPath && contentType.includes('application/json')) {
        const json = await response.json().catch(() => null);
        if (json && typeof json === 'object') {
          // Log structure on first capture so we can learn the field layout
          if (!interceptedData) {
            logger.info('[detail intercept] publicInformation keys: ' + Object.keys(json).join(', '));
            logger.info('[detail intercept] Full JSON (first capture): ' + JSON.stringify(json, null, 2).substring(0, 2000));
          }
          interceptedData = json;
          logger.info(
            `Intercepted actor detail API response from ${reqUrl}. ` +
            `Keys: ${Object.keys(json).join(', ')}`
          );
        }
      }
    } catch (err) {
      // Non-fatal
      logger.warn(`[detail intercept] error: ${err.message}`);
    }
  };

  // Use page.on (not page.once) so the handler fires on every response until
  // it finds the /api/eos/{uuid} API call. The finally block always calls page.off
  // to prevent listener accumulation across retries.
  page.on('response', responseHandler);

  let selectorFound = true;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Primary wait: #competent-authority-person is the anchor h2 for CA data.
    // It is rendered by Angular after the page settles, so a 20s timeout is used.
    await page
      .waitForSelector('#competent-authority-person', { timeout: 20000 })
      .catch(async () => {
        // h2#competent-authority-person not found — fall back to broader selectors
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
              'mat-card',
              'mat-tab-group',
              'mat-expansion-panel',
              '.detail-container',
              '[class*="detail-container"]',
              'mat-card-content',
              'mat-card-title',
            ].join(', '),
            { timeout: 15000 }
          )
          .catch(() => {
            selectorFound = false;
            logger.warn(`Timeout waiting for detail content for UUID ${uuid}`);
          });
      });
  } finally {
    // Always remove the listener — prevents accumulation on retry
    page.off('response', responseHandler);
  }

  // If selector timed out AND no API data, throw to force retry
  if (!selectorFound && !interceptedData) {
    throw new Error(`Detail page for UUID ${uuid} failed to render: selector timeout and no API data intercepted`);
  }

  return extractDetailData(page, interceptedData);
}

/**
 * Extracts detail data from the current detail page.
 * Uses intercepted API data if available, otherwise falls back to DOM scraping.
 *
 * @param {import('puppeteer').Page} page
 * @param {object|null} interceptedData - Pre-intercepted API actor detail object
 * @returns {Promise<object>}
 */
async function extractDetailData(page, interceptedData = null) {
  const detail = emptyDetail();

  // Step 1: extract actorAddress, email, phone from intercepted API response.
  // CA data is NOT in the API response (/api/actors/{uuid}/publicInformation only
  // contains importer/nonEuManufacturer relations). Website is also unreliable from
  // the API. We always continue to DOM scraping after this step.
  if (interceptedData) {
    try {
      detail.actorAddress = flattenAddress(
        interceptedData.geographicalAddress ||
        interceptedData.address ||
        interceptedData.actorAddress ||
        interceptedData.registeredAddress ||
        interceptedData.location ||
        null
      );

      const contacts = extractContacts(
        interceptedData.contacts ||
        interceptedData.contact ||
        interceptedData.contactInfo ||
        interceptedData
      );
      detail.email = contacts.email;
      detail.phone = contacts.phone;
      // Do not set website from API — it is reliably available in the DOM
      // Do not set AR or Importer fields from API — the API response structure
      // for these is unconfirmed and speculative property access can set garbage
      // values that then block the reliable DOM extraction. DOM is authoritative
      // for AR, Importer, CA, and Website fields.
    } catch (err) {
      logger.warn(`Failed to parse intercepted detail data: ${err.message}`);
    }
  }

  // Step 2: DOM scraping — always runs regardless of API data.
  // Extracts: website, caName, caAddress, caCountry, caEmail, caPhone.
  // Also fills in actorAddress, email, phone if they are still empty after Step 1.
  logger.info('Running DOM scraping for CA fields and website');

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

      // Website: use innerText regex to find "Web site" label followed by URL.
      // This is more reliable than hunting for <a> tags since the value may be
      // plain text rather than a hyperlink.
      const allText = document.body.innerText || '';
      const websiteMatch = allText.match(/Web\s*site\s*\n\s*([^\n]+)/i);
      if (websiteMatch) {
        result.website = websiteMatch[1].trim();
      } else {
        // Fallback: external anchor that is not mailto/tel/eudamed
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
        if (websiteAnchor) {
          result.website = websiteAnchor.href.trim();
        }
      }

      // Email (fallback if API did not provide it)
      const emailEl = document.querySelector('a[href^="mailto:"]');
      if (emailEl) {
        result.email = emailEl.href.replace('mailto:', '').trim();
      }

      // Phone (fallback if API did not provide it)
      const phoneEl = document.querySelector('a[href^="tel:"]');
      if (phoneEl) {
        result.phone = phoneEl.href.replace('tel:', '').trim();
      }

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

      // Competent Authority: located in the element immediately after h2#competent-authority-person.
      // The mat-expansion-panel approach was wrong — the CA section is a sibling div, not a panel.
      const caSection =
        document.querySelector('#competent-authority-person + div') ||
        (document.querySelector('#competent-authority-person') &&
          document.querySelector('#competent-authority-person').nextElementSibling) ||
        null;

      if (caSection) {
        // Strategy 1: innerText newline-based regex (most reliable when innerText is available)
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

        // Strategy 2 fallback: leaf-node label→value pairs
        // Used when innerText regex yields nothing (e.g. collapsed/hidden sections)
        if (!result.caName) {
          const LABELS = ['name', 'address', 'country', 'email', 'telephone number'];
          const leaves = Array.from(caSection.querySelectorAll('*'))
            .filter(el => el.children.length === 0)
            .map(el => (el.textContent || '').trim())
            .filter(t => t.length > 0);

          for (let i = 0; i < leaves.length - 1; i++) {
            const lower = leaves[i].toLowerCase();
            if (!LABELS.includes(lower)) continue;
            // normalise key: remove spaces so "telephone number" → "telephonenumber"
            const key = lower.replace(/\s+/g, '');
            if (key === 'name')            result.caName    = result.caName    || leaves[i + 1];
            if (key === 'address')         result.caAddress = result.caAddress || leaves[i + 1];
            if (key === 'country')         result.caCountry = result.caCountry || leaves[i + 1];
            if (key === 'email')           result.caEmail   = result.caEmail   || leaves[i + 1];
            if (key === 'telephonenumber') result.caPhone   = result.caPhone   || leaves[i + 1];
          }
        }
      }

      // ── Authorised Representative(s) ─────────────────────────────────
      // DOM structure: h2#authorised-representative-person + div
      // Inside that div: dl.row.ng-star-inserted with dt/dd pairs.
      // dt texts: "Organisation name", "Telephone number", "Email"
      //
      // Helper: extract dt/dd pairs from a section div. Looks for all dl
      // elements (with or without .row.ng-star-inserted) and collects pairs.
      const extractDtDdPairs = (sectionEl) => {
        const pairs = {};
        if (!sectionEl) return pairs;
        // Try dl elements first
        const dlElements = sectionEl.querySelectorAll('dl');
        for (const dl of dlElements) {
          const dtElements = Array.from(dl.querySelectorAll('dt'));
          for (const dt of dtElements) {
            const label = (dt.innerText || dt.textContent || '').trim().toLowerCase();
            const dd = dt.nextElementSibling;
            if (!dd || dd.tagName !== 'DD') continue;
            const value = (dd.innerText || dd.textContent || '').trim();
            if (value) pairs[label] = value;
          }
        }
        return pairs;
      };

      const arSection =
        document.querySelector('#authorised-representative-person + div') ||
        (document.querySelector('#authorised-representative-person') || {}).nextElementSibling ||
        null;

      if (arSection) {
        // Primary: dt/dd pairs from dl elements
        const arPairs = extractDtDdPairs(arSection);
        for (const [label, value] of Object.entries(arPairs)) {
          if (/organisation\s*name/i.test(label)) result.arName = value;
          else if (/telephone\s*number/i.test(label)) result.arPhone = value;
          else if (/^email$/i.test(label)) result.arEmail = value;
        }

        // Fallback: innerText label\nvalue regex (single pass)
        if (!result.arName) {
          const arText = arSection.innerText || '';
          const nameM = arText.match(/Organisation\s+name\s*\n\s*([^\n]+)/i);
          const phoneM = arText.match(/Telephone\s+number\s*\n\s*([^\n]+)/i);
          const emailM = arText.match(/Email\s*\n\s*([^\n]+)/i);
          if (nameM) result.arName = nameM[1].trim();
          if (phoneM) result.arPhone = phoneM[1].trim();
          if (emailM) result.arEmail = emailM[1].trim();
        }
      }

      // ── Importer(s) ───────────────────────────────────────────────────
      // Same pattern as AR: find heading by ID, get + div sibling, extract dt/dd.
      // Try multiple heading IDs since the exact ID is unconfirmed.
      const impSection =
        document.querySelector('#importer + div') ||
        document.querySelector('#importers + div') ||
        (() => {
          // Broader: find any heading whose ID contains "importer"
          const h = document.querySelector('[id*="importer"]');
          return h ? (h.nextElementSibling || null) : null;
        })() ||
        (() => {
          // Text-based: find h2/h3 whose text starts with "Importer"
          const headings = Array.from(document.querySelectorAll('h2, h3'));
          const h = headings.find(el => /^importer/i.test((el.textContent || '').trim()));
          return h ? (h.nextElementSibling || null) : null;
        })() ||
        null;

      if (impSection) {
        // Primary: dt/dd pairs
        const impPairs = extractDtDdPairs(impSection);
        for (const [label, value] of Object.entries(impPairs)) {
          if (/organisation\s*name/i.test(label) || /^name$/i.test(label)) result.importerName = value;
          else if (/^email$/i.test(label)) result.importerEmail = value;
        }

        // Fallback: innerText label\nvalue regex
        if (!result.importerName) {
          const impText = impSection.innerText || '';
          const nameM = impText.match(/(?:Organisation\s+)?name\s*\n\s*([^\n]+)/i);
          const emailM = impText.match(/Email\s*\n\s*([^\n]+)/i);
          if (nameM) result.importerName = nameM[1].trim();
          if (emailM) result.importerEmail = emailM[1].trim();
        }
      }

      return result;
    });

    // Merge: DOM values fill in any field still empty after the API step.
    // For CA fields and website, DOM is authoritative so always overwrite.
    if (!detail.actorAddress) detail.actorAddress = domData.actorAddress;
    if (!detail.email) detail.email = domData.email;
    if (!detail.phone) detail.phone = domData.phone;
    // Website, CA fields: always use DOM values (API does not provide these)
    detail.website = domData.website;
    detail.caName = domData.caName;
    detail.caAddress = domData.caAddress;
    detail.caCountry = domData.caCountry;
    detail.caEmail = domData.caEmail;
    detail.caPhone = domData.caPhone;
    // AR and Importer: DOM is authoritative (API extraction was removed —
    // the API response structure for these fields is unconfirmed)
    detail.arName = domData.arName;
    detail.arPhone = domData.arPhone;
    detail.arEmail = domData.arEmail;
    detail.importerName = domData.importerName;
    detail.importerEmail = domData.importerEmail;
  } catch (err) {
    logger.warn(`DOM scraping for detail page failed: ${err.message}`);
    // Return whatever we have — all fields default to ''
  }

  return detail;
}

module.exports = {
  navigateToDetailPage,
  extractDetailData,
};
