#!/usr/bin/env node
/**
 * Import Konvert template URLs into production statics_templates table.
 * Uses the bulk API endpoint on the live server.
 */

const URLS = [
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/KPLbHPgGxqhkw-U_AYP8vaA5Ozg/weEmVw../4634.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/OXhs3OVnkynLbs6vzafHZJ-9bPM/tqTq1w../4630.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Y9xBVAfbwqlJT74kSA7_3TU8oho/Hw_Qww../4626.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Exc8quMr8Nr9vNvEQZmGPvEUfO4/_hhyTw../4622.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/O2Fska9xqV-goh4LgWUgmo_3EvA/VjablA../4618.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/PJHrF4C--5pmohaQkA2-7qtXU0s/a9l9eQ../4614.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/LxB_zUi2WjP7khl4Phmsf6pETs4/d3MHBg../4610.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/uJt6mQW30U_yqHWwDIsrmEYxmSI/jSRxtw../4606.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Qma1-nlPZ5d3tQG_T6jNF_3NxQM/TP0_AA../4602.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/J0k-C6BNN-IrevDixqwzMQDttkk/BnO7jw../4598.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/4ByiDldmC3QtXKTLDo86JRaAPP8/6ZT-tg../4594.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Ps1jhS1jiZwEzayXuzDGSWy5V2c/kh_WBw../4590.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/bWzOLUPZE3ENYqmvwp4i_SLhLUw/ULUu0w../4586.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/dit-6r3vZGDiU7KFFyk9d1OyQ-E/SDtDGA../4582.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/2a053KAt6awYMhoemGKFpLN0yiw/ddanFA../4578.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/zLOxOsNdms3r8jMizFsROGzyDew/QdUE3w../4574.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/PlvOed2ECUq-p2AN8GJBjKr0XIs/SFDzrA../4570.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/-Mt3uxtQEUHTKTNkfKvP9chlJpA/pa5aAQ../4566.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/aJ-iFV_in_jXdBx0NfJp7IwOG7E/ucX0wQ../4562.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/O5isI27s63lDjKDfLs3TnegP3mk/GGh-NA../4558.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/H2d6hRTa7iz7RfsyL-tsuQO1PP0/NErbGA../4554.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/i922MqXV_NiTKA1brqrac_DK6pY/1WwesQ../4550.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/gvMfNPHq2QBnppjYLiBvZ0l-ACg/RD6PFw../4546.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/vNIvlHbqw-urdt4-oUN2ucxI1qA/Zy8PPQ../4542.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/hf_TJ-ZSEcP5AbUvqXpCQCigwoc/CTm0SQ../4538.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/noGIaQAUD7oXu1YkFhbV9k1zTjo/tt5A6g../4633.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/IoJtE88EYITwNP2Y_rCzWU7TrXE/vmmz8A../4629.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/-9VKzxbGo3XWLFLs5mTMQfIrf-0/-XpnKg../4625.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/lsy7lS9giFGxo3MbcCy1Cs2SM6k/QX83Uw../4621.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Na7RvqQ-Mna_Wov21ObSViEo1Ek/jJFw0w../4617.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/YbJiluHI4STiRf6067rGPXp9WgY/leopZQ../4613.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/9-xp9lmUsyvc2oqhdfGeAt-LemI/FOA2rQ../4609.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/qZxcg53qCd2AkN6nxX8eJhqymdk/WCxXlw../4605.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/4T9vDQY8IMBkyeVI6P-yZkF9SHI/HlFTDw../4601.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/i-MI2iDE135sSuTpIW3JCoTZQiY/MzXDNQ../4597.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/cT0wHjhgyq7ltPcmhm_aik8sEj8/CTRQmg../4593.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/keCbJyjDl_zMly8IknG8CchlvtE/ik_nMg../4589.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/z08BoRdJnw4pn9WoZmm32DzluI0/S77AZg../4585.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/TUXsnIoBjLGIveJjam7NuBzYUVw/TGDo9w../4581.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/d0GCzFiVjeEeKi7GDQ7J-WFxaFw/bs-Fpg../4577.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Dd64guvvT1ZhvGrIIpP9N1uj8tg/JypbnQ../4573.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/7cBXHu_hmFDN2aUonVt__C1erVI/7z_jSQ../4569.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/ElnUNfa82WqOnTDAdJUQtvI7ewo/CN6eZQ../4565.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/luMNgLiH0EZ2LzmFTM_FqLEP4i4/YUL5yQ../4561.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/PGjf8sYGzJ8HwcPCIltsu6QfyZw/Jxay2g../4557.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/CazRdNvFhToz7WWRb273Fblc_80/iRjV1w../4553.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/w2GMK6WALCnOYME1MDAb8Xd7Eag/RCT8_Q../4549.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/5GJqQNh56CWQYjGpdotizxTqhug/0pgzUg../4545.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/dsS55EiOw1xaCAS1kEfGMud8O9g/griaVw../4541.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Fqr_mRfDG-bcG6xT7b7zt-iwhT8/Oax6Gw../4537.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/p9A7lXj7wZeEk6TPEOWt5bFLscE/pzwo4w../4632.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/DAwfIqMTxOJB7hYu5UjzOyCvAHk/72ZQxQ../4628.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/L-xAW7eIQ9a91ChcDKa0kwUQN-s/4OiwBA../4624.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/mintJ1J_8FRqxaIPt_wWkvlrquw/6GIdCA../4620.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/5M8xycrPKWfVN3EfU2Wn1w-ksWc/yQwcrQ../4616.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/_bCply8P8nb2BJRyrQGhT5s3qZo/m-KbNA../4612.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/TbBZKVd5WOwYX5bqDQ8qd9T1nJE/VZGh0g../4608.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/gfwmcG-E2A3SpaWIBZzfq5zAG5w/3wcmcQ../4604.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/yRYaH7ZLDvV93Tzmf6HUCtwKJB0/Sbs-2g../4600.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Llgo7ReCAktaQQ7u9Uve8MPks1I/WswU8A../4596.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/ugy74kHuzDMTuV3-GwOV16wDWgI/WvW8Ow../4592.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/6SBx_5A-5gCR92NOwqXfmGVvcDM/lEKQRA../4588.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/8FRrWIyoL6Yl2lqG2zVV_eFwgEU/RF-R_A../4584.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/swo2lTM-bGebEDZeMq0b7ErvOz0/k25z6Q../4580.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/hzNqHNo3l1FM1QANqYyoulupwdY/eF9IYA../4576.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Tzyjv5Yo9HhJVSJ0JIFDFPz_qYI/4hDUJA../4572.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/EQi5T5fU_3NkYg5OKFYt9mtKWFc/1dwDjA../4568.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/LHa-UXXLSg3rhlY8vnDBGxSKEKY/G4TdVQ../4564.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/QkujhcQif46LcRZuXIMhLmUats4/9gwTjA../4560.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/XUfkb9KNAT2lrPRhQEm0aDxD8bo/6DEbzA../4556.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/6qcC1X2-ogWZb5DO25h_hL-tOQM/zC_CPw../4552.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/OS4najOjg0yVazSqzF2QQ29HvVw/hNhJGQ../4548.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Z1P5RKbQ0-j_ovW3Pjo_32Imx_U/sdQRmg../4544.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/lbWPdhQuXl2BuqWE5vnvKqPVij4/5gnPpg../4540.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/GutWyATyEQre9wrhj_405rbbLvU/63rE3Q../4536.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/7JpchP3VqCIEQevDjLM44hgKyiw/abmH7g../4631.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/QoTZPbHRNb-iOkJU3aj-bvAzCFg/81YR1Q../4627.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/NO0MV5zWylCtvs5gehUpd7kA-6Y/C35Dew../4623.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/QpS2-l2ybdTl-yELP6ftZtsx0Rw/Ah5RjA../4619.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/MACts8uzQpEJuW1ouJEzUEgUmlw/kQYw9A../4615.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/kYbPzGH0gaa0SmWg271NYxbhCfY/S-XqaA../4611.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/bTJ9ozIShpg5ZMgh0rmkyShm9DQ/MQsGyg../4607.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/RfrNXLbbDDGj4OAC4T0n7PMk4FQ/s_dwwA../4603.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/Q98DnjelVjg6go2seRn5JFbMEq4/eDqQVQ../4599.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/IsvzD8Bv8VK7HPL-QqbwuelsNl0/nzfREw../4595.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/GXoN2Yh8pBh2w0rpqBReuXzJ3JY/BLnYJw../4591.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/vtI6U-goYZAm1so5-7jwhhF6SCA/jAwIpA../4587.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/wiCxeJzeyB3Na9nlwUUxM1lbFws/176oiw../4583.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/eoJJPNrWdwP6NIqCrEE5LFu8WoY/kcq3KA../4579.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/0RT26vD4V4t1xXpSXa6qN53DMD8/ys9pYQ../4575.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/1CqcyLOOLSUjAPcl15GTvBn2PzE/gnVqvg../4571.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/XVWEi15JrXrVx1NZl8V6FVseYs0/Zyaf9A../4567.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/dPrcFos3KkSsbESgfnHszKUSPTM/AhEd-Q../4563.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/vIP0QR2ghwoRsjaKt7p2opWu-Q4/zV3bgg../4559.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/OkwbpOYDlNDvetjhSE3iGqkVWAo/Kr9pmA../4555.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/LYcTPRV2PspszzH-WZoKUSqQbbk/ariN-w../4551.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/LjqJNLTAuFWC2QTfCYCwU4WzJls/aiiqKQ../4547.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/AQ4NKYDdHVBlTTQPzItIqAGX6Ms/evMqBA../4543.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/AG-I7gO10LuvilztsuLb1dmZAQI/PRM00A../4539.webp",
  "https://xn7q-nefz-qhlj.n7d.xano.io/vault/r4fM_Vz3/rT5nMHViB6khhjkv9eNYG53J6Bw/T6JyZw../4535.webp",
];

const templates = URLS.map((url, i) => ({
  name: `Konvert ${url.match(/\/(\d+)\.webp/)?.[1] || i}`,
  category: 'Uncategorized',
  image_url: url,
  tags: ['konvert'],
}));

// Import via local server or production API
const API_BASE = process.env.API_BASE || 'https://mineblock-dashboard.onrender.com';

async function importTemplates() {
  console.log(`Importing ${templates.length} templates to ${API_BASE}...`);

  const res = await fetch(`${API_BASE}/api/v1/statics-templates/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templates }),
  });

  const data = await res.json();
  console.log('Result:', JSON.stringify(data));
}

importTemplates().catch(err => console.error('Error:', err.message));
