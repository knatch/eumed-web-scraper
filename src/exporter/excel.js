'use strict';

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const logger = require('../utils/logger.js');

/** Column definitions: key, header, width */
const COLUMNS = [
  { key: 'srn',              header: 'Actor ID / SRN',        width: 20 },
  { key: 'name',             header: 'Name',                  width: 40 },
  { key: 'abbreviatedName',  header: 'Abbreviated Name',      width: 25 },
  { key: 'country',          header: 'Country',               width: 22 },
  { key: 'city',             header: 'City',                  width: 20 },
  { key: 'actorAddress',     header: 'Actor Address',         width: 40 },
  { key: 'email',            header: 'Email',                 width: 30 },
  { key: 'phone',            header: 'Telephone Number',      width: 20 },
  { key: 'website',          header: 'Website',               width: 35 },
  { key: 'caName',           header: 'CA Name',               width: 35 },
  { key: 'caAddress',        header: 'CA Address',            width: 40 },
  { key: 'caCountry',        header: 'CA Country',            width: 20 },
  { key: 'caEmail',          header: 'CA Email',              width: 30 },
  { key: 'caPhone',          header: 'CA Telephone Number',   width: 22 },
  { key: 'arName',           header: 'AR Organisation Name', width: 35 },
  { key: 'arPhone',          header: 'AR Phone',             width: 22 },
  { key: 'arEmail',          header: 'AR Email',             width: 30 },
  { key: 'importerName',     header: 'Importer Organisation Name', width: 35 },
  { key: 'importerEmail',    header: 'Importer Email',       width: 30 },
  { key: 'deviceName',       header: 'Device Name',          width: 40 },
  { key: 'nomenclatureCodes', header: 'Nomenclature Code(s)', width: 30 },
  { key: 'applicableLegislation', header: 'Applicable Legislation', width: 30 },
  { key: 'riskClass',        header: 'Risk Class',           width: 15 },
  { key: 'humanTissues',     header: 'Human Tissues/Cells',  width: 20 },
];

const HEADER_BG_COLOR = 'DDEEFF';

/**
 * Creates a new ExcelJS workbook with a styled "Economic Operators" worksheet.
 *
 * @param {string} outputPath - Destination file path (used only to determine output dir)
 * @returns {{ workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet }}
 */
function createWorkbook(outputPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EUDAMED Scraper';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('Economic Operators');

  // Define columns
  worksheet.columns = COLUMNS.map((col) => ({
    key: col.key,
    header: col.header,
    width: col.width,
  }));

  // Style header row
  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: `FF${HEADER_BG_COLOR}` },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF000000' } },
    };
  });
  headerRow.commit();

  return { workbook, worksheet };
}

/**
 * Adds a single record as a new row on the worksheet.
 * All cells are aligned to the top.
 *
 * @param {ExcelJS.Worksheet} worksheet
 * @param {object} record
 */
function addRow(worksheet, record) {
  const rowValues = {};
  for (const col of COLUMNS) {
    rowValues[col.key] = record[col.key] !== undefined ? record[col.key] : '';
  }

  const row = worksheet.addRow(rowValues);
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.alignment = { vertical: 'top', wrapText: false };
  });
  row.commit();
}

/**
 * Writes the workbook to disk at outputPath, creating the output directory if needed.
 *
 * @param {ExcelJS.Workbook} workbook
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
async function saveWorkbook(workbook, outputPath) {
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  await workbook.xlsx.writeFile(outputPath);
  logger.info(`Workbook saved to ${outputPath}`);
}

module.exports = {
  createWorkbook,
  addRow,
  saveWorkbook,
};
