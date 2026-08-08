import type { GeneratedFiles } from "./types";

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

export function composePreview(files: GeneratedFiles): string {
  const style = files["styles.css"].replace(/<\/style/gi, "<\\/style");
  const script = files["script.js"].replace(/<\/script/gi, "<\\/script");
  let html = files["index.html"];
  const runtime = `<script>(function(){try{var k='__nucleus_probe__';localStorage.setItem(k,'1');localStorage.removeItem(k)}catch(e){var data={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:function(k){return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null},setItem:function(k,v){data[k]=String(v)},removeItem:function(k){delete data[k]},clear:function(){data={}},key:function(i){return Object.keys(data)[i]||null},get length(){return Object.keys(data).length}}})}})();window.addEventListener('error',function(e){parent.postMessage({source:'nucleus-preview',type:'error',message:e.message},'*')});window.addEventListener('unhandledrejection',function(e){parent.postMessage({source:'nucleus-preview',type:'error',message:String(e.reason)},'*')});</script>`;
  const styleTag = `<style>${style}</style>`;
  const scriptTag = `<script>${script}</script>`;
  html = html.includes("</head>") ? html.replace("</head>", `${styleTag}${runtime}</head>`) : `${styleTag}${runtime}${html}`;
  html = html.includes("</body>") ? html.replace("</body>", `${scriptTag}</body>`) : `${html}${scriptTag}`;
  return html;
}
