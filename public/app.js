const $=id=>document.getElementById(id);let socket,snapshot=null,connected=false,submitting=false,dialogId=null;const requests=new Map();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function markdown(text){return DOMPurify.sanitize(marked.parse(String(text||'')),{FORBID_TAGS:['img','style','iframe','form','input'],FORBID_ATTR:['style'],ADD_ATTR:['target','rel']})}
const LINK_SCHEME=/^(?:https?:|mailto:)/i;
function linkify(root){if(!root||!root.querySelectorAll)return;for(const a of root.querySelectorAll('a[href]')){const href=a.getAttribute('href')||'';if(LINK_SCHEME.test(href)||href.startsWith('//')){a.target='_blank';a.rel='noopener noreferrer';a.title=a.href||href}}}
function openExternal(a){const href=a.getAttribute('href')||'';if(!LINK_SCHEME.test(href)&&!href.startsWith('//'))return false;let w=null;try{w=window.open(a.href,'_blank')}catch{}if(w){try{w.opener=null}catch{}}else{try{location.href=a.href}catch{}}return true}
document.addEventListener('click',e=>{if(e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;const t=e.target instanceof Element?e.target:null;const a=t&&t.closest('a[href]');if(!a)return;const messages=document.getElementById('messages');if(!messages||!messages.contains(a))return;if(openExternal(a))e.preventDefault()});
let toastTimer;
function showToast(text){const t=$('toast');if(!t)return;t.textContent=text;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,3200)}
const GOAL_LABELS={running:'进行中',paused:'已暂停',done:'已达成',failed:'判定不可达',stopped:'已停止'};
function renderGoal(){const g=snapshot?.goal,bar=$('goalbar');if(!bar)return;if(!g||g.status==='idle'){bar.hidden=true;return}const label=GOAL_LABELS[g.status]||g.status;bar.hidden=false;$('goalText').textContent=g.objective;$('goalMeta').textContent=`${label} · 第 ${g.turns}/${g.maxTurns} 轮${g.lastReason?' · '+g.lastReason:''}`;$('goalStop').hidden=!['running','paused'].includes(g.status)}
async function goalCommand(message){const arg=message.replace(/^\/goal\s*/i,'').trim();if(!arg||arg==='status'){const g=snapshot?.goal;showToast(g&&g.status!=='idle'?`${GOAL_LABELS[g.status]||g.status} · 第 ${g.turns}/${g.maxTurns} 轮 · ${g.objective}`:'没有进行中的目标。用法：/goal <目标> [--verify "命令"] [--turns N]');return}if(/^(stop|clear|cancel|off|pause)$/i.test(arg)){await act('goal-stop');showToast('目标已停止');return}if(/^resume$/i.test(arg)){await act('goal-resume');return}const v=arg.match(/--verify(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);const t=arg.match(/--turns(?:=|\s+)(\d+)/);const objective=arg.replace(/--verify(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/,'').replace(/--turns(?:=|\s+)\d+/,'').trim();if(!objective){showToast('请给出目标描述');return}await act('goal-start',{objective,verify:v?(v[1]||v[2]||v[3]):null,maxTurns:t?Number(t[1]):8});$('prompt').value='';$('prompt').style.height='auto'}
$('goalStop').onclick=()=>act('goal-stop').catch(()=>{});$('loadOlder').onclick=()=>loadOlder();
function error(text){$('error').hidden=!text;$('error').textContent=text||''}
function call(action,fields={}){return new Promise((resolve,reject)=>{if(!connected)return reject(new Error('连接已断开。未发送消息。'));const id=crypto.randomUUID();const timer=setTimeout(()=>{requests.delete(id);reject(new Error('操作响应超时。请检查会话状态，不要重复发送。'))},125000);requests.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,action,...fields}))})}
async function act(action,fields={}){try{error('');return await call(action,fields)}catch(e){error(e.message);throw e}}
let messageCache=[],messageBase=0,historyMore=false,loadingOlder=false;
function applySnapshot(data){
 const from=data.messagesFrom;
 if(Number.isInteger(from)&&!data.messagesReset&&Array.isArray(data.messages)){
  const local=from-messageBase;
  messageCache=local<0?messageCache:messageCache.slice(0,Math.min(local,messageCache.length)).concat(data.messages);
 }else{
  messageCache=Array.isArray(data.messages)?data.messages.slice():[];
  messageBase=Number.isInteger(from)?from:0;
  historyMore=Boolean(data.hasMoreOlder);
 }
 data.messages=messageCache;data.messageBase=messageBase;data.historyMore=historyMore;snapshot=data;
}
async function loadOlder(){
 if(loadingOlder||messageBase<=0)return;
 loadingOlder=true;
 const sc=$('scroll'),prevH=sc.scrollHeight,prevTop=sc.scrollTop;
 try{
  const r=await act('history',{before:messageBase,limit:80});
  messageCache=r.messages.concat(messageCache);messageBase=r.from;historyMore=r.hasMoreOlder;
  if(snapshot){snapshot.messages=messageCache;snapshot.messageBase=messageBase;snapshot.historyMore=historyMore}
  render();sc.scrollTop=prevTop+(sc.scrollHeight-prevH);
 }catch{}finally{loadingOlder=false}
}
let renderQueued=false;
function scheduleRender(){if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;render()})}
function connect(){socket=new WebSocket(`ws://${location.host}/ws`);socket.onopen=()=>{connected=true;controls()};socket.onclose=()=>{connected=false;const progress=$('runProgress');if(progress){progress.classList.add('disconnected');progress.lastElementChild.textContent='连接已断开，正在重连'}for(const p of requests.values()){clearTimeout(p.timer);p.reject(new Error('连接断开，命令结果未知；重连后请检查会话，不会自动重发。'))}requests.clear();controls();setTimeout(connect,1500)};socket.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='result'){const p=requests.get(data.id);if(p){clearTimeout(p.timer);requests.delete(data.id);data.ok?p.resolve(data.data):p.reject(new Error(data.error))}}else if(data.type==='snapshot'){applySnapshot(data);scheduleRender()}else if(data.type==='editor'){$('prompt').value=data.text||'';controls()}}}
function controls(){const busy=snapshot?.busy;const enabled=connected&&snapshot?.ready;$('status').textContent=!connected?'连接断开 · 正在重连':snapshot?.phase||'启动中';$('send').textContent=busy?'■':'↑';$('send').setAttribute('aria-label',busy?'停止':'发送');$('send').disabled=!enabled||submitting||(!busy&&!$('prompt').value.trim());$('newChat').disabled=!enabled||busy;$('model').disabled=!enabled||busy;$('effort').disabled=!enabled||busy}
function textContent(m){return typeof m.content==='string'?m.content:(m.content||[]).filter(b=>b?.type==='text').map(b=>b.text).join('\n')}
function details(label,body,key,preview=''){return `<div class="activity"><details class="tool" data-key="${esc(key)}"><summary><span>${esc(label)}</span>${preview?`<span class="activity-preview">${esc(String(preview).split('\n')[0].slice(0,160))}</span>`:''}</summary><pre>${esc(body)}</pre></details></div>`}

const FAV_BASE=document.title||'Pi Chat';
const FAV_IDLE=document.querySelector('link[data-idle-icon]')?.href||'';
let favSpin=null,favFrames=null,favActive=false,favDoneTimer=null,favPendingReset=null;
function favLink(){let l=document.querySelector('link[rel="icon"]');if(!l){l=document.createElement('link');l.rel='icon';document.head.append(l)}return l}
function favDraw(done,angle){
 const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');
 x.clearRect(0,0,64,64);
 x.fillStyle=done?'#267b63':'#242424';
 x.font='600 40px Georgia,"Times New Roman",serif';x.textAlign='center';x.textBaseline='middle';
 x.fillText('π',32,33);
 if(done){x.strokeStyle='#267b63';x.lineWidth=5;x.lineCap='round';x.beginPath();x.arc(32,32,27,0,Math.PI*2);x.stroke();
  x.strokeStyle='#fff';x.lineWidth=6;x.beginPath();x.moveTo(21,33);x.lineTo(29,41);x.lineTo(44,24);x.stroke();}
 else if(angle!==null){x.strokeStyle='#267b63';x.lineWidth=5;x.lineCap='round';x.beginPath();x.arc(32,32,27,angle,angle+Math.PI*0.65);x.stroke();}
 return c.toDataURL('image/png');
}
function favSet(href){favLink().href=href}
function favStop(){if(favSpin){clearInterval(favSpin);favSpin=null}}
function favStart(animate){
 if(favSpin||favActive)return;
 favActive=true;
 if(!animate){favSet(favDraw(false,null));document.title='● 运行中 · '+FAV_BASE;return}
 favFrames=favFrames||Array.from({length:8},(_,i)=>favDraw(false,i*Math.PI/4));
 let i=0;const tick=()=>favSet(favFrames[i++%8]);
 tick();favSpin=setInterval(tick,170);
 document.title='● 运行中 · '+FAV_BASE;
}
function favFinish(){
 if(!favActive)return;
 favActive=false;favStop();
 if(favDoneTimer)clearTimeout(favDoneTimer);
 favSet(favDraw(true,0));
 document.title='✓ 完成 · '+FAV_BASE;
 const reset=()=>{favPendingReset=null;favDoneTimer=null;if(favActive)return;favSet(FAV_IDLE);document.title=FAV_BASE};
 if(document.hidden){favPendingReset=reset}else{favDoneTimer=setTimeout(reset,4000)}
}
function syncFavicon(){
 const active=Boolean(snapshot?.busy)||snapshot?.goal?.status==='running';
 if(active){if(favPendingReset){favPendingReset=null}if(favDoneTimer){clearTimeout(favDoneTimer);favDoneTimer=null}favStart(!matchMedia('(prefers-reduced-motion: reduce)').matches)}
 else if(favActive)favFinish();
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&favPendingReset){const f=favPendingReset;favPendingReset=null;setTimeout(f,500)}});
function render(){if(!snapshot)return;controls();renderGoal();syncFavicon();$('olderWrap').hidden=!historyMore;const s=snapshot;const opened=new Set([...document.querySelectorAll('details[open]')].map(d=>d.dataset.key));const atBottom=$('scroll').scrollHeight-$('scroll').scrollTop-$('scroll').clientHeight<120;
 $('title').textContent=s.sessions.find(x=>x.key===s.active)?.title||'新对话';$('history').innerHTML='';for(const x of s.sessions.filter(x=>x.title.toLowerCase().includes($('search').value.toLowerCase()))){const b=document.createElement('button');b.textContent=x.title;b.className=x.key===s.active?'active':'';b.disabled=s.busy;b.onclick=()=>act('switch',{key:x.key}).then(()=>{$('app').classList.remove('mobile-nav');error('')}).catch(()=>{});$('history').append(b)}
 const modelKey=JSON.stringify(s.models);if($('model').dataset.list!==modelKey){$('model').innerHTML='';s.models.forEach(m=>{const o=new Option(`${m.name||m.id}`,JSON.stringify([m.provider,m.id]));$('model').add(o)});$('model').dataset.list=modelKey}$('model').value=s.state.model?JSON.stringify([s.state.model.provider,s.state.model.id]):'';
 const levelKey=JSON.stringify(s.levels);if($('effort').dataset.list!==levelKey){$('effort').innerHTML='';s.levels.forEach(l=>$('effort').add(new Option(`思考 · ${l}`,l)));$('effort').dataset.list=levelKey}$('effort').value=s.state.thinkingLevel;
 let html='';const results=new Map(s.messages.filter(m=>m.role==='toolResult').map(m=>[m.toolCallId,m]));const live=new Map(s.tools.map(t=>[t.id,t]));
 s.messages.forEach((m,i)=>{if(m.role==='system'||m.role==='toolResult'||(m.role==='custom'&&!m.display))return;if(m.role==='user'){const raw=textContent(m);if(raw.startsWith('[goal-continue]')){const head=raw.split('\n')[0].replace('[goal-continue]','').trim();html+=`<div class="goal-turn"><b>◎ 目标续跑</b> · ${esc(head)}</div>`;return}html+=`<div class="user"><div class="bubble">${esc(raw)}</div></div>`;return}let body='';if(Array.isArray(m.content))for(const [j,b] of m.content.entries()){if(!b)continue;if(b.type==='text')body+=markdown(b.text);if(b.type==='thinking'&&b.thinking)body+=details('思考',b.thinking,`think-${i}-${j}`);if(b.type==='toolCall'){const r=results.get(b.id),t=live.get(b.id);const status=r?(r.isError?'失败':'完成'):t?.status||(s.busy?'等待执行':'未完成');const output=r?textContent(r):t?.result?textContent(t.result):'';const args=b.arguments||{};const hint=args.command||args.path||args.file_path||JSON.stringify(args);body+=details(`${b.name} · ${status}`,JSON.stringify(args,null,2)+'\n\n'+output,b.id,hint)}}else body+=markdown(m.content||m.summary||'');if(m.errorMessage)body+=`<div class="error">${esc(m.errorMessage)}</div>`;if(m.stopReason==='aborted')body+='<div class="note">已停止</div>';if(body){const hasText=!!textContent(m).trim();html+=`<div class="assistant${hasText?'':' activity-only'}">${body}</div>`}});
 let progress=$('runProgress');if(!progress){progress=document.createElement('div');progress.id='runProgress';progress.className='run-progress';progress.setAttribute('role','status');progress.innerHTML='<span class="run-dot" aria-hidden="true"></span><span></span>';$('messages').after(progress)}
 const last=s.messages.at(-1);const block=Array.isArray(last?.content)?last.content.at(-1):null;const thinking=last?.role==='assistant'&&!last.stopReason&&block?.type==='thinking';
 progress.hidden=!s.busy;progress.classList.toggle('disconnected',!connected);progress.lastElementChild.textContent=!connected?'连接已断开，正在重连':s.dialogs.length?'等待你的确认':thinking?`正在思考 · 已收到 ${[...(block.thinking||'')].length} 字`:s.phase==='运行中'?'正在处理…':s.phase;
 $('messages').innerHTML=html;linkify($('messages'));document.querySelectorAll('details').forEach(d=>d.open=opened.has(d.dataset.key));
 renderMathInElement($('messages'),{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false}],throwOnError:false,trust:false});
 $('notices').innerHTML=s.notices.map(n=>`<p class="notice">${esc(n)}</p>`).join('');if(atBottom)$('scroll').scrollTop=$('scroll').scrollHeight;renderDialog();
}
function renderDialog(){const d=snapshot.dialogs[0];if(!d){if($('dialog').open)$('dialog').close();dialogId=null;return}if(dialogId===d.id)return;dialogId=d.id;$('dialogTitle').textContent=d.title||'Pi 请求确认';$('dialogMessage').textContent=d.message||'';$('dialogInput').innerHTML='';if(d.method==='select'){const select=document.createElement('select');select.id='answer';for(const x of d.options)select.add(new Option(x,x));$('dialogInput').append(select)}if(['input','editor'].includes(d.method)){const input=document.createElement('textarea');input.id='answer';input.value=d.prefill||'';input.placeholder=d.placeholder||'';$('dialogInput').append(input)}if(!$('dialog').open)$('dialog').showModal()}
async function answer(cancelled){const id=dialogId;if(!id)return;try{await act('dialog',{dialogId:id,cancelled,confirmed:!cancelled,value:$('answer')?.value});$('dialog').close();dialogId=null}catch{}}
$('dialogForm').onsubmit=e=>{e.preventDefault();answer(false)};$('cancelDialog').onclick=()=>answer(true);$('dialog').oncancel=e=>{e.preventDefault();answer(true)};
$('composer').onsubmit=async e=>{e.preventDefault();if(submitting)return;const message=$('prompt').value.trim();submitting=true;controls();try{if(/^\/goal(\s|$)/i.test(message)){await goalCommand(message);return}if(snapshot.busy){const q=await act('stop');if(q?.steering?.length||q?.followUp?.length)$('prompt').value=[$('prompt').value,...q.steering,...q.followUp].filter(Boolean).join('\n\n')}else if(message){await act('prompt',{message});if($('prompt').value.trim()===message)$('prompt').value=''}}catch{}finally{submitting=false;controls()}};
$('prompt').oninput=()=>{controls();$('prompt').style.height='auto';$('prompt').style.height=Math.min($('prompt').scrollHeight,150)+'px';const q=$('prompt').value;const cmds=[{name:'goal',description:'设定目标并自动推进到验收通过'}].concat(snapshot?.commands||[]).filter((c,i,a)=>a.findIndex(x=>x.name===c.name)===i);const list=q.startsWith('/')&&!q.includes(' ')?cmds.filter(c=>('/'+c.name).startsWith(q)).slice(0,8):[];$('commands').hidden=!list.length;$('commands').innerHTML='';list.forEach(c=>{const b=document.createElement('button');b.textContent='/'+c.name+' '+(c.description||'');b.onclick=()=>{$('prompt').value='/'+c.name+' ';$('commands').hidden=true;$('prompt').focus();controls()};$('commands').append(b)})};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&snapshot?.busy&&/^\/goal(\s|$)/i.test($('prompt').value.trim())){e.preventDefault();showToast('任务运行中：先停止或等本轮结束，再执行 /goal');return}if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&innerWidth>700&&!snapshot?.busy){e.preventDefault();if(!$('send').disabled)$('composer').requestSubmit()}};
$('newChat').onclick=()=>act('new').then(()=>{$('app').classList.remove('mobile-nav');$('prompt').focus()}).catch(()=>{});$('search').oninput=render;
$('model').onchange=()=>{const [provider,modelId]=JSON.parse($('model').value);act('model',{provider,modelId}).catch(()=>render())};$('effort').onchange=()=>act('thinking',{level:$('effort').value}).catch(()=>render());
document.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=()=>$('app').classList.toggle(innerWidth<=700?'mobile-nav':'sidebar-hidden'));
connect();
