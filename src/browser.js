'use strict';

const puppeteer = require('puppeteer');
const config = require('./config.js');
const logger = require('./utils/logger.js');

/**
 * Launches a Puppeteer browser instance with hardened args.
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function launchBrowser() {
  logger.info('Launching browser...');
  const browser = await puppeteer.launch({
    headless: config.HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: {
      width: 1280,
      height: 900,
    },
  });
  logger.info('Browser launched.');
  return browser;
}

/**
 * Closes the browser instance.
 * @param {import('puppeteer').Browser} browser
 * @returns {Promise<void>}
 */
async function closeBrowser(browser) {
  logger.info('Closing browser...');
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('browser.close() timeout')), 10000)
      ),
    ]);
    logger.info('Browser closed.');
  } catch (err) {
    logger.warn(`Browser close error: ${err.message}. Force killing...`);
    try { browser.process()?.kill('SIGKILL'); } catch (_) {}
  }
}

/**
 * Opens a new page in the browser, sets a realistic user agent,
 * and disables CSS animations via evaluateOnNewDocument.
 * @param {import('puppeteer').Browser} browser
 * @returns {Promise<import('puppeteer').Page>}
 */
async function newPage(browser) {
  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/117.0.0.0 Safari/537.36'
  );

  await page.evaluateOnNewDocument(() => {
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `;
    document.addEventListener('DOMContentLoaded', () => {
      document.head.appendChild(style);
    });
  });

  return page;
}

/**
 * Returns `existingPage` if it is still open, otherwise opens and returns
 * a fresh page from `browser`. Use this in retry loops where a failed
 * navigation may have closed the page context.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {import('puppeteer').Page} existingPage
 * @returns {Promise<import('puppeteer').Page>}
 */
async function getOrCreatePage(browser, existingPage) {
  try {
    if (existingPage && !existingPage.isClosed()) {
      return existingPage;
    }
  } catch (_) {
    // isClosed() can itself throw if the target is gone — treat as closed
  }
  logger.info('Page context was closed — opening a new page');
  return newPage(browser);
}

module.exports = {
  launchBrowser,
  closeBrowser,
  newPage,
  getOrCreatePage,
};
