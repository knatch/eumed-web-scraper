'use strict';

const logger = require('./logger.js');

/**
 * Retries an async function up to maxRetries times.
 * Logs each failure with the provided label.
 * Returns null after all retries are exhausted (does not throw).
 *
 * @param {Function} fn - Async function to attempt
 * @param {{ maxRetries?: number, label?: string }} options
 * @returns {Promise<any|null>}
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 3, label = '' } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const prefix = label ? `[${label}] ` : '';
      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        logger.warn(`${prefix}Attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        logger.error(`${prefix}All ${maxRetries} attempts failed: ${err.message}`);
      }
    }
  }

  return null;
}

module.exports = withRetry;
