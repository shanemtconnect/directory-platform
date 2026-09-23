import { MAX_BEACON_EVENTS } from "@/lib/stats/keys";

/**
 * The entire client side of the stats feature.
 *
 * Inline, hand-written, and about 600 bytes: no analytics library, no
 * third-party script, no cookie, no fingerprint, nothing loaded from another
 * origin. It reads `data-` attributes this site rendered, posts a listing id
 * and a word, and never runs again.
 *
 * It exists because a listing page is ISR-cached, so the server cannot see a
 * view: one render serves an unknown number of readers. Impressions ride along
 * in the same request rather than costing one per card.
 *
 * Written as a string rather than as a client component on purpose — a "use
 * client" component for this would ship React, the router and a hydration pass
 * to every visitor of every page, to send one POST.
 */
export const BEACON_SCRIPT = `
(function(){
  if(window.__dpBeacon)return;window.__dpBeacon=1;
  function send(){
    var nodes=document.querySelectorAll('[data-dp-stat][data-dp-listing]');
    var events=[],seen=Object.create(null);
    for(var i=0;i<nodes.length&&events.length<${MAX_BEACON_EVENTS};i++){
      var m=nodes[i].getAttribute('data-dp-stat'),l=nodes[i].getAttribute('data-dp-listing');
      if(!m||!l)continue;
      if(nodes[i].parentNode&&nodes[i].parentNode.getClientRects&&nodes[i].parentNode.getClientRects().length===0)continue;
      var k=m+'|'+l;
      if(seen[k])continue;
      seen[k]=1;
      events.push({listingId:l,metric:m});
    }
    if(!events.length)return;
    var body=JSON.stringify({events:events});
    try{
      if(navigator.sendBeacon){
        navigator.sendBeacon('/api/beacon',new Blob([body],{type:'application/json'}));
      }else{
        fetch('/api/beacon',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:body}).catch(function(){});
      }
    }catch(e){}
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',send);}else{send();}
})();
`.trim();
