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
  defaultMeta: { service: 'mineblock-admin' },
  transports: [
    new winston.transports.Console(),
  ],
});

export default logger;
