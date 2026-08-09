const B='https://puure-dashboard.onrender.com';
const SID='co_07e0e29d35155bba866ef88ed01f637e';
const j=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return{};}};
const lj=await j(await fetch(B+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({email:'admin@trypuure.co',password:'PuureAdmin2026!'})}));
const H={authorization:'Bearer '+(lj?.data?.accessToken||lj?.accessToken)};
console.log('watching for the refund to reach us…');
for(let i=0;i<160;i++){
  try{
    const d=await j(await fetch(`${B}/api/v1/checkout/${SID}`,{headers:H}));
    const s=(d?.data?.session)||d?.data||{};
    const refunds=Array.isArray(s.refunds)?s.refunds:[];
    if(s.status==='refunded'||refunds.length){
      console.log('*** REFUND RECEIVED ***');
      console.log('session status :', s.status);
      console.log('refunds ledger :', JSON.stringify(refunds));
      process.exit(0);
    }
  }catch(e){}
  await new Promise(r=>setTimeout(r,5000));
}
console.log('no refund seen in window');
