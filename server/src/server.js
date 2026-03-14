import app from './app.js';
import env from './config/env.js';
import { testConnection } from './config/db.js';
import logger from './utils/logger.js';

const start = async () => {
  try {
    await testConnection();
    logger.info('Database connection established');
  } catch (err) {
    logger.warn(`Database not available: ${err.message}. Starting server anyway.`);
  }

  app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });
};

start();
