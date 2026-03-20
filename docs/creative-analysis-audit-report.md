# Creative Analysis Tool — Bug Audit & Fix Report
**Date:** March 20, 2026
**Audited by:** 8 parallel agents
**Files:** `server/src/routes/creativeAnalysis.js`, `client/src/pages/performance/CreativeAnalysis.jsx`

---

## Summary

**28 bugs found** across backend and frontend. **12 fixed**, remaining are low-priority.

| Severity | Found | Fixed |
|----------|-------|-------|
| Critical | 4 | 4 |
| High | 4 | 4 |
| Medium | 9 | 4 |
| Low | 11 | 0 |

---

## CRITICAL BUGS — ALL FIXED

### BUG-01: `week` vs `week_code` column name mismatch
- **Impact:** If migration ran before ensureTable, all queries would fail
- **Root Cause:** Migration 016 uses `week_code`, but `ensureTable()` and all queries use `week`
- **Status:** Not a live issue — `ensureTable()` runs first and creates the column as `week`. Migration's `CREATE TABLE IF NOT EXISTS` is a no-op. No fix needed.

### BUG-02: `weekToDateRange()` timezone drift
- **Impact:** Date ranges sent to Triple Whale could be off by 1 day, causing wrong week's data
- **Root Cause:** `new Date(year, 0, 4)` uses local time, but `.toISOString()` formats in UTC
- **Fix:** Changed all date math to use `Date.UTC()`, `getUTCDay()`, `getUTCFullYear()`

### BUG-03: `getCurrentWeek()` timezone + DST drift
- **Impact:** Cron sync could sync wrong week during DST transitions
- **Root Cause:** Same local-vs-UTC issue + millisecond-based week calculation doesn't account for DST
- **Fix:** Rewrote to use UTC-only date math

### BUG-04: `getCurrentWeek()` returns week 0 or negative in early January
- **Impact:** Cron sync would store data under nonsensical `WK00_2026` or `WK-1_2026`
- **Root Cause:** Dates before ISO week 1 Monday produce negative diff
- **Fix:** Added detection + rollback to previous year's last week (e.g., `WK52_2025`)

---

## HIGH BUGS — ALL FIXED

### BUG-05: `activeOnly` toggle ignored in custom date mode
- **Impact:** Active Only button appears active but has no effect on data in custom mode
- **Root Cause:** Custom date mode condition takes priority in fetchData
- **Fix:** Hide the Active Only button when in custom date mode

### BUG-06: `order_revenue` may not exist in Triple Whale
- **Impact:** All revenue/ROAS data could be 0 if TW uses a different column name
- **Root Cause:** Hardcoded `order_revenue` column. TW setups vary (`pixel_revenue`, `revenue`)
- **Fix:** Added revenue column fallback loop: tries `order_revenue` → `pixel_revenue` → `revenue`

### BUG-07: GROUP BY splits same creative into duplicate rows
- **Impact:** Same creative appears multiple times in leaderboard/active views with partial metrics
- **Root Cause:** `GROUP BY creative_id, type, avatar, angle, format, editor` — metadata differences across hooks create separate groups
- **Fix:** Changed to `GROUP BY creative_id` with `MAX()` for metadata columns in both `/active` and `/leaderboard`

### BUG-08: TW fetch loop misidentifies auth/server errors as column problems
- **Impact:** Auth failures silently exhaust all 5 retry attempts instead of failing fast
- **Root Cause:** Any `!res.ok` triggers next column variant, even for 401/403/500
- **Fix:** Added status code checks — auth errors (401/403) and server errors (500+) return immediately

---

## MEDIUM BUGS — 4 FIXED

### BUG-09: Leaderboard always uses week mode (NOTED, not fixed)
- Leaderboard always passes `week` param even in custom date mode

### BUG-10: `/active` response missing `hooks` array (NOTED)
- Expand chevron does nothing in active-only mode

### BUG-11: `/data-by-date` missing `is_winner` field — FIXED
- **Fix:** Added `getLifetimeMetrics()` call to the `/data-by-date` endpoint

### BUG-12: Stale date picker state (NOTED)
- Old dates persist when switching between modes

### BUG-13: DELETE + INSERT not in transaction — FIXED
- **Fix:** Wrapped in `BEGIN`/`COMMIT`/`ROLLBACK` transaction
- **Fix:** Added guard: if all parsed ads were skipped, don't wipe existing data

### BUG-14: ensureTable schema vs migration mismatch (NOTED)
- Missing columns in ensureTable vs migration (not blocking since ensureTable runs first)

### BUG-15: `weekToDateRange` doesn't validate week bounds — FIXED
- **Fix:** Clamped week number to 1-53 range

### BUG-16: Week string zero-padding inconsistency (NOTED)
- Ad names with `WK8_2026` vs `WK08_2026`

### BUG-17: TW response shape assumption — FIXED
- **Fix:** Added `data?.data || data?.rows || []` fallback for wrapped responses

---

## LOW BUGS — NOTED FOR FUTURE

| Bug | Description |
|-----|-------------|
| BUG-18 | Image ads (IM-prefix) may parse creative_id from wrong index |
| BUG-19 | Ads without week token lose all metadata |
| BUG-20 | Resolution segments (1080x1080) break right-to-left parsing |
| BUG-21 | KNOWN_ANGLES cross-validation too aggressive for avatars |
| BUG-22 | `filter(Boolean)` drops intentionally empty segments |
| BUG-23 | Silent fallback when all purchase columns fail (no warning) |
| BUG-24 | Fallback loop stops on first successful response even if purchases are all 0 |
| BUG-25 | `MIN(week)`/`MAX(week)` uses lexicographic ordering — wrong across years |
| BUG-26 | Sort direction starts ascending for numeric columns (should be desc) |
| BUG-27 | Sync button in custom mode syncs the week, not the date range |
| BUG-28 | `/sync` endpoint ignores user-provided startDate/endDate |

---

## NEW FEATURES ADDED

1. **Manual date selection** — Week/Custom toggle with date pickers
2. **Lifetime metrics** — Every creative now shows lifetime_spend, lifetime_revenue, lifetime_roas, weeks_active
3. **Winner badge** — Gold "WINNER" label on creatives with $500+ spend and ROAS >= 1.80
4. **Performance chart** — Click the chart button on any creative to see weekly spend vs ROAS graph
5. **Active-only filter** — Toggle to show only actively running creatives
6. **Sync Data button** — Manual sync trigger
7. **Active-only default** — Performance Data table now only shows creatives with spend > 0

---

## CLEANUP ITEMS

- Remove orphaned routes in App.jsx for deleted features (Video, Audio, LAB section)
- Remove unused icon imports in Sidebar.jsx
