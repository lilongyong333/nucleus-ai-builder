import type { AppManifest, AppRuntimeActor, GeneratedFiles } from "./types";

const MAX_FILE_SIZE = 120_000;

export const starterFiles: GeneratedFiles = {
  "index.html": `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Focus Board</title></head>
  <body>
    <main class="app-shell">
      <header><div><span class="eyebrow">NUCLEUS DEMO</span><h1>今天，把重要的事做完。</h1><p>一个真正可点击、可新增、可完成的任务面板。</p></div><div class="score"><strong id="done-count">0</strong><span>已完成</span></div></header>
      <form id="task-form"><input id="task-input" placeholder="添加一个任务…" autocomplete="off"><button>添加任务</button></form>
      <div class="filter-row"><button class="filter active" data-filter="all">全部</button><button class="filter" data-filter="open">进行中</button><button class="filter" data-filter="done">已完成</button></div>
      <ul id="task-list"></ul>
    </main>
  </body>
</html>`,
  "styles.css": `*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f4f1eb;color:#1f211d;font-family:Inter,ui-sans-serif,system-ui;display:grid;place-items:center;padding:32px}.app-shell{width:min(760px,100%);background:#fffdf8;border:1px solid #dedbd2;border-radius:28px;padding:36px;box-shadow:0 24px 80px rgba(40,35,28,.1)}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}h1{font-size:clamp(30px,5vw,52px);line-height:1.02;letter-spacing:-.05em;margin:10px 0 12px}p{color:#77746c;margin:0}.eyebrow{font-size:11px;font-weight:800;letter-spacing:.16em;color:#d35d37}.score{width:94px;height:94px;border-radius:50%;background:#e8ff73;display:grid;place-content:center;text-align:center;flex:0 0 auto}.score strong{font-size:30px}.score span{font-size:11px}form{display:flex;gap:10px;margin:34px 0 18px}input{flex:1;border:1px solid #d9d6cc;background:#f8f6f1;border-radius:14px;padding:15px 17px;font:inherit;outline:none}input:focus{border-color:#1f211d}button{border:0;border-radius:14px;background:#20221e;color:white;padding:0 20px;font-weight:700;cursor:pointer}.filter-row{display:flex;gap:8px;margin-bottom:14px}.filter{background:#efede7;color:#77746c;padding:9px 13px;font-size:12px}.filter.active{background:#20221e;color:white}ul{list-style:none;padding:0;margin:0;display:grid;gap:9px}.task{display:flex;align-items:center;gap:13px;padding:15px;border:1px solid #e4e1d8;border-radius:15px}.task input{display:none}.check{width:22px;height:22px;border-radius:7px;border:1px solid #bbb7ac;display:grid;place-content:center;cursor:pointer}.task.done .check{background:#20221e;color:#e8ff73}.task.done .label{text-decoration:line-through;color:#aaa69d}.label{flex:1}.delete{background:transparent;color:#aaa69d;padding:6px}.empty{text-align:center;color:#aaa69d;padding:34px}@media(max-width:560px){body{padding:14px}.app-shell{padding:24px;border-radius:22px}header{display:block}.score{display:none}form{flex-direction:column}form button{height:48px}}`,
  "script.js": `const seed=['整理面试项目需求','完成核心生成链路','准备 60 秒演示'];let tasks=seed.map((text,i)=>({id:i+1,text,done:i===0}));let filter='all';const list=document.querySelector('#task-list');const count=document.querySelector('#done-count');function render(){const shown=tasks.filter(t=>filter==='all'||(filter==='done'?t.done:!t.done));count.textContent=tasks.filter(t=>t.done).length;list.innerHTML=shown.length?shown.map(t=>'<li class="task '+(t.done?'done':'')+'"><button class="check" data-toggle="'+t.id+'">'+(t.done?'✓':'')+'</button><span class="label">'+escapeHtml(t.text)+'</span><button class="delete" aria-label="删除" data-delete="'+t.id+'">×</button></li>').join(''):'<li class="empty">这里暂时没有任务</li>'}function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}document.querySelector('#task-form').addEventListener('submit',e=>{e.preventDefault();const input=document.querySelector('#task-input');const text=input.value.trim();if(!text)return;tasks.unshift({id:Date.now(),text,done:false});input.value='';render()});list.addEventListener('click',e=>{const toggle=e.target.closest('[data-toggle]');const del=e.target.closest('[data-delete]');if(toggle){const t=tasks.find(x=>x.id===Number(toggle.dataset.toggle));if(t)t.done=!t.done}if(del)tasks=tasks.filter(x=>x.id!==Number(del.dataset.delete));render()});document.querySelectorAll('.filter').forEach(btn=>btn.addEventListener('click',()=>{filter=btn.dataset.filter;document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x===btn));render()}));render();`,
};

export function normalizeGeneratedFiles(input: unknown): GeneratedFiles {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const result = {} as GeneratedFiles;
  for (const path of ["index.html", "styles.css", "script.js"] as const) {
    const value = raw[path];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`模型没有生成 ${path}`);
    }
    if (value.length > MAX_FILE_SIZE) throw new Error(`${path} 超过安全大小限制`);
    result[path] = value.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
  }
  return result;
}

export type PreviewRuntimeOptions = {
  projectId?: string;
  versionId?: string | null;
  token?: string;
  actor?: AppRuntimeActor | null;
  manifest?: AppManifest | null;
  source?: "preview" | "published";
};

export function composePreview(files: GeneratedFiles, options: PreviewRuntimeOptions = {}): string {
  const style = files["styles.css"].replace(/<\/style/gi, "<\\/style");
  const script = files["script.js"].replace(/<\/script/gi, "<\\/script");
  let html = files["index.html"];
  const config = JSON.stringify({
    projectId: options.projectId ?? null,
    versionId: options.versionId ?? null,
    token: options.token ?? null,
    actor: options.actor ?? null,
    manifest: options.manifest ?? null,
    source: options.source ?? "preview",
    basePath: options.projectId ? `/api/app-runtime/${options.projectId}` : null,
  }).replace(/<\//g, "<\\/");
  const runtime = `<script>(function(){
var config=${config};
try{var probe='__nucleus_probe__';localStorage.setItem(probe,'1');localStorage.removeItem(probe)}catch(e){var memory={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:function(k){return Object.prototype.hasOwnProperty.call(memory,k)?memory[k]:null},setItem:function(k,v){memory[k]=String(v)},removeItem:function(k){delete memory[k]},clear:function(){memory={}},key:function(i){return Object.keys(memory)[i]||null},get length(){return Object.keys(memory).length}}})}
window.__nucleusRuntimeFailed=false;
var eventQueue=[];var eventTimer=null;var emitted=0;
function printable(value){if(typeof value==='string')return value;try{return JSON.stringify(value)}catch(e){return String(value)}}
function evidence(){var headings=Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).slice(0,12).map(function(el){return el.textContent.trim().slice(0,120)});var controls=Array.prototype.slice.call(document.querySelectorAll('button,input,select,textarea,a')).slice(0,30).map(function(el){return {tag:el.tagName.toLowerCase(),text:(el.textContent||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim().slice(0,100),id:el.id||null}});return {title:document.title,viewport:{width:innerWidth,height:innerHeight},headings:headings,controls:controls,html:(document.body&&document.body.innerHTML||'').slice(0,6000)}}
function flushEvents(){eventTimer=null;if(!config.basePath||!config.token||eventQueue.length===0)return;var events=eventQueue.splice(0,30);fetch(config.basePath+'/events',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.token},body:JSON.stringify({versionId:config.versionId,source:config.source,events:events})}).catch(function(){eventQueue=events.concat(eventQueue).slice(0,60)})}
function queueEvent(level,message,extra){if(!config.token)return;eventQueue.push({level:level,message:String(message).slice(0,2000),evidence:extra||{}});if(eventQueue.length>=20)flushEvents();else if(!eventTimer)eventTimer=setTimeout(flushEvents,900)}
async function api(path,init){if(!config.basePath||!config.token)throw new Error('Nucleus runtime API is not available for this preview');var response=await fetch(config.basePath+path,Object.assign({},init||{},{headers:Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+config.token},init&&init.headers||{})}));var data=response.status===204?null:await response.json().catch(function(){return null});if(!response.ok)throw new Error(data&&data.error||('Runtime API '+response.status));return data}
window.nucleus={
  manifest:config.manifest,
  auth:{current:config.actor,ready:Promise.resolve(config.actor)},
  data:{
    list:async function(collection,query){var params=new URLSearchParams(query||{});var data=await api('/records/'+encodeURIComponent(collection)+(params.toString()?'?'+params:''));return data.records},
    create:async function(collection,value){var data=await api('/records/'+encodeURIComponent(collection),{method:'POST',body:JSON.stringify(value)});return data.record},
    update:async function(collection,id,value){var data=await api('/records/'+encodeURIComponent(collection)+'/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(value)});return data.record},
    remove:async function(collection,id){await api('/records/'+encodeURIComponent(collection)+'/'+encodeURIComponent(id),{method:'DELETE'});return true}
  },
  logs:{info:function(message,extra){queueEvent('info',message,extra)},warn:function(message,extra){queueEvent('warn',message,extra)},error:function(message,extra){queueEvent('error',message,extra)}},
  capabilities:config.manifest&&config.manifest.capabilities||{}
};
['log','info','warn','error'].forEach(function(level){var original=console[level];console[level]=function(){var args=Array.prototype.slice.call(arguments);var message=args.map(printable).join(' ');if(emitted<200){emitted+=1;parent.postMessage({source:'nucleus-preview',type:'console',level:level,message:message},'*');queueEvent(level==='log'?'info':level,message,{console:true})}return original.apply(console,args)}});
window.addEventListener('error',function(e){window.__nucleusRuntimeFailed=true;var detail={stack:e.error&&e.error.stack||null,filename:e.filename||null,line:e.lineno||null,column:e.colno||null,dom:evidence()};parent.postMessage({source:'nucleus-preview',type:'error',message:e.message,detail:detail},'*');queueEvent('error',e.message,detail)});
window.addEventListener('unhandledrejection',function(e){window.__nucleusRuntimeFailed=true;var message=printable(e.reason);var detail={stack:e.reason&&e.reason.stack||null,dom:evidence()};parent.postMessage({source:'nucleus-preview',type:'error',message:message,detail:detail},'*');queueEvent('error',message,detail)});
var picker=false;var hover=null;var overlay=null;
function selectorFor(el){if(el.id)return '#'+CSS.escape(el.id);var test=el.getAttribute('data-testid');if(test)return '[data-testid="'+CSS.escape(test)+'"]';var parts=[];while(el&&el.nodeType===1&&el!==document.body){var part=el.tagName.toLowerCase();var parentEl=el.parentElement;if(parentEl){var siblings=Array.prototype.filter.call(parentEl.children,function(child){return child.tagName===el.tagName});if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(el)+1)+')'}parts.unshift(part);el=parentEl;if(parts.length>=6)break}return 'body > '+parts.join(' > ')}
function describe(el){var rect=el.getBoundingClientRect();var computed=getComputedStyle(el);var attrs={};['id','class','role','aria-label','data-testid'].forEach(function(name){var value=el.getAttribute(name);if(value)attrs[name]=value.slice(0,240)});return {selector:selectorFor(el),tag:el.tagName.toLowerCase(),text:(el.textContent||'').trim().slice(0,500),attributes:attrs,rect:{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)},styles:{color:computed.color,backgroundColor:computed.backgroundColor,fontSize:computed.fontSize,fontWeight:computed.fontWeight,borderRadius:computed.borderRadius,padding:computed.padding,margin:computed.margin,gap:computed.gap,width:computed.width,height:computed.height,textAlign:computed.textAlign,display:computed.display,flexDirection:computed.flexDirection,justifyContent:computed.justifyContent,alignItems:computed.alignItems,gridTemplateColumns:computed.gridTemplateColumns}}}
function ensureOverlay(){if(overlay)return;overlay=document.createElement('div');overlay.setAttribute('data-nucleus-overlay','true');overlay.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4968ff;background:rgba(73,104,255,.08);box-shadow:0 0 0 1px rgba(255,255,255,.9);display:none';document.documentElement.appendChild(overlay)}
function moveOverlay(el){ensureOverlay();var rect=el.getBoundingClientRect();overlay.style.display='block';overlay.style.left=rect.left+'px';overlay.style.top=rect.top+'px';overlay.style.width=rect.width+'px';overlay.style.height=rect.height+'px'}
function targetFromEvent(event){var target=event.target;if(!(target instanceof Element)||target===overlay||target.closest('[data-nucleus-overlay]'))return null;return target}
function hoverHandler(event){if(!picker)return;var target=targetFromEvent(event);if(!target)return;hover=target;moveOverlay(target)}
function clickHandler(event){if(!picker)return;var target=hover||targetFromEvent(event);if(!target)return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();var description=describe(target);picker=false;hover=null;if(overlay)overlay.style.display='none';document.documentElement.style.cursor='';parent.postMessage({source:'nucleus-preview',type:'element-selected',element:description},'*')}
function touchHandler(event){if(!picker)return;var target=targetFromEvent(event);if(!target)return;hover=target;moveOverlay(target)}
document.addEventListener('pointerover',hoverHandler,true);document.addEventListener('touchstart',touchHandler,{capture:true,passive:true});document.addEventListener('click',clickHandler,true);
window.addEventListener('message',function(event){var data=event.data||{};if(data.source!=='nucleus-host')return;if(data.type==='picker'){picker=Boolean(data.enabled);document.documentElement.style.cursor=picker?'crosshair':'';if(!picker&&overlay)overlay.style.display='none'}if(data.type==='visual-patch'&&typeof data.selector==='string'){var el=document.querySelector(data.selector);if(!el)return;if(typeof data.text==='string')el.textContent=data.text;if(data.styles&&typeof data.styles==='object')Object.keys(data.styles).forEach(function(key){if(typeof data.styles[key]==='string')el.style[key]=data.styles[key]});moveOverlay(el);parent.postMessage({source:'nucleus-preview',type:'visual-patch-applied',element:describe(el)},'*')}});
window.addEventListener('DOMContentLoaded',function(){setTimeout(function(){var detail=evidence();if(!window.__nucleusRuntimeFailed)parent.postMessage({source:'nucleus-preview',type:'ready',detail:detail},'*');queueEvent('info','应用启动完成',{ready:true,detail:detail})},0)},{once:true});
})();</script>`;
  const styleTag = `<style>${style}</style>`;
  const scriptTag = `<script>${script}</script>`;
  html = html.includes("</head>") ? html.replace("</head>", `${styleTag}${runtime}</head>`) : `${styleTag}${runtime}${html}`;
  html = html.includes("</body>") ? html.replace("</body>", `${scriptTag}</body>`) : `${html}${scriptTag}`;
  return html;
}
