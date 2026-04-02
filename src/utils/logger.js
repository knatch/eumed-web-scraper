'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const config = require('../config.js');

const logDir = path.dirname(config.LOG_FILE);
fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
  ),
  transports: [
    new transports.Console({
      level: 'info',
      format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
      ),
    }),
    new transports.File({
      filename: config.LOG_FILE,
      level: 'error',
    }),
  ],
});

module.exports = logger;
