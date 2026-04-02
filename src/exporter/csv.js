'use strict';

const fs = require('fs');
const path = require('path');

/** Column keys in export order — must match excel.js COLUMNS order. */
const COLUMN_KEYS = [
  'srn',
  'name',
  'abbreviatedName',
  'country',
  'city',
  'actorAddress',
  'email',
  'phone',
  'website',
  'caName',
  'caAddress',
  'caCountry',
  'caEmail',
  'caPhone',
  'arName',
  'arPhone',
  'arEmail',
  'importerName',
  'importerEmail',
  'deviceName',
  'nomenclatureCodes',
  'applicableLegislation',
  'riskClass',
  'humanTissues',
];

/** Header labels in the same order as COLUMN_KEYS. */
const HEADER_LABELS = [
  'SRN',
  'Name',
  'Abbreviated Name',
  'Country',
  'City',
  'Actor Address',
  'Email',
  'Telephone Number',
  'Website',
  'CA Name',
  'CA Address',
  'CA Country',
  'CA Email',
  'CA Telephone Number',
  'AR Organisation Name',
  'AR Phone',
  'AR Email',
  'Importer Organisation Name',
  'Importer Email',
  'Device Name',
  'Nomenclature Code(s)',
  'Applicable Legislation',
  'Risk Class',
  'Human Tissues/Cells',
];

/**
 * Escapes a single field value for CSV output.
 * Wraps in double-quotes if the value contains a double-quote, comma, or newline.
 * Internal double-quotes are doubled ("").
 *
 * @param {string} value
 * @returns {string}
 */
function escapeField(value) {
  const str = value == null ? '' : String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Formats an array of field values as a single CSV line (no trailing newline).
 *
 * @param {string[]} fields
 * @returns {string}
 */
function formatLine(fields) {
  return fields.map(escapeField).join(',');
}

/**
 * Creates the output directory if needed, opens a write stream with a UTF-8 BOM,
 * and writes the header row immediately.
 *
 * @param {string} outputPath - Destination file path for the CSV.
 * @returns {fs.WriteStream}
 */
function createCsvStream(outputPath) {
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const stream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  // UTF-8 BOM so Excel recognises the encoding on open
  stream.write('\uFEFF');

  // Header row
  stream.write(formatLine(HEADER_LABELS) + '\n');

  return stream;
}

/**
 * Formats a record object as a CSV line and writes it to the stream.
 *
 * @param {fs.WriteStream} stream
 * @param {object} record
 */
function appendCsvRow(stream, record) {
  const fields = COLUMN_KEYS.map((key) => (record[key] !== undefined ? record[key] : ''));
  stream.write(formatLine(fields) + '\n');
}

/**
 * Closes the write stream and returns a Promise that resolves when the stream
 * has fully flushed and closed.
 *
 * @param {fs.WriteStream} stream
 * @returns {Promise<void>}
 */
function finalizeCsvStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  createCsvStream,
  appendCsvRow,
  finalizeCsvStream,
};
