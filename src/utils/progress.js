'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config.js');

const outputDir = path.dirname(config.CHECKPOINT_FILE);
fs.mkdirSync(outputDir, { recursive: true });

/**
 * Writes state object to CHECKPOINT_FILE as JSON.
 * @param {{ lastCompletedPageIndex: number, lastCompletedRowIndex: number, totalRecordsWritten: number, timestamp: string }} state
 */
function saveCheckpoint(state) {
  fs.writeFileSync(config.CHECKPOINT_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Reads CHECKPOINT_FILE if it exists and returns the parsed object.
 * Returns null if the file does not exist.
 * @returns {object|null}
 */
function loadCheckpoint() {
  if (!fs.existsSync(config.CHECKPOINT_FILE)) {
    return null;
  }
  const raw = fs.readFileSync(config.CHECKPOINT_FILE, 'utf8');
  return JSON.parse(raw);
}

/**
 * Appends a single record as a JSON line to STAGING_FILE.
 * @param {object} record
 */
function appendToStaging(record) {
  fs.appendFileSync(config.STAGING_FILE, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Reads STAGING_FILE if it exists, parses each line as JSON, and returns an array.
 * Returns [] if the file does not exist.
 * @returns {object[]}
 */
function loadStaging() {
  if (!fs.existsSync(config.STAGING_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(config.STAGING_FILE, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Deletes STAGING_FILE and CHECKPOINT_FILE if they exist.
 */
function clearStaging() {
  if (fs.existsSync(config.STAGING_FILE)) {
    fs.unlinkSync(config.STAGING_FILE);
  }
  if (fs.existsSync(config.CHECKPOINT_FILE)) {
    fs.unlinkSync(config.CHECKPOINT_FILE);
  }
}

module.exports = {
  saveCheckpoint,
  loadCheckpoint,
  appendToStaging,
  loadStaging,
  clearStaging,
};
