// Consent-first tracking runtime — the ONE <head> script funnelRender injects.
//
// Ordered exactly as the reference (DATA-FLOW.md hop 4/5, edge_consent.py):
//   1. CONSENT resolves FIRST, before any pixel. Deny-by-default posture is
//      configurable (TRACKING_DEFAULT_CONSENT); a CMP calls
//      window.__fosConsent.set('granted'|'denied').
//   2. ONLY after consent is granted does the runtime mint a visitor id,
//      send the touch beacon, capture click-ids, and fire pixels.
//   3. Consent DENIED runs COOKIELESS — no vid, no touch, no click (no
//      identity). It only posts a consent=denied signal, which the relay
//      records without any matchable identity (that is correct, not an error).
//
// GOOGLE (GA4): this runtime deliberately emits NO Google loader. ga4 rows are
// s2s-only (the trackingAdmin registry refuses native/hybrid for them) and
// /track/config already selects mode IN ('native','hybrid'), so a ga4 row never
// reaches fireOne; fireOne's kind check is the second gate, so even a
// hand-written hybrid ga4 row inserted straight into lb_pixels emits nothing
// here. Until the tag-manager phase lands, GA4 is served entirely server-side
// by the Measurement Protocol sender in trackingDelivery. Keep this note OUT of
// the emitted script body — every byte in there ships on every page view.
//
// SECURITY (XSS): funnel_id / page_id are embedded through jsonForScript()
// (escapes <, >, &, U+2028/9) so a hostile funnel/page id can never break out
// of the inline <script>. Pixel ids arrive at runtime as JSON from /track/config
// and are used as JS string VALUES (fbq('init', id)) — never concatenated into
// script markup. Nothing user-controlled is written as HTML anywhere here.

// JSON safe for inline <script> embedding (same rules as funnelRender).
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const CONSENT_VALUES = ['granted', 'denied'];

// The default consent posture when no stored signal and no CMP has spoken.
// Read at REQUEST time (rollback = unset the var; DECISIONS #1).
//
// ⚠ GO-LIVE COMPLIANCE REQUIREMENT: for consent-regulated traffic (EEA/UK,
// or any GDPR-style jurisdiction) TRACKING_DEFAULT_CONSENT MUST be set to
// 'denied'. The default 'granted' fires the identity pipeline immediately on
// page load and therefore RACES a CMP: identity is captured before the banner
// can answer, which is a consent violation in-region. 'denied' is the
// reference posture (edge_consent.py defaults deny in-region); with it set,
// nothing identifying runs until the CMP calls
// window.__fosConsent.set('granted'). 'granted' is only acceptable for
// deployments that serve no consent-regulated traffic.
function defaultConsent() {
  const v = String(process.env.TRACKING_DEFAULT_CONSENT || 'granted').trim().toLowerCase();
  return CONSENT_VALUES.includes(v) ? v : 'granted';
}

// Returns the <head> fragment (a single <script>) or '' when tracking is off.
// Gated by TRACKING_ENABLED (request-time). Off ⇒ byte-identical to no script.
export function trackingHeadScript({ funnel_id = null, page_id = null } = {}) {
  const enabled = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.TRACKING_ENABLED ?? '1').trim().toLowerCase()
  );
  if (!enabled) return '';

  const cfg = jsonForScript({
    funnel_id: funnel_id != null ? String(funnel_id) : null,
    page_id: page_id != null ? String(page_id) : null,
    api_base: '/api/v1/track',
    default_consent: defaultConsent(),
  });

  // Compact, framework-free, fully guarded — one inline <script>.
  const body = `(function(){
var CFG=window.__fosTrackCfg;var API=(CFG&&CFG.api_base)||'/api/v1/track';
function ck(n){try{var parts=(document.cookie||'').split(';');for(var i=0;i<parts.length;i++){var kv=parts[i].split('=');if((kv[0]||'').trim()===n){return decodeURIComponent((kv.slice(1).join('=')||'').trim());}}return '';}catch(e){return '';}}
function setck(n,v,days){try{var d=new Date(Date.now()+days*864e5);document.cookie=n+'='+encodeURIComponent(v)+';path=/;max-age='+(days*86400)+';SameSite=Lax';}catch(e){}}
function vidNew(){try{var a=new Uint8Array(12);(window.crypto||{}).getRandomValues&&window.crypto.getRandomValues(a);var s='';for(var i=0;i<a.length;i++){s+=('0'+a[i].toString(16)).slice(-2);}return 'v_'+(s||(''+Date.now()+Math.random()).replace(/[^0-9]/g,'').slice(0,16));}catch(e){return 'v_'+(''+Date.now());}}
function getVid(create){var v=ck('_fos_vid');if(!v&&create){v=vidNew();setck('_fos_vid',v,365);}return v;}
function post(path,body){try{return fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',keepalive:true,body:JSON.stringify(body)}).catch(function(){});}catch(e){}}
/* The checkout session id rides in ?s= so the funnel can carry it across
   pages. It identifies a buyer's order, so it must never be beaconed, stored
   in lb_touches/lb_clicks, or forwarded to an ad platform as
   event_source_url. Strip it (and its aliases) from every URL we transmit. */
function scrub(u){try{if(!u)return u;var x=new URL(u,window.location.origin);
['s','session','session_id'].forEach(function(k){x.searchParams.delete(k);});
return x.toString();}catch(e){return String(u||'').split('?')[0];}}
var pipelineRan=false;
function runPipeline(){if(pipelineRan)return;pipelineRan=true;try{
  var vid=getVid(true);var url=scrub(location.href);var ref=scrub(document.referrer||'');
  post('/touch',{funnel_id:CFG.funnel_id,page_id:CFG.page_id,vid:vid,url:url,referrer:ref,consent:'granted'});
  post('/click',{funnel_id:CFG.funnel_id,vid:vid,url:url,consent:'granted'});
  firePixels(vid,url);
}catch(e){}}
function firePixels(vid,url){try{
  fetch(API+'/config?funnel='+encodeURIComponent(CFG.funnel_id||''),{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(j){
    var pixels=(j&&j.data&&j.data.pixels)||[];
    pixels.forEach(function(px){try{fireOne(px,vid,url);}catch(e){}});
    // Relay one PageView server-side (same id the browser would use) so it
    // survives ad blockers. Consent granted ⇒ carries fbp/fbc identity.
    var eid='pv_'+vid+'_'+Math.floor(Date.now()/1000);
    post('/collect',{funnel_id:CFG.funnel_id,event_name:'PageView',event_id:eid,consent:'granted',url:url,identity:{fbp:ck('_fbp'),fbc:ck('_fbc')}});
  }).catch(function(){});
}catch(e){}}
function loadFbq(){try{
  if(window.fbq)return;
  var n=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments);};
  n.push=n;n.loaded=true;n.version='2.0';n.queue=[];
  window.fbq=n;if(!window._fbq){window._fbq=n;}
  var t=document.createElement('script');t.async=true;
  t.src='https://connect.facebook.net/en_US/fbevents.js';
  var s=document.getElementsByTagName('script')[0];
  if(s&&s.parentNode){s.parentNode.insertBefore(t,s);}else{(document.head||document.documentElement).appendChild(t);}
}catch(e){}}
function fireOne(px,vid,url){
  // Browser pixel — pixel id used as a VALUE, never written as markup.
  // The fbq BASE snippet loads lazily here, which keeps it behind the same
  // consent gate as everything else: fireOne only runs from runPipeline,
  // which only runs after consent resolves granted. /track/config already
  // returns only enabled native|hybrid pixels; the mode check is kept
  // explicit so an s2s-only config can never boot a browser pixel.
  if(px.kind==='meta_pixel'&&(px.mode==='native'||px.mode==='hybrid')){
    loadFbq();
    try{window.fbq('init',px.pixel_id);window.fbq('track','PageView');}catch(e){}
  }
}
function deny(){try{post('/consent',{funnel_id:CFG.funnel_id,status:'denied'});}catch(e){}}
window.__fosConsent=window.__fosConsent||{};
window.__fosConsent.set=function(state){try{if(state!=='granted'&&state!=='denied')return;setck('_fos_consent',state,180);if(state==='granted'){runPipeline();}else{deny();}}catch(e){}};
window.__fosConsent.get=function(){return ck('_fos_consent')||'';};
function boot(){try{
  var c=ck('_fos_consent');
  if(c==='granted'){runPipeline();return;}
  if(c==='denied'){deny();return;}
  if(CFG.default_consent==='granted'){runPipeline();}else{deny();}
}catch(e){}}
if(document.readyState!=='loading'){boot();}else{document.addEventListener('DOMContentLoaded',boot);}
})();`;
  return `<script>window.__fosTrackCfg=${cfg};${body}</script>`;
}

export default { trackingHeadScript };
