'use strict';

/**
 * Investigation script — confirms real EUDAMED /api/eos field names.
 * Run: node investigate.js
 * Output is written to investigate_output.txt
 *
 * Logs:
 *   1. Every JSON response URL seen during list page load
 *   2. Top-level wrapper key and first 2 actor objects from /api/eos
 *   3. Top-level keys and full JSON of first actor's detail response from /api/eos/{uuid}
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'investigate_output.txt');
const lines = [];

function log(msg) {
  const s = String(msg);
  console.log(s);
  lines.push(s);
}

function flush() {
  fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n');
}

const LIST_URL =
  'https://ec.europa.eu/tools/eudamed/#/screen/search-eo' +
  '?countryIso2Code=US' +
  '&paging=%7B%22pageSize%22%3A50%2C%22pageIndex%22%3A0%7D' +
  '&sorting=%7B%22sortField%22%3A%22srn%22%2C%22sortDirection%22%3A%22asc%22%7D' +
  '&submitted=true';

const DETAIL_BASE = 'https://ec.europa.eu/tools/eudamed/#/screen/search-eo';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Returns the first actor array found under any common wrapper key.
// Also returns the wrapper key name so we can log it.
function findActorsArray(json) {
  const candidates = ['content', 'data', 'results', 'items', 'records', '_embedded'];
  for (const key of candidates) {
    if (Array.isArray(json[key]) && json[key].length > 0) {
      return { key, actors: json[key] };
    }
  }
  if (Array.isArray(json) && json.length > 0) {
    return { key: '(root array)', actors: json };
  }
  return { key: null, actors: null };
}

// Extracts first UUID from an actor object using all known candidate field names.
function extractUuid(actor) {
  return (
    actor.uuid ||
    actor.actorUuid ||
    actor.actorId ||
    actor.eudamedId ||
    actor.id ||
    actor.actorGuid ||
    actor.guid ||
    actor.uniqueId ||
    actor.eoId ||
    null
  );
}

async function main() {
  log('=== EUDAMED API Investigation ===');
  log(`Timestamp: ${new Date().toISOString()}`);
  log('');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // -----------------------------------------------------------------------
    // PHASE 1 — List page: intercept /api/eos
    // -----------------------------------------------------------------------
    log('=== PHASE 1: List page — intercepting /api/eos ===');
    log(`URL: ${LIST_URL}`);
    log('');

    let listJson = null;

    const listHandler = async (response) => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('application/json') && !url.match(/\.(js|css|woff2?|ttf|png|svg|ico)(\?|$)/)) {
          log(`  [JSON url] ${url}`);
        }
        // Capture /api/eos list calls (not detail calls)
        if (url.includes('/api/eos') && !url.match(/\/api\/eos\/[a-f0-9-]{8,}/i)) {
          const json = await response.json().catch(() => null);
          if (json) {
            listJson = json;
            log(`  [CAPTURED] /api/eos response`);
          }
        }
      } catch (e) {
        log(`  [handler error] ${e.message}`);
      }
    };

    page.on('response', listHandler);
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Page loaded. Waiting 12s for Angular + API call...');
    await sleep(12000);
    page.off('response', listHandler);

    flush(); // save what we have so far

    if (!listJson) {
      log('');
      log('ERROR: /api/eos was never intercepted. See [JSON url] lines above for actual API URLs.');
      log('The isActorsList filter needs to be updated to match the correct URL pattern.');
      flush();
      return;
    }

    log('');
    log('--- /api/eos top-level keys ---');
    log(Object.keys(listJson).join(', '));
    log('');

    const { key: wrapperKey, actors } = findActorsArray(listJson);

    if (!actors) {
      log('ERROR: No actor array found under any standard wrapper key.');
      log('Full /api/eos response (first 3000 chars):');
      log(JSON.stringify(listJson, null, 2).slice(0, 3000));
      flush();
      return;
    }

    log(`--- Actor array wrapper key: "${wrapperKey}" (${actors.length} actors) ---`);
    log('');
    log('--- First 2 actor objects (full JSON) ---');
    log(JSON.stringify(actors.slice(0, 2), null, 2));
    log('');

    const firstActor = actors[0];
    const firstUuid = extractUuid(firstActor);

    log(`--- UUID field value extracted: ${firstUuid} ---`);
    log(`--- UUID field name search order: uuid, actorUuid, actorId, eudamedId, id, actorGuid, guid, uniqueId, eoId ---`);

    if (!firstUuid) {
      log('ERROR: UUID not found under any known field name. Add the correct field name from the actor object above.');
      flush();
      return;
    }

    flush();

    // -----------------------------------------------------------------------
    // PHASE 2 — Detail page: intercept /api/eos/{uuid}
    // -----------------------------------------------------------------------
    log('');
    log(`=== PHASE 2: Detail page — intercepting /api/eos/${firstUuid} ===`);
    const detailUrl = `${DETAIL_BASE}/${firstUuid}`;
    log(`URL: ${detailUrl}`);
    log('');

    let detailJson = null;

    const detailHandler = async (response) => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('application/json') && !url.match(/\.(js|css|woff2?|ttf|png|svg|ico)(\?|$)/)) {
          log(`  [JSON url] ${url}`);
        }
        if (url.includes('/api/eos/') && url.includes(firstUuid)) {
          const json = await response.json().catch(() => null);
          if (json) {
            detailJson = json;
            log(`  [CAPTURED] /api/eos/${firstUuid} response`);
          }
        }
      } catch (e) {
        log(`  [handler error] ${e.message}`);
      }
    };

    page.on('response', detailHandler);
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('Page loaded. Waiting 12s for Angular + API call...');
    await sleep(12000);
    page.off('response', detailHandler);

    flush();

    if (!detailJson) {
      log('');
      log('ERROR: /api/eos/{uuid} was never intercepted. See [JSON url] lines above for the actual detail API URL pattern.');
      flush();
      return;
    }

    log('');
    log('--- Detail top-level keys ---');
    log(Object.keys(detailJson).join(', '));
    log('');
    log('--- Full detail JSON ---');
    log(JSON.stringify(detailJson, null, 2));

    flush();
    log('');
    log('=== Investigation complete. Results saved to investigate_output.txt ===');
    flush();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  flush();
  process.exit(1);
});
