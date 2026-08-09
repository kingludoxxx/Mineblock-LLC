const B='https://puure-dashboard.onrender.com';
const FID='fnl_6b9889145845fb', PID='fpg_d31bd92049c2c3', VARIANT='51919607529775';
const j=async r=>{const t=await r.text();try{return JSON.parse(t);}catch{return{raw:t.slice(0,160)};}};
// wait for the deploy to actually carry the new runtime
let ok=false;
for(let i=0;i<40;i++){
  const h=await (await fetch(B+'/f/live-test')).text();
  if(h.includes('correct them above')){ok=true;break;}
  await new Promise(r=>setTimeout(r,10000));
}
console.log('server code deployed:', ok);
const lj=await j(await fetch(B+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({email:'admin@trypuure.co',password:'PuureAdmin2026!'})}));
const H={'content-type':'application/json',authorization:'Bearer '+(lj?.data?.accessToken||lj?.accessToken)};
const { checkoutPageTemplate } = await import('/Users/ludo/Puure-integrator/server/src/services/funnelRender.js');
const t = checkoutPageTemplate();
for (const b of t.blocks) {
  if (b.type === 'whop_checkout') b.props={...b.props, variant_id:VARIANT, quantity:1};
  if (b.type === 'order_summary') b.props={...b.props, variant_id:VARIANT};
}
const r = await fetch(`${B}/api/v1/funnels/${FID}/pages/${PID}`,{method:'PATCH',headers:H,
  body:JSON.stringify({blocks:t.blocks, custom_css:t.custom_css, custom_js:t.custom_js, status:'published'})});
console.log('re-seed:', r.status);
const h = await (await fetch(B+'/f/live-test')).text();
console.log('unstick msg live :', h.includes('correct them above'));
console.log('complete listener:', h.includes("'complete'"));
console.log('activate() live  :', h.includes('function activate'));
