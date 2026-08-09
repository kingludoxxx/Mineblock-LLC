const B='https://puure-dashboard.onrender.com';
const j=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return{raw:t.slice(0,150)};}};
const lj=await j(await fetch(B+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({email:'admin@trypuure.co',password:'PuureAdmin2026!'})}));
const tok=lj?.data?.accessToken||lj?.accessToken;
const H={authorization:'Bearer '+tok};
let seen=new Set();
console.log('watching for a paid session…');
for(let i=0;i<180;i++){
  try{
    const s=await j(await fetch(B+'/api/v1/checkout?limit=10',{headers:H}));
    const rows=s?.data?.sessions||s?.data||[];
    for(const r of (Array.isArray(rows)?rows:[])){
      const key=r.id+':'+r.status;
      if(seen.has(key))continue;
      seen.add(key);
      console.log(`[${new Date().toISOString().slice(11,19)}] session ${r.id} status=${r.status} total=${r.total} ${r.email||''}`);
      if(r.status==='paid'){ console.log('*** PAID DETECTED ***'); process.exit(0); }
    }
  }catch(e){}
  await new Promise(r=>setTimeout(r,5000));
}
console.log('watcher timed out after 15m');
