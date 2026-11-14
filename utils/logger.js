const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    })
  ),
  // File logs are size-capped and rotated (previously unbounded — grew to hundreds of GB
  // locally). Test processes (NODE_ENV=test or LOG_TO_FILE=false) never write log files.
  transports: [
    new transports.Console({ silent: process.env.LOG_SILENT === 'true' }),
    ...(process.env.NODE_ENV === 'test' || process.env.LOG_TO_FILE === 'false' ? [] : [
      new transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 20 * 1024 * 1024, maxFiles: 3, tailable: true }),
      new transports.File({ filename: 'logs/combined.log',              maxsize: 20 * 1024 * 1024, maxFiles: 3, tailable: true }),
    ]),
  ],
});

module.exports = logger;
