const B='https://puure-dashboard.onrender.com';
const j=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return{};}};
const lj=await j(await fetch(B+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({email:'admin@trypuure.co',password:'PuureAdmin2026!'})}));
const H={authorization:'Bearer '+(lj?.data?.accessToken||lj?.accessToken)};
console.log('watching for a PAID session…');
for(let i=0;i<240;i++){
  try{
    const s=await j(await fetch(B+'/api/v1/checkout?limit=15',{headers:H}));
    const rows=s?.data?.sessions||s?.data||[];
    const paid=(Array.isArray(rows)?rows:[]).filter(r=>r.status==='paid');
    if(paid.length){ console.log('*** PAID ***', JSON.stringify(paid[0])); process.exit(0); }
  }catch(e){}
  await new Promise(r=>setTimeout(r,5000));
}
console.log('timed out');
