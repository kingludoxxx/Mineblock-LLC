import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';
import { fetchDailyAdSpend } from './creativeAnalysis.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────
const SHOPIFY_STORE = '17cca0-2.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
// SUPPLIER_SHARE_TOKEN — env var for public /public/cost-sheet token-based access
const SUPPLIER_SHARE_TOKEN = process.env.SUPPLIER_SHARE_TOKEN || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_KPI_CHANNEL = 'C0AN0BPN0NA'; // supply-chain alerts channel

// Track already-alerted unknown products to avoid spam
const alertedUnknownProducts = new Set();
const SHOPIFY_API_VERSION = '2024-01';
const MIN_ORDER_NUMBER = 0; // Sync ALL orders

const WHOP_API_TOKEN = process.env.WHOP_API_TOKEN || '';
const WHOP_API_URL = 'https://api.whop.com/api';
const WHOP_COMPANY_ID = 'biz_pkN7XmNrvouslh';

const UNIT_COST_PER_MINER = 10.92;
const UNIT_COST_PER_MINER_2920 = 11.28; // Orders #2722-#5716
const UNIT_COST_PER_MINER_ORIGINAL = 12.13; // Orders before #2722
const BITAXE_UNIT_COST = 55.00; // Bitaxe Gamma product cost

const MR_MINER_COUNTS = {
  'MR-01': 1, 'MR-02': 2, 'MR-04': 4, 'MR-05': 5, 'MR-08': 8, 'MR-15': 15, 'MR-16': 16, 'M5-05': 5,
};

const RIG_UNIT_COSTS = {
  'RIG-1': 1.96, 'RIG-2': 2.91, 'RIG-4': 3.87,
};

const RIG_SLOT_COUNTS = {
  'RIG-1': 1, 'RIG-2': 2, 'RIG-4': 4,
};

const SHIPPING_RATES_MR = {
  'U.A.E': { 1: 6.5, 2: 8.02, 3: 9.55, 4: 10.9, 5: 12.4, 6: 13.8, 7: 15.29, 8: 16.78, 9: 18.27, 10: 19.76, 11: 21.25, 12: 22.56, 13: 24.04, 14: 25.52, 15: 27.0, 16: 28.48, 17: 29.72, 18: 31.18, 19: 32.65, 20: 34.12, 21: 35.3, 22: 36.76, 23: 38.21, 24: 39.35, 25: 40.79, 26: 42.23, 27: 43.32, 28: 44.75, 29: 45.81, 30: 46.84 },
  'United Arab Emirates': { 1: 6.5, 2: 8.02, 3: 9.55, 4: 10.9, 5: 12.4, 6: 13.8, 7: 15.29, 8: 16.78, 9: 18.27, 10: 19.76, 11: 21.25, 12: 22.56, 13: 24.04, 14: 25.52, 15: 27.0, 16: 28.48, 17: 29.72, 18: 31.18, 19: 32.65, 20: 34.12, 21: 35.3, 22: 36.76, 23: 38.21, 24: 39.35, 25: 40.79, 26: 42.23, 27: 43.32, 28: 44.75, 29: 45.81, 30: 46.84 },
  'Austria': { 1: 6.19, 2: 7.98, 3: 9.78, 4: 11.39, 5: 13.16, 6: 14.81, 7: 16.56, 8: 18.31, 9: 20.06, 10: 21.81, 11: 23.57, 12: 25.12, 13: 26.86, 14: 28.59, 15: 30.33, 16: 32.07, 17: 33.54, 18: 35.26, 19: 36.99, 20: 38.71, 21: 40.11, 22: 41.82, 23: 43.53, 24: 44.88, 25: 46.58, 26: 48.27, 27: 49.56, 28: 51.25, 29: 52.5, 30: 53.72 },
  'Australia': { 1: 6.11, 2: 6.67, 3: 7.23, 4: 7.67, 5: 8.23, 6: 8.71, 7: 9.26, 8: 9.81, 9: 10.36, 10: 10.91, 11: 11.46, 12: 11.91, 13: 12.46, 14: 13.0, 15: 13.55, 16: 14.09, 17: 14.52, 18: 15.06, 19: 15.6, 20: 16.14, 21: 16.55, 22: 17.08, 23: 17.62, 24: 18.01, 25: 18.54, 26: 19.07, 27: 19.44, 28: 19.97, 29: 20.33, 30: 20.68 },
  'Belgium': { 1: 6.51, 2: 8.63, 3: 10.74, 4: 12.66, 5: 14.74, 6: 16.69, 7: 18.75, 8: 20.82, 9: 22.89, 10: 24.95, 11: 27.02, 12: 28.85, 13: 30.9, 14: 32.95, 15: 32.69, 16: 34.61, 17: 36.24, 18: 38.14, 19: 40.04, 20: 41.95, 21: 43.5, 22: 45.39, 23: 47.28, 24: 48.77, 25: 50.65, 26: 52.52, 27: 53.95, 28: 55.81, 29: 57.2, 30: 58.55 },
  'Canada': { 1: 5.51, 2: 7.01, 3: 8.51, 4: 10.55, 5: 12.1, 6: 13.55, 7: 15.09, 8: 16.64, 9: 18.18, 10: 19.72, 11: 21.27, 12: 22.63, 13: 24.16, 14: 25.69, 15: 28.78, 16: 30.41, 17: 31.79, 18: 33.41, 19: 35.03, 20: 36.65, 21: 37.97, 22: 39.58, 23: 41.19, 24: 42.45, 25: 44.04, 26: 45.64, 27: 46.85, 28: 48.43, 29: 49.61, 30: 50.75 },
  'Cyprus': { 1: 8.73, 2: 11.91, 3: 15.1, 4: 18.0, 5: 21.14, 6: 24.09, 7: 27.2, 8: 30.31, 9: 33.42, 10: 36.53, 11: 39.64, 12: 42.42, 13: 45.5, 14: 48.59, 15: 53.62, 16: 56.84, 17: 59.58, 18: 62.77, 19: 65.96, 20: 69.15, 21: 71.77, 22: 74.93, 23: 78.1, 24: 80.61, 25: 83.75, 26: 86.89, 27: 89.3, 28: 92.41, 29: 94.74, 30: 97.02 },
  'Germany': { 1: 5.81, 2: 7.42, 3: 8.78, 4: 10.15, 5: 11.65, 6: 13.05, 7: 14.54, 8: 16.03, 9: 17.52, 10: 19.01, 11: 20.5, 12: 21.82, 13: 23.3, 14: 24.78, 15: 26.26, 16: 27.73, 17: 28.98, 18: 30.45, 19: 31.92, 20: 33.38, 21: 34.57, 22: 36.03, 23: 37.48, 24: 38.62, 25: 40.07, 26: 41.51, 27: 42.6, 28: 44.03, 29: 45.09, 30: 46.13 },
  'Estonia': { 1: 5.64, 2: 7.46, 3: 9.28, 4: 10.93, 5: 12.72, 6: 14.4, 7: 16.18, 8: 17.96, 9: 19.74, 10: 21.52, 11: 23.29, 12: 24.87, 13: 26.64, 14: 28.4, 15: 30.17, 16: 31.93, 17: 33.43, 18: 35.18, 19: 36.93, 20: 38.68, 21: 40.1, 22: 41.84, 23: 43.58, 24: 44.95, 25: 46.67, 26: 48.39, 27: 49.7, 28: 51.41, 29: 52.68, 30: 53.93 },
  'Spain': { 1: 4.99, 2: 6.55, 3: 8.1, 4: 9.5, 5: 11.03, 6: 12.46, 7: 13.98, 8: 15.49, 9: 17.01, 10: 18.53, 11: 20.04, 12: 21.39, 13: 22.89, 14: 24.4, 15: 25.9, 16: 27.41, 17: 28.68, 18: 30.18, 19: 31.67, 20: 33.16, 21: 34.38, 22: 35.86, 23: 37.34, 24: 38.51, 25: 39.98, 26: 41.44, 27: 42.56, 28: 44.02, 29: 45.1, 30: 46.16 },
  'Finland': { 1: 6.76, 2: 8.74, 3: 10.72, 4: 12.51, 5: 14.46, 6: 16.28, 7: 18.21, 8: 20.15, 9: 22.08, 10: 24.02, 11: 25.95, 12: 27.67, 13: 29.59, 14: 31.51, 15: 33.43, 16: 35.35, 17: 36.97, 18: 38.88, 19: 40.78, 20: 42.68, 21: 44.23, 22: 46.12, 23: 48.01, 24: 49.5, 25: 51.37, 26: 53.24, 27: 54.67, 28: 56.53, 29: 57.91, 30: 59.26 },
  'France': { 1: 5.48, 2: 7.14, 3: 8.8, 4: 10.86, 5: 12.5, 6: 14.02, 7: 15.64, 8: 17.26, 9: 18.89, 10: 20.51, 11: 22.13, 12: 23.56, 13: 25.17, 14: 26.78, 15: 28.0, 16: 29.58, 17: 30.92, 18: 32.49, 19: 34.06, 20: 35.63, 21: 36.9, 22: 38.45, 23: 40.01, 24: 41.23, 25: 42.78, 26: 44.32, 27: 45.5, 28: 47.03, 29: 48.16, 30: 49.27 },
  'United Kingdom': { 1: 4.25, 2: 5.37, 3: 6.66, 4: 7.84, 5: 8.81, 6: 9.96, 7: 11.12, 8: 12.69, 9: 13.9, 10: 15.1, 11: 16.31, 12: 17.38, 13: 18.57, 14: 19.77, 15: 20.8, 16: 21.99, 17: 23.17, 18: 24.36, 19: 25.34, 20: 26.52, 21: 27.48, 22: 28.65, 23: 29.58, 24: 30.74, 25: 31.89, 26: 33.05, 27: 34.21, 28: 35.08, 29: 36.23, 30: 37.38 },
  'Greece': { 1: 5.77, 2: 8.1, 3: 10.43, 4: 12.56, 5: 14.85, 6: 17.01, 7: 19.29, 8: 21.56, 9: 23.83, 10: 26.11, 11: 28.38, 12: 30.42, 13: 32.67, 14: 34.93, 15: 37.19, 16: 39.45, 17: 41.37, 18: 43.61, 19: 45.85, 20: 48.09, 21: 49.92, 22: 52.15, 23: 54.37, 24: 56.13, 25: 58.33, 26: 60.54, 27: 62.23, 28: 64.42, 29: 66.06, 30: 67.66 },
  'Hong Kong': { 1: 4.61, 2: 5.01, 3: 5.41, 4: 5.72, 5: 6.12, 6: 6.46, 7: 6.85, 8: 7.25, 9: 7.64, 10: 8.03, 11: 8.42, 12: 8.75, 13: 9.14, 14: 9.52, 15: 13.25, 16: 13.64, 17: 13.92, 18: 14.3, 19: 14.69, 20: 15.07, 21: 15.34, 22: 15.72, 23: 16.1, 24: 16.35, 25: 16.73, 26: 17.11, 27: 17.35, 28: 17.73, 29: 17.95, 30: 18.18 },
  'Croatia': { 1: 7.75, 2: 10.54, 3: 13.32, 4: 15.86, 5: 18.6, 6: 21.17, 7: 23.89, 8: 26.61, 9: 29.33, 10: 32.05, 11: 34.77, 12: 37.19, 13: 39.89, 14: 42.59, 15: 45.29, 16: 47.98, 17: 50.28, 18: 52.96, 19: 55.63, 20: 58.31, 21: 60.5, 22: 63.15, 23: 65.81, 24: 67.91, 25: 70.54, 26: 73.18, 27: 75.2, 28: 77.81, 29: 79.76, 30: 81.67 },
  'Ireland': { 1: 7.13, 2: 9.86, 3: 12.59, 4: 15.08, 5: 17.77, 6: 20.3, 7: 22.96, 8: 25.63, 9: 28.3, 10: 30.97, 11: 33.63, 12: 36.01, 13: 38.66, 14: 41.31, 15: 43.95, 16: 46.6, 17: 48.85, 18: 51.48, 19: 54.1, 20: 56.73, 21: 58.88, 22: 61.48, 23: 64.09, 24: 66.15, 25: 68.74, 26: 71.32, 27: 73.3, 28: 75.86, 29: 77.78, 30: 79.66 },
  'Italy': { 1: 6.39, 2: 7.99, 3: 9.6, 4: 11.03, 5: 12.61, 6: 14.08, 7: 15.65, 8: 17.22, 9: 18.79, 10: 20.36, 11: 21.93, 12: 23.31, 13: 24.87, 14: 26.42, 15: 28.76, 16: 30.37, 17: 31.72, 18: 33.32, 19: 34.91, 20: 36.51, 21: 37.8, 22: 39.38, 23: 40.96, 24: 42.2, 25: 43.77, 26: 45.34, 27: 46.53, 28: 48.09, 29: 49.24, 30: 50.36 },
  'Lithuania': { 1: 5.59, 2: 7.36, 3: 9.12, 4: 10.72, 5: 12.46, 6: 14.09, 7: 15.82, 8: 17.54, 9: 19.27, 10: 20.99, 11: 22.72, 12: 24.25, 13: 25.96, 14: 27.68, 15: 30.56, 16: 32.34, 17: 33.86, 18: 35.64, 19: 37.42, 20: 39.19, 21: 40.64, 22: 42.4, 23: 44.16, 24: 45.55, 25: 47.3, 26: 49.05, 27: 50.38, 28: 52.12, 29: 53.41, 30: 54.67 },
  'Luxembourg': { 1: 8.45, 2: 11.93, 3: 15.41, 4: 18.6, 5: 22.02, 6: 25.25, 7: 28.65, 8: 32.05, 9: 35.45, 10: 38.85, 11: 42.25, 12: 45.29, 13: 48.66, 14: 52.03, 15: 57.35, 16: 60.85, 17: 63.84, 18: 67.32, 19: 70.79, 20: 74.26, 21: 77.12, 22: 80.56, 23: 84.01, 24: 86.75, 25: 90.17, 26: 93.59, 27: 96.22, 28: 99.61, 29: 102.16, 30: 104.65 },
  'Malta': { 1: 10.26, 2: 14.6, 3: 18.93, 4: 22.91, 5: 27.18, 6: 31.2, 7: 35.44, 8: 39.68, 9: 43.91, 10: 48.15, 11: 52.38, 12: 56.17, 13: 60.38, 14: 64.58, 15: 45.73, 16: 48.53, 17: 50.93, 18: 53.71, 19: 56.49, 20: 59.26, 21: 61.55, 22: 64.3, 23: 67.06, 24: 69.26, 25: 71.99, 26: 74.73, 27: 76.83, 28: 79.54, 29: 81.58, 30: 83.58 },
  'Mexico': { 1: 4.36, 2: 5.59, 3: 6.83, 4: 8.06, 5: 9.08, 6: 10.29, 7: 11.49, 8: 12.69, 9: 13.9, 10: 15.1, 11: 16.31, 12: 17.51, 13: 18.72, 14: 19.77, 15: 20.96, 16: 22.16, 17: 23.35, 18: 24.55, 19: 25.54, 20: 26.73, 21: 27.92, 22: 28.87, 23: 30.05, 24: 30.98, 25: 32.15, 26: 33.32, 27: 34.21, 28: 35.08, 29: 35.94, 30: 36.78 },
  'Netherlands': { 1: 6.35, 2: 8.3, 3: 10.26, 4: 12.02, 5: 13.95, 6: 15.75, 7: 17.66, 8: 19.57, 9: 21.47, 10: 23.38, 11: 25.29, 12: 26.99, 13: 28.88, 14: 30.77, 15: 28.0, 16: 29.58, 17: 30.92, 18: 32.49, 19: 34.06, 20: 35.63, 21: 36.9, 22: 38.45, 23: 40.01, 24: 41.23, 25: 42.78, 26: 44.32, 27: 45.5, 28: 47.03, 29: 48.16, 30: 49.27 },
  'Poland': { 1: 4.07, 2: 6.55, 3: 8.36, 4: 10.16, 5: 11.97, 6: 13.78, 7: 15.58, 8: 17.26, 9: 19.05, 10: 20.85, 11: 22.64, 12: 24.44, 13: 26.03, 14: 27.81, 15: 29.59, 16: 31.13, 17: 32.9, 18: 34.4, 19: 36.15, 20: 37.61, 21: 39.35, 22: 40.77, 23: 42.49, 24: 43.87, 25: 45.58, 26: 46.92, 27: 48.62, 28: 49.91, 29: 51.18, 30: 51.56 },
  'Portugal': { 1: 5.64, 2: 7.46, 3: 9.28, 4: 10.93, 5: 12.72, 6: 14.4, 7: 16.18, 8: 17.96, 9: 19.74, 10: 21.52, 11: 23.29, 12: 24.87, 13: 26.64, 14: 28.4, 15: 30.17, 16: 31.93, 17: 33.43, 18: 35.18, 19: 36.93, 20: 38.68, 21: 40.1, 22: 41.84, 23: 43.58, 24: 44.95, 25: 46.67, 26: 48.39, 27: 49.7, 28: 51.41, 29: 52.68, 30: 53.93 },
  'Saudi Arabia': { 1: 18.78, 2: 20.1, 3: 21.41, 4: 22.72, 5: 24.04, 6: 25.35, 7: 26.67, 8: 27.98, 9: 29.29, 10: 30.61, 11: 31.92, 12: 33.23, 13: 34.55, 14: 35.86, 15: 38.87, 16: 40.3, 17: 41.73, 18: 43.15, 19: 44.58, 20: 46.01, 21: 47.43, 22: 48.86, 23: 50.29, 24: 51.71, 25: 53.14, 26: 54.57, 27: 55.99, 28: 57.42, 29: 58.85, 30: 60.27 },
  'United States': { 1: 5.15, 2: 6.87, 3: 7.44, 4: 8.59, 5: 9.74, 6: 10.88, 7: 12.03, 8: 13.18, 9: 14.18, 10: 15.47, 11: 18.31, 12: 19.8, 13: 21.29, 14: 22.79, 15: 24.28, 16: 25.77, 17: 27.26, 18: 28.75, 19: 30.25, 20: 31.74, 21: 33.23, 22: 34.72, 23: 36.21, 24: 37.7, 25: 39.2, 26: 40.69, 27: 42.18, 28: 43.67, 29: 45.16, 30: 46.66 },
  'Switzerland': { 1: 7.02, 2: 9.81, 3: 13.0, 4: 14.46, 5: 17.22, 6: 19.83, 7: 22.58, 8: 25.33, 9: 28.07, 10: 30.82, 11: 33.56, 12: 36.02, 13: 38.75, 14: 41.47, 15: 44.19, 16: 46.92, 17: 49.25, 18: 51.95, 19: 54.65, 20: 57.35, 21: 59.57, 22: 62.26, 23: 64.94, 24: 67.07, 25: 69.73, 26: 72.39, 27: 74.44, 28: 77.08, 29: 79.06, 30: 81.0 },
};

const SHIPPING_RATES_RIG = {
  'U.A.E': { 1: 0.22, 2: 0.43, 4: 0.73 },
  'United Arab Emirates': { 1: 0.22, 2: 0.43, 4: 0.73 },
  'Austria': { 1: 0.37, 2: 0.75, 4: 1.27 },
  'Australia': { 1: 0.14, 2: 0.28, 4: 0.47 },
  'Belgium': { 1: 0.4, 2: 0.8, 4: 1.37 },
  'Canada': { 1: 0.35, 2: 0.71, 4: 1.2 },
  'Cyprus': { 1: 0.57, 2: 1.14, 4: 1.93 },
  'Germany': { 1: 0.32, 2: 0.65, 4: 1.11 },
  'Estonia': { 1: 0.36, 2: 0.72, 4: 1.22 },
  'Spain': { 1: 0.29, 2: 0.58, 4: 0.99 },
  'Finland': { 1: 0.39, 2: 0.77, 4: 1.32 },
  'France': { 1: 0.35, 2: 0.7, 4: 1.19 },
  'United Kingdom': { 1: 0.28, 2: 0.56, 4: 0.96 },
  'Greece': { 1: 0.42, 2: 0.83, 4: 1.41 },
  'Hong Kong': { 1: 0.07, 2: 0.14, 4: 0.24 },
  'Croatia': { 1: 0.52, 2: 1.04, 4: 1.77 },
  'Ireland': { 1: 0.49, 2: 0.97, 4: 1.66 },
  'Italy': { 1: 0.29, 2: 0.57, 4: 0.98 },
  'Lithuania': { 1: 0.35, 2: 0.7, 4: 1.19 },
  'Luxembourg': { 1: 0.68, 2: 1.36, 4: 2.31 },
  'Luxambourg': { 1: 0.68, 2: 1.36, 4: 2.31 },
  'Malta': { 1: 0.77, 2: 1.55, 4: 2.63 },
  'Mexico': { 1: 0.43, 2: 0.86, 4: 1.46 },
  'Netherlands': { 1: 0.37, 2: 0.75, 4: 1.27 },
  'Poland': { 1: 0.97, 2: 1.32, 4: 1.81 },
  'Portugal': { 1: 0.34, 2: 0.68, 4: 1.15 },
  'Saudi Arabia': { 1: 0.28, 2: 0.55, 4: 0.94 },
  'United States': { 1: 0.28, 2: 0.65, 4: 1.2 },
  'Switzerland': { 1: 0.72, 2: 1.29, 4: 1.85 },
};

// Bitaxe Gamma shipping rates per country (single unit only)
const SHIPPING_RATES_BITAXE = {
  'U.A.E': 9.65, 'United Arab Emirates': 9.65,
  'Austria': 10.12, 'Australia': 14.45, 'Belgium': 11.26,
  'Canada': 9.35, 'Cyprus': 16.05, 'Germany': 9.00,
  'Estonia': 9.73, 'Spain': 8.45, 'Finland': 11.11,
  'France': 9.64, 'United Kingdom': 6.69, 'Greece': 11.22,
  'Hong Kong': 4.99, 'Croatia': 14.13, 'Ireland': 13.46,
  'Italy': 9.77, 'Lithuania': 9.53, 'Luxembourg': 16.61, 'Luxambourg': 16.61,
  'Malta': 20.48, 'Mexico': 8.79, 'Netherlands': 10.69,
  'Poland': 8.73, 'Portugal': 9.73, 'Saudi Arabia': 23.01,
  'United States': 12.21, 'Switzerland': 16.61,
};

// Shipping rates for orders #2920-#6008 (older quotation)
const SHIPPING_RATES_MR_2920 = {
  'U.A.E': { 1: 4.92, 2: 6.35, 3: 7.78, 4: 9.21, 5: 10.64, 6: 12.07, 7: 13.5, 8: 14.93, 9: 16.36, 10: 17.79, 11: 18.35, 12: 19.12, 13: 20.89, 14: 21.76, 15: 23.19, 16: 24.41, 24: 37.8, 30: 46.39 },
  'United Arab Emirates': { 1: 4.92, 2: 6.35, 3: 7.78, 4: 9.21, 5: 10.64, 6: 12.07, 7: 13.5, 8: 14.93, 9: 16.36, 10: 17.79, 11: 18.35, 12: 19.12, 13: 20.89, 14: 21.76, 15: 23.19, 16: 24.41, 24: 37.8, 30: 46.39 },
  'Austria': { 1: 5.94, 2: 8.23, 3: 10.51, 4: 12.8, 5: 15.09, 6: 17.38, 7: 19.66, 8: 21.95, 9: 24.24, 10: 26.52, 11: 27.64, 12: 28.79, 13: 31.71, 14: 33.03, 15: 35.4, 16: 37.26, 24: 58.54, 30: 72.26 },
  'Australia': { 1: 4.93, 2: 6.42, 3: 7.53, 4: 8.45, 5: 9.75, 6: 10.67, 7: 11.59, 8: 12.5, 9: 13.42, 10: 14.34, 11: 15.26, 12: 16.17, 13: 17.09, 14: 18.01, 15: 18.93, 16: 19.34, 24: 27.19, 30: 32.69 },
  'Belgium': { 1: 6.16, 2: 8.67, 3: 11.18, 4: 13.69, 5: 16.2, 6: 18.71, 7: 21.22, 8: 23.73, 9: 26.24, 10: 28.75, 11: 28.04, 12: 29.21, 13: 32.22, 14: 33.56, 15: 36.02, 16: 37.91, 24: 59.75, 30: 73.85 },
  'Canada': { 1: 5.18, 2: 7.02, 3: 9.47, 4: 11.4, 5: 13.34, 6: 15.28, 7: 17.22, 8: 19.15, 9: 21.09, 10: 23.03, 11: 25.27, 12: 26.32, 13: 28.94, 14: 30.15, 15: 32.27, 16: 33.97, 24: 53.21, 30: 65.59 },
  'Cyprus': { 1: 8.39, 2: 12.17, 3: 15.95, 4: 19.73, 5: 23.51, 6: 27.29, 7: 31.07, 8: 34.85, 9: 38.63, 10: 42.41, 11: 46.11, 12: 48.03, 13: 53.11, 14: 55.32, 15: 59.49, 16: 62.62, 24: 99.14, 30: 122.77 },
  'Germany': { 1: 5.5, 2: 7.31, 3: 9.21, 4: 11.12, 5: 13.02, 6: 14.93, 7: 16.84, 8: 18.74, 9: 20.65, 10: 22.55, 11: 23.44, 12: 24.41, 13: 26.82, 14: 27.94, 15: 29.9, 16: 31.47, 24: 49.24, 30: 60.67 },
  'Estonia': { 1: 5.34, 2: 7.5, 3: 9.66, 4: 11.82, 5: 13.98, 6: 16.14, 7: 18.3, 8: 20.46, 9: 22.62, 10: 24.78, 11: 25.86, 12: 26.94, 13: 29.7, 14: 30.94, 15: 33.19, 16: 34.94, 24: 55.02, 30: 67.98 },
  'Spain': { 1: 4.7, 2: 6.54, 3: 8.39, 4: 10.23, 5: 12.07, 6: 13.91, 7: 15.76, 8: 17.6, 9: 19.44, 10: 21.28, 11: 22.19, 12: 23.12, 13: 25.47, 14: 26.53, 15: 28.44, 16: 29.94, 24: 47.08, 30: 58.13 },
  'Finland': { 1: 6.32, 2: 8.67, 3: 11.02, 4: 13.37, 5: 15.72, 6: 18.07, 7: 20.42, 8: 22.78, 9: 25.13, 10: 27.48, 11: 28.6, 12: 29.79, 13: 32.78, 14: 34.15, 15: 36.58, 16: 38.5, 24: 60.38, 30: 74.49 },
  'France': { 1: 5.3, 2: 7.43, 3: 10.04, 4: 12.17, 5: 14.29, 6: 16.42, 7: 18.55, 8: 20.68, 9: 22.81, 10: 24.94, 11: 25.61, 12: 26.68, 13: 29.34, 14: 30.56, 15: 32.72, 16: 34.44, 24: 53.97, 30: 66.55 },
  'United Kingdom': { 1: 4.1, 2: 5.78, 3: 7.4, 4: 9.02, 5: 10.64, 6: 12.64, 7: 14.33, 8: 16.01, 9: 17.69, 10: 19.38, 11: 20.22, 12: 21.06, 13: 23.21, 14: 24.18, 15: 25.93, 16: 27.29, 24: 42.95, 30: 53.05 },
  'Greece': { 1: 5.62, 2: 8.39, 3: 11.15, 4: 13.91, 5: 16.68, 6: 19.44, 7: 22.2, 8: 24.97, 9: 27.73, 10: 30.49, 11: 32.02, 12: 33.35, 13: 36.93, 14: 38.47, 15: 41.41, 16: 43.59, 24: 69.18, 30: 85.76 },
  'Hong Kong': { 1: 3.97, 2: 4.45, 3: 4.92, 4: 5.4, 5: 5.88, 6: 6.35, 7: 6.83, 8: 7.31, 9: 7.78, 10: 8.26, 11: 8.74, 12: 9.22, 13: 9.7, 14: 10.18, 15: 10.66, 16: 11.14, 24: 17.79, 30: 20.65 },
  'Croatia': { 1: 7.43, 2: 10.74, 3: 14.04, 4: 17.34, 5: 20.65, 6: 23.95, 7: 27.25, 8: 30.56, 9: 33.86, 10: 37.16, 11: 38.91, 12: 40.53, 13: 44.78, 14: 46.65, 15: 50.13, 16: 52.76, 24: 83.41, 30: 103.24 },
  'Ireland': { 1: 6.89, 2: 10.13, 3: 13.37, 4: 16.61, 5: 19.85, 6: 23.09, 7: 26.33, 8: 29.57, 9: 32.81, 10: 36.05, 11: 37.81, 12: 39.38, 13: 43.57, 14: 45.38, 15: 48.81, 16: 51.38, 24: 81.41, 30: 100.85 },
  'Italy': { 1: 5.88, 2: 7.78, 3: 9.69, 4: 11.59, 5: 13.5, 6: 15.41, 7: 17.31, 8: 19.22, 9: 21.12, 10: 23.03, 11: 24.54, 12: 25.56, 13: 28.04, 14: 29.21, 15: 31.21, 16: 32.85, 24: 51.24, 30: 63.05 },
  'Lithuania': { 1: 5.27, 2: 7.37, 3: 9.47, 4: 11.56, 5: 13.66, 6: 15.76, 7: 17.85, 8: 19.95, 9: 22.04, 10: 24.14, 11: 26.2, 12: 27.29, 13: 30.1, 14: 31.35, 15: 33.64, 16: 35.41, 24: 55.78, 30: 68.93 },
  'Luxembourg': { 1: 8.26, 2: 12.39, 3: 16.52, 4: 20.65, 5: 24.78, 6: 28.91, 7: 33.04, 8: 37.16, 9: 41.29, 10: 45.42, 11: 49.55, 12: 53.68, 13: 57.81, 14: 59.71, 15: 61.94, 16: 66.07, 24: 107.05, 30: 132.78 },
  'Luxambourg': { 1: 8.26, 2: 12.39, 3: 16.52, 4: 20.65, 5: 24.78, 6: 28.91, 7: 33.04, 8: 37.16, 9: 41.29, 10: 45.42, 11: 49.55, 12: 53.68, 13: 57.81, 14: 59.71, 15: 61.94, 16: 66.07, 24: 107.05, 30: 132.78 },
  'Malta': { 1: 10.07, 2: 15.22, 3: 20.36, 4: 25.51, 5: 30.65, 6: 35.8, 7: 40.94, 8: 46.09, 9: 51.24, 10: 56.38, 11: 61.53, 12: 66.67, 13: 71.82, 14: 74.97, 15: 76.97, 16: 82.11, 24: 85.51, 30: 106.09 },
  'Mexico': { 1: 4.61, 2: 6.67, 3: 8.74, 4: 10.8, 5: 12.86, 6: 14.93, 7: 16.99, 8: 19.06, 9: 21.12, 10: 23.19, 11: 24.28, 12: 25.29, 13: 27.95, 14: 29.12, 15: 31.29, 16: 32.94, 24: 52.09, 30: 64.48 },
  'Netherlands': { 1: 5.97, 2: 8.29, 3: 10.61, 4: 12.93, 5: 15.25, 6: 17.57, 7: 19.88, 8: 22.2, 9: 24.52, 10: 26.84, 11: 23.92, 12: 24.91, 13: 27.36, 14: 28.5, 15: 30.48, 16: 32.09, 24: 50.16, 30: 61.78 },
  'Poland': { 1: 4.07, 2: 6.77, 3: 8.96, 4: 11.15, 5: 13.34, 6: 15.53, 7: 17.72, 8: 19.92, 9: 22.11, 10: 24.3, 11: 25.5, 12: 26.56, 13: 29.39, 14: 30.62, 15: 32.94, 16: 34.68, 24: 54.98, 30: 68.14 },
  'Portugal': { 1: 5.34, 2: 7.5, 3: 9.66, 4: 11.82, 5: 13.98, 6: 16.14, 7: 18.3, 8: 20.46, 9: 22.62, 10: 24.78, 11: 25.86, 12: 26.94, 13: 29.7, 14: 30.94, 15: 33.19, 16: 34.94, 24: 55.02, 30: 67.98 },
  'Saudi Arabia': { 1: 13.85, 2: 15.72, 3: 17.59, 4: 19.48, 5: 21.35, 6: 23.23, 7: 25.1, 8: 26.98, 9: 28.86, 10: 30.73, 11: 36.59, 12: 38.12, 13: 40.15, 14: 41.82, 15: 43.25, 16: 45.53, 24: 65.18, 30: 81.98 },
  'United States': { 1: 6.48, 2: 8.64, 3: 10.7, 4: 12.1, 5: 14.61, 6: 17.12, 7: 19.63, 8: 22.14, 9: 24.65, 10: 27.16, 11: 29.67, 12: 32.18, 13: 34.69, 14: 37.2, 15: 39.71, 16: 42.22, 24: 62.29, 30: 77.35 },
  'Switzerland': { 1: 7.78, 2: 10.42, 3: 12.86, 4: 16.2, 5: 19.54, 6: 22.87, 7: 26.21, 8: 29.54, 9: 32.88, 10: 36.21, 11: 38.12, 12: 39.71, 13: 44.05, 14: 45.88, 15: 49.46, 16: 52.06, 24: 82.91, 30: 114.26 },
};

// Shipping rates for orders #2722-#2919 (oldest quotation, sparse: 1,2,4,6,8,9)
const SHIPPING_RATES_MR_2722 = {
  'United Arab Emirates': { 1: 5.01, 2: 6.47, 4: 9.38, 6: 12.29, 8: 15.21, 9: 16.66 },
  'U.A.E': { 1: 5.01, 2: 6.47, 4: 9.38, 6: 12.29, 8: 15.21, 9: 16.66 },
  'Austria': { 1: 6.24, 2: 8.77, 4: 13.81, 6: 18.86, 8: 23.91, 9: 26.43 },
  'Australia': { 1: 5.63, 2: 6.73, 4: 9.25, 6: 11.45, 8: 13.33, 9: 14.27 },
  'Belgium': { 1: 6.44, 2: 9.16, 4: 14.59, 6: 20.03, 8: 25.46, 9: 28.18 },
  'Canada': { 1: 5.79, 2: 8.19, 4: 13.69, 6: 18.67, 8: 23.65, 9: 26.14 },
  'Cyprus': { 1: 8.54, 2: 12.39, 4: 20.09, 6: 27.79, 8: 35.49, 9: 39.34 },
  'Germany': { 1: 5.6, 2: 7.76, 4: 11.97, 6: 16.18, 8: 20.38, 9: 22.49 },
  'Estonia': { 1: 5.66, 2: 8.09, 4: 12.94, 6: 17.79, 8: 22.65, 9: 25.07 },
  'Spain': { 1: 4.89, 2: 6.86, 4: 10.81, 6: 14.75, 8: 18.7, 9: 20.67 },
  'Finland': { 1: 6.66, 2: 9.29, 4: 14.53, 6: 19.77, 8: 25.01, 9: 27.63 },
  'France': { 1: 5.6, 2: 7.96, 4: 13.04, 6: 17.7, 8: 22.36, 9: 24.69 },
  'United Kingdom': { 1: 4.50, 2: 6.54, 4: 10.48, 6: 14.82, 8: 18.89, 9: 20.93 },
  'Greece': { 1: 5.73, 2: 8.54, 4: 14.17, 6: 19.8, 8: 25.43, 9: 28.24 },
  'Hong Kong': { 1: 4.04, 2: 4.53, 4: 5.5, 6: 6.47, 8: 7.44, 9: 7.93 },
  'Croatia': { 1: 7.73, 2: 11.26, 4: 18.31, 6: 25.36, 8: 32.42, 9: 35.94 },
  'Ireland': { 1: 7.02, 2: 10.32, 4: 16.92, 6: 23.52, 8: 30.12, 9: 33.42 },
  'Italy': { 1: 5.99, 2: 7.93, 4: 11.81, 6: 15.69, 8: 19.57, 9: 21.51 },
  'Lithuania': { 1: 5.6, 2: 7.96, 4: 12.68, 6: 17.41, 8: 22.13, 9: 24.49 },
  'Luxembourg': { 1: 8.8, 2: 13.39, 4: 22.58, 6: 31.77, 8: 40.96, 9: 45.55 },
  'Luxambourg': { 1: 8.8, 2: 13.39, 4: 22.58, 6: 31.77, 8: 40.96, 9: 45.55 },
  'Malta': { 1: 10.26, 2: 15.5, 4: 25.98, 6: 36.46, 8: 46.94, 9: 52.19 },
  'Mexico': { 1: 5.5, 2: 8.41, 4: 14.24, 6: 20.06, 8: 25.88, 9: 28.79 },
  'Netherlands': { 1: 6.24, 2: 8.77, 4: 13.81, 6: 18.86, 8: 23.91, 9: 26.43 },
  'Poland': { 1: 4.3, 2: 7.21, 4: 12.0, 6: 16.79, 8: 21.58, 9: 23.97 },
  'Portugal': { 1: 5.53, 2: 7.83, 4: 12.42, 6: 17.02, 8: 21.61, 9: 23.91 },
  'Saudi Arabia': { 1: 13.85, 2: 15.72, 4: 19.48, 6: 23.23, 8: 26.98, 9: 28.86 },
  'United States': { 1: 6.61, 2: 9.08, 4: 13.0, 6: 18.5, 8: 24.0, 9: 26.74 },
  'Switzerland': { 1: 7.76, 2: 11.58, 4: 18.0, 6: 25.41, 8: 32.82, 9: 36.53 },
};

/**
 * Interpolate a shipping rate from a sparse rate table (e.g. SHIPPING_RATES_MR_2920).
 * Handles exact matches, linear interpolation between defined points,
 * and linear extrapolation beyond the max defined quantity.
 */
function interpolateRate(countryRates, quantity) {
  if (countryRates[quantity] !== undefined) return countryRates[quantity];

  const definedQtys = Object.keys(countryRates).map(Number).sort((a, b) => a - b);

  // Below the minimum defined rate — use the first rate
  if (quantity < definedQtys[0]) return countryRates[definedQtys[0]];

  const maxQty = definedQtys[definedQtys.length - 1];

  if (quantity > maxQty) {
    // Extrapolate beyond max using the last increment
    const prevQty = definedQtys[definedQtys.length - 2];
    const rateMax = countryRates[maxQty];
    const ratePrev = countryRates[prevQty];
    const perUnit = (rateMax - ratePrev) / (maxQty - prevQty);
    return Math.round((rateMax + perUnit * (quantity - maxQty)) * 100) / 100;
  }

  // Interpolate between two surrounding defined rates
  let lower = definedQtys[0];
  let upper = definedQtys[definedQtys.length - 1];
  for (const q of definedQtys) {
    if (q <= quantity) lower = q;
    if (q >= quantity && q < upper) { upper = q; break; }
  }
  // Refine upper: find smallest defined qty > quantity
  for (const q of definedQtys) {
    if (q > quantity) { upper = q; break; }
  }

  const rateLower = countryRates[lower];
  const rateUpper = countryRates[upper];
  const interpolated = rateLower + (rateUpper - rateLower) * (quantity - lower) / (upper - lower);
  return Math.round(interpolated * 100) / 100;
}

// ── DB Setup ────────────────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS supplier_costs (
      sku TEXT PRIMARY KEY,
      product_type TEXT NOT NULL,
      unit_cost NUMERIC(10,2) NOT NULL,
      miner_count INT DEFAULT 0,
      slot_count INT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shipping_rates_mr (
      country TEXT NOT NULL,
      miner_count INT NOT NULL,
      rate NUMERIC(10,2) NOT NULL,
      PRIMARY KEY (country, miner_count)
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shipping_rates_rig (
      country TEXT NOT NULL,
      unit_count INT NOT NULL,
      rate NUMERIC(10,2) NOT NULL,
      PRIMARY KEY (country, unit_count)
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shopify_orders_cache (
      order_id BIGINT PRIMARY KEY,
      order_number INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      financial_status TEXT,
      fulfillment_status TEXT,
      total_price NUMERIC(10,2),
      subtotal_price NUMERIC(10,2),
      total_discounts NUMERIC(10,2) DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      country TEXT,
      customer_email TEXT,
      line_items JSONB,
      total_miners INT DEFAULT 0,
      total_rig_units INT DEFAULT 0,
      cogs NUMERIC(10,2) DEFAULT 0,
      shipping_cost NUMERIC(10,2) DEFAULT 0,
      gross_profit NUMERIC(10,2) DEFAULT 0,
      profit_margin NUMERIC(6,2) DEFAULT 0,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS daily_kpi_snapshots (
      snapshot_date DATE PRIMARY KEY,
      total_orders INT DEFAULT 0,
      total_revenue NUMERIC(12,2) DEFAULT 0,
      total_cogs NUMERIC(12,2) DEFAULT 0,
      total_shipping NUMERIC(12,2) DEFAULT 0,
      total_discounts NUMERIC(12,2) DEFAULT 0,
      gross_profit NUMERIC(12,2) DEFAULT 0,
      avg_order_value NUMERIC(10,2) DEFAULT 0,
      avg_profit_margin NUMERIC(6,2) DEFAULT 0,
      total_miners_sold INT DEFAULT 0,
      total_rigs_sold INT DEFAULT 0,
      top_sku TEXT,
      refund_count INT DEFAULT 0,
      computed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS kpi_alerts (
      id SERIAL PRIMARY KEY,
      alert_type TEXT NOT NULL,
      severity TEXT DEFAULT 'warning',
      message TEXT NOT NULL,
      metric_name TEXT,
      metric_value NUMERIC,
      threshold NUMERIC,
      snapshot_date DATE,
      acknowledged BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS whop_payment_fees (
      payment_id TEXT PRIMARY KEY,
      order_number INT,
      payment_amount NUMERIC,
      currency TEXT,
      total_fees NUMERIC,
      whop_fees NUMERIC,
      processing_fees NUMERIC,
      other_fees NUMERIC,
      lasso_fees NUMERIC DEFAULT 0,
      fee_details JSONB,
      paid_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgQuery('ALTER TABLE whop_payment_fees ADD COLUMN IF NOT EXISTS lasso_fees NUMERIC DEFAULT 0').catch(() => {});

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS lasso_revenue_shares (
      id SERIAL PRIMARY KEY,
      payment_id TEXT,
      amount NUMERIC,
      created_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  tablesReady = true;
}

async function seedStaticData() {
  // Seed supplier costs if empty
  const existing = await pgQuery('SELECT COUNT(*) as count FROM supplier_costs');
  if (parseInt(existing[0].count) === 0) {
    for (const [sku, count] of Object.entries(MR_MINER_COUNTS)) {
      await pgQuery(
        `INSERT INTO supplier_costs (sku, product_type, unit_cost, miner_count) VALUES ($1, 'MR', $2, $3) ON CONFLICT DO NOTHING`,
        [sku, UNIT_COST_PER_MINER, count]
      );
    }
    for (const [sku, cost] of Object.entries(RIG_UNIT_COSTS)) {
      await pgQuery(
        `INSERT INTO supplier_costs (sku, product_type, unit_cost, slot_count) VALUES ($1, 'RIG', $2, $3) ON CONFLICT DO NOTHING`,
        [sku, cost, RIG_SLOT_COUNTS[sku]]
      );
    }
  }

  // Seed MR shipping rates if empty
  const mrCount = await pgQuery('SELECT COUNT(*) as count FROM shipping_rates_mr');
  if (parseInt(mrCount[0].count) === 0) {
    for (const [country, rates] of Object.entries(SHIPPING_RATES_MR)) {
      for (const [count, rate] of Object.entries(rates)) {
        await pgQuery(
          `INSERT INTO shipping_rates_mr (country, miner_count, rate) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [country, parseInt(count), rate]
        );
      }
    }
  }

  // Seed RIG shipping rates if empty
  const rigCount = await pgQuery('SELECT COUNT(*) as count FROM shipping_rates_rig');
  if (parseInt(rigCount[0].count) === 0) {
    for (const [country, rates] of Object.entries(SHIPPING_RATES_RIG)) {
      for (const [count, rate] of Object.entries(rates)) {
        await pgQuery(
          `INSERT INTO shipping_rates_rig (country, unit_count, rate) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [country, parseInt(count), rate]
        );
      }
    }
  }
}

// ── Shopify API ─────────────────────────────────────────────────────
async function shopifyFetch(endpoint, params = {}) {
  const url = new URL(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
    },
  });

  const linkHeader = resp.headers.get('link');
  let nextUrl = null;
  if (linkHeader) {
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (match) nextUrl = match[1];
  }

  const data = await resp.json();
  return { data, nextUrl };
}

async function fetchAllOrders(sinceId = null, extraQueryStr = '') {
  const allOrders = [];
  const params = { limit: '250', status: 'any' };
  if (sinceId) params.since_id = sinceId.toString();
  // Parse extra query params like &created_at_min=...
  if (extraQueryStr) {
    const extra = new URLSearchParams(extraQueryStr.replace(/^&/, ''));
    for (const [k, v] of extra) params[k] = v;
  }

  let result = await shopifyFetch('orders.json', params);
  allOrders.push(...(result.data.orders || []));

  while (result.nextUrl) {
    const resp = await fetch(result.nextUrl, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
    });
    const linkHeader = resp.headers.get('link');
    let nextUrl = null;
    if (linkHeader) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (match) nextUrl = match[1];
    }
    const data = await resp.json();
    allOrders.push(...(data.orders || []));
    result = { data, nextUrl };
  }

  return allOrders;
}

// ── Cost Calculation ────────────────────────────────────────────────
function parseSku(sku, title, variantTitle) {
  // First try SKU-based matching (existing logic)
  if (sku) {
    const upper = sku.toUpperCase().trim();

    // Check for Bitaxe SKU
    if (upper === 'BX' || upper.startsWith('BX-')) {
      return { type: 'BITAXE', sku: 'BX', unitCost: BITAXE_UNIT_COST };
    }

    for (const [prefix, minerCount] of Object.entries(MR_MINER_COUNTS)) {
      if (upper === prefix || upper.startsWith(prefix + '-') || upper.startsWith(prefix)) {
        return { type: 'MR', sku: prefix, minerCount };
      }
    }

    for (const [rigSku, cost] of Object.entries(RIG_UNIT_COSTS)) {
      if (upper === rigSku || upper.startsWith(rigSku + '-') || upper.startsWith(rigSku)) {
        return { type: 'RIG', sku: rigSku, unitCost: cost, slotCount: RIG_SLOT_COUNTS[rigSku] };
      }
    }
  }

  // Fallback: title-based matching for older orders without SKUs
  if (!sku && title) {
    const lowerTitle = title.toLowerCase();

    // Check if it's a Bitaxe Gamma
    if (lowerTitle.includes('bitaxe')) {
      return { type: 'BITAXE', sku: 'BX', unitCost: BITAXE_UNIT_COST };
    }

    // Check if it's a Winner Pack (5 miners upsell)
    if (lowerTitle.includes('winner pack')) {
      return { type: 'MR', minerCount: 5, unitCost: null };
    }

    // Check if it's a Pro Package / MinerForge Pro Package (5, 8, or 15 miners)
    if (lowerTitle.includes('pro package')) {
      const combinedText = ((variantTitle || '') + ' ' + title).toLowerCase();
      let minerCount = 5; // default
      if (combinedText.includes('15')) minerCount = 15;
      else if (combinedText.includes('8')) minerCount = 8;
      else if (combinedText.includes('5')) minerCount = 5;
      return { type: 'MR', minerCount, unitCost: null };
    }

    // Check if it's a Miner product
    if (lowerTitle.includes('miner') && !lowerTitle.includes('rig') && !lowerTitle.includes('setup') && !lowerTitle.includes('verification')) {
      // Determine miner count from variant title or product title
      let minerCount = 1; // default
      const combinedText = ((variantTitle || '') + ' ' + title).toLowerCase();

      // Parse "X + Y Free" patterns first (e.g. "12 + 4 Free" = 16, "6 + 2 Free" = 8, "3 + 1 Free" = 4)
      const freeMatch = combinedText.match(/(\d+)\s*\+\s*(\d+)\s*free/i);
      if (freeMatch) {
        minerCount = parseInt(freeMatch[1]) + parseInt(freeMatch[2]);
      }
      else if (combinedText.includes('5 pack') || combinedText.includes('5-pack')) minerCount = 5;
      else if (combinedText.includes('4 pack') || combinedText.includes('4-pack') || combinedText.includes('4 miner')) minerCount = 4;
      else if (combinedText.includes('2 pack') || combinedText.includes('2-pack') || combinedText.includes('2 miner')) minerCount = 2;
      else if (variantTitle) {
        const match = variantTitle.match(/(\d+)\s*miner/i);
        if (match) {
          minerCount = parseInt(match[1]);
        } else {
          const numMatch = variantTitle.match(/(\d+)/);
          if (numMatch) {
            const num = parseInt(numMatch[1]);
            if ([1, 2, 4, 5, 8, 15, 16].includes(num)) minerCount = num;
          }
        }
      }

      return { type: 'MR', minerCount, unitCost: null };
    }

    // Check if it's a Mining Rig
    if (lowerTitle.includes('mining rig') || lowerTitle.includes('slot')) {
      let slotCount = 1; // default
      const combinedText = ((variantTitle || '') + ' ' + title).toLowerCase();

      if (combinedText.includes('4 slot')) slotCount = 4;
      else if (combinedText.includes('2 slot')) slotCount = 2;
      else if (combinedText.includes('1 slot')) slotCount = 1;
      else if (variantTitle) {
        const match = variantTitle.match(/(\d+)/);
        if (match) {
          const num = parseInt(match[1]);
          if ([1, 2, 4].includes(num)) slotCount = num;
        }
      }

      const rigKey = `RIG-${slotCount}`;
      const unitCost = RIG_UNIT_COSTS[rigKey] || RIG_UNIT_COSTS['RIG-1'];
      return { type: 'RIG', slotCount, unitCost };
    }
  }

  return null; // Unknown product
}

function calculateOrderCosts(order) {
  const lineItems = order.line_items || [];
  const country = order.shipping_address?.country || order.billing_address?.country || 'United States';

  // Determine which quotation to use based on order number
  const orderNumber = order.order_number || 0;
  let unitCostPerMiner;
  let mrShippingRates;

  if (orderNumber >= 6009) {
    unitCostPerMiner = UNIT_COST_PER_MINER; // 10.92
    mrShippingRates = SHIPPING_RATES_MR;
  } else if (orderNumber >= 5717) {
    unitCostPerMiner = UNIT_COST_PER_MINER; // 10.92 (price changed at 5717)
    mrShippingRates = SHIPPING_RATES_MR_2920; // but shipping stayed the same until 6009
  } else if (orderNumber >= 2920) {
    unitCostPerMiner = UNIT_COST_PER_MINER_2920; // 11.28
    mrShippingRates = SHIPPING_RATES_MR_2920;
  } else if (orderNumber >= 2722) {
    unitCostPerMiner = UNIT_COST_PER_MINER_2920; // 11.28 (orders #2722-#2919)
    mrShippingRates = SHIPPING_RATES_MR_2722;
  } else {
    unitCostPerMiner = UNIT_COST_PER_MINER_ORIGINAL; // 12.13 (orders before #2722)
    mrShippingRates = SHIPPING_RATES_MR_2722; // same shipping rates
  }

  let totalMiners = 0;
  let totalRigUnits = 0;
  let rigCogs = 0;
  let bitaxeCogs = 0;
  let bitaxeShipping = 0;
  let bitaxeUnits = 0;
  const skuBreakdown = [];

  const unrecognizedItems = [];

  for (const item of lineItems) {
    const parsed = parseSku(item.sku, item.title, item.variant_title);
    if (!parsed) {
      // Track unrecognized products (skip setup/verification/shipping/whop items)
      const title = (item.title || '').toLowerCase();
      if (title && !title.includes('setup') && !title.includes('verification') && !title.includes('shipping') && !title.includes('whop') && !title.includes('protection') && parseFloat(item.price || 0) > 0) {
        unrecognizedItems.push({ sku: item.sku, title: item.title, price: item.price, quantity: item.quantity });
      }
      continue;
    }

    if (parsed.type === 'MR') {
      const minersInLine = parsed.minerCount * (item.quantity || 1);
      totalMiners += minersInLine;
      skuBreakdown.push({ sku: parsed.sku || item.title, type: 'MR', quantity: item.quantity, miners: minersInLine });
    } else if (parsed.type === 'RIG') {
      const qty = item.quantity || 1;
      rigCogs += parsed.unitCost * qty;
      totalRigUnits += parsed.slotCount * qty;
      skuBreakdown.push({ sku: parsed.sku, type: 'RIG', quantity: qty, units: parsed.slotCount * qty });
    } else if (parsed.type === 'BITAXE') {
      const qty = item.quantity || 1;
      bitaxeCogs += BITAXE_UNIT_COST * qty;
      const shipRate = SHIPPING_RATES_BITAXE[country] || SHIPPING_RATES_BITAXE['United States'];
      bitaxeShipping += shipRate * qty;
      bitaxeUnits += qty;
      skuBreakdown.push({ sku: 'BX', type: 'BITAXE', quantity: qty });
    }
  }

  // MR COGS = total miners * unit cost (varies by quotation period)
  const mrCogs = totalMiners * unitCostPerMiner;

  // MR shipping lookup — country-specific, with interpolation for sparse rate tables
  let mrShipping = 0;
  if (totalMiners > 0) {
    const countryRates = mrShippingRates[country] || mrShippingRates['United States'];
    // Use interpolation for sparse tables (2920 quote) and direct lookup for dense tables (6009+ quote)
    if (mrShippingRates === SHIPPING_RATES_MR_2920 || mrShippingRates === SHIPPING_RATES_MR_2722) {
      mrShipping = interpolateRate(countryRates, totalMiners);
    } else {
      const maxDefined = Math.max(...Object.keys(countryRates).map(Number));
      if (totalMiners <= maxDefined) {
        mrShipping = countryRates[totalMiners] || countryRates[maxDefined] || 0;
      } else {
        // Extrapolate: use max rate + per-unit rate for additional miners
        const maxRate = countryRates[maxDefined];
        const prevRate = countryRates[maxDefined - 1] || maxRate;
        const perUnitRate = maxRate - prevRate; // incremental cost per miner
        mrShipping = Math.round((maxRate + perUnitRate * (totalMiners - maxDefined)) * 100) / 100;
      }
    }
  }

  // RIG shipping lookup — country-specific, scale linearly for quantities beyond defined rates
  let rigShipping = 0;
  if (totalRigUnits > 0) {
    const rigCountryRates = SHIPPING_RATES_RIG[country] || SHIPPING_RATES_RIG['United States'];
    if (rigCountryRates[totalRigUnits]) {
      rigShipping = rigCountryRates[totalRigUnits];
    } else {
      // For undefined slot counts, calculate proportionally using the per-slot rate from 4-slot
      const perSlotRate = rigCountryRates[4] / 4;
      rigShipping = Math.round(perSlotRate * totalRigUnits * 100) / 100;
    }
  }

  const totalCogs = mrCogs + rigCogs + bitaxeCogs;
  const totalShipping = mrShipping + rigShipping + bitaxeShipping;
  // Use subtotal_price (product revenue only, excludes customer-paid shipping)
  const revenue = parseFloat(order.subtotal_price || order.total_price || 0);
  const grossProfit = revenue - totalCogs - totalShipping;
  const profitMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  return {
    totalMiners,
    totalRigUnits,
    cogs: Math.round(totalCogs * 100) / 100,
    shippingCost: Math.round(totalShipping * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100,
    profitMargin: Math.round(profitMargin * 100) / 100,
    skuBreakdown,
    unrecognizedItems,
  };
}

// ── Anomaly Detection ───────────────────────────────────────────────
async function runAnomalyDetection(snapshotDate) {
  // Get the last 14 days of snapshots for baseline
  const history = await pgQuery(`
    SELECT * FROM daily_kpi_snapshots
    WHERE snapshot_date < $1
    ORDER BY snapshot_date DESC
    LIMIT 14
  `, [snapshotDate]);

  if (history.length < 3) return; // Not enough data

  const today = await pgQuery(
    'SELECT * FROM daily_kpi_snapshots WHERE snapshot_date = $1',
    [snapshotDate]
  );
  if (today.length === 0) return;
  const snap = today[0];

  const avgRevenue = history.reduce((s, h) => s + parseFloat(h.total_revenue), 0) / history.length;
  const avgOrders = history.reduce((s, h) => s + parseInt(h.total_orders), 0) / history.length;
  const avgMargin = history.reduce((s, h) => s + parseFloat(h.avg_profit_margin), 0) / history.length;

  const alerts = [];

  // Revenue drop > 50%
  if (avgRevenue > 0 && parseFloat(snap.total_revenue) < avgRevenue * 0.5) {
    alerts.push({
      type: 'revenue_drop',
      severity: 'critical',
      message: `Revenue dropped to $${snap.total_revenue} (avg: $${avgRevenue.toFixed(2)})`,
      metric: 'total_revenue',
      value: parseFloat(snap.total_revenue),
      threshold: avgRevenue * 0.5,
    });
  }

  // Revenue spike > 200%
  if (avgRevenue > 0 && parseFloat(snap.total_revenue) > avgRevenue * 2) {
    alerts.push({
      type: 'revenue_spike',
      severity: 'info',
      message: `Revenue spiked to $${snap.total_revenue} (avg: $${avgRevenue.toFixed(2)})`,
      metric: 'total_revenue',
      value: parseFloat(snap.total_revenue),
      threshold: avgRevenue * 2,
    });
  }

  // Order count drop > 60%
  if (avgOrders > 0 && parseInt(snap.total_orders) < avgOrders * 0.4) {
    alerts.push({
      type: 'order_drop',
      severity: 'warning',
      message: `Orders dropped to ${snap.total_orders} (avg: ${avgOrders.toFixed(1)})`,
      metric: 'total_orders',
      value: parseInt(snap.total_orders),
      threshold: avgOrders * 0.4,
    });
  }

  // Margin below 20%
  if (parseFloat(snap.avg_profit_margin) < 20 && parseInt(snap.total_orders) > 0) {
    alerts.push({
      type: 'low_margin',
      severity: 'warning',
      message: `Profit margin at ${snap.avg_profit_margin}% (below 20% threshold)`,
      metric: 'avg_profit_margin',
      value: parseFloat(snap.avg_profit_margin),
      threshold: 20,
    });
  }

  // Margin shift > 15 points from average
  if (Math.abs(parseFloat(snap.avg_profit_margin) - avgMargin) > 15 && parseInt(snap.total_orders) > 0) {
    alerts.push({
      type: 'margin_shift',
      severity: 'warning',
      message: `Profit margin shifted to ${snap.avg_profit_margin}% (avg: ${avgMargin.toFixed(1)}%)`,
      metric: 'avg_profit_margin',
      value: parseFloat(snap.avg_profit_margin),
      threshold: avgMargin,
    });
  }

  for (const alert of alerts) {
    await pgQuery(`
      INSERT INTO kpi_alerts (alert_type, severity, message, metric_name, metric_value, threshold, snapshot_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [alert.type, alert.severity, alert.message, alert.metric, alert.value, alert.threshold, snapshotDate]);
  }
}

// ── Snapshot Recalculation ──────────────────────────────────────────
async function recalculateSnapshots(startDate, endDate) {
  let dates;
  if (startDate && endDate) {
    dates = await pgQuery(`
      SELECT DISTINCT DATE(created_at AT TIME ZONE 'Europe/Berlin') as d
      FROM shopify_orders_cache
      WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
      ORDER BY d
    `, [startDate, endDate]);
  } else if (startDate) {
    dates = await pgQuery(`
      SELECT DISTINCT DATE(created_at AT TIME ZONE 'Europe/Berlin') as d
      FROM shopify_orders_cache
      WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1
      ORDER BY d
    `, [startDate]);
  } else {
    dates = await pgQuery(`
      SELECT DISTINCT DATE(created_at AT TIME ZONE 'Europe/Berlin') as d
      FROM shopify_orders_cache
      ORDER BY d
    `);
  }

  for (const row of dates) {
    const d = row.d;
    const allOrders = await pgQuery(`
      SELECT * FROM shopify_orders_cache WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1
    `, [d]);

    if (allOrders.length === 0) continue;

    // Filter out refunded/voided/cancelled orders from revenue calculations
    const orders = allOrders.filter(o => !['refunded', 'voided'].includes(o.financial_status));
    const refundedOrders = allOrders.filter(o => ['refunded', 'voided'].includes(o.financial_status));

    // Use subtotal_price (product revenue, excludes customer-paid shipping)
    const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.subtotal_price || o.total_price || 0), 0);
    const totalCogs = orders.reduce((s, o) => s + parseFloat(o.cogs || 0), 0);
    const totalShipping = orders.reduce((s, o) => s + parseFloat(o.shipping_cost || 0), 0);
    const totalDiscounts = orders.reduce((s, o) => s + parseFloat(o.total_discounts || 0), 0);
    const grossProfit = totalRevenue - totalCogs - totalShipping;
    const avgOv = orders.length > 0 ? totalRevenue / orders.length : 0;
    const avgMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const totalMiners = orders.reduce((s, o) => s + (parseInt(o.total_miners) || 0), 0);
    const totalRigs = orders.reduce((s, o) => s + (parseInt(o.total_rig_units) || 0), 0);
    const refunds = refundedOrders.length;

    // Find top SKU
    const skuCounts = {};
    for (const o of orders) {
      const items = typeof o.line_items === 'string' ? JSON.parse(o.line_items) : (o.line_items || []);
      for (const item of items) {
        if (item.sku) {
          skuCounts[item.sku] = (skuCounts[item.sku] || 0) + (item.quantity || 1);
        }
      }
    }
    const topSku = Object.entries(skuCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    await pgQuery(`
      INSERT INTO daily_kpi_snapshots (
        snapshot_date, total_orders, total_revenue, total_cogs, total_shipping,
        total_discounts, gross_profit, avg_order_value, avg_profit_margin,
        total_miners_sold, total_rigs_sold, top_sku, refund_count, computed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (snapshot_date) DO UPDATE SET
        total_orders = EXCLUDED.total_orders,
        total_revenue = EXCLUDED.total_revenue,
        total_cogs = EXCLUDED.total_cogs,
        total_shipping = EXCLUDED.total_shipping,
        total_discounts = EXCLUDED.total_discounts,
        gross_profit = EXCLUDED.gross_profit,
        avg_order_value = EXCLUDED.avg_order_value,
        avg_profit_margin = EXCLUDED.avg_profit_margin,
        total_miners_sold = EXCLUDED.total_miners_sold,
        total_rigs_sold = EXCLUDED.total_rigs_sold,
        top_sku = EXCLUDED.top_sku,
        refund_count = EXCLUDED.refund_count,
        computed_at = NOW()
    `, [
      d, orders.length,
      Math.round(totalRevenue * 100) / 100,
      Math.round(totalCogs * 100) / 100,
      Math.round(totalShipping * 100) / 100,
      Math.round(totalDiscounts * 100) / 100,
      Math.round(grossProfit * 100) / 100,
      Math.round(avgOv * 100) / 100,
      Math.round(avgMargin * 100) / 100,
      totalMiners, totalRigs, topSku, refunds,
    ]);

    await runAnomalyDetection(d);
  }
}

// ── Period Helpers ───────────────────────────────────────────────────
function getPeriodRange(period, dateStr) {
  const date = new Date(dateStr + 'T00:00:00Z');
  let start, end;

  if (period === 'daily') {
    start = dateStr;
    end = dateStr;
  } else if (period === 'weekly') {
    const day = date.getUTCDay();
    const diff = day === 0 ? 6 : day - 1; // Monday start
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - diff);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    start = monday.toISOString().slice(0, 10);
    end = sunday.toISOString().slice(0, 10);
  } else if (period === 'monthly') {
    start = dateStr.slice(0, 7) + '-01';
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    end = dateStr.slice(0, 7) + '-' + String(lastDay).padStart(2, '0');
  } else {
    start = dateStr;
    end = dateStr;
  }

  return { start, end };
}

// ── Whop Fee Sync ───────────────────────────────────────────────────
async function fetchPaymentFees(paymentId, paymentAmount = 0) {
  if (!WHOP_API_TOKEN) return null;
  try {
    const resp = await fetch(`${WHOP_API_URL}/v1/payments/${paymentId}/fees`, {
      headers: { 'Authorization': `Bearer ${WHOP_API_TOKEN}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const fees = data.data || [];

    let whopFees = 0;
    let processingFees = 0;
    let otherFees = 0;

    for (const fee of fees) {
      const amount = fee.amount || 0;
      if (['whop_processing_fee', 'orchestration_percentage_fee'].includes(fee.type)) {
        whopFees += amount;
      } else if (['payment_processing_percentage_fee', 'payment_processing_fixed_fee', 'stripe_radar_fee', '3d_secure_fee', 'cross_border_percentage_fee', 'fx_percentage_fee'].includes(fee.type)) {
        processingFees += amount;
      } else {
        otherFees += amount;
      }
    }

    // Add Lasso fee (1% of payment amount) — charged as revenue share, not in per-payment fees
    const lassoFee = Math.round(paymentAmount * 0.01 * 100) / 100;

    return {
      totalFees: whopFees + processingFees + otherFees + lassoFee,
      whopFees,
      processingFees,
      otherFees,
      lassoFees: lassoFee,
      feeDetails: [...fees, { name: 'Lasso CRM fee (1%)', amount: lassoFee, type: 'lasso_percentage_fee' }],
    };
  } catch (err) {
    console.error(`[KPI] Error fetching fees for ${paymentId}:`, err.message);
    return null;
  }
}

async function syncWhopFees(lookbackDays = 3) {
  if (!WHOP_API_TOKEN) return { synced: 0 };

  try {
    await ensureTables();
    const cutoffTs = Math.floor((Date.now() - lookbackDays * 86400000) / 1000);

    // Whop API returns oldest-first and date filters don't work reliably.
    // Strategy: start from LAST page (newest payments) and work backwards.
    const firstResp = await fetch(`${WHOP_API_URL}/v5/company/payments?per=100&page=1`, {
      headers: { 'Authorization': `Bearer ${WHOP_API_TOKEN}` }
    });
    if (!firstResp.ok) return { synced: 0, error: 'Failed to fetch payments' };
    const firstData = await firstResp.json();
    const totalPages = firstData.pagination?.total_pages || 1;

    let synced = 0;
    const maxPages = Math.min(lookbackDays * 3, 30); // ~3 pages per day, cap at 30

    // Iterate from last page backwards (newest to oldest)
    for (let page = totalPages; page >= Math.max(1, totalPages - maxPages); page--) {
      const resp = await fetch(`${WHOP_API_URL}/v5/company/payments?per=100&page=${page}`, {
        headers: { 'Authorization': `Bearer ${WHOP_API_TOKEN}` }
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const payments = data.data || [];

      for (const payment of payments) {
        // Skip unpaid/open payments
        if (!payment.paid_at || payment.status !== 'paid') continue;

        // Skip if before the lookback window (but don't break — page has mixed ordering)
        if (payment.created_at < cutoffTs) continue;

        // Check if already synced
        const existing = await pgQuery('SELECT payment_id FROM whop_payment_fees WHERE payment_id = $1', [payment.id]);
        if (existing.length > 0) continue;

        // Fetch fee breakdown (pass amount for Lasso 1% calculation)
        const fees = await fetchPaymentFees(payment.id, payment.final_amount || 0);
        if (!fees) continue;

        const paidAt = new Date(payment.paid_at * 1000).toISOString();
        await pgQuery(`
          INSERT INTO whop_payment_fees (payment_id, payment_amount, currency, total_fees, whop_fees, processing_fees, other_fees, lasso_fees, fee_details, paid_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (payment_id) DO UPDATE SET
            total_fees=EXCLUDED.total_fees, whop_fees=EXCLUDED.whop_fees, processing_fees=EXCLUDED.processing_fees,
            other_fees=EXCLUDED.other_fees, lasso_fees=EXCLUDED.lasso_fees, fee_details=EXCLUDED.fee_details, synced_at=NOW()
        `, [payment.id, payment.final_amount, payment.currency, fees.totalFees, fees.whopFees, fees.processingFees, fees.otherFees, fees.lassoFees, JSON.stringify(fees.feeDetails), paidAt]);

        synced++;
        if (synced % 10 === 0) await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[KPI] Whop fees synced: ${synced} payments`);
    return { synced };
  } catch (err) {
    console.error('[KPI] Whop fee sync error:', err.message);
    return { synced: 0, error: err.message };
  }
}

// ── Routes ──────────────────────────────────────────────────────────

/** POST /sync — Pull Shopify orders, calculate costs, store KPIs */
router.post('/sync', authenticate, async (req, res) => {
  try {
    if (!SHOPIFY_TOKEN) {
      return res.status(400).json({ success: false, error: { message: 'SHOPIFY_ACCESS_TOKEN not configured' } });
    }

    await ensureTables();
    await seedStaticData();

    const fullSync = req.query.full === 'true' || (req.body && req.body.full === true);
    if (fullSync) {
      await pgQuery('DELETE FROM shopify_orders_cache');
      await pgQuery('DELETE FROM daily_kpi_snapshots');
      await pgQuery('DELETE FROM whop_payment_fees');
      console.log('[KPI] Full re-sync: cleared cache');
    }

    // Incremental sync: fetch new orders + re-fetch recent orders (last 3 days) to catch status changes
    const lastSynced = await pgQuery('SELECT MAX(order_id) as max_id FROM shopify_orders_cache');
    const sinceId = fullSync ? null : (lastSynced[0]?.max_id || null);

    // Fetch new orders
    const newOrders = await fetchAllOrders(sinceId);

    // Also re-fetch orders from last 3 days to catch refunds/status changes
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const recentOrders = fullSync ? [] : await fetchAllOrders(null, `&created_at_min=${threeDaysAgo}`);

    // Merge: use Map to deduplicate by order ID
    const orderMap = new Map();
    for (const o of [...newOrders, ...recentOrders]) {
      orderMap.set(o.id, o);
    }
    const orders = Array.from(orderMap.values());
    const eligible = orders.filter(o => (o.order_number || 0) >= MIN_ORDER_NUMBER);

    let synced = 0;
    let skipped = 0;

    for (const order of eligible) {
      const costs = calculateOrderCosts(order);

      await pgQuery(`
        INSERT INTO shopify_orders_cache (
          order_id, order_number, created_at, financial_status, fulfillment_status,
          total_price, subtotal_price, total_discounts, currency, country,
          customer_email, line_items, total_miners, total_rig_units,
          cogs, shipping_cost, gross_profit, profit_margin, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (order_id) DO UPDATE SET
          financial_status = EXCLUDED.financial_status,
          fulfillment_status = EXCLUDED.fulfillment_status,
          total_price = EXCLUDED.total_price,
          subtotal_price = EXCLUDED.subtotal_price,
          total_discounts = EXCLUDED.total_discounts,
          line_items = EXCLUDED.line_items,
          total_miners = EXCLUDED.total_miners,
          total_rig_units = EXCLUDED.total_rig_units,
          cogs = EXCLUDED.cogs,
          shipping_cost = EXCLUDED.shipping_cost,
          gross_profit = EXCLUDED.gross_profit,
          profit_margin = EXCLUDED.profit_margin,
          synced_at = NOW()
      `, [
        order.id,
        order.order_number,
        order.created_at,
        order.financial_status,
        order.fulfillment_status,
        parseFloat(order.total_price || 0),
        parseFloat(order.subtotal_price || 0),
        parseFloat(order.total_discounts || 0),
        order.currency || 'USD',
        order.shipping_address?.country || order.billing_address?.country || 'Unknown',
        order.customer?.email || order.email || null,
        JSON.stringify(order.line_items || []),
        costs.totalMiners,
        costs.totalRigUnits,
        costs.cogs,
        costs.shippingCost,
        costs.grossProfit,
        costs.profitMargin,
      ]);
      synced++;
    }

    skipped = orders.length - eligible.length;

    // Recalculate daily snapshots
    await recalculateSnapshots();

    // Sync Whop payment fees (30 days for full sync, 3 days for incremental)
    const feeResult = await syncWhopFees(fullSync ? 30 : 3).catch(err => {
      console.error('[KPI] Fee sync error:', err.message);
      return { synced: 0, error: err.message };
    });

    const totalOrders = await pgQuery('SELECT COUNT(*) as count FROM shopify_orders_cache');

    res.json({
      success: true,
      data: {
        fetched: orders.length,
        synced,
        skipped,
        totalCached: parseInt(totalOrders[0].count),
        incremental: !!sinceId,
        feesSynced: feeResult.synced || 0,
      },
    });
  } catch (err) {
    console.error('[KPI Sync] Error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /home-dashboard — Main dashboard overview with sparklines + day-over-day comparison */
router.get('/home-dashboard', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const dateStr = req.query.date || new Date().toISOString().slice(0, 10);

    // 8-day window: selected date + 7 previous days
    const endDate = dateStr;
    const sd = new Date(dateStr + 'T00:00:00Z');
    sd.setUTCDate(sd.getUTCDate() - 7);
    const startDate = sd.toISOString().slice(0, 10);

    // Parallel: snapshots, fees, ad spend
    const [snapshots, feeRows, adSpendRows] = await Promise.all([
      pgQuery(`SELECT * FROM daily_kpi_snapshots WHERE snapshot_date BETWEEN $1 AND $2 ORDER BY snapshot_date`, [startDate, endDate]),
      pgQuery(`SELECT DATE(paid_at AT TIME ZONE 'Europe/Berlin') as fee_date, COALESCE(SUM(total_fees),0) as total_fees, COALESCE(SUM(whop_fees),0) as whop_fees, COALESCE(SUM(processing_fees),0) as processing_fees, COALESCE(SUM(other_fees),0) as other_fees, COALESCE(SUM(lasso_fees),0) as lasso_fees FROM whop_payment_fees WHERE DATE(paid_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2 GROUP BY DATE(paid_at AT TIME ZONE 'Europe/Berlin') ORDER BY fee_date`, [startDate, endDate]),
      fetchDailyAdSpend(startDate, endDate),
    ]);

    // Build fee lookup by date
    const feeLookup = {};
    for (const r of feeRows) {
      const d = typeof r.fee_date === 'string' ? r.fee_date.slice(0, 10) : new Date(r.fee_date).toISOString().slice(0, 10);
      feeLookup[d] = parseFloat(r.total_fees || 0);
    }

    // Build ad spend lookup by date
    const spendLookup = {};
    for (const r of adSpendRows) {
      spendLookup[r.date] = r.spend;
    }

    // Build snapshot lookup by date
    const snapLookup = {};
    for (const s of snapshots) {
      const d = typeof s.snapshot_date === 'string' ? s.snapshot_date.slice(0, 10) : new Date(s.snapshot_date).toISOString().slice(0, 10);
      snapLookup[d] = s;
    }

    // Fetch Shopify online store sessions for conversion rate
    const sessionLookup = {};
    try {
      if (SHOPIFY_TOKEN) {
        // Shopify Analytics API - get daily sessions
        const analyticsRes = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/reports.json`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }, signal: AbortSignal.timeout(10000) }
        ).catch(() => null);
        // Fallback: use orders count from cache to estimate (Shopify Analytics API may not be available)
        // Try the REST approach for visitor data
        if (!analyticsRes || !analyticsRes.ok) {
          // Use GraphQL to get online store sessions
          const gqlBody = JSON.stringify({
            query: `{
              shopifyqlQuery(query: "FROM visits SHOW sum(visitor_count) AS sessions GROUP BY day SINCE ${startDate} UNTIL ${endDate} ORDER BY day") {
                __typename
                ... on TableResponse {
                  tableData { rowData columns { name dataType } }
                }
              }
            }`
          });
          const gqlRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: 'POST',
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
            body: gqlBody,
            signal: AbortSignal.timeout(10000),
          }).catch(() => null);
          if (gqlRes && gqlRes.ok) {
            const gqlData = await gqlRes.json();
            const tableData = gqlData?.data?.shopifyqlQuery?.tableData;
            if (tableData?.rowData) {
              const cols = tableData.columns?.map(c => c.name) || [];
              const dayIdx = cols.findIndex(c => c === 'day');
              const sessIdx = cols.findIndex(c => c === 'sessions');
              if (dayIdx >= 0 && sessIdx >= 0) {
                for (const row of tableData.rowData) {
                  const d = row[dayIdx]?.slice(0, 10);
                  if (d) sessionLookup[d] = parseInt(row[sessIdx] || 0);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[KPI] sessions fetch failed:', err.message);
    }

    // Helper: build metrics object for a date
    function metricsForDate(d) {
      const s = snapLookup[d];
      const revenue = s ? parseFloat(s.total_revenue || 0) : 0;
      const cogs = s ? parseFloat(s.total_cogs || 0) : 0;
      const shipping = s ? parseFloat(s.total_shipping || 0) : 0;
      const fees = feeLookup[d] || 0;
      const orders = s ? parseInt(s.total_orders || 0) : 0;
      const adSpend = spendLookup[d] || 0;
      const costs = cogs + shipping + fees + adSpend; // Include ad spend in total costs
      const profit = revenue - costs;
      const netMargin = revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0;
      const aov = orders > 0 ? Math.round((revenue / orders) * 100) / 100 : 0;
      const roas = adSpend > 0 ? Math.round((revenue / adSpend) * 100) / 100 : 0;
      const sessions = sessionLookup[d] || null;
      const conversionRate = (sessions && sessions > 0 && orders > 0) ? Math.round((orders / sessions) * 10000) / 100 : null;
      return { date: d, revenue, adSpend, roas, orders, aov, costs, cogs, shipping, fees, profit, netMargin, conversionRate };
    }

    // Build sparklines for all 8 days (fill gaps with zeros)
    const allDays = [];
    for (let i = 0; i <= 7; i++) {
      const dt = new Date(startDate + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + i);
      allDays.push(dt.toISOString().slice(0, 10));
    }
    const dailyMetrics = allDays.map(d => metricsForDate(d));

    // Current = exact match for selected date
    const current = dailyMetrics.find(m => m.date === dateStr) || null;

    // Previous = day before selected date
    const prevDate = new Date(dateStr + 'T00:00:00Z');
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    const prevDateStr = prevDate.toISOString().slice(0, 10);
    const previous = dailyMetrics.find(m => m.date === prevDateStr) || null;

    // Sparklines = last 7 entries (excluding today for a clean trailing view)
    const sparklines = dailyMetrics.slice(0, 7);

    res.json({
      success: true,
      data: { current, previous, sparklines },
    });
  } catch (err) {
    console.error('[KPI] home-dashboard error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /dashboard — Aggregated KPIs for a period */
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { period = 'daily', date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required (YYYY-MM-DD)' } });

    const { start, end } = getPeriodRange(period, date);

    const snapshots = await pgQuery(`
      SELECT * FROM daily_kpi_snapshots
      WHERE snapshot_date BETWEEN $1 AND $2
      ORDER BY snapshot_date
    `, [start, end]);

    if (snapshots.length === 0) {
      return res.json({
        success: true,
        data: {
          period, start, end,
          totalOrders: 0, totalRevenue: 0, totalCogs: 0, totalShipping: 0,
          totalDiscounts: 0, grossProfit: 0, avgOrderValue: 0, avgProfitMargin: 0,
          totalMinersSold: 0, totalRigsSold: 0, refundCount: 0, topSku: null,
          days: [],
        },
      });
    }

    const agg = {
      totalOrders: snapshots.reduce((s, r) => s + parseInt(r.total_orders), 0),
      totalRevenue: snapshots.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
      totalCogs: snapshots.reduce((s, r) => s + parseFloat(r.total_cogs), 0),
      totalShipping: snapshots.reduce((s, r) => s + parseFloat(r.total_shipping), 0),
      totalDiscounts: snapshots.reduce((s, r) => s + parseFloat(r.total_discounts), 0),
      grossProfit: snapshots.reduce((s, r) => s + parseFloat(r.gross_profit), 0),
      totalMinersSold: snapshots.reduce((s, r) => s + parseInt(r.total_miners_sold || 0), 0),
      totalRigsSold: snapshots.reduce((s, r) => s + parseInt(r.total_rigs_sold || 0), 0),
      refundCount: snapshots.reduce((s, r) => s + parseInt(r.refund_count || 0), 0),
    };
    agg.avgOrderValue = agg.totalOrders > 0 ? Math.round((agg.totalRevenue / agg.totalOrders) * 100) / 100 : 0;
    agg.avgProfitMargin = agg.totalRevenue > 0 ? Math.round((agg.grossProfit / agg.totalRevenue) * 10000) / 100 : 0;

    // Query Whop payment fees for the period
    const feeRows = await pgQuery(`
      SELECT
        COALESCE(SUM(total_fees), 0) as total_fees,
        COALESCE(SUM(whop_fees), 0) as whop_fees,
        COALESCE(SUM(processing_fees), 0) as processing_fees,
        COALESCE(SUM(other_fees), 0) as other_fees,
        COALESCE(SUM(lasso_fees), 0) as lasso_fees,
        COUNT(*) as fee_count
      FROM whop_payment_fees
      WHERE DATE(paid_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
    `, [start, end]);

    const totalFees = parseFloat(feeRows[0]?.total_fees || 0);
    const whopFees = parseFloat(feeRows[0]?.whop_fees || 0);
    const processingFees = parseFloat(feeRows[0]?.processing_fees || 0);
    const otherFees = parseFloat(feeRows[0]?.other_fees || 0);
    const lassoFees = parseFloat(feeRows[0]?.lasso_fees || 0);

    // Subtract fees from gross profit
    agg.grossProfit = agg.totalRevenue - agg.totalCogs - agg.totalShipping - totalFees;
    agg.avgProfitMargin = agg.totalRevenue > 0 ? Math.round((agg.grossProfit / agg.totalRevenue) * 10000) / 100 : 0;

    // Find overall top SKU from the period's snapshots
    const skuFreq = {};
    for (const s of snapshots) {
      if (s.top_sku) skuFreq[s.top_sku] = (skuFreq[s.top_sku] || 0) + 1;
    }
    const topSku = Object.entries(skuFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    res.json({
      success: true,
      data: {
        period, start, end,
        ...agg,
        totalFees: Math.round(totalFees * 100) / 100,
        whopFees: Math.round(whopFees * 100) / 100,
        processingFees: Math.round(processingFees * 100) / 100,
        otherFees: Math.round(otherFees * 100) / 100,
        lassoFees: Math.round(lassoFees * 100) / 100,
        topSku,
        days: snapshots.map(s => ({
          date: s.snapshot_date,
          orders: parseInt(s.total_orders),
          revenue: parseFloat(s.total_revenue),
          cogs: parseFloat(s.total_cogs),
          shipping: parseFloat(s.total_shipping),
          grossProfit: parseFloat(s.gross_profit),
          margin: parseFloat(s.avg_profit_margin),
          minersSold: parseInt(s.total_miners_sold || 0),
          rigsSold: parseInt(s.total_rigs_sold || 0),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Shared cost-sheet helper (used by authenticated + public endpoints) ──
async function buildCostSheet(period, date) {
  await ensureTables();
  const { start, end } = getPeriodRange(period, date);

  const orders = await pgQuery(`
    SELECT order_number, created_at, total_price, subtotal_price, cogs, shipping_cost,
           gross_profit, profit_margin, total_miners, total_rig_units,
           line_items, country, financial_status
    FROM shopify_orders_cache
    WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
      AND financial_status NOT IN ('refunded', 'voided')
    ORDER BY created_at DESC
  `, [start, end]);

  const summary = {
    totalOrders: orders.length,
    totalRevenue: orders.reduce((s, o) => s + parseFloat(o.subtotal_price || o.total_price), 0),
    totalCogs: orders.reduce((s, o) => s + parseFloat(o.cogs), 0),
    totalShipping: orders.reduce((s, o) => s + parseFloat(o.shipping_cost), 0),
    totalGrossProfit: orders.reduce((s, o) => s + parseFloat(o.gross_profit), 0),
  };
  summary.overallMargin = summary.totalRevenue > 0
    ? Math.round((summary.totalGrossProfit / summary.totalRevenue) * 10000) / 100
    : 0;

  return {
    period, start, end,
    summary,
    orders: orders.map(o => ({
      orderNumber: o.order_number,
      date: o.created_at,
      revenue: parseFloat(o.subtotal_price || o.total_price),
      cogs: parseFloat(o.cogs),
      shipping: parseFloat(o.shipping_cost),
      grossProfit: parseFloat(o.gross_profit),
      margin: parseFloat(o.profit_margin),
      miners: parseInt(o.total_miners),
      rigs: parseInt(o.total_rig_units),
      country: o.country,
      status: o.financial_status,
    })),
  };
}

/** GET /cost-sheet — Detailed cost breakdown for a period */
router.get('/cost-sheet', authenticate, async (req, res) => {
  try {
    const { period = 'daily', date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required' } });
    const data = await buildCostSheet(period, date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /share-token — Return the supplier share token (authenticated) */
router.get('/share-token', authenticate, (req, res) => {
  const token = process.env.SUPPLIER_SHARE_TOKEN || '';
  if (!token) return res.status(404).json({ success: false, error: { message: 'Share token not configured' } });
  res.json({ success: true, data: { token } });
});

/** GET /public/cost-sheet — Public supplier cost sheet (token-based auth) */
router.get('/public/cost-sheet', async (req, res) => {
  try {
    const { token, period, date } = req.query;

    if (!token || !SUPPLIER_SHARE_TOKEN || token !== SUPPLIER_SHARE_TOKEN) {
      return res.status(403).json({ success: false, error: { message: 'Invalid or missing share token' } });
    }
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required' } });

    const data = await buildCostSheet(period || 'daily', date);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /trends — Revenue/profit/order trends over N days */
router.get('/trends', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const days = parseInt(req.query.days) || 30;

    const snapshots = await pgQuery(`
      SELECT * FROM daily_kpi_snapshots
      ORDER BY snapshot_date DESC
      LIMIT $1
    `, [days]);

    const sorted = snapshots.reverse();

    // Compute moving averages (7-day)
    const withMa = sorted.map((s, i) => {
      const window = sorted.slice(Math.max(0, i - 6), i + 1);
      return {
        date: s.snapshot_date,
        orders: parseInt(s.total_orders),
        revenue: parseFloat(s.total_revenue),
        cogs: parseFloat(s.total_cogs),
        shipping: parseFloat(s.total_shipping),
        grossProfit: parseFloat(s.gross_profit),
        margin: parseFloat(s.avg_profit_margin),
        minersSold: parseInt(s.total_miners_sold || 0),
        rigsSold: parseInt(s.total_rigs_sold || 0),
        aov: parseFloat(s.avg_order_value),
        ma7Revenue: Math.round(window.reduce((s2, w) => s2 + parseFloat(w.total_revenue), 0) / window.length * 100) / 100,
        ma7Orders: Math.round(window.reduce((s2, w) => s2 + parseInt(w.total_orders), 0) / window.length * 10) / 10,
        ma7Margin: Math.round(window.reduce((s2, w) => s2 + parseFloat(w.avg_profit_margin), 0) / window.length * 100) / 100,
      };
    });

    // Period-over-period comparison
    const currentPeriod = sorted.slice(-Math.min(days, sorted.length));
    const priorPeriod = sorted.slice(0, Math.max(0, sorted.length - days));

    const current = {
      revenue: currentPeriod.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
      orders: currentPeriod.reduce((s, r) => s + parseInt(r.total_orders), 0),
    };
    const prior = {
      revenue: priorPeriod.reduce((s, r) => s + parseFloat(r.total_revenue), 0),
      orders: priorPeriod.reduce((s, r) => s + parseInt(r.total_orders), 0),
    };

    res.json({
      success: true,
      data: {
        days,
        dataPoints: withMa,
        comparison: {
          revenueChange: prior.revenue > 0
            ? Math.round(((current.revenue - prior.revenue) / prior.revenue) * 10000) / 100
            : null,
          orderChange: prior.orders > 0
            ? Math.round(((current.orders - prior.orders) / prior.orders) * 10000) / 100
            : null,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /sku-breakdown — Sales breakdown by SKU for a date range */
router.get('/sku-breakdown', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: { message: 'startDate and endDate are required' } });
    }

    const orders = await pgQuery(`
      SELECT line_items, total_price, cogs, shipping_cost, gross_profit
      FROM shopify_orders_cache
      WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
    `, [startDate, endDate]);

    const skuData = {};

    for (const order of orders) {
      const items = typeof order.line_items === 'string' ? JSON.parse(order.line_items) : (order.line_items || []);
      for (const item of items) {
        const sku = item.sku || 'UNKNOWN';
        if (!skuData[sku]) {
          skuData[sku] = { sku, unitsSold: 0, revenue: 0, cogs: 0, orderCount: 0, title: item.title || sku };
        }
        const qty = item.quantity || 1;
        skuData[sku].unitsSold += qty;
        skuData[sku].revenue += parseFloat(item.price || 0) * qty;
        skuData[sku].orderCount++;

        // Calculate COGS per SKU
        const parsed = parseSku(item.sku, item.title, item.variant_title);
        if (parsed && parsed.type === 'MR') {
          skuData[sku].cogs += UNIT_COST_PER_MINER * parsed.minerCount * qty;
        } else if (parsed && parsed.type === 'RIG') {
          skuData[sku].cogs += parsed.unitCost * qty;
        }
      }
    }

    const breakdown = Object.values(skuData).sort((a, b) => b.revenue - a.revenue);
    const totalRevenue = breakdown.reduce((s, b) => s + b.revenue, 0);

    res.json({
      success: true,
      data: {
        startDate, endDate,
        totalSkus: breakdown.length,
        breakdown: breakdown.map(b => {
          const profit = b.revenue - b.cogs;
          const margin = b.revenue > 0 ? (profit / b.revenue) * 100 : 0;
          return {
            ...b,
            revenue: Math.round(b.revenue * 100) / 100,
            cogs: Math.round(b.cogs * 100) / 100,
            profit: Math.round(profit * 100) / 100,
            margin: Math.round(margin * 100) / 100,
            revenueShare: totalRevenue > 0 ? Math.round((b.revenue / totalRevenue) * 10000) / 100 : 0,
          };
        }),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /alerts — Recent anomaly alerts */
router.get('/alerts', authenticate, async (req, res) => {
  try {
    await ensureTables();

    const alerts = await pgQuery(`
      SELECT * FROM kpi_alerts
      ORDER BY created_at DESC
      LIMIT 50
    `);

    const unacknowledged = alerts.filter(a => !a.acknowledged).length;

    res.json({
      success: true,
      data: {
        total: alerts.length,
        unacknowledged,
        alerts: alerts.map(a => ({
          id: a.id,
          type: a.alert_type,
          severity: a.severity,
          message: a.message,
          metric: a.metric_name,
          value: a.metric_value ? parseFloat(a.metric_value) : null,
          threshold: a.threshold ? parseFloat(a.threshold) : null,
          date: a.snapshot_date,
          acknowledged: a.acknowledged,
          createdAt: a.created_at,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /fees — Detailed Whop payment fee breakdown */
router.get('/fees', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { period, date } = req.query;
    const { start, end } = getPeriodRange(period || 'daily', date || new Date().toISOString().slice(0, 10));

    // Daily summary
    const dailySummary = await pgQuery(`
      SELECT
        DATE(paid_at AT TIME ZONE 'Europe/Berlin') as date,
        COUNT(*) as transactions,
        COALESCE(SUM(payment_amount), 0) as total_payment_amount,
        COALESCE(SUM(total_fees), 0) as total_fees,
        COALESCE(SUM(whop_fees), 0) as whop_fees,
        COALESCE(SUM(processing_fees), 0) as processing_fees,
        COALESCE(SUM(other_fees), 0) as other_fees
      FROM whop_payment_fees
      WHERE DATE(paid_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
      GROUP BY DATE(paid_at AT TIME ZONE 'Europe/Berlin')
      ORDER BY date DESC
    `, [start, end]);

    // Fee type breakdown
    const feeTypeBreakdown = await pgQuery(`
      SELECT fee_details FROM whop_payment_fees
      WHERE DATE(paid_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
    `, [start, end]);

    // Aggregate by fee type
    const byType = {};
    for (const row of feeTypeBreakdown) {
      const details = typeof row.fee_details === 'string' ? JSON.parse(row.fee_details) : (row.fee_details || []);
      for (const fee of details) {
        if (!byType[fee.type]) byType[fee.type] = { name: fee.name, type: fee.type, total: 0, count: 0 };
        byType[fee.type].total += fee.amount || 0;
        byType[fee.type].count++;
      }
    }

    // Per-payment detail (last 50)
    const recentPayments = await pgQuery(`
      SELECT payment_id, payment_amount, currency, total_fees, whop_fees, processing_fees, other_fees, paid_at
      FROM whop_payment_fees
      WHERE DATE(paid_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
      ORDER BY paid_at DESC
      LIMIT 50
    `, [start, end]);

    const totalFees = dailySummary.reduce((s, r) => s + parseFloat(r.total_fees), 0);
    const totalWhop = dailySummary.reduce((s, r) => s + parseFloat(r.whop_fees), 0);
    const totalProcessing = dailySummary.reduce((s, r) => s + parseFloat(r.processing_fees), 0);
    const totalOther = dailySummary.reduce((s, r) => s + parseFloat(r.other_fees), 0);
    const totalPaymentAmount = dailySummary.reduce((s, r) => s + parseFloat(r.total_payment_amount), 0);

    res.json({
      success: true,
      data: {
        summary: {
          totalFees: Math.round(totalFees * 100) / 100,
          whopFees: Math.round(totalWhop * 100) / 100,
          processingFees: Math.round(totalProcessing * 100) / 100,
          otherFees: Math.round(totalOther * 100) / 100,
          totalPaymentAmount: Math.round(totalPaymentAmount * 100) / 100,
          effectiveRate: totalPaymentAmount > 0 ? Math.round(totalFees / totalPaymentAmount * 10000) / 100 : 0,
          transactionCount: dailySummary.reduce((s, r) => s + parseInt(r.transactions), 0),
        },
        dailyBreakdown: dailySummary.map(r => ({
          date: r.date,
          transactions: parseInt(r.transactions),
          paymentAmount: Math.round(parseFloat(r.total_payment_amount) * 100) / 100,
          totalFees: Math.round(parseFloat(r.total_fees) * 100) / 100,
          whopFees: Math.round(parseFloat(r.whop_fees) * 100) / 100,
          processingFees: Math.round(parseFloat(r.processing_fees) * 100) / 100,
          otherFees: Math.round(parseFloat(r.other_fees) * 100) / 100,
        })),
        feeTypeBreakdown: Object.values(byType).sort((a, b) => b.total - a.total).map(f => ({
          name: f.name,
          type: f.type,
          total: Math.round(f.total * 100) / 100,
          count: f.count,
        })),
        recentPayments: recentPayments.map(r => ({
          paymentId: r.payment_id,
          amount: parseFloat(r.payment_amount),
          currency: r.currency,
          totalFees: parseFloat(r.total_fees),
          whopFees: parseFloat(r.whop_fees),
          processingFees: parseFloat(r.processing_fees),
          paidAt: r.paid_at,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

/** GET /export — CSV export of KPI data */
router.get('/export', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { period = 'daily', date, format = 'csv' } = req.query;
    if (!date) return res.status(400).json({ success: false, error: { message: 'date is required' } });
    if (format !== 'csv') return res.status(400).json({ success: false, error: { message: 'Only csv format is supported' } });

    const { start, end } = getPeriodRange(period, date);

    const orders = await pgQuery(`
      SELECT order_number, created_at, financial_status, fulfillment_status,
             total_price, subtotal_price, total_discounts, country,
             total_miners, total_rig_units, cogs, shipping_cost,
             gross_profit, profit_margin
      FROM shopify_orders_cache
      WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') BETWEEN $1 AND $2
      ORDER BY created_at
    `, [start, end]);

    const headers = [
      'Order Number', 'Date', 'Financial Status', 'Fulfillment Status',
      'Revenue', 'Subtotal', 'Discounts', 'Country',
      'Miners', 'Rig Units', 'COGS', 'Shipping Cost',
      'Gross Profit', 'Profit Margin %',
    ];

    const rows = orders.map(o => [
      o.order_number,
      new Date(o.created_at).toISOString().slice(0, 19),
      o.financial_status || '',
      o.fulfillment_status || '',
      o.total_price,
      o.subtotal_price,
      o.total_discounts,
      o.country || '',
      o.total_miners,
      o.total_rig_units,
      o.cogs,
      o.shipping_cost,
      o.gross_profit,
      o.profit_margin,
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.map(v => {
        const str = String(v ?? '');
        return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kpi-${period}-${date}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Auto-sync every 60 seconds ──────────────────────────────────────
let autoSyncCount = 0;

async function sendKpiSlackAlert(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_KPI_CHANNEL) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: SLACK_KPI_CHANNEL, text, username: 'Mineblock Bot', icon_url: 'https://i.imgur.com/PJCRE4g.png' }),
    });
  } catch {}
}

async function upsertOrders(orders) {
  let synced = 0;
  const affectedDates = new Set();
  for (const order of orders) {
    if (order.order_number < MIN_ORDER_NUMBER) continue;
    const costs = calculateOrderCosts(order);
    const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }) : null;

    // Alert on unrecognized products
    if (costs.unrecognizedItems && costs.unrecognizedItems.length > 0) {
      for (const item of costs.unrecognizedItems) {
        const key = `${item.title}|${item.sku || 'null'}`;
        if (!alertedUnknownProducts.has(key)) {
          alertedUnknownProducts.add(key);
          console.warn(`[KPI] ⚠️ Unrecognized product in order #${order.order_number}: "${item.title}" (SKU: ${item.sku || 'null'}) — $${item.price} x${item.quantity}. COGS = $0!`);
          await sendKpiSlackAlert(`⚠️ *Unknown Product Detected*\n\nOrder #${order.order_number} contains an unrecognized product:\n• *Title:* ${item.title}\n• *SKU:* ${item.sku || 'null'}\n• *Price:* $${item.price}\n• *Qty:* ${item.quantity}\n\n⚠️ This product has *$0 COGS* — please add its cost data to the KPI system.`);
        }
      }
    }

    await pgQuery(`
      INSERT INTO shopify_orders_cache (order_id, order_number, created_at, country, financial_status,
        total_price, subtotal_price, total_discounts, line_items, cogs, shipping_cost, gross_profit, profit_margin, total_miners, total_rig_units, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      ON CONFLICT (order_id) DO UPDATE SET
        financial_status=EXCLUDED.financial_status, total_price=EXCLUDED.total_price,
        subtotal_price=EXCLUDED.subtotal_price, total_discounts=EXCLUDED.total_discounts,
        line_items=EXCLUDED.line_items, cogs=EXCLUDED.cogs, shipping_cost=EXCLUDED.shipping_cost,
        gross_profit=EXCLUDED.gross_profit, profit_margin=EXCLUDED.profit_margin, country=EXCLUDED.country,
        total_miners=EXCLUDED.total_miners, total_rig_units=EXCLUDED.total_rig_units, synced_at=NOW()
    `, [order.id, order.order_number, order.created_at,
        order.shipping_address?.country || 'United States', order.financial_status,
        order.total_price, order.subtotal_price, order.total_discounts,
        JSON.stringify(order.line_items), costs.cogs, costs.shippingCost,
        costs.grossProfit, costs.profitMargin, costs.totalMiners || 0, costs.totalRigUnits || 0]);
    if (orderDate) affectedDates.add(orderDate);
    synced++;
  }
  return { synced, affectedDates };
}

async function autoSync() {
  if (!SHOPIFY_TOKEN) return;
  try {
    await ensureTables();
    await seedStaticData();
    autoSyncCount++;

    // 1. Fetch new orders (incremental via since_id)
    const sinceIdRows = await pgQuery('SELECT MAX(order_id) AS max_id FROM shopify_orders_cache');
    const sinceId = sinceIdRows[0]?.max_id || null;
    const newOrders = await fetchAllOrders(sinceId);

    // 2. Every 5th cycle (~5 min), also re-fetch last 3 days to catch refunds/status changes
    let recentOrders = [];
    if (autoSyncCount % 5 === 0) {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
      const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${threeDaysAgo}&limit=250&fields=id,order_number,created_at,total_price,subtotal_price,total_discounts,line_items,shipping_address,financial_status`;
      try {
        const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
        if (resp.ok) recentOrders = (await resp.json()).orders || [];
      } catch {}
    }

    const allOrders = [...newOrders, ...recentOrders];
    if (allOrders.length === 0) return;

    const { synced, affectedDates } = await upsertOrders(allOrders);
    for (const d of affectedDates) await recalculateSnapshots(d);
    if (synced > 0) console.log(`[KPI Auto-Sync] ${synced} new orders synced`);

    // Also sync Whop fees every 5th cycle (~5 min)
    if (autoSyncCount % 5 === 0) {
      await syncWhopFees().catch(err => console.error('[KPI] Fee sync error:', err.message));
    }
  } catch (err) {
    console.error('[KPI Auto-Sync] Error:', err.message);
  }
}

setTimeout(() => {
  autoSync().catch(() => {});
  setInterval(() => autoSync().catch(() => {}), 60_000); // Every 60 seconds
}, 30_000); // Start 30s after boot

// ── Daily P&L Slack Report ──────────────────────────────────────────────────
const SLACK_DAILY_PNL_CHANNEL = 'C0AF724MJPR';
// Operations & Teams removed from P&L report per request

async function sendDailyPnlReport(dateStr) {
  if (!SLACK_BOT_TOKEN) {
    console.warn('[Daily P&L] No SLACK_BOT_TOKEN configured');
    return;
  }

  try {
    await ensureTables();

    // Get snapshot for the date
    const snapRows = await pgQuery(
      'SELECT * FROM daily_kpi_snapshots WHERE snapshot_date = $1', [dateStr]
    );

    // Get fees for the date (use total_fees to match dashboard)
    const feeRows = await pgQuery(
      `SELECT COALESCE(SUM(total_fees),0) as total_fees
       FROM whop_payment_fees WHERE DATE(paid_at AT TIME ZONE 'Europe/Berlin') = $1`, [dateStr]
    );

    // Get ad spend from Triple Whale
    const adSpendRows = await fetchDailyAdSpend(dateStr, dateStr);

    const snap = snapRows[0];
    if (!snap) {
      console.warn(`[Daily P&L] No snapshot for ${dateStr}`);
      return;
    }

    // Calculate metrics — MUST match dashboard formula exactly
    // Dashboard: profit = revenue - (cogs + shipping + total_fees + adSpend)
    const revenue = parseFloat(snap.total_revenue || 0);
    const cogs = parseFloat(snap.total_cogs || 0);
    const shipping = parseFloat(snap.total_shipping || 0);
    const fees = parseFloat(feeRows[0]?.total_fees || 0);
    const adSpend = adSpendRows[0]?.spend || 0;
    const totalCosts = cogs + shipping + fees + adSpend;
    const profit = revenue - totalCosts;
    const roas = adSpend > 0 ? (revenue / adSpend) : 0;
    const netMarginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

    // Format date as MM/DD/YYYY
    const [y, m, d] = dateStr.split('-');
    const displayDate = `${m}/${d}/${y}`;

    const fmt = (n) => {
      const abs = Math.abs(n);
      const str = abs >= 1000
        ? abs.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        : abs.toFixed(1);
      return n < 0 ? `-$${str}` : `$${str}`;
    };

    const msgText = [
      `*${displayDate}*`,
      `Revenue:  ${fmt(revenue)}`,
      `COGS:  ${fmt(cogs)}`,
      `Shipping:  ${fmt(shipping)}`,
      `Fees:  ${fmt(fees)}`,
      `Ad Spend:  ${fmt(adSpend)}`,
      `Total Costs:  ${fmt(totalCosts)}`,
      `ROAS:  ${roas.toFixed(2)}x`,
      `Net Margin:  ${netMarginPct.toFixed(1)}%`,
      `Profit:  ${fmt(profit)}`,
    ].join('\n');

    const profitEmoji = profit >= 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
    const marginColor = netMarginPct >= 15 ? '#10b981' : netMarginPct >= 0 ? '#f59e0b' : '#ef4444';

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `${profit >= 0 ? '📊' : '📉'} Daily P&L — ${displayDate}`, emoji: true } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: msgText } },
      { type: 'divider' },
    ];

    // Ensure bot is in the channel
    await fetch('https://slack.com/api/conversations.join', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: SLACK_DAILY_PNL_CHANNEL }),
    }).catch(() => {});

    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: SLACK_DAILY_PNL_CHANNEL,
        text: `Daily P&L for ${displayDate}: Profit ${fmt(profit)}`,
        blocks,
        username: 'Mineblock Bot',
        icon_url: 'https://i.imgur.com/PJCRE4g.png',
      }),
    });

    const result = await resp.json();
    if (!result.ok) {
      console.error('[Daily P&L] Slack error:', result.error);
    } else {
      console.log(`[Daily P&L] Sent report for ${displayDate}: Profit ${fmt(profit)}`);
    }
  } catch (err) {
    console.error('[Daily P&L] Error:', err.message);
  }
}

// ── Startup catch-up: check if yesterday's report was sent, if not send it ──
// Render free tier spins down the server after 15min idle, so setInterval
// schedulers miss their window. This catch-up runs on every server boot
// and checks Slack channel history — if yesterday's report wasn't posted, send it.
async function catchUpDailyPnl() {
  if (!SLACK_BOT_TOKEN) return;
  try {
    await ensureTables();

    // Get yesterday's date in Berlin timezone
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value;
    const berlinDate = `${get('year')}-${get('month')}-${get('day')}`;
    const hour = parseInt(get('hour'));

    // Only catch up after midnight Berlin (the Shopify day has ended)
    // Before midnight, "yesterday" data isn't complete yet
    const yDate = new Date(berlinDate + 'T00:00:00Z');
    yDate.setUTCDate(yDate.getUTCDate() - 1);
    const yStr = yDate.toISOString().slice(0, 10);
    const [y, m, d] = yStr.split('-');
    const displayDate = `${m}/${d}/${y}`;

    // Check Slack channel history for yesterday's report
    const oldest = Math.floor(new Date(berlinDate + 'T00:00:00+01:00').getTime() / 1000) - 86400;
    const histResp = await fetch(
      `https://slack.com/api/conversations.history?channel=${SLACK_DAILY_PNL_CHANNEL}&oldest=${oldest}&limit=50`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const hist = await histResp.json();

    if (hist.ok) {
      const alreadySent = (hist.messages || []).some(msg =>
        msg.text?.includes(`Daily P&L for ${displayDate}`)
      );
      if (alreadySent) {
        console.log(`[Daily P&L] Report for ${displayDate} already sent — skipping catch-up`);
        return;
      }
    }

    // Check if we have a snapshot for yesterday (data is available)
    const snapRows = await pgQuery(
      'SELECT 1 FROM daily_kpi_snapshots WHERE snapshot_date = $1 LIMIT 1', [yStr]
    );
    if (snapRows.length === 0) {
      console.log(`[Daily P&L] No snapshot for ${yStr} yet — skipping catch-up`);
      return;
    }

    console.log(`[Daily P&L] Catch-up: sending missed report for ${displayDate}`);
    await sendDailyPnlReport(yStr);
  } catch (err) {
    console.error('[Daily P&L] Catch-up error:', err.message);
  }
}

// Manual trigger (authenticated)
router.post('/daily-pnl', authenticate, async (req, res) => {
  try {
    const dateStr = req.query.date || (() => {
      const now = new Date();
      const berlin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      berlin.setDate(berlin.getDate() - 1);
      return `${berlin.getFullYear()}-${String(berlin.getMonth() + 1).padStart(2, '0')}-${String(berlin.getDate()).padStart(2, '0')}`;
    })();
    await sendDailyPnlReport(dateStr);
    res.json({ success: true, date: dateStr });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── Cron-triggered endpoint (called by Render Cron Job daily) ──────────────
// Protected by CRON_SECRET env var instead of JWT auth
router.get('/cron/daily-pnl', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.query.secret !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    // Use explicit date if provided, otherwise calculate yesterday in Berlin timezone
    let dateStr = req.query.date;
    if (!dateStr) {
      const now = new Date();
      const berlin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      berlin.setDate(berlin.getDate() - 1);
      dateStr = `${berlin.getFullYear()}-${String(berlin.getMonth() + 1).padStart(2, '0')}-${String(berlin.getDate()).padStart(2, '0')}`;
    }

    console.log(`[Daily P&L] Cron trigger for ${dateStr}`);
    await sendDailyPnlReport(dateStr);
    res.json({ success: true, date: dateStr });
  } catch (err) {
    console.error('[Daily P&L] Cron error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Run catch-up 90s after boot (let DB connections settle)
setTimeout(() => catchUpDailyPnl(), 90_000);

export default router;
export {
  calculateOrderCosts,
  ensureTables,
  parseSku,
  seedStaticData,
  runAnomalyDetection,
  interpolateRate,
  syncWhopFees,
  UNIT_COST_PER_MINER,
  UNIT_COST_PER_MINER_2920,
  MR_MINER_COUNTS,
  RIG_UNIT_COSTS,
  RIG_SLOT_COUNTS,
  SHIPPING_RATES_MR,
  SHIPPING_RATES_MR_2920,
  SHIPPING_RATES_MR_2722,
  SHIPPING_RATES_RIG,
  MIN_ORDER_NUMBER,
};
