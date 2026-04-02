'use strict';

/**
 * Returns a Promise that resolves after a random number of milliseconds
 * between min and max.
 *
 * @param {number} min - Minimum delay in ms (default 1000)
 * @param {number} max - Maximum delay in ms (default 3000)
 * @returns {Promise<void>}
 */
async function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = randomDelay;
