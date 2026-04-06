'use strict';

const fs = require('fs');
const path = require('path');
const cliProgress = require('cli-progress');

const config = require('./config.js');
const logger = require('./utils/logger.js');
const randomDelay = require('./utils/delay.js');
const withRetry = require('./utils/retry.js');
const {
  saveCheckpoint,
  loadCheckpoint,
  appendToStaging,
  loadStaging,
  clearStaging,
} = require('./utils/progress.js');
const { launchBrowser, closeBrowser, newPage, getOrCreatePage } = require('./browser.js');
const { navigateToListPage } = require('./scraper/listPage.js');
const { navigateToDetailPage } = require('./scraper/detailPage.js');
const { scrapeDeviceDetail } = require('./scraper/deviceDetailPage.js');
const { createWorkbook, addRow, saveWorkbook } = require('./exporter/excel.js');
const { createCsvStream, appendCsvRow, finalizeCsvStream } = require('./exporter/csv.js');
const { countryName } = require('./utils/countryNames.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parses process.argv for known flags and returns an overrides object.
 * @returns {{ country?: string, output?: string, headless?: boolean, dryRun?: boolean }}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const overrides = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--country':
        overrides.country = args[++i];
        break;
      case '--output':
        overrides.output = args[++i];
        break;
      case '--headless':
        overrides.headless = args[++i] !== 'false';
        break;
      case '--dry-run':
        overrides.dryRun = true;
        break;
      default:
        break;
    }
  }

  return overrides;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Parse args and apply overrides to config
  const args = parseArgs();

  if (args.country !== undefined) config.COUNTRY_CODE = args.country;
  if (args.output !== undefined) config.OUTPUT_FILE = args.output;
  if (args.headless !== undefined) config.HEADLESS = args.headless;

  // Re-derive output filenames if country was overridden via CLI
  config.applyCountryToFilenames();

  const isDryRun = Boolean(args.dryRun);
  const DRY_RUN_MAX_RECORDS = 3;

  logger.info(
    `Starting EUDAMED scraper | country=${config.COUNTRY_CODE} | dryRun=${isDryRun} | headless=${config.HEADLESS}`
  );

  // 2. Create output/ and logs/ directories
  fs.mkdirSync(path.dirname(config.OUTPUT_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(config.LOG_FILE), { recursive: true });

  // 3. Load checkpoint
  let checkpoint = loadCheckpoint();

  // 4. Load staging records (must happen before checkpoint synthesis below)
  const stagingRecords = loadStaging();
  logger.info(`Loaded ${stagingRecords.length} records from staging`);

  // If staging has records but no checkpoint exists, the previous run wrote
  // records to staging and then crashed before saving (or between saves).
  // Synthesise a checkpoint from the staging count so the loop resumes at
  // the correct page/row instead of replaying everything from page 0.
  if (!checkpoint && stagingRecords.length > 0) {
    const lastIdx = stagingRecords.length - 1;
    checkpoint = {
      lastCompletedPageIndex: Math.floor(lastIdx / config.PAGE_SIZE),
      lastCompletedRowIndex: lastIdx % config.PAGE_SIZE,
      totalRecordsWritten: stagingRecords.length,
      timestamp: new Date().toISOString(),
      synthesised: true,
    };
    logger.info(
      `No checkpoint file found but staging has ${stagingRecords.length} records — ` +
      `synthesised checkpoint: page=${checkpoint.lastCompletedPageIndex}, ` +
      `row=${checkpoint.lastCompletedRowIndex}`
    );
  }

  const startPage = checkpoint ? checkpoint.lastCompletedPageIndex : 0;
  const resumeFromRow = checkpoint ? checkpoint.lastCompletedRowIndex + 1 : 0;

  if (checkpoint && !checkpoint.synthesised) {
    logger.info(
      `Resuming from checkpoint: page=${startPage}, row=${resumeFromRow}, ` +
      `totalRecords=${checkpoint.totalRecordsWritten}`
    );
  }

  // 5. Launch browser
  const browser = await launchBrowser();
  let page = await newPage(browser);

  // 6. CLI progress bar
  const progressBar = new cliProgress.SingleBar(
    {
      format: '[{bar}] Page {pageIndex} | Records: {value} | Errors: {errors}',
      clearOnComplete: false,
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  progressBar.start(Infinity, stagingRecords.length, {
    pageIndex: startPage,
    errors: 0,
  });

  // 7. Create workbook + CSV stream and re-hydrate from staging
  const { workbook, worksheet } = createWorkbook(config.OUTPUT_FILE);
  const csvStream = createCsvStream(config.CSV_FILE);
  for (const record of stagingRecords) {
    addRow(worksheet, record);
    appendCsvRow(csvStream, record);
  }

  // 8. State variables
  let pageIndex = startPage;
  let currentResumeFromRow = resumeFromRow;
  let totalErrors = 0;
  let totalRecords = stagingRecords.length;
  let shouldBreakOuter = false;
  // Track consecutive page failures to detect when we've gone past the last page.
  // If N consecutive pages fail, we are almost certainly past the end of the data.
  let consecutivePageFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // Tracks the row index of the last record successfully written in the current
  // page so the catch-block checkpoint can save an accurate position rather than
  // always saving 0 (which would cause all rows on the crashed page to replay).
  let lastWrittenRowIndex = resumeFromRow > 0 ? resumeFromRow - 1 : -1;

  // ---------------------------------------------------------------------------
  // 9. SIGINT / SIGTERM handler — saves checkpoint on Ctrl+C or kill signal
  // ---------------------------------------------------------------------------
  const handleSignal = async (signal) => {
    logger.info(`${signal} received — saving checkpoint before exit`);
    saveCheckpoint({
      lastCompletedPageIndex: pageIndex,
      lastCompletedRowIndex: lastWrittenRowIndex,
      totalRecordsWritten: totalRecords,
      timestamp: new Date().toISOString(),
    });
    await saveWorkbook(workbook, config.OUTPUT_FILE).catch(() => {});
    await finalizeCsvStream(csvStream).catch(() => {});
    await closeBrowser(browser).catch(() => {});
    progressBar.stop();
    logger.info(`Checkpoint saved at ${totalRecords} records. Exiting.`);
    process.exit(0);
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  // ---------------------------------------------------------------------------
  // 10. Outer pagination loop
  // ---------------------------------------------------------------------------
  try {
    while (true) {
      // a. Navigate to list page with retry.
      // On each attempt, check if the page context was closed by the previous
      // failure (Puppeteer "Session closed" / "Target closed" errors) and
      // recreate it from the browser before trying again.
      const rows = await withRetry(
        async () => {
          page = await getOrCreatePage(browser, page);
          return navigateToListPage(page, pageIndex, config.COUNTRY_CODE);
        },
        { maxRetries: config.MAX_RETRIES, label: `list page ${pageIndex}` }
      );

      // b. Null means all retries failed — skip page and recover. Empty array
      //    means the server returned a genuine empty page (end of data).
      if (rows === null) {
        consecutivePageFailures++;
        logger.warn(
          `Page ${pageIndex} failed after all retries ` +
          `(${consecutivePageFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive failures)`
        );
        totalErrors++;

        if (consecutivePageFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.info(
            `${MAX_CONSECUTIVE_FAILURES} consecutive page failures — ` +
            `assuming end of data, stopping pagination`
          );
          break;
        }

        page = await getOrCreatePage(browser, page);
        pageIndex++;
        currentResumeFromRow = 0;
        continue;
      }
      // Reset consecutive failure counter on any successful page load
      consecutivePageFailures = 0;

      if (rows.length === 0) {
        logger.info(`No rows returned for page ${pageIndex} — stopping pagination`);
        break;
      }

      logger.info(`Page ${pageIndex}: ${rows.length} rows found`);
      progressBar.update(totalRecords, { pageIndex, errors: totalErrors });

      // c. Inner loop over rows
      for (let i = 0; i < rows.length; i++) {
        // Resume: skip rows already processed on the first resumed page
        if (pageIndex === startPage && i < currentResumeFromRow) {
          continue;
        }

        const row = rows[i];

        // Guard: skip rows with no SRN and no name — these are malformed rows.
        if (!row.srn && !row.name) {
          totalErrors++;
          logger.error(
            `Skipping row (page=${pageIndex}, row=${i}): both SRN and name are empty`
          );
          progressBar.update(totalRecords, { pageIndex, errors: totalErrors });
          continue;
        }

        // Build the base record from list-level fields.
        // The list API already returns email, phone, and actorAddress — populate
        // these now so the record is usable even if detail page retrieval fails.
        const baseRecord = {
          srn: row.srn || '',
          name: row.name || '',
          abbreviatedName: row.abbreviatedName || '',
          country: countryName(config.COUNTRY_CODE),
          city: row.city || '',
          actorAddress: row.actorAddress || '',
          email: row.email || '',
          phone: row.phone || '',
          // Detail-only fields default to empty
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
          // Device detail fields default to empty
          deviceName: '',
          nomenclatureCodes: '',
          applicableLegislation: '',
          riskClass: '',
          humanTissues: '',
        };

        // Navigate to detail page only when we have a UUID.
        // Detail page provides: website, caName, caAddress, caCountry, caEmail, caPhone.
        // If it fails or UUID is missing, write the record with list-level fields only.
        let detail = null;

        if (row.uuid) {
          detail = await withRetry(
            async () => {
              page = await getOrCreatePage(browser, page);
              return navigateToDetailPage(page, row.uuid);
            },
            { maxRetries: config.MAX_RETRIES, label: `detail ${row.srn} (${row.uuid})` }
          ).catch((err) => {
            totalErrors++;
            logger.error(
              `Failed to retrieve detail for SRN=${row.srn} UUID=${row.uuid} ` +
              `(page=${pageIndex}, row=${i}): ${err.message}`
            );
            progressBar.update(totalRecords, { pageIndex, errors: totalErrors });
            return null;
          });
        } else {
          logger.warn(
            `SRN=${row.srn} (page=${pageIndex}, row=${i}): UUID is empty — ` +
            `skipping detail page, writing list-level fields only`
          );
        }

        // After detail page, scrape device detail (reuses the same page).
        // Device scraping is independent of whether detail page scraping succeeded —
        // the page is navigated back to the actor detail page explicitly below.
        let deviceDetail = null;
        if (row.uuid) {
          deviceDetail = await withRetry(
            async () => {
              page = await getOrCreatePage(browser, page);
              // Navigate back to the actor detail page first — the device link
              // is on the actor detail page, which may no longer be the current URL
              // after a previous device scrape or retry.
              await page.goto(
                `${config.BASE_URL}/#/screen/search-eo/${row.uuid}`,
                { waitUntil: 'domcontentloaded', timeout: 60000 }
              );
              await page
                .waitForSelector('#devices, [id*="devices"]', { timeout: 15000 })
                .catch(() => {});
              // Small delay for Angular to render
              await new Promise((r) => setTimeout(r, 2000));
              return scrapeDeviceDetail(page, row.uuid);
            },
            { maxRetries: 2, label: `device ${row.srn} (${row.uuid})` }
          ).catch((err) => {
            totalErrors++;
            logger.error(
              `Failed to retrieve device detail for SRN=${row.srn} UUID=${row.uuid} ` +
              `(page=${pageIndex}, row=${i}): ${err.message}`
            );
            progressBar.update(totalRecords, { pageIndex, errors: totalErrors });
            return null;
          });
        }

        // Merge: list fields take priority for email/phone/address since those
        // come directly from the confirmed list API. Detail supplements with
        // website and CA fields.
        const record = { ...baseRecord };
        if (detail) {
          // Only override email/phone/actorAddress from detail if the list had nothing
          record.email = baseRecord.email || detail.email || '';
          record.phone = baseRecord.phone || detail.phone || '';
          record.actorAddress = baseRecord.actorAddress || detail.actorAddress || '';
          record.website = detail.website || '';
          record.caName = detail.caName || '';
          record.caAddress = detail.caAddress || '';
          record.caCountry = countryName(detail.caCountry || '');
          record.caEmail = detail.caEmail || '';
          record.caPhone = detail.caPhone || '';
          record.arName = detail.arName || '';
          record.arPhone = detail.arPhone || '';
          record.arEmail = detail.arEmail || '';
          record.importerName = detail.importerName || '';
          record.importerEmail = detail.importerEmail || '';
        }

        // Merge device detail fields
        if (deviceDetail) {
          record.deviceName = deviceDetail.deviceName || '';
          record.nomenclatureCodes = deviceDetail.nomenclatureCodes || '';
          record.applicableLegislation = deviceDetail.applicableLegislation || '';
          record.riskClass = deviceDetail.riskClass || '';
          record.humanTissues = deviceDetail.humanTissues || '';
        }

        // Normalize: replace any empty-string / null / undefined field with 'N/A'
        for (const key of Object.keys(record)) {
          if (record[key] === '' || record[key] == null) record[key] = 'N/A';
        }

        // Write to workbook, CSV, and staging
        addRow(worksheet, record);
        appendCsvRow(csvStream, record);
        appendToStaging(record);
        totalRecords++;
        lastWrittenRowIndex = i;

        progressBar.update(totalRecords, { pageIndex, errors: totalErrors });

        // Periodic checkpoint + workbook save
        if (totalRecords % config.CHECKPOINT_INTERVAL === 0) {
          saveCheckpoint({
            lastCompletedPageIndex: pageIndex,
            lastCompletedRowIndex: i,
            totalRecordsWritten: totalRecords,
            timestamp: new Date().toISOString(),
          });
          await saveWorkbook(workbook, config.OUTPUT_FILE);
          logger.info(`Checkpoint saved at ${totalRecords} records`);
        }

        // Polite delay between requests
        await randomDelay(config.MIN_DELAY_MS, config.MAX_DELAY_MS);

        // Dry-run: stop after DRY_RUN_MAX_RECORDS
        if (isDryRun && totalRecords >= DRY_RUN_MAX_RECORDS) {
          logger.info(`Dry-run limit of ${DRY_RUN_MAX_RECORDS} records reached — stopping`);
          shouldBreakOuter = true;
          break;
        }
      }

      if (shouldBreakOuter) break;

      // d. If this page returned fewer rows than PAGE_SIZE, it is the last page.
      if (rows.length < config.PAGE_SIZE) {
        logger.info(
          `Page ${pageIndex} returned ${rows.length} rows (< PAGE_SIZE ${config.PAGE_SIZE}) — ` +
          `last page reached, stopping pagination`
        );
        break;
      }

      // e. Advance to next page
      pageIndex++;

      // f. After the first (possibly resumed) page, reset the resume-row offset
      currentResumeFromRow = 0;
    }
  } catch (err) {
    // On unexpected error: save checkpoint + workbook before re-throwing.
    // Use lastWrittenRowIndex (updated after every successful record write)
    // so the resume skips exactly the rows already written on this page,
    // rather than replaying the entire page from row 0.
    logger.error(`Unexpected error: ${err.message}`);
    saveCheckpoint({
      lastCompletedPageIndex: pageIndex,
      lastCompletedRowIndex: lastWrittenRowIndex,
      totalRecordsWritten: totalRecords,
      timestamp: new Date().toISOString(),
    });
    await saveWorkbook(workbook, config.OUTPUT_FILE).catch(() => {});
    await finalizeCsvStream(csvStream).catch(() => {});
    throw err;
  }

  // 11. Final workbook + CSV save
  await saveWorkbook(workbook, config.OUTPUT_FILE);
  await finalizeCsvStream(csvStream);

  // 12. Clear staging/checkpoint files
  clearStaging();

  // 13. Close browser
  await closeBrowser(browser);

  // 14. Stop progress bar
  progressBar.stop();

  // 15. Final summary
  logger.info(`Completed. ${totalRecords} records exported. ${totalErrors} errors.`);
}

// Entry point
main().catch((err) => {
  logger.error(`Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
