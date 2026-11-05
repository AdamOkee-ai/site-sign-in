/* Site Sign-In app. Talks to the database only through window.__siBackend (see firebase-shim.js and db-adapter.js). */
(function(){
"use strict";

/* ---------- helpers ---------- */
const $ = (s,r=document)=>r.querySelector(s);
function h(tag,attrs,...kids){
  const e=document.createElement(tag);
  if(attrs) for(const k in attrs){
    const v=attrs[k];
    if(v==null||v===false) continue;
    if(k==="class") e.className=v;
    else if(k.startsWith("on")) e.addEventListener(k.slice(2),v);
    else if(k==="text") e.textContent=v;
    else if(v===true) e.setAttribute(k,"");
    else e.setAttribute(k,v);
  }
  for(const c of kids.flat()){ if(c==null||c===false) continue; e.append(c.nodeType?c:document.createTextNode(c)); }
  return e;
}
const pad2=n=>String(n).padStart(2,"0");
const todayStr=()=>{const d=new Date();return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate());};
const nowHM=()=>{const d=new Date();return pad2(d.getHours())+":"+pad2(d.getMinutes());};
const parseDate=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);};
const dayName=s=>parseDate(s).toLocaleDateString("en-GB",{weekday:"long"});
const dateLong=s=>parseDate(s).toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});
const slug=s=>String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60)||"x";
const fullName=p=>((p.f||"")+" "+(p.l||"")).replace(/\s+/g," ").trim();
const cmpTime=(a,b)=>(a||"99:99").localeCompare(b||"99:99");
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){return null;}}

let toastTimer;
function toast(msg){
  document.querySelectorAll(".toast").forEach(t=>t.remove());
  const t=h("div",{class:"toast",role:"status",text:msg});
  document.body.append(t); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.remove(),2600);
}

/* ---------- state ---------- */
const S={
  db:null,user:null,downloads:null,
  canWrite:true,isAdmin:false,
  today:todayStr(),date:todayStr(),
  tab:"sign",
  members:[],isSuper:false,sigs:{},B:null,
  projects:[],project:null,mode:"in",view:"",
  openAll:[],muster:new Set(),onData:null,
  roster:[],        // companies [{id,name,order,people:[]}]
  att:[],           // attendance docs for S.date [{_id,_v,...}]
  site:"",
  company:store("signin.company")||"",
  q:"", listQ:"",
  loaded:{roster:false,att:false,projects:false},
  unsubAtt:null,unsubSigs:null, connectTimer:null, reachable:true
};

/* ---------- tabs ---------- */
function staleRows(){
  const v=viewId();
  return S.openAll.filter(r=>r.date<S.today&&(v==="all"||r.project===v)).sort((a,b)=>b.date.localeCompare(a.date)||(a.company||"").localeCompare(b.company||"")||a.name.localeCompare(b.name));
}
function tabDefs(){
  const t=[{id:"sign",label:"Sign in",sub:"Add yourself"}];
  if(S.isAdmin||S.isSuper) t.push({id:"list",label:"On site",sub:"Who is here"});
  if(S.isAdmin){const nStale=staleRows().length; t.push({id:"summary",label:"Summary",sub:nStale?nStale+" to fix":"Site team"});t.push({id:"setup",label:"Setup",sub:"Manage"});}
  return t;
}
function renderTabs(){
  const box=$("#tabs"); box.replaceChildren();
  const defs=tabDefs();
  document.querySelector("nav.tabs").hidden=defs.length<2;
  document.body.classList.toggle("solo",defs.length<2);
  if(!defs.find(d=>d.id===S.tab)) S.tab="sign";
  defs.forEach(d=>box.append(h("button",{role:"tab","aria-selected":String(S.tab===d.id),onclick:()=>{S.tab=d.id;render();window.scrollTo(0,0);}},d.label,h("small",{text:d.sub}))));
  ["sign","list","summary","setup"].forEach(id=>{$("#pane-"+id).hidden=(id!==S.tab);});
}

/* ---------- data selectors ---------- */
const att=()=>viewRows();
const coById=id=>S.roster.find(c=>c.id===id);
function recFor(personId){return S.att.find(a=>a.personId===personId&&a.project===S.project);}
const projById=id=>S.projects.find(p=>p.id===id);
const projName=id=>(projById(id)&&projById(id).name)||id||"";
const viewId=()=>S.view||S.project||"all";
function viewRows(){const v=viewId();return S.att.filter(a=>v==="all"||a.project===v);}
function projBar(){
  if(S.projects.length<2) return null;
  const v=viewId();
  const mk=(id,label)=>h("button",{"aria-pressed":String(v===id),onclick:()=>{S.view=id;render();}},label);
  return h("div",{class:"seg",role:"group","aria-label":"Project"},mk("all","All projects"),...S.projects.map(p=>mk(p.id,p.name)));
}
function groupByCompany(rows){
  const m=new Map();
  rows.forEach(r=>{const k=r.company||"Other";if(!m.has(k))m.set(k,[]);m.get(k).push(r);});
  return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,rows])=>({name,rows:rows.sort((a,b)=>cmpTime(a.timeIn,b.timeIn)||a.name.localeCompare(b.name))}));
}

/* ---------- signature ---------- */
const SIG_W=320,SIG_H=110;
function sigSVG(sig,cls){
  let strokes=[];try{strokes=JSON.parse(sig||"[]");}catch(e){}
  const ns="http://www.w3.org/2000/svg";
  const svg=document.createElementNS(ns,"svg");
  svg.setAttribute("viewBox","0 0 "+SIG_W+" "+SIG_H); svg.setAttribute("class",cls||"sigthumb");
  svg.setAttribute("role","img"); svg.setAttribute("aria-label","Signature");
  strokes.forEach(s=>{
    if(!Array.isArray(s)||!s.length) return;
    const p=document.createElementNS(ns,"path");
    let d="M"+s[0][0]+" "+s[0][1];
    if(s.length===1) d+="l0.1 0.1"; else for(let i=1;i<s.length;i++) d+="L"+s[i][0]+" "+s[i][1];
    p.setAttribute("d",d); p.setAttribute("fill","none"); p.setAttribute("stroke","currentColor");
    p.setAttribute("stroke-width","3.2"); p.setAttribute("stroke-linecap","round"); p.setAttribute("stroke-linejoin","round");
    svg.append(p);
  });
  return svg;
}
function sigPad(){
  const wrap=h("div",{class:"sigwrap"});
  const cv=h("canvas",{"aria-label":"Signature pad. Draw your signature with your finger."});
  const hint=h("div",{class:"hint",text:"Sign here with your finger"});
  wrap.append(cv,h("div",{class:"baseline"}),hint);
  const strokes=[]; let cur=null, ctx=null;
  function size(){
    const r=wrap.getBoundingClientRect(); const dpr=window.devicePixelRatio||1;
    cv.width=Math.max(1,Math.round(r.width*dpr)); cv.height=Math.max(1,Math.round(r.height*dpr));
    ctx=cv.getContext("2d"); ctx.setTransform(cv.width/SIG_W,0,0,cv.height/SIG_H,0,0);
    ctx.lineWidth=3.2; ctx.lineCap="round"; ctx.lineJoin="round";
    ctx.strokeStyle=getComputedStyle(document.body).color; redraw();
  }
  function redraw(){
    if(!ctx) return; ctx.clearRect(0,0,SIG_W,SIG_H);
    strokes.forEach(s=>{ctx.beginPath();ctx.moveTo(s[0][0],s[0][1]);if(s.length===1)ctx.lineTo(s[0][0]+.1,s[0][1]+.1);for(let i=1;i<s.length;i++)ctx.lineTo(s[i][0],s[i][1]);ctx.stroke();});
  }
  function pt(e){const r=cv.getBoundingClientRect();return [Math.round((e.clientX-r.left)/r.width*SIG_W),Math.round((e.clientY-r.top)/r.height*SIG_H)];}
  cv.addEventListener("pointerdown",e=>{e.preventDefault();try{cv.setPointerCapture(e.pointerId);}catch(_){}cur=[pt(e)];strokes.push(cur);hint.hidden=true;redraw();});
  cv.addEventListener("pointermove",e=>{if(!cur)return;e.preventDefault();const p=pt(e),l=cur[cur.length-1];if(Math.abs(p[0]-l[0])+Math.abs(p[1]-l[1])<2)return;cur.push(p);redraw();});
  const end=()=>{cur=null;};
  cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
  requestAnimationFrame(size); window.addEventListener("resize",size);
  return {
    el:wrap,
    clear(){strokes.length=0;hint.hidden=false;redraw();},
    isValid(){return strokes.reduce((n,s)=>n+s.length,0)>=6;},
    value(){return JSON.stringify(strokes);}
  };
}

/* ---------- sheets ---------- */
function openSheet(build){
  const prevFocus=document.activeElement;
  const scrim=h("div",{class:"scrim"});
  const sheet=h("div",{class:"sheet",role:"dialog","aria-modal":"true"});
  const close=()=>{scrim.remove();if(prevFocus&&prevFocus.focus)try{prevFocus.focus();}catch(e){}};
  build(sheet,close);
  scrim.append(sheet);
  scrim.addEventListener("pointerdown",e=>{if(e.target===scrim)close();});
  document.addEventListener("keydown",function k(e){if(e.key==="Escape"){document.removeEventListener("keydown",k);close();}});
  document.body.append(scrim);
  const first=sheet.querySelector("input,select,button"); if(first&&!sheet.querySelector("canvas")) first.focus();
  return close;
}

/* ---------- writes ---------- */
async function safeWrite(fn,okMsg){
  try{await fn(); if(okMsg) toast(okMsg); return true;}
  catch(e){
    const c=(e&&e.code)||"";
    if(c.includes("permission-denied")) toast("You do not have permission to do that.");
    else if(c.includes("resource-exhausted")||c.includes("quota")) toast("The database limit has been reached. Tell the site team.");
    else if(c.includes("not-found")) toast("That record no longer exists. Reload and try again.");
    else toast("Could not save. Check your signal and try again.");
    return false;
  }
}

function sheetSignIn(opts){
  /* opts: {company, companyId, person|null (walk-in)} */
  openSheet((sheet,close)=>{
    const p=opts.person;
    const walk=!p;
    const first=h("input",{type:"text",id:"wf",autocomplete:"off",placeholder:"First name"});
    const last=h("input",{type:"text",id:"wl",autocomplete:"off",placeholder:"Surname"});
    const coName=h("input",{type:"text",id:"wc",autocomplete:"off",placeholder:"Company name",value:opts.company||""});
    const role=h("input",{type:"text",id:"wr",autocomplete:"off",placeholder:"e.g. GO, SPK, Spotter (optional)"});
    const tin=h("input",{type:"time",id:"tin",value:nowHM()});
    const pad=sigPad();
    const proj=projById(S.project)||{name:S.project,areas:[]};
    const areaSel=(proj.areas&&proj.areas.length)?h("select",{id:"area"},h("option",{value:""},"Not specified"),...proj.areas.map(a=>h("option",{value:a},a))):null;
    const err=h("div",{class:"err",role:"alert"});
    const go=h("button",{class:"btn primary",id:"goIn"},"Sign in");
    sheet.append(...[
      h("h2",null,walk?"Not on the list":fullName(p),h("small",null,walk?"Add your details and sign in to "+proj.name+".":(proj.name+"  ·  "+opts.company+(p.r?"  ·  "+p.r:"")))),
      walk?h("div",{style:"display:grid;gap:12px"},
        h("label",{class:"f",for:"wf"},"First name",first),
        h("label",{class:"f",for:"wl"},"Surname",last),
        h("label",{class:"f",for:"wc"},"Company",coName),
        h("label",{class:"f",for:"wr"},"Role",role)):null,
      areaSel?h("label",{class:"f",for:"area"},"Working area (optional)",areaSel):null,
      h("label",{class:"f",for:"tin"},"Time in",tin),
      h("div",{style:"display:grid;gap:6px"},h("div",{style:"font-weight:600;font-size:14px"},"Signature"),pad.el),
      err,
      h("div",{class:"row end"},
        h("button",{class:"btn",onclick:()=>pad.clear()},"Clear"),
        h("button",{class:"btn",onclick:close},"Cancel"),
        go)
    ].filter(Boolean));
    go.addEventListener("click",async()=>{
      err.textContent="";
      let rec;
      if(walk){
        const f=first.value.trim(),l=last.value.trim(),c=coName.value.trim();
        if(!f||!l){err.textContent="Enter your first name and surname.";return;}
        if(!c){err.textContent="Enter your company name.";return;}
        rec={personId:"w-"+slug(c)+"-"+slug(f+" "+l),company:c,companyId:"w-"+slug(c),name:fullName({f,l}),role:role.value.trim(),walkIn:true};
      }else{
        rec={personId:p.id,company:opts.company,companyId:opts.companyId,name:fullName(p),role:p.r||"",walkIn:false};
      }
      if(!tin.value){err.textContent="Enter your time in.";return;}
      if(!pad.isValid()){err.textContent="Sign in the box before you sign in.";return;}
      if(S.date!==S.today){err.textContent="Switch back to today to sign in.";return;}
      if(recFor(rec.personId)){err.textContent="This person is already signed in today.";return;}
      go.disabled=true;
      const doc={...rec,date:S.today,day:dayName(S.today),project:S.project,projectName:proj.name,area:areaSel?areaSel.value:"",timeIn:tin.value,timeOut:"",signedAt:new Date().toISOString()};
      const docId=S.today+"_"+S.project+"_"+rec.personId;
      const ok=await safeWrite(async()=>{
        await S.db.doc("sigs/"+docId).set({date:S.today,sig:pad.value()});   /* signatures are kept apart so only supervisors can read them */
        await S.db.doc("attendance/"+docId).set(doc);
      },"Signed in: "+rec.name);
      if(ok) close(); else go.disabled=false;
    });
  });
}

function sheetSignOut(r){
  openSheet((sheet,close)=>{
    const tout=h("input",{type:"time",id:"tout",value:r.date===S.today?nowHM():""});
    const err=h("div",{class:"err",role:"alert"});
    const go=h("button",{class:"btn dark"},"Sign out");
    sheet.append(...[
      h("h2",null,r.name,h("small",null,(r.projectName||"")+"  ·  "+r.company+"  ·  In at "+r.timeIn)),
      r.date!==S.today?h("div",{class:"banner warn"},"This entry is from "+dateLong(r.date)+". Enter the time the person actually left site."):null,
      h("label",{class:"f",for:"tout"},"Time out",tout),
      err,
      h("div",{class:"row end"},h("button",{class:"btn",onclick:close},"Cancel"),go)
    ].filter(Boolean));
    go.addEventListener("click",async()=>{
      if(!tout.value){err.textContent="Enter your time out.";return;}
      if(tout.value<r.timeIn){err.textContent="Time out is earlier than time in ("+r.timeIn+").";return;}
      go.disabled=true;
      const ok=await safeWrite(()=>S.db.doc("attendance/"+r._id).update({timeOut:tout.value,outAt:new Date().toISOString()}),"Signed out: "+r.name);
      if(ok) close(); else go.disabled=false;
    });
  });
}

/* ---------- Sign in pane ---------- */
function renderSign(){
  const pane=$("#pane-sign"); pane.replaceChildren();
  if(S.date!==S.today){
    pane.append(h("div",{class:"banner warn"},"You are viewing "+dateLong(S.date)+". Signing in is only for today."),
      h("button",{class:"btn primary",onclick:()=>{S.date=S.today;subscribeAtt();render();}},"Go to today"));
    return;
  }
  /* step 1: project */
  if(S.project&&!projById(S.project)&&S.loaded.projects) S.project=null;
  if(!S.project){
    pane.append(h("h2",null,"Which project are you on?"));
    if(!S.projects.length) pane.append(h("div",{class:"card empty"},S.loaded.projects?"No projects are set up yet.":"Loading projects...",h("br"),S.isAdmin&&S.loaded.projects?"Open Setup to add them.":""));
    S.projects.forEach(p=>pane.append(h("button",{class:"projbtn",onclick:()=>{S.project=p.id;S.company="";S.q="";S.view="";render();}},h("b",{text:p.name}),h("span",{"aria-hidden":"true"},"›"))));
    return;
  }
  const proj=projById(S.project);
  pane.append(h("div",{class:"card pad row",style:"justify-content:space-between"},
    h("div",null,h("div",{class:"muted small"},"Project"),h("b",{style:"font:700 24px/1 var(--display)",text:proj.name})),
    S.projects.length>1?h("button",{class:"btn sm",onclick:()=>{S.project=null;render();}},"Change project"):null));
  /* step 2: sign in or out */
  const seg=h("div",{class:"seg",role:"group","aria-label":"Action"},
    h("button",{"aria-pressed":String(S.mode==="in"),onclick:()=>{S.mode="in";S.q="";renderSign();}},"Sign in"),
    h("button",{"aria-pressed":String(S.mode==="out"),onclick:()=>{S.mode="out";S.q="";renderSign();}},"Sign out"));
  pane.append(seg);
  if(S.mode==="out") return renderSignOut(pane);
  if(!S.roster.length && S.loaded.roster){
    pane.append(h("div",{class:"card empty"},"No contractors are set up yet.",h("br"),S.isAdmin?"Open Setup to add them.":"Ask the site team to add your company."));
  }
  const sel=h("select",{id:"co","aria-label":"Company",onchange:e=>{S.company=e.target.value;S.q="";renderSign();}},
    h("option",{value:""},"Choose your company"),
    ...S.roster.map(c=>h("option",{value:c.id,selected:c.id===S.company},c.name)));
  pane.append(h("div",{class:"card pad",style:"display:grid;gap:12px"},
    h("h2",null,"Who are you signing in for?"),
    h("label",{class:"f",for:"co"},"Company",sel)));
  const co=coById(S.company);
  if(co){
    const inCount=co.people.filter(p=>recFor(p.id)).length;
    const q=h("input",{type:"search",id:"q",placeholder:"Search name",value:S.q,"aria-label":"Search names",autocomplete:"off"});
    const listBox=h("div",{class:"card"});
    q.addEventListener("input",()=>{S.q=q.value;drawList();});
    function drawList(){
      listBox.replaceChildren();
      const term=S.q.trim().toLowerCase();
      const ppl=co.people.filter(p=>!term||fullName(p).toLowerCase().includes(term))
        .sort((a,b)=>(fullName(a)).localeCompare(fullName(b)));
      const wrap=h("div",{class:"list"});
      ppl.forEach(p=>{
        const r=recFor(p.id);
        const meta=h("div",{class:"meta"},p.r?h("span",{class:"tag",text:p.r}):null);
        let right;
        if(!r) right=h("span",{class:"pill out",text:"Tap to sign in"});
        else if(!r.timeOut) right=h("span",{class:"pill in",text:"In "+r.timeIn+" · sign out"});
        else right=h("span",{class:"pill out",text:r.timeIn+"–"+r.timeOut});
        const row=h("button",{class:"person",onclick:()=>{
          if(!S.canWrite){toast("Read only.");return;}
          if(!r) sheetSignIn({company:co.name,companyId:co.id,person:p});
          else if(!r.timeOut) sheetSignOut(r);
          else toast(r.name+" has already signed out today.");
        }},h("div",{class:"who"},h("div",{class:"nm",text:fullName(p)}),meta),right);
        wrap.append(row);
      });
      if(!ppl.length) wrap.append(h("div",{class:"empty"},"No match for that search."));
      listBox.append(wrap);
    }
    drawList();
    pane.append(
      h("div",{class:"row",style:"justify-content:space-between"},
        h("h3",null,co.name),h("span",{class:"muted small",text:inCount+" of "+co.people.length+" signed in"})),
      q,listBox);
  }
  pane.append(h("button",{class:"btn",onclick:()=>{
      if(!S.canWrite){toast("Read only.");return;}
      sheetSignIn({company:co?co.name:"",companyId:co?co.id:"",person:null});
    }},"My name is not on the list"));
}
function renderSignOut(pane){
  const here=S.att.filter(a=>a.project===S.project&&!a.timeOut).sort((a,b)=>a.name.localeCompare(b.name));
  const q=h("input",{type:"search",id:"q",placeholder:"Search your name or company",value:S.q,"aria-label":"Search people on site",autocomplete:"off"});
  const box=h("div",{class:"card"});
  q.addEventListener("input",()=>{S.q=q.value;draw();});
  function draw(){
    box.replaceChildren();
    const t=S.q.trim().toLowerCase();
    const f=here.filter(r=>!t||(r.name+" "+r.company).toLowerCase().includes(t));
    const wrap=h("div",{class:"list"});
    f.forEach(r=>wrap.append(h("button",{class:"person",onclick:()=>{
        if(!S.canWrite){toast("Read only.");return;}
        sheetSignOut(r);}},
      h("div",{class:"who"},h("div",{class:"nm",text:r.name}),h("div",{class:"meta"},h("span",{text:r.company}))),
      h("span",{class:"pill in",text:"In "+r.timeIn}))));
    if(!f.length) wrap.append(h("div",{class:"empty"},here.length?"No match for that search.":"Nobody is signed in on this project yet."));
    box.append(wrap);
  }
  draw();
  pane.append(h("div",{class:"row",style:"justify-content:space-between"},h("h2",null,"Leaving site?"),h("span",{class:"muted small",text:here.length+" on site"})),
    h("div",{class:"muted small"},"Find your name, tap it and confirm your time out."),q,box);
}

/* ---------- On site (today list) ---------- */
function dateBar(){
  if(!S.isAdmin) return null;
  const inp=h("input",{type:"date",id:"dpick",value:S.date,max:S.today,"aria-label":"Date",onchange:e=>{if(!e.target.value)return;S.date=e.target.value;subscribeAtt();render();}});
  return h("div",{class:"row"},h("div",{style:"flex:1;min-width:150px"},inp),
    S.date!==S.today?h("button",{class:"btn sm",onclick:()=>{S.date=S.today;subscribeAtt();render();}},"Today"):null);
}
function renderList(){
  const pane=$("#pane-list"); pane.replaceChildren();
  const rows=att();
  const on=rows.filter(r=>!r.timeOut).length;
  pane.append(h("div",{class:"row",style:"justify-content:space-between"},
    h("h2",null,S.date===S.today?"On site today":"On site "+dateLong(S.date)),
    h("span",{class:"pill in",text:on+" here now"})));
  if(S.date===S.today) pane.append(h("button",{class:"btn danger",style:"border-width:2px;font-weight:700",onclick:openRollCall},"Emergency roll call"));
  const db=dateBar(); if(db) pane.append(db);
  const pb=projBar(); if(pb) pane.append(pb);
  const q=h("input",{type:"search",id:"lq",placeholder:"Search name or company","aria-label":"Search the list",value:S.listQ,autocomplete:"off"});
  const out=h("div",{style:"display:flex;flex-direction:column;gap:14px"});
  q.addEventListener("input",()=>{S.listQ=q.value;draw();});
  pane.append(q,out);
  function draw(){
    out.replaceChildren();
    const t=S.listQ.trim().toLowerCase();
    const f=rows.filter(r=>!t||(r.name+" "+r.company).toLowerCase().includes(t));
    if(!f.length){out.append(h("div",{class:"card empty"},rows.length?"No match for that search.":"Nobody has signed in yet."));return;}
    groupByCompany(f).forEach(g=>{
      const inN=g.rows.filter(r=>!r.timeOut).length;
      const list=h("div",{class:"list"});
      g.rows.forEach(r=>{
        const actions=[];
        if(S.canWrite&&!r.timeOut&&(S.date===S.today||S.isAdmin)) actions.push(h("button",{class:"btn sm",onclick:()=>sheetSignOut(r)},S.date===S.today?"Sign out":"Set time out"));
        if(S.isAdmin&&r.timeOut) actions.push(h("button",{class:"btn sm",onclick:async()=>{await safeWrite(()=>S.db.doc("attendance/"+r._id).update({timeOut:""}),"Sign-out removed");}},"Undo out"));
        if(S.isAdmin&&r.walkIn&&!(coById(r.companyId)&&coById(r.companyId).people.some(p=>p.id===r.personId))) actions.push(h("button",{class:"btn sm",onclick:()=>addWalkInToRoster(r)},"Add to roster"));
        if(S.isAdmin) actions.push(h("button",{class:"btn sm danger",onclick:()=>confirmDelete(r)},"Delete"));
        list.append(h("div",{class:"person",style:"flex-wrap:wrap"},
          h("div",{class:"who"},h("div",{class:"nm",text:r.name}),
            h("div",{class:"meta"},r.role?h("span",{class:"tag",text:r.role}):null,r.walkIn?h("span",{class:"tag",text:"Not on list"}):null,viewId()==="all"&&r.project?h("span",{class:"tag",text:r.projectName||projName(r.project)}):null,r.area?h("span",{class:"tag",text:r.area}):null)),
          h("div",{style:"display:flex;flex-direction:column;align-items:flex-end;gap:4px"},
            h("span",{class:"pill "+(r.timeOut?"out":"in"),text:r.timeOut?"Out":"On site"}),
            h("span",{class:"times",text:r.timeIn+" – "+(r.timeOut||"…")})),
          S.sigs[r._id]?sigSVG(S.sigs[r._id]):null,
          actions.length?h("div",{class:"row end",style:"width:100%"},actions):null));
      });
      out.append(h("div",{class:"card group"},h("div",{class:"grouphead"},h("h3",null,g.name),h("span",null,inN+" on site · "+g.rows.length+" signed in")),list));
    });
  }
  draw();
}
function confirmDelete(r){
  openSheet((sheet,close)=>{
    const go=h("button",{class:"btn danger"},"Delete entry");
    sheet.append(h("h2",null,"Delete this entry?",h("small",null,r.name+" · "+r.company+" · in at "+r.timeIn)),
      h("div",{class:"row end"},h("button",{class:"btn",onclick:close},"Keep it"),go));
    go.addEventListener("click",async()=>{go.disabled=true;const ok=await safeWrite(()=>S.db.doc("attendance/"+r._id).delete(),"Entry deleted");if(ok)close();else go.disabled=false;});
  });
}
async function addWalkInToRoster(r){
  let co=S.roster.find(c=>slug(c.name)===slug(r.company));
  const parts=r.name.split(" ");const f=parts.shift()||"",l=parts.join(" ");
  const person={id:"n"+Date.now().toString(36),f,l,r:r.role||"",n:""};
  if(co){
    const people=co.people.concat([person]);
    await safeWrite(()=>S.db.doc("roster/"+co.id).update({people}),"Added to "+co.name+" roster");
  }else{
    const id=slug(r.company);
    await safeWrite(()=>S.db.doc("roster/"+id).set({name:r.company,order:S.roster.length+1,people:[person]}),"Created "+r.company+" and added "+r.name);
  }
}

/* ---------- Emergency roll call ---------- */
function rollRows(){return viewRows().filter(r=>!r.timeOut&&r.date===S.today);}
function rollText(){
  const rows=rollRows(); const v=viewId();
  const lines=["EMERGENCY ROLL CALL","Okee Electrics - "+(v==="all"?"All projects":projName(v))+" - "+dateLong(S.today)+" "+nowHM(),"On site now: "+rows.length,""];
  groupByCompany(rows).forEach(g=>{lines.push(g.name.toUpperCase()+" ("+g.rows.length+")");g.rows.forEach(r=>lines.push("  [ ] "+r.name+(r.area?" ("+r.area+")":"")+"  in "+r.timeIn));lines.push("");});
  return lines.join("\n");
}
function openRollCall(){
  const ov=h("div",{class:"roll",role:"dialog","aria-modal":"true","aria-label":"Emergency roll call"});
  const close=()=>{S.onData=null;ov.remove();};
  const draw=()=>{
    const rows=rollRows(); const v=viewId();
    const ok=rows.filter(r=>S.muster.has(r._id)).length;
    ov.replaceChildren(
      h("div",{class:"rbar"},h("div",{class:"rbar-in"},
        h("div",null,h("h2",null,"Emergency roll call"),h("div",{class:"small",text:(v==="all"?"All projects":projName(v))+" · "+nowHM()})),
        h("div",{style:"text-align:right"},h("div",{class:"big",text:ok+" / "+rows.length}),h("div",{class:"small",style:"white-space:nowrap"},"accounted")),
        h("button",{class:"btn sm",onclick:close},"Close"))),
      h("div",{class:"rbody"},
        h("div",{class:"row"},
          h("button",{class:"btn sm",onclick:()=>{S.muster.clear();draw();}},"Clear ticks"),
          h("button",{class:"btn sm",onclick:async()=>{try{await navigator.clipboard.writeText(rollText());toast("List copied");}catch(e){showText(rollText());}}},"Copy list"),
          h("span",{class:"muted small"},"Ticks stay on this phone only.")),
        rows.length?groupByCompany(rows).map(g=>{
          const gok=g.rows.filter(r=>S.muster.has(r._id)).length;
          return h("div",{class:"card group"},h("div",{class:"grouphead"},h("h3",null,g.name),h("span",null,gok+" of "+g.rows.length+" accounted for")),
            h("div",{class:"list"},...g.rows.map(r=>h("div",{class:"person"},
              h("button",{class:"tick","aria-pressed":String(S.muster.has(r._id)),"aria-label":"Accounted for: "+r.name,onclick:()=>{S.muster.has(r._id)?S.muster.delete(r._id):S.muster.add(r._id);draw();}},"\u2713"),
              h("div",{class:"who"},h("div",{class:"nm",style:"font-size:18px",text:r.name}),
                h("div",{class:"meta"},r.role?h("span",{class:"tag",text:r.role}):null,v==="all"&&r.projectName?h("span",{class:"tag",text:r.projectName}):null,r.area?h("span",{class:"tag",text:r.area}):null)),
              h("span",{class:"times",text:"In "+r.timeIn})))));
        }):h("div",{class:"card empty"},"Nobody is signed in right now."))
    );
  };
  S.onData=draw; draw(); document.body.append(ov); ov.scrollTop=0;
}

/* ---------- Summary (site team) ---------- */

/* ---------- PDF report ---------- */
function pdfAscii(t){return String(t==null?"":t).normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^\x20-\x7E]/g,"?");}
async function makePdfBytes(){
  const L=window.PDFLib; if(!L) return null;
  const {PDFDocument,StandardFonts,rgb}=L;
  const doc=await PDFDocument.create();
  const fR=await doc.embedFont(StandardFonts.Helvetica), fB=await doc.embedFont(StandardFonts.HelveticaBold);
  const MM=72/25.4, PW=210, PH=297;
  const rows=att(), v=viewId(), showProj=v==="all", hasArea=rows.some(r=>r.area);
  const M=14,W=PW-2*M,RH=11;
  const C=(a)=>rgb(a[0]/255,a[1]/255,a[2]/255);
  const INK=[20,23,27],RED=[225,16,10],GREY=[90,98,108],LINE=[211,216,222],WHITE=[255,255,255],PALE=[238,240,243];
  const cols=[{k:"name",t:"Name",w:0},{k:"role",t:"Role",w:20}].concat(hasArea?[{k:"area",t:"Area",w:22}]:[]).concat(showProj?[{k:"proj",t:"Project",w:18}]:[]).concat([{k:"in",t:"In",w:14},{k:"out",t:"Out",w:14},{k:"sig",t:"Signature",w:30}]);
  cols[0].w=W-cols.reduce((n,c)=>n+c.w,0);
  const xs=[];let xx=M;cols.forEach(c=>{xs.push(xx);xx+=c.w;});
  let pg=doc.addPage([PW*MM,PH*MM]), y=M;
  const Y=mm=>(PH-mm)*MM, X=mm=>mm*MM;
  const txt=(str,x,base,size,bold,col,right)=>{
    str=pdfAscii(str); const f=bold?fB:fR;
    const w=f.widthOfTextAtSize(str,size);
    pg.drawText(str,{x:right?X(x)-w:X(x),y:Y(base),size,font:f,color:C(col)});
  };
  const rect=(x,top,w,h,col)=>pg.drawRectangle({x:X(x),y:Y(top+h),width:X(w),height:h*MM,color:C(col)});
  const hline=(x1,x2,yy,col,th)=>pg.drawLine({start:{x:X(x1),y:Y(yy)},end:{x:X(x2),y:Y(yy)},thickness:th,color:C(col)});
  const fit=(t,w)=>{t=pdfAscii(t);const max=(w-3)*MM;if(fR.widthOfTextAtSize(t,9.5)<=max)return t;while(t.length>1&&fR.widthOfTextAtSize(t+"...",9.5)>max)t=t.slice(0,-1);return t+"...";};
  /* title block */
  try{
    const img=document.querySelector(".top-row img");
    if(img&&img.src){const png=await doc.embedPng(await (await fetch(img.src)).arrayBuffer()); pg.drawImage(png,{x:X(M),y:Y(y+14.6),width:12*MM,height:14.6*MM});}
  }catch(e){}
  txt("DAILY SITE ATTENDANCE RECORD",M+16,y+6,16,true,INK);
  txt((v==="all"?"All projects":projName(v))+"   |   "+dayName(S.date)+" "+dateLong(S.date),M+16,y+12.5,10.5,false,GREY);
  y+=19; hline(M,M+W,y,RED,2.2); y+=7;
  const inN=rows.filter(r=>!r.timeOut).length, groups=groupByCompany(rows);
  txt("Signed in: "+rows.length+"      "+(S.date<S.today?"No time out: ":"On site now: ")+inN+"      Signed out: "+(rows.length-inN)+"      Companies: "+groups.length,M,y,10,true,INK);
  y+=6;
  const colHead=()=>{rect(M,y,W,7,PALE);cols.forEach((c,i)=>txt(c.t.toUpperCase(),xs[i]+1.5,y+4.8,8.5,true,GREY));y+=7;};
  const groupHead=(g,cont)=>{
    rect(M,y,W,8,INK); rect(M,y+8,W,0.7,RED);
    txt(g.name.toUpperCase()+(cont?"  (continued)":""),M+2,y+5.6,11,true,WHITE);
    txt(g.rows.filter(r=>!r.timeOut).length+" on site  |  "+g.rows.length+" signed in",M+W-2,y+5.5,9,false,WHITE,true);
    y+=8.7; colHead();
  };
  const sigDraw=(sig,bx,by,bw,bh)=>{
    let st=[];try{st=JSON.parse(sig||"[]");}catch(e){}
    const k=Math.min(bw/SIG_W,bh/SIG_H);
    st.forEach(s=>{
      if(!Array.isArray(s)||s.length<2) return;
      let d="M"+s[0][0]+" "+s[0][1]; for(let i=1;i<s.length;i++) d+=" L"+s[i][0]+" "+s[i][1];
      pg.drawSvgPath(d,{x:X(bx),y:Y(by),scale:k*MM,borderWidth:0.7,borderColor:C(INK),borderLineCap:L.LineCapStyle.Round});
    });
  };
  let anyWalk=false;
  groups.forEach(g=>{
    if(y+8.7+7+RH>PH-16){pg=doc.addPage([PW*MM,PH*MM]);y=M;}
    groupHead(g,false);
    g.rows.forEach(r=>{
      if(y+RH>PH-16){pg=doc.addPage([PW*MM,PH*MM]);y=M;groupHead(g,true);}
      if(r.walkIn) anyWalk=true;
      const vals={name:fit(r.name+(r.walkIn?" *":""),cols[0].w),role:fit(r.role||"",20),area:fit(r.area||"",22),proj:fit(r.projectName||projName(r.project),18),in:r.timeIn||"",out:r.timeOut||"-"};
      cols.forEach((c,i)=>{ if(c.k!=="sig") txt(vals[c.k],xs[i]+1.5,y+6.6,9.5,false,(c.k==="out"&&!r.timeOut)?RED:INK); });
      const si=cols.length-1; sigDraw(S.sigs[r._id],xs[si]+1.5,y+1,cols[si].w-3,RH-2);
      hline(M,M+W,y+RH,LINE,0.6); y+=RH;
    });
    y+=5;
  });
  if(!groups.length) txt("Nobody signed in on this day.",M,y,10,false,GREY);
  if(anyWalk) txt("* Not on the company roster",M,Math.min(y+2,PH-20),8.5,false,GREY);
  const pages=doc.getPages();
  pages.forEach((p,i)=>{pg=p;txt("Okee Electrics  |  Site Sign-In",M,PH-8,8,false,GREY);txt("Page "+(i+1)+" of "+pages.length+"  |  Created "+nowHM(),M+W,PH-8,8,false,GREY,true);});
  return await doc.save();
}
function summaryText(){
  const rows=att(); const lines=[];
  lines.push("DAILY SITE ATTENDANCE RECORD");
  lines.push((viewId()==="all"?"All projects":projName(viewId()))+" - "+dayName(S.date)+" "+dateLong(S.date));
  lines.push("Signed in: "+rows.length+" | On site now: "+rows.filter(r=>!r.timeOut).length+" | Signed out: "+rows.filter(r=>r.timeOut).length+" | Companies: "+new Set(rows.map(r=>r.company)).size);
  lines.push("");
  groupByCompany(rows).forEach(g=>{
    lines.push(g.name.toUpperCase()+" ("+g.rows.length+")");
    g.rows.forEach(r=>lines.push("  "+r.name+(r.area?" ("+r.area+")":"")+(viewId()==="all"&&r.projectName?" {"+r.projectName+"}":"")+"  "+r.timeIn+" - "+(r.timeOut||"not signed out")));
    lines.push("");
  });
  return lines.join("\n");
}
function csvText(){
  const esc=v=>{v=String(v==null?"":v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;};
  const head=["Date","Day","Project","Area","Company","Name","Role","Time in","Time out","Not on roster"];
  const out=[head.map(esc).join(",")];
  groupByCompany(att()).forEach(g=>g.rows.forEach(r=>out.push([r.date,r.day,r.projectName||projName(r.project),r.area||"",r.company,r.name,r.role,r.timeIn,r.timeOut,r.walkIn?"Yes":""].map(esc).join(","))));
  return "﻿"+out.join("\r\n");
}
function renderSummary(){
  const pane=$("#pane-summary"); pane.replaceChildren();
  const rows=att();
  const inN=rows.filter(r=>!r.timeOut).length, outN=rows.length-inN;
  const groups=groupByCompany(rows);
  const open=S.date<S.today?inN:0;
  pane.append(h("h2",null,"Daily summary"));
  const db=dateBar(); if(db) pane.append(db);
  const pb=projBar(); if(pb) pane.append(pb);
  const stale=staleRows();
  if(stale.length){
    const byDate=new Map(); stale.forEach(r=>{if(!byDate.has(r.date))byDate.set(r.date,[]);byDate.get(r.date).push(r);});
    const card=h("div",{class:"card group",style:"border-color:var(--bad)"},
      h("div",{class:"grouphead",style:"background:var(--bad)"},h("h3",null,"Forgotten sign-outs"),h("span",null,stale.length+" to fix")));
    const list=h("div",{class:"list"});
    byDate.forEach((rows,d)=>{
      list.append(h("div",{class:"muted small",style:"padding:10px 14px 0;font-weight:700"},dayName(d)+" "+dateLong(d)));
      rows.forEach(r=>list.append(h("div",{class:"person",style:"min-height:56px"},
        h("div",{class:"who"},h("div",{class:"nm",text:r.name}),h("div",{class:"meta"},h("span",{text:r.company}),r.projectName?h("span",{class:"tag",text:r.projectName}):null,h("span",{text:"In "+r.timeIn}))),
        S.canWrite?h("button",{class:"btn sm",onclick:()=>sheetSignOut(r)},"Set time out"):null)));
    });
    card.append(list); pane.append(card);
  }
  pane.append(h("div",{class:"tiles"},
    h("div",{class:"card tile t-total"},h("b",{text:rows.length}),h("span",null,"Signed in")),
    h("div",{class:"card tile t-in"},h("b",{text:inN}),h("span",null,S.date<S.today?"No time out":"On site now")),
    h("div",{class:"card tile"},h("b",{text:outN}),h("span",null,"Signed out")),
    h("div",{class:"card tile"},h("b",{text:groups.length}),h("span",null,"Companies"))));
  if(open) pane.append(h("div",{class:"banner warn"},open+" "+(open===1?"person has":"people have")+" no time out recorded for this day."));
  const walk=rows.filter(r=>r.walkIn).length;
  if(walk) pane.append(h("div",{class:"banner warn"},walk+" "+(walk===1?"person is":"people are")+" not on a roster. Check the On site tab."));
  if(!rows.length){pane.append(h("div",{class:"card empty"},"Nobody has signed in on "+dateLong(S.date)+"."));}
  else{
    const max=Math.max(...groups.map(g=>g.rows.length));
    const bars=h("div",{class:"bars"});
    groups.slice().sort((a,b)=>b.rows.length-a.rows.length||a.name.localeCompare(b.name)).forEach(g=>{
      const gi=g.rows.filter(r=>!r.timeOut).length, go=g.rows.length-gi;
      const ins=g.rows.map(r=>r.timeIn).sort()[0];
      bars.append(h("div",{class:"bar"},
        h("div",null,h("div",{class:"nm",text:g.name}),h("div",{class:"muted small",text:"First in "+ins})),
        h("div",{class:"track",role:"img","aria-label":g.name+": "+gi+" on site, "+go+" signed out"},
          h("div",{class:"seg-in",style:"width:"+(gi/max*100)+"%"}),h("div",{class:"seg-out",style:"width:"+(go/max*100)+"%"})),
        h("div",{class:"n",text:g.rows.length})));
    });
    pane.append(h("div",{class:"card pad",style:"display:grid;gap:12px"},
      h("h3",null,"By contractor"),bars,
      h("div",{class:"legend"},h("span",null,h("i",{style:"background:var(--good)"}),S.date<S.today?"No time out":"On site"),h("span",null,h("i",{style:"background:var(--muted);opacity:.55"}),"Signed out"))));
    const act=h("div",{class:"row"},
      h("button",{class:"btn primary",onclick:async()=>{
        try{await navigator.clipboard.writeText(summaryText());toast("Report copied");}
        catch(e){showText(summaryText());}}},"Copy report"),
      S.downloads?h("button",{class:"btn",onclick:async()=>{
        let blob=null; try{blob=await makePdfBytes();}catch(e){console.error(e);}
        if(!blob){toast("PDF is not available right now.");return;}
        try{await S.downloads.save({filename:"site-attendance-"+(viewId()==="all"?"all":projName(viewId()))+"-"+S.date+".pdf",data:blob});toast("PDF ready");}
        catch(e){if(!e||e.code!=="declined")toast("Could not create the PDF.");}}},"Download PDF"):null,
      S.downloads?h("button",{class:"btn",onclick:async()=>{
        try{await S.downloads.save({filename:"site-attendance-"+(viewId()==="all"?"all":projName(viewId()))+"-"+S.date+".csv",data:csvText()});}
        catch(e){if(!e||e.code!=="declined")toast("Could not create the file.");}}},"Download CSV"):null);
    pane.append(act);
  }
}
function showText(t){
  openSheet((sheet,close)=>{
    const ta=h("textarea",{readonly:true,style:"width:100%;min-height:240px;font:13px/1.4 monospace;padding:10px;border:1.5px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)"});
    ta.value=t;
    sheet.append(h("h2",null,"Report","",h("small",null,"Select all and copy.")),ta,h("div",{class:"row end"},h("button",{class:"btn",onclick:close},"Close")));
    ta.focus();ta.select();
  });
}

/* ---------- Setup (site team) ---------- */
function renderSetup(){
  const pane=$("#pane-setup"); pane.replaceChildren();
  pane.append(h("h2",null,"Setup"));
  pane.append(projectsCard());
  pane.append(accessCard(), membersCard(), importCard());
  const box=h("div",{class:"card"});
  S.roster.forEach(co=>{
    const nf=h("input",{type:"text",placeholder:"First name","aria-label":"First name"});
    const nl=h("input",{type:"text",placeholder:"Surname","aria-label":"Surname"});
    const nr=h("input",{type:"text",placeholder:"Role (optional)","aria-label":"Role",style:"grid-column:1/-1"});
    const people=h("div");
    const sq=h("input",{type:"search",placeholder:"Search "+co.name+" people","aria-label":"Search "+co.name+" people",autocomplete:"off"});
    sq.addEventListener("input",()=>{const t=sq.value.trim().toLowerCase();people.querySelectorAll(".rrow").forEach(r=>{r.hidden=!!t&&!r.dataset.n.includes(t);});});
    co.people.slice().sort((a,b)=>fullName(a).localeCompare(fullName(b))).forEach(p=>{
      people.append(h("div",{class:"rrow","data-n":fullName(p).toLowerCase()},h("span",null,fullName(p),p.r?" ":"",p.r?h("span",{class:"tag",text:p.r}):null),
        h("button",{class:"btn sm",onclick:()=>sheetEditPerson(co.id,p.id),"aria-label":"Edit "+fullName(p)},"Edit")));
    });
    box.append(h("details",{class:"co","data-id":co.id},
      h("summary",null,h("span",null,co.name),h("span",{class:"muted small",text:co.people.length+(co.people.length===1?" person":" people")})),
      h("div",{class:"inner"},
        h("div",{class:"row",style:"justify-content:space-between"},h("b",null,"Add a person"),
          h("button",{class:"btn sm",onclick:()=>sheetRenameCompany(co.id)},"Rename company")),
        h("div",{style:"display:grid;gap:8px;grid-template-columns:1fr 1fr"},nf,nl,nr),
        h("button",{class:"btn sm primary",onclick:async()=>{
          const f=nf.value.trim(),l=nl.value.trim(); if(!f||!l){toast("Enter a first name and surname.");return;}
          const cur=coById(co.id); if(!cur)return;
          const p={id:"n"+Date.now().toString(36),f,l,r:nr.value.trim()};
          await safeWrite(()=>S.db.doc("roster/"+co.id).update({people:cur.people.concat([p])}),"Added "+fullName(p));
        }},"Add person"),
        co.people.length>8?sq:null,
        people,
        h("button",{class:"btn sm danger",onclick:()=>confirmRemoveCompany(co)},"Remove company"))));
  });
  pane.append(h("h3",null,"Contractors"),box);
  const cn=h("input",{type:"text",id:"newco",placeholder:"New contractor name",autocomplete:"off"});
  pane.append(h("div",{class:"card pad",style:"display:grid;gap:10px"},h("label",{class:"f",for:"newco"},"Add a contractor",cn),
    h("div",{class:"row end"},h("button",{class:"btn sm primary",onclick:async()=>{
      const n=cn.value.trim(); if(!n){toast("Enter a company name.");return;}
      const id=slug(n); if(S.roster.some(c=>c.id===id)){toast("That company already exists.");return;}
      await safeWrite(()=>S.db.doc("roster/"+id).set({name:n,order:S.roster.length+1,people:[]}),"Added "+n);
    }},"Add contractor"))));
  /* keep open details open across live re-render */
}
function sheetEditPerson(coId,pid){
  const co0=coById(coId); const p0=co0&&co0.people.find(x=>x.id===pid); if(!p0) return;
  openSheet((sheet,close)=>{
    const f=h("input",{type:"text",id:"ef",value:p0.f||"",autocomplete:"off"});
    const l=h("input",{type:"text",id:"el",value:p0.l||"",autocomplete:"off"});
    const r=h("input",{type:"text",id:"er",value:p0.r||"",autocomplete:"off",placeholder:"e.g. GO, SPK, Spotter"});
    const err=h("div",{class:"err",role:"alert"});
    const save=h("button",{class:"btn primary"},"Save changes");
    const del=h("button",{class:"btn danger"},"Remove person");
    sheet.append(h("h2",null,"Edit person",h("small",null,co0.name)),
      h("label",{class:"f",for:"ef"},"First name",f),h("label",{class:"f",for:"el"},"Surname",l),h("label",{class:"f",for:"er"},"Role (optional)",r),err,
      h("div",{class:"row",style:"justify-content:space-between"},del,h("div",{class:"row"},h("button",{class:"btn",onclick:close},"Cancel"),save)));
    save.addEventListener("click",async()=>{
      const fv=f.value.trim(),lv=l.value.trim(); if(!fv||!lv){err.textContent="Enter a first name and surname.";return;}
      const cur=coById(coId); if(!cur){close();return;}
      save.disabled=true;
      const ok=await safeWrite(()=>S.db.doc("roster/"+coId).update({people:cur.people.map(x=>x.id===pid?{...x,f:fv,l:lv,r:r.value.trim()}:x)}),"Saved "+fv+" "+lv);
      if(ok) close(); else save.disabled=false;
    });
    let armed=false;
    del.addEventListener("click",async()=>{
      if(!armed){armed=true;del.textContent="Tap again to remove";return;}
      const cur=coById(coId); if(!cur){close();return;}
      del.disabled=true;
      const ok=await safeWrite(()=>S.db.doc("roster/"+coId).update({people:cur.people.filter(x=>x.id!==pid)}),"Removed "+fullName(p0));
      if(ok) close(); else del.disabled=false;
    });
  });
}
function sheetRenameCompany(coId){
  const co0=coById(coId); if(!co0) return;
  openSheet((sheet,close)=>{
    const n=h("input",{type:"text",id:"cn",value:co0.name,autocomplete:"off"});
    const err=h("div",{class:"err",role:"alert"});
    const save=h("button",{class:"btn primary"},"Save name");
    sheet.append(h("h2",null,"Rename company",h("small",null,"Earlier sign-ins keep the name they were made under.")),
      h("label",{class:"f",for:"cn"},"Company name",n),err,
      h("div",{class:"row end"},h("button",{class:"btn",onclick:close},"Cancel"),save));
    save.addEventListener("click",async()=>{
      const v=n.value.trim(); if(!v){err.textContent="Enter a company name.";return;}
      if(S.roster.some(c=>c.id!==coId&&c.name.toLowerCase()===v.toLowerCase())){err.textContent="Another company already has that name.";return;}
      save.disabled=true;
      const ok=await safeWrite(()=>S.db.doc("roster/"+coId).update({name:v}),"Renamed to "+v);
      if(ok) close(); else save.disabled=false;
    });
  });
}
function saveProjects(list,msg){return safeWrite(()=>S.db.doc("config/projects").set({list}),msg||"Saved");}
function projectsCard(){
  const card=h("div",{class:"card pad",style:"display:grid;gap:12px"});
  card.append(h("h3",null,"Projects and working areas"),
    h("div",{class:"muted small"},"Each project appears on the first Sign in screen. Add working areas to a project and people will be asked which area they are working in. Leave a project without areas to hide that question."));
  S.projects.forEach(p=>{
    const areas=h("div",{class:"row"});
    (p.areas||[]).forEach(a=>areas.append(h("button",{class:"tag",style:"min-height:32px;padding:4px 10px;font-size:13px","aria-label":"Remove area "+a,onclick:()=>saveProjects(S.projects.map(x=>x.id===p.id?{...x,areas:x.areas.filter(y=>y!==a)}:x),"Area removed")},a+"  ✕")));
    const ai=h("input",{type:"text",placeholder:"Add a working area","aria-label":"Add working area to "+p.name,autocomplete:"off"});
    card.append(h("div",{style:"border-top:1px solid var(--line);padding-top:12px;display:grid;gap:8px"},
      h("div",{class:"row",style:"justify-content:space-between"},h("b",{style:"font:700 20px/1 var(--display)",text:p.name}),
        h("button",{class:"btn sm danger",onclick:()=>confirmRemoveProject(p)},"Remove project")),
      areas.children.length?areas:h("div",{class:"muted small"},"No areas. The area question is hidden."),
      h("div",{class:"row"},h("div",{style:"flex:1;min-width:150px"},ai),h("button",{class:"btn sm",onclick:()=>{
        const v=ai.value.trim(); if(!v)return; if((p.areas||[]).includes(v)){toast("That area exists.");return;}
        saveProjects(S.projects.map(x=>x.id===p.id?{...x,areas:(x.areas||[]).concat([v])}:x),"Area added");}},"Add area"))));
  });
  const ni=h("input",{type:"text",id:"newproj",placeholder:"New project, e.g. HEL18",autocomplete:"off","aria-label":"New project name"});
  card.append(h("div",{style:"border-top:1px solid var(--line);padding-top:12px;display:grid;gap:8px"},ni,
    h("div",{class:"row end"},h("button",{class:"btn sm primary",onclick:()=>{
      const n=ni.value.trim(); if(!n){toast("Enter a project name.");return;}
      const id=slug(n); if(S.projects.some(x=>x.id===id)){toast("That project exists.");return;}
      saveProjects(S.projects.concat([{id,name:n,areas:[]}]),"Added "+n);}},"Add project"))));
  return card;
}
function confirmRemoveProject(p){
  openSheet((sheet,close)=>{
    const go=h("button",{class:"btn danger"},"Remove project");
    sheet.append(h("h2",null,"Remove "+p.name+"?",h("small",null,"People can no longer choose it. Past sign-ins stay in the daily records.")),
      h("div",{class:"row end"},h("button",{class:"btn",onclick:close},"Keep it"),go));
    go.addEventListener("click",async()=>{go.disabled=true;const ok=await saveProjects(S.projects.filter(x=>x.id!==p.id),p.name+" removed");if(ok)close();else go.disabled=false;});
  });
}
function accessCard(){
  return h("div",{class:"card pad",style:"display:grid;gap:8px"},
    h("h3",null,"Who can do what"),
    h("div",{class:"small"},h("b",null,"Contractors: "),"just open the link on their phone. No account. They see Sign in only."),
    h("div",{class:"small"},h("b",null,"Supervisors: "),"sign in with Google or email (link at the bottom of the page) once you add their email below. They also see On site and can sign people out."),
    h("div",{class:"small"},h("b",null,"OKEE site team: "),"added below as site team, or listed as an owner in the security rules. They see everything, including Summary and Setup."));
}
function membersCard(){
  const card=h("div",{class:"card pad",style:"display:grid;gap:10px"});
  card.append(h("h3",null,"Supervisors and site team"));
  const list=h("div");
  if(!S.members.length) list.append(h("div",{class:"muted small"},"Nobody added yet. Owners listed in the security rules always have site team access."));
  S.members.slice().sort((a,b)=>a.id.localeCompare(b.id)).forEach(m=>list.append(h("div",{class:"rrow"},
    h("span",null,m.id," ",h("span",{class:"tag",text:m.role==="site"?"Site team":"Supervisor"})),
    h("button",{class:"btn sm danger",onclick:()=>safeWrite(()=>S.db.doc("members/"+m.id).delete(),"Removed "+m.id)},"Remove"))));
  const em=h("input",{type:"email",id:"memail",placeholder:"Their email address","aria-label":"Email address",autocomplete:"off",inputmode:"email"});
  const rl=h("select",{id:"mrole","aria-label":"Level"},h("option",{value:"supervisor"},"Supervisor"),h("option",{value:"site"},"OKEE site team"));
  card.append(list,em,rl,h("div",{class:"row end"},h("button",{class:"btn sm primary",onclick:async()=>{
    const v=em.value.trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)){toast("Enter a valid email address.");return;}
    const ok=await safeWrite(()=>S.db.doc("members/"+v).set({role:rl.value}),"Added "+v); if(ok) em.value="";
  }},"Add person")));
  return card;
}
/* ---------- import people ---------- */
function parseLines(text){
  const map=new Map();
  text.split(/\r?\n/).forEach(line=>{
    const parts=line.split(",").map(x=>x.trim()); if(parts.length<2||!parts[0]||!parts[1]) return;
    const bits=parts[1].split(/\s+/); const f=bits.shift(), l=bits.join(" "); if(!f||!l) return;
    if(!map.has(parts[0])) map.set(parts[0],[]);
    map.get(parts[0]).push({f,l,r:parts[2]||""});
  });
  return [...map.entries()].map(([name,people])=>({name,people}));
}
async function importRoster(list){
  let added=0,created=0;
  for(const c of list){
    if(!c||!c.name||!Array.isArray(c.people)) continue;
    const id=slug(c.name), cur=S.roster.find(x=>x.id===id);
    const seen=new Set(cur?cur.people.map(p=>fullName(p).toLowerCase()):[]);
    const fresh=[];
    c.people.forEach((p,i)=>{const f=String(p.f||"").trim(),l=String(p.l||"").trim(); if(!f||!l)return; const k=(f+" "+l).toLowerCase(); if(seen.has(k))return; seen.add(k);
      fresh.push({id:"i"+Date.now().toString(36)+"-"+fresh.length+"-"+i,f,l,r:String(p.r||"").trim()});});
    if(!fresh.length) continue;
    const ok=cur?await safeWrite(()=>S.db.doc("roster/"+id).update({people:cur.people.concat(fresh)})):await safeWrite(()=>S.db.doc("roster/"+id).set({name:c.name,order:S.roster.length+created+1,people:fresh}));
    if(!ok) return toast("Import stopped. "+added+" people were added first.");
    added+=fresh.length; if(!cur) created++;
  }
  toast("Imported "+added+" "+(added===1?"person":"people")+(created?" and "+created+" new "+(created===1?"company":"companies"):""));
}
function importCard(){
  const card=h("div",{class:"card pad",style:"display:grid;gap:10px"});
  const file=h("input",{type:"file",accept:".json,application/json","aria-label":"Choose a roster file"});
  const ta=h("textarea",{rows:"4",placeholder:"One per line:\nCompany, First Surname, Role (optional)",style:"width:100%;padding:10px;border:1.5px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);font:inherit"});
  card.append(h("h3",null,"Import people"),
    h("div",{class:"muted small"},"Add many people at once. Companies and people that already exist are skipped."),
    h("label",{class:"f"},"Roster file (.json)",file),
    h("div",{class:"row end"},h("button",{class:"btn sm primary",onclick:async()=>{
      const f=file.files&&file.files[0]; if(!f){toast("Choose a file first.");return;}
      let data; try{data=JSON.parse(await f.text());}catch(e){toast("That file could not be read.");return;}
      if(!Array.isArray(data)){toast("That file is not a roster.");return;}
      await importRoster(data); file.value="";}},"Import file")),
    h("label",{class:"f"},"Or paste a list",ta),
    h("div",{class:"row end"},h("button",{class:"btn sm primary",onclick:async()=>{
      const list=parseLines(ta.value); if(!list.length){toast("Nothing to import. Use: Company, First Surname");return;}
      await importRoster(list); ta.value="";}},"Import list")));
  return card;
}
function confirmRemoveCompany(co){
  openSheet((sheet,close)=>{
    const go=h("button",{class:"btn danger"},"Remove company");
    sheet.append(h("h2",null,"Remove "+co.name+"?",h("small",null,"Its roster of "+co.people.length+" people is deleted. Past sign-ins stay in the daily records.")),
      h("div",{class:"row end"},h("button",{class:"btn",onclick:close},"Keep it"),go));
    go.addEventListener("click",async()=>{go.disabled=true;const ok=await safeWrite(()=>S.db.doc("roster/"+co.id).delete(),co.name+" removed");if(ok)close();else go.disabled=false;});
  });
}

/* ---------- footer: staff sign-in ---------- */
function renderFoot(){
  const ft=$("#foot"); if(!ft||!S.B) return;
  ft.replaceChildren();
  if(S.B.email) ft.append(h("span",{class:"muted small",text:"Signed in as "+S.B.email}),h("button",{class:"btn sm",onclick:()=>S.B.signOut()},"Sign out"));
  else ft.append(h("button",{class:"btn sm",onclick:()=>S.B.signIn()},"OKEE Site Team Sign-In"));
}

/* ---------- render ---------- */
function render(soft){
  if(S.onData) S.onData();
  $("#dayName").textContent=dayName(S.date);
  $("#dateLong").textContent=dateLong(S.date);
  $("#siteTitle").textContent="Site Sign-In";
  $("#subTxt").textContent=(S.project&&projById(S.project)?projName(S.project)+" · ":"")+"Okee Electrics";
  const chip=$("#roleChip"); const rl=S.isAdmin?"OKEE site team":(S.isSuper?"Supervisor":"");
  chip.hidden=!rl; chip.textContent=rl;
  const st=$("#status");
  if(!S.booted){st.hidden=true;}
  else if(!S.db){st.hidden=false;st.className="banner bad";st.textContent="The sign-in list is not available. Check your signal and reload the page.";}
  else if(!S.reachable){st.hidden=false;st.className="banner warn";st.textContent="Cannot reach the shared list yet. What you see may be out of date.";}
  else st.hidden=true;
  renderTabs();
  renderFoot();
  const keepOpen=[...document.querySelectorAll("#pane-setup details[open]")].map(d=>d.dataset.id);
  const ae=document.activeElement; const typing=ae&&ae.tagName==="INPUT"&&ae.closest("#main");
  const rendersByTab={sign:renderSign,list:renderList,summary:renderSummary,setup:renderSetup};
  if(soft && typing) return; // live updates must not wipe what someone is typing
  rendersByTab[S.tab]();
  if(S.tab==="setup") document.querySelectorAll("#pane-setup details").forEach(d=>{if(keepOpen.includes(d.dataset.id))d.open=true;});
}

/* ---------- subscriptions ---------- */
function subscribeAtt(){
  if(S.unsubAtt){S.unsubAtt();S.unsubAtt=null;}
  S.att=[]; S.loaded.att=false;
  if(!S.db) return;
  if(S.unsubSigs){S.unsubSigs();S.unsubSigs=null;} S.sigs={};
  if(S.isAdmin||S.isSuper) S.unsubSigs=S.db.collection("sigs").where("date","==",S.date).onSnapshot(snap=>{
    const m={}; snap.docs.forEach(d=>{m[d.id]=d.data().sig;}); S.sigs=m; render(true);
  },()=>{});
  S.unsubAtt=S.db.collection("attendance").where("date","==",S.date).onSnapshot(snap=>{
    S.att=snap.docs.map(d=>({...d.data(),_id:d.id}));
    S.loaded.att=true; if(!snap.metadata.fromCache){S.reachable=true;clearTimeout(S.connectTimer);}
    render(true);
  },e=>{S.reachable=false;render(true);});
}
function subscribe(){
  S.connectTimer=setTimeout(()=>{S.reachable=false;render(true);},10000);
  S.db.collection("roster").onSnapshot(snap=>{
    S.roster=snap.docs.map(d=>({...d.data(),id:d.id})).sort((a,b)=>(a.order||999)-(b.order||999)||a.name.localeCompare(b.name));
    S.loaded.roster=true; render(true);
  },()=>{S.reachable=false;render(true);});
  if(S.isAdmin) S.db.collection("members").onSnapshot(snap=>{
    S.members=snap.docs.map(d=>({id:d.id,role:d.data().role})); render(true);
  },()=>{});
  if(S.isAdmin) S.db.collection("attendance").where("timeOut","==","").onSnapshot(snap=>{
    S.openAll=snap.docs.map(d=>({...d.data(),_id:d.id})); render(true);
  },()=>{});
  S.db.doc("config/projects").onSnapshot(snap=>{
    S.projects=(snap.exists&&Array.isArray(snap.data().list))?snap.data().list:[];
    S.loaded.projects=true; render(true);
  },()=>{});
  subscribeAtt();
}

/* roll to a new day if the page stays open overnight */
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState!=="visible") return;
  const t=todayStr();
  if(t!==S.today){const was=S.date===S.today;S.today=t;if(was){S.date=t;subscribeAtt();}render();}
});

/* ---------- boot ---------- */
async function boot(){
  render(true);
  let B=null; try{ B=await window.__siBackend; }catch(e){ B=null; }
  if(B){
    S.B=B; S.db=B.db; S.isAdmin=B.role==="site"; S.isSuper=B.role==="supervisor";
    S.downloads={save:o=>B.download(o.filename,o.data)};
  }
  S.booted=true;
  render();
  if(S.db) subscribe();
}
boot();
})();