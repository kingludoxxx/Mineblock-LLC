#!/bin/sh
echo "[Cron] Triggering Daily P&L report..."
curl -sf "https://mineblock-dashboard.onrender.com/api/v1/kpi-system/cron/daily-pnl?secret=${CRON_SECRET}" || echo "[Cron] Failed to trigger"
echo "[Cron] Done"
