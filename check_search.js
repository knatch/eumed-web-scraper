'use strict';

/**
 * Diagnostic script: inspects the EUDAMED Angular SPA to determine
 * whether the search auto-submits from URL params or requires a button click,
 * and captures any /api/eos network calls.
 */

const puppeteer = require('puppeteer');

const LIST_URL =
  'https://ec.europa.eu/tools/eudamed/#/screen/search-eo' +
  '?countryIso2Code=US' +
  '&paging=%7B%22pageSize%22%3A50%2C%22pageIndex%22%3A0%7D' +
  '&sorting=%7B%22sortField%22%3A%22srn%22%2C%22sortDirection%22%3A%22asc%22%7D' +
  '&submitted=true';

async function main() {
  console.log('[check_search] Launching browser (headless)...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();

  // Track every JSON response URL so we can see all API calls
  const jsonResponses = [];
  let interceptedEosData = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (ct.includes('application/json') && !url.match(/\.(js|css|woff|png|svg)(\?|$)/)) {
        jsonResponses.push(url);
        if (url.includes('/api/eos') && !url.match(/\/api\/eos\/[a-f0-9-]{8,}/i)) {
          console.log(`[check_search] /api/eos FIRED: ${url}`);
          const json = await response.json().catch(() => null);
          if (json) {
            interceptedEosData = json;
            const preview = JSON.stringify(json).substring(0, 300);
            console.log(`[check_search] /api/eos response preview: ${preview}`);
          }
        }
      }
    } catch (_) {}
  });

  console.log(`[check_search] Navigating to: ${LIST_URL}`);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[check_search] domcontentloaded fired. Waiting 5s for Angular bootstrap...');
  await new Promise(r => setTimeout(r, 5000));

  // Probe 1: Is app-root or ng-version present (Angular bootstrapped)?
  const angularBootstrapped = await page.evaluate(() => {
    return (
      !!document.querySelector('app-root') ||
      !!document.querySelector('[ng-version]') ||
      !!document.querySelector('eudamed-root')
    );
  });
  console.log(`[check_search] Angular bootstrapped: ${angularBootstrapped}`);

  // Probe 2: Submit button text
  const submitBtnText = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
  });
  console.log(`[check_search] All visible buttons: ${JSON.stringify(submitBtnText)}`);

  // Probe 3: Are table rows present?
  const rowCount = await page.evaluate(() => {
    return document.querySelectorAll('table tbody tr, mat-row').length;
  });
  console.log(`[check_search] Table rows present: ${rowCount}`);

  // Probe 4: app-root inner HTML excerpt (first 800 chars)
  const appHtml = await page.evaluate(() => {
    const el = document.querySelector('app-root') || document.body;
    return el.innerHTML.substring(0, 800);
  });
  console.log(`[check_search] app-root HTML excerpt:\n${appHtml}\n`);

  // Wait 5 more seconds in case Angular needs more time to fire /api/eos
  console.log('[check_search] Waiting 5 more seconds...');
  await new Promise(r => setTimeout(r, 5000));

  // Probe 5: Check again after extra wait
  const rowCountAfter = await page.evaluate(() => {
    return document.querySelectorAll('table tbody tr, mat-row').length;
  });
  console.log(`[check_search] Table rows after extra wait: ${rowCountAfter}`);

  // Probe 6: Check for a Search/Apply/Submit button specifically
  const searchBtnInfo = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button[type="submit"], button.search-button'));
    if (candidates.length === 0) {
      // Try any button whose text looks like Search
      const allBtns = Array.from(document.querySelectorAll('button'));
      const searchBtns = allBtns.filter(b => /search|apply|submit|find/i.test(b.textContent));
      return searchBtns.map(b => ({
        text: b.textContent.trim(),
        type: b.type,
        disabled: b.disabled,
        class: b.className,
      }));
    }
    return candidates.map(b => ({
      text: b.textContent.trim(),
      type: b.type,
      disabled: b.disabled,
      class: b.className,
    }));
  });
  console.log(`[check_search] Search-like buttons: ${JSON.stringify(searchBtnInfo, null, 2)}`);

  // If no rows and no /api/eos yet — try clicking the first search-like button
  if (rowCountAfter === 0 && !interceptedEosData && searchBtnInfo.length > 0) {
    console.log('[check_search] No rows yet — attempting to click the first search-like button...');
    try {
      await page.evaluate(() => {
        const allBtns = Array.from(document.querySelectorAll('button'));
        const searchBtns = allBtns.filter(b => /search|apply|submit|find/i.test(b.textContent));
        if (searchBtns.length > 0) searchBtns[0].click();
      });
      console.log('[check_search] Clicked. Waiting 6s for API response...');
      await new Promise(r => setTimeout(r, 6000));

      const rowCountPostClick = await page.evaluate(() => {
        return document.querySelectorAll('table tbody tr, mat-row').length;
      });
      console.log(`[check_search] Rows after click: ${rowCountPostClick}`);
    } catch (err) {
      console.log(`[check_search] Click attempt failed: ${err.message}`);
    }
  }

  console.log(`\n[check_search] All JSON response URLs intercepted (${jsonResponses.length} total):`);
  for (const u of jsonResponses) {
    console.log(`  ${u}`);
  }

  console.log(`\n[check_search] /api/eos intercepted: ${!!interceptedEosData}`);

  await browser.close();
  console.log('[check_search] Done.');
}

main().catch(err => {
  console.error(`[check_search] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
