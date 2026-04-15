#!/usr/bin/env node
import 'dotenv/config';

const TOKEN = process.env.META_ACCESS_TOKEN;
const BASE = 'https://graph.facebook.com/v21.0';

const r = await fetch(`${BASE}/act_1363888491879561/adcreatives`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    access_token: TOKEN,
    name: 'TEST_DELETE_ME',
    object_story_spec: {
      page_id: '871833962672965',
      link_data: {
        link: 'https://mineblock.co',
        message: 'Test',
        image_hash: 'abc123',
      },
    },
  }),
});

const data = await r.json();
console.log('Status:', r.status);
console.log('Error subcode:', data.error?.error_subcode || 'NONE');
console.log('Response:', JSON.stringify(data, null, 2));
