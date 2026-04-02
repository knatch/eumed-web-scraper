'use strict';

// Surgical test for two issues:
// 1. What field in the list API response actually carries the UUID?
// 2. Does extractDetailData return CA fields for a known UUID?

const puppeteer = require('puppeteer');
const { navigateToDetailPage } = require('./src/scraper/detailPage');

const KNOWN_UUID = 'c9b02f67-29f8-4ee1-9968-47f12cc83a48';

// List URL — page 0, US
const LIST_URL =
  'https://ec.europa.eu/tools/eudamed/#/screen/search-eo' +
  '?countryIso2Code=US' +
  '&paging=' + encodeURIComponent(JSON.stringify({ pageSize: 10, pageIndex: 0 })) +
  '&sorting=' + encodeURIComponent(JSON.stringify({ sortField: 'srn', sortDirection: 'asc' })) +
  '&submitted=true';

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    // ── TEST 1: intercept list API and log raw actor fields ─────────────────
    console.log('\n=== TEST 1: List API intercept — looking for UUID field ===\n');

    const listPage = await browser.newPage();
    await listPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
    );

    let listActors = null;
    const listHandler = async (response) => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('application/json') && url.includes('/api/eos') && !url.match(/\/api\/eos\/[a-f0-9-]{8,}/i)) {
          console.log('[list intercept] Hit URL:', url);
          const json = await response.json().catch(() => null);
          if (json) {
            const actors =
              json.content || json.actors || json.data || json.results ||
              json.items || json.records || (Array.isArray(json) ? json : null);
            if (actors && actors.length > 0) {
              listActors = actors;
              console.log('[list intercept] Array found, length:', actors.length);
              console.log('[list intercept] First actor ALL KEYS:', Object.keys(actors[0]).join(', '));
              console.log('[list intercept] First actor RAW:\n', JSON.stringify(actors[0], null, 2));
            } else {
              console.log('[list intercept] JSON top-level keys:', Object.keys(json).join(', '));
              console.log('[list intercept] Full JSON (first 3000 chars):\n', JSON.stringify(json).substring(0, 3000));
            }
          }
        } else if (ct.includes('application/json') && !url.match(/\.(js|css|woff2?|ttf|png|svg|ico)(\?|$)/)) {
          console.log('[list intercept] Other JSON response:', url);
        }
      } catch (err) {
        console.log('[list intercept] Handler error:', err.message);
      }
    };

    listPage.on('response', listHandler);
    await listPage.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Angular
    await listPage.waitForSelector('app-root, [ng-version], eudamed-root', { timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // Try clicking search button if no data yet
    if (!listActors) {
      console.log('[test] No API data after 3s — trying to click search button...');
      await listPage.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const searchBtn = btns.find(b =>
          !b.disabled && b.offsetParent !== null && /search|apply|find|submit/i.test(b.textContent)
        );
        if (searchBtn) { console.log('Clicking:', searchBtn.textContent.trim()); searchBtn.click(); }
      });
      await new Promise(r => setTimeout(r, 5000));
    }

    listPage.off('response', listHandler);

    if (listActors) {
      console.log('\n[RESULT] UUID field detection across first 3 actors:');
      for (let i = 0; i < Math.min(3, listActors.length); i++) {
        const a = listActors[i];
        console.log(`  Actor ${i}: srn=${a.srn || a.srnCode || '?'} | uuid=${a.uuid || '(missing)'} | actorUuid=${a.actorUuid || '(missing)'} | id=${a.id || '(missing)'} | uuid2=${a.uuid2 || '(missing)'} | eoId=${a.eoId || '(missing)'}`);
      }
    } else {
      console.log('[RESULT] List API intercept FAILED — no actors captured.');
      // Dump all JSON requests seen
    }

    await listPage.close();

    // ── TEST 2: detail page CA extraction ───────────────────────────────────
    console.log('\n=== TEST 2: Detail page CA extraction for UUID:', KNOWN_UUID, '===\n');

    const detailPage = await browser.newPage();
    await detailPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
    );

    try {
      const detail = await navigateToDetailPage(detailPage, KNOWN_UUID);
      console.log('\n[RESULT] navigateToDetailPage returned:');
      console.log(JSON.stringify(detail, null, 2));

      const caFieldsFilled = detail.caName || detail.caAddress || detail.caCountry || detail.caEmail || detail.caPhone;
      if (caFieldsFilled) {
        console.log('\n[PASS] CA fields are populated — detailPage.js is working correctly.');
      } else {
        console.log('\n[FAIL] CA fields are all empty — bug is in detailPage.js DOM extraction.');
      }
    } catch (err) {
      console.log('[ERROR] navigateToDetailPage threw:', err.message);
    }

    await detailPage.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err.stack || err.message);
  process.exit(1);
});
