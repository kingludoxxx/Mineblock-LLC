// Temporary script to query Faiz/Muhammad's completed tasks in March 2026
// Run with: node scripts/faiz-march-report.js

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN || '';
const VIDEO_ADS_LIST_ID = '901518716584';
const CLICKUP_API = 'https://api.clickup.com/api/v2';
const FAIZ_USER_ID = 170558610;

// March 2026 timestamps
const MARCH_START = new Date('2026-03-01T00:00:00Z').getTime();
const MARCH_END = new Date('2026-04-01T00:00:00Z').getTime();

async function clickupFetch(url) {
  const res = await fetch(`${CLICKUP_API}${url}`, {
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!CLICKUP_TOKEN) {
    console.error('CLICKUP_API_TOKEN not set');
    process.exit(1);
  }

  console.log('Fetching all tasks from Video Ads list with "ready to launch" and "launched" statuses...\n');

  const allTasks = [];
  for (const status of ['ready%20to%20launch', 'launched']) {
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const data = await clickupFetch(
        `/list/${VIDEO_ADS_LIST_ID}/task?page=${page}&limit=100&statuses%5B%5D=${status}&include_closed=false&subtasks=true`
      );
      const tasks = data.tasks || [];
      allTasks.push(...tasks);
      hasMore = tasks.length === 100;
      page++;
    }
  }

  console.log(`Total tasks in "ready to launch" + "launched": ${allTasks.length}`);

  // Filter: assigned to Faiz AND created in March 2026
  const faizMarchTasks = allTasks.filter(task => {
    const isAssigned = (task.assignees || []).some(a => a.id === FAIZ_USER_ID);
    const createdAt = parseInt(task.date_created);
    const createdInMarch = createdAt >= MARCH_START && createdAt < MARCH_END;
    return isAssigned && createdInMarch;
  });

  console.log(`Faiz's tasks created in March and completed (ready to launch/launched): ${faizMarchTasks.length}\n`);

  // Extract B codes
  const bCodes = [];
  for (const task of faizMarchTasks) {
    const match = task.name.match(/B\d{3,5}/);
    if (match) {
      bCodes.push(match[0]);
    }
  }

  // Sort numerically
  bCodes.sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));

  console.log('=== FAIZ/MUHAMMAD — MARCH 2026 COMPLETED VIDEOS ===');
  console.log(`Total: ${bCodes.length}\n`);
  console.log(bCodes.join('\n'));
}

main().catch(err => { console.error(err); process.exit(1); });
