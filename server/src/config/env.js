import dotenv from 'dotenv';

dotenv.config();

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 3000,
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://localhost:5432/mineblock',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

export default env;
