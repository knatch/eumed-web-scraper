'use strict';

require('dotenv').config();

const countryCode = process.env.COUNTRY_CODE || 'US';

const config = {
  BASE_URL: process.env.BASE_URL || 'https://ec.europa.eu/tools/eudamed',
  COUNTRY_CODE: countryCode,
  PAGE_SIZE: Number(process.env.PAGE_SIZE) || 50,
  OUTPUT_FILE: process.env.OUTPUT_FILE || `./output/eudamed_export_${countryCode}.xlsx`,
  STAGING_FILE: process.env.STAGING_FILE || './output/staging.jsonl',
  CHECKPOINT_FILE: process.env.CHECKPOINT_FILE || './output/progress.json',
  HEADLESS: process.env.HEADLESS !== 'false',
  MIN_DELAY_MS: Number(process.env.MIN_DELAY_MS) || 1000,
  MAX_DELAY_MS: Number(process.env.MAX_DELAY_MS) || 3000,
  MAX_RETRIES: Number(process.env.MAX_RETRIES) || 3,
  CHECKPOINT_INTERVAL: Number(process.env.CHECKPOINT_INTERVAL) || 50,
  LOG_FILE: process.env.LOG_FILE || './logs/errors.log',
  // How long (ms) to wait for Angular to fully render the detail page content.
  // Increase this if detail pages are scraped before field data appears in the DOM.
  RENDER_TIMEOUT_MS: Number(process.env.RENDER_TIMEOUT_MS) || 15000,
  CSV_FILE: process.env.CSV_FILE || `./output/eudamed_export_${countryCode}.csv`,
};

/**
 * Re-derives OUTPUT_FILE and CSV_FILE from the current COUNTRY_CODE.
 * Call this after overriding config.COUNTRY_CODE via CLI args so the
 * filenames stay in sync with the country being scraped.
 */
config.applyCountryToFilenames = function () {
  if (!process.env.OUTPUT_FILE) {
    this.OUTPUT_FILE = `./output/eudamed_export_${this.COUNTRY_CODE}.xlsx`;
  }
  if (!process.env.CSV_FILE) {
    this.CSV_FILE = `./output/eudamed_export_${this.COUNTRY_CODE}.csv`;
  }
};

module.exports = config;
