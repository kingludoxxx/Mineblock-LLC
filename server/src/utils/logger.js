import winston from 'winston';
import env from '../config/env.js';

const { combine, timestamp, json, errors } = winston.format;

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json()
  ),
  defaultMeta: { service: process.env.BRAND_APP_NAME || process.env.BRAND_NAME || 'admin-app' },
  transports: [
    new winston.transports.Console(),
  ],
});

export default logger;
