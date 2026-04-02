'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = '/Users/marci/Code/work/eudamed/ca_dom_output.txt';
const TARGET_URL = 'https://ec.europa.eu/tools/eudamed/#/screen/search-eo/c9b02f67-29f8-4ee1-9968-47f12cc83a48';

(async () => {
  let browser;
  const lines = [];
  const log = (msg) => {
    console.log(msg);
    lines.push(msg);
  };

  try {
    log(`Launching Puppeteer...`);
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    log(`Navigating to: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    log(`Waiting for app-root...`);
    await page.waitForSelector('app-root', { timeout: 15000 });

    log(`Waiting 8 seconds for full Angular render...`);
    await new Promise(r => setTimeout(r, 8000));

    log(`Running page.evaluate()...`);
    const data = await page.evaluate(() => {
      const result = {};

      // 1. Find the h2 with id=competent-authority-person
      const h2 = document.querySelector('#competent-authority-person');
      result.h2_outerHTML = h2 ? h2.outerHTML : 'NOT FOUND';

      // 2. Next sibling element
      const nextSib = h2 ? h2.nextElementSibling : null;
      result.nextSibling_outerHTML = nextSib ? nextSib.outerHTML.substring(0, 2000) : 'NOT FOUND';
      result.nextSibling_tagName = nextSib ? nextSib.tagName : 'N/A';
      result.nextSibling_className = nextSib ? nextSib.className : 'N/A';

      // 3. Parent innerHTML
      const parent = h2 ? h2.parentElement : null;
      result.parent_tagName = parent ? parent.tagName : 'N/A';
      result.parent_className = parent ? parent.className : 'N/A';
      result.parent_innerHTML_first2000 = parent ? parent.innerHTML.substring(0, 2000) : 'NOT FOUND';

      // 4. CSS adjacent sibling selector
      const adjDiv = document.querySelector('#competent-authority-person + div');
      result.adjDiv_innerHTML = adjDiv ? adjDiv.innerHTML.substring(0, 2000) : 'NOT FOUND';

      // 5. innerText of the adjacent div
      result.adjDiv_innerText = adjDiv ? (adjDiv.innerText || adjDiv.textContent || '') : 'NOT FOUND';

      // 6. All heading IDs on the page to understand what exists
      const headings = Array.from(document.querySelectorAll('h1[id], h2[id], h3[id], h4[id]'));
      result.allHeadingIDs = headings.map(h => `${h.tagName}#${h.id}: ${(h.textContent||'').trim().substring(0,60)}`);

      // 7. Leaf nodes of adjacent div
      if (adjDiv) {
        const leaves = Array.from(adjDiv.querySelectorAll('*'))
          .filter(el => el.children.length === 0)
          .map(el => ({
            tag: el.tagName,
            class: el.className,
            text: (el.textContent || '').trim().substring(0, 100),
          }))
          .filter(n => n.text.length > 0);
        result.adjDiv_leafNodes = leaves;
      } else {
        result.adjDiv_leafNodes = [];
      }

      // 8. Also try: look for any element that comes after #competent-authority-person
      // (not necessarily a div — could be a section, mat-card, etc.)
      result.nextSibling_all_outerHTML = h2 ? (h2.nextElementSibling ? h2.nextElementSibling.outerHTML.substring(0, 3000) : 'no next sibling') : 'no h2 found';

      // 9. Full body innerText around "Competent Authority"
      const bodyText = document.body.innerText || '';
      const caIndex = bodyText.indexOf('Competent Authority');
      result.bodyText_around_CA = caIndex >= 0 ? bodyText.substring(caIndex, caIndex + 1000) : 'NOT FOUND in body';

      return result;
    });

    log('\n=== RESULTS ===\n');

    log(`h2#competent-authority-person outerHTML: ${data.h2_outerHTML}`);
    log('');

    log(`Next sibling tagName: ${data.nextSibling_tagName}`);
    log(`Next sibling className: ${data.nextSibling_className}`);
    log(`Next sibling outerHTML (first 2000):\n${data.nextSibling_outerHTML}`);
    log('');

    log(`Parent tagName: ${data.parent_tagName}`);
    log(`Parent className: ${data.parent_className}`);
    log(`Parent innerHTML (first 2000):\n${data.parent_innerHTML_first2000}`);
    log('');

    log(`Adjacent div innerHTML (#competent-authority-person + div):\n${data.adjDiv_innerHTML}`);
    log('');

    log(`Adjacent div innerText:\n${data.adjDiv_innerText}`);
    log('');

    log(`All heading IDs on page:\n${data.allHeadingIDs.join('\n')}`);
    log('');

    log(`Leaf nodes in adjacent div (tag | class | text):`);
    for (const n of (data.adjDiv_leafNodes || [])) {
      log(`  [${n.tag}] class="${n.class}" => "${n.text}"`);
    }
    log('');

    log(`Next sibling full outerHTML (first 3000):\n${data.nextSibling_all_outerHTML}`);
    log('');

    log(`Body innerText around "Competent Authority" (1000 chars):\n${data.bodyText_around_CA}`);

    fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
    log(`\nOutput written to: ${OUTPUT_FILE}`);

  } catch (err) {
    const errMsg = `FATAL ERROR: ${err.message}\n${err.stack}`;
    console.error(errMsg);
    lines.push(errMsg);
    fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
