import http from 'node:http';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const root=path.dirname(fileURLToPath(import.meta.url));
const vendorRoot=path.dirname(require.resolve('katex/package.json'));
const cwd=path.resolve(process.env.PI_CHAT_CWD || process.cwd());
const port=Number(process.env.PI_CHAT_PORT||8791);
const dir=path.resolve(process.env.PI_CHAT_STATE_DIR || path.join(root,'state'));await mkdir(path.join(dir,'sessions'),{recursive:true});
type RecordValue=Record<string,any>;
type Session={key:string;title:string;file?:string};
let registry:{active:string;sessions:Session[]};
try{registry=JSON.parse(await readFile(path.join(dir,'registry.json'),'utf8'))}catch{const key=randomUUID();registry={active:key,sessions:[{key,title:'新对话'}]}}
async function save(){await writeFile(path.join(dir,'registry.json.tmp'),JSON.stringify(registry,null,2));const {rename}=await import('node:fs/promises');await rename(path.join(dir,'registry.json.tmp'),path.join(dir,'registry.json'))}
type GoalStatus='idle'|'running'|'paused'|'done'|'failed'|'stopped';
type Goal={status:GoalStatus;objective:string;verify:string|null;maxTurns:number;maxMinutes:number;turns:number;startedAt:number;lastReason:string;history:{turn:number;verdict:string;reason:string}[]};
const goalPath=path.join(dir,'goal.json');
let goal:Goal={status:'idle',objective:'',verify:null,maxTurns:8,maxMinutes:30,turns:0,startedAt:0,lastReason:'',history:[]};
try{const saved=JSON.parse(await readFile(goalPath,'utf8'));if(saved?.objective){const resumed=saved.status==='running';goal={...goal,...saved,status:resumed?'paused':saved.status,lastReason:resumed?'服务重启，目标已暂停：发送 /goal resume 继续，/goal stop 取消':saved.lastReason||''}}}catch{}
async function saveGoal(){try{await writeFile(goalPath+'.tmp',JSON.stringify(goal,null,2));const {rename}=await import('node:fs/promises');await rename(goalPath+'.tmp',goalPath)}catch{}}
let turnTools=0,stalledTurns=0,goalBusy=false;
function goalPublic(){return {status:goal.status,objective:goal.objective,verify:goal.verify,maxTurns:goal.maxTurns,maxMinutes:goal.maxMinutes,turns:goal.turns,startedAt:goal.startedAt,elapsedMs:goal.startedAt?Date.now()-goal.startedAt:0,lastReason:goal.lastReason,history:goal.history.slice(-5)}}
function textOf(m:RecordValue){if(typeof m?.content==='string')return m.content;if(!Array.isArray(m?.content))return '';return m.content.filter((b:RecordValue)=>b?.type==='text').map((b:RecordValue)=>b.text).join('\n')}
function evidence(){const parts:string[]=[];for(const m of messages.slice(-8)){if(m.role==='user'){const t=textOf(m);if(t)parts.push('用户: '+t.slice(0,600))}else if(m.role==='assistant'){const t=textOf(m);if(t)parts.push('助手: '+t.slice(0,2000));for(const b of (Array.isArray(m.content)?m.content:[]))if(b?.type==='toolCall')parts.push('工具调用 '+b.name+': '+JSON.stringify(b.arguments||{}).slice(0,500))}else if(m.role==='toolResult'){parts.push('工具结果: '+textOf(m).slice(0,1200))}}return parts.join('\n').slice(-8000)}
function runVerify(cmd:string){return new Promise<{ok:boolean;out:string}>(resolve=>{const p=spawn('bash',['-lc',cmd],{cwd,env:process.env});let out='';const timer=setTimeout(()=>{try{p.kill('SIGKILL')}catch{}},120000);p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.on('error',e=>{clearTimeout(timer);resolve({ok:false,out:e.message})});p.on('close',code=>{clearTimeout(timer);resolve({ok:code===0,out:out.slice(-3000)})})})}
function judgeGoal(ev:string){return new Promise<{verdict:'met'|'not_met'|'impossible';reason:string;missing:string[]}>((resolve,reject)=>{const prompt=['你是严格的目标验收评审，只根据提供的一轮对话证据判断目标是否达成。','规则：','- 只接受可核实的证据（命令输出、测试结果、文件内容、退出码）。模型自称“已完成/搞定”不算证据。','- 证据不足以证明达成时，一律判 not_met，并列出缺什么。','- 只有当目标在原理上无法完成时才判 impossible。','- 不要执行工具，不要提出新任务。','','<goal>',goal.objective,'</goal>','',goal.verify?('验收命令: '+goal.verify+'（由系统执行，结果见证据）'):'验收方式：依据上述证据判断目标是否达成。','','<evidence>',ev,'</evidence>','','只输出一行 JSON：{"verdict":"met|not_met|impossible","reason":"一句话结论","missing":["待补齐项"]}'].join('\n');const bin=process.env.PI_CHAT_BIN||'pi';const args=['-p','--no-session','--no-tools'];if(process.env.PI_CHAT_GOAL_MODEL)args.push('--model',process.env.PI_CHAT_GOAL_MODEL);const p=spawn(bin,[...args,prompt],{cwd,env:process.env,stdio:['ignore','pipe','pipe']});let out='';const timer=setTimeout(()=>{try{p.kill('SIGKILL')}catch{}},90000);p.stdout.on('data',d=>out+=d);p.stderr.on('data',()=>{});p.on('error',()=>{clearTimeout(timer);resolve({verdict:'not_met',reason:'评审进程启动失败',missing:[]})});p.on('close',()=>{clearTimeout(timer);const m=out.match(/\{[\s\S]*\}/);if(!out.trim()||!m)return reject(new Error('评审无有效输出：'+(out.trim().slice(0,120)||'empty')));try{const j=JSON.parse(m?m[0]:'{}');const v=['met','not_met','impossible'].includes(j.verdict)?j.verdict:'not_met';resolve({verdict:v,reason:String(j.reason||'').slice(0,300),missing:Array.isArray(j.missing)?j.missing.slice(0,5).map(String):[]})}catch{reject(new Error('评审输出无法解析：'+out.slice(0,160)))}})})}
function finishGoal(status:GoalStatus,reason:string){goal.status=status;goal.lastReason=reason;void saveGoal();notice('目标'+(status==='done'?'已达成':status==='failed'?'判定不可达':status==='paused'?'已暂停':'已停止')+'：'+reason);broadcast()}
async function continueGoal(reason:string,missing:string[]=[]){if(goal.status!=='running')return;if(goal.turns>=goal.maxTurns){finishGoal('stopped','达到轮次上限 '+goal.maxTurns);return}const text='[goal-continue] 轮次 '+goal.turns+'/'+goal.maxTurns+' · 上轮评审：'+(reason||'未通过')+(missing.length?'\n待补齐：'+missing.join('；'):'')+'\n目标与验收标准见最初的 /goal 指令。请继续推进：先执行必要的工具动作，用真实输出证明进展；不要只做口头声明。';busy=true;phase='目标推进';broadcast();try{await rpc('prompt',{message:text})}catch(e){busy=false;phase='就绪';finishGoal('paused','续跑发送失败：'+(e as Error).message)}}
async function onGoalSettled(){if(goal.status!=='running'||goalBusy)return;goalBusy=true;try{goal.turns++;if(goal.turns>goal.maxTurns){finishGoal('stopped','达到轮次上限 '+goal.maxTurns);return}if(Date.now()-goal.startedAt>goal.maxMinutes*60000){finishGoal('stopped','超过时间上限 '+goal.maxMinutes+' 分钟');return}if(turnTools===0){stalledTurns++;if(stalledTurns>=2){finishGoal('stopped','连续两轮没有工具动作（停滞检测）');return}}else stalledTurns=0;let verdict:'met'|'not_met'|'impossible';let reason:string;let missing:string[]=[];if(goal.verify){const r=await runVerify(goal.verify);verdict=r.ok?'met':'not_met';reason=r.ok?'验收命令通过':('验收命令未通过：'+r.out.slice(-200));if(!r.ok)missing=[r.out.slice(-200)]}else{const j=await judgeGoal(evidence());verdict=j.verdict;reason=j.reason;missing=j.missing}goal.history.push({turn:goal.turns,verdict,reason});if(goal.history.length>50)goal.history=goal.history.slice(-50);if(verdict==='met'){finishGoal('done',reason||'验收通过');return}if(verdict==='impossible'){finishGoal('failed',reason||'判定不可达');return}goal.lastReason=reason;await saveGoal();await continueGoal(reason,missing)}catch(e){finishGoal('paused','评审异常：'+(e as Error).message)}finally{goalBusy=false;turnTools=0}}
let child:ChildProcessWithoutNullStreams, dead=false,ready=false,busy=false,phase='启动中',state:RecordValue={},messages:RecordValue[]=[],models:RecordValue[]=[],levels:string[]=[],commands:RecordValue[]=[],dialogs:RecordValue[]=[],notices:{id:string;text:string}[]=[],activeMessage=-1,noticeSeq=0;
const tools=new Map<string,RecordValue>();
const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const clients=new Set<WebSocket>();
let revision=0,timer:ReturnType<typeof setTimeout>|undefined;
function snapshot(){return {type:'snapshot',revision:++revision,ready,busy,phase,state:{sessionId:state.sessionId,thinkingLevel:state.thinkingLevel,model:state.model?{id:state.model.id,provider:state.model.provider}:null},sessions:registry.sessions.map(({key,title})=>({key,title})),active:registry.active,messages,tools:[...tools.values()],models,levels,commands,dialogs,notices:notices.map(n=>n.text),goal:goalPublic()}}
function broadcast(){if(timer)return;timer=setTimeout(()=>{timer=undefined;const data=JSON.stringify(snapshot());for(const ws of clients){if(ws.bufferedAmount>8e6){ws.close(1013,'Reconnect');continue}if(ws.readyState===WebSocket.OPEN)ws.send(data)}},70)}
const NOTICE_TTL_MS=Number(process.env.PI_CHAT_NOTICE_TTL_MS||30000);
function notice(s:string){
 if(notices.length&&notices[notices.length-1].text===s)return;
 const item={id:String(++noticeSeq),text:s};
 notices.push(item);notices=notices.slice(-8);broadcast();
 const t=setTimeout(()=>{const i=notices.findIndex(n=>n.id===item.id);if(i>=0){notices.splice(i,1);broadcast()}},NOTICE_TTL_MS);
 (t as any).unref?.();
}
function clearGoalNotices(){const before=notices.length;notices=notices.filter(n=>!n.text.startsWith('目标')&&!n.text.startsWith('/goal '));if(notices.length!==before)broadcast()}
function write(record:RecordValue){return new Promise<void>((resolve,reject)=>{if(dead||!child?.stdin.writable)return reject(new Error('Pi 进程不可用，请重启服务'));child.stdin.write(JSON.stringify(record)+'\n',e=>e?reject(e):resolve())})}
function rpc(type:string,fields:RecordValue={}){const id=randomUUID();return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${type} 响应超时；未自动重发，请检查当前状态`))},120000);pending.set(id,{resolve,reject,timer});write({type,...fields,id}).catch(e=>{clearTimeout(timer);pending.delete(id);reject(e)})})}
async function refresh(){state=await rpc('get_state');levels=(await rpc('get_available_thinking_levels')).levels;const s=registry.sessions.find(s=>s.key===registry.active)!;if(state.sessionFile)s.file=state.sessionFile;await save();broadcast()}
function handle(e:RecordValue){
 if(e.type==='response'){const p=pending.get(e.id);if(p){clearTimeout(p.timer);pending.delete(e.id);e.success?p.resolve(e.data):p.reject(new Error(e.error||'Pi 命令失败'))}return}
 if(e.type==='agent_start'){busy=true;phase='运行中';turnTools=0}
 if(e.type==='agent_settled'){busy=false;phase='就绪';activeMessage=-1;void refresh().then(()=>onGoalSettled()).catch(e=>notice(e.message))}
 if(e.type==='message_start'){messages.push(e.message);activeMessage=messages.length-1}
 if(e.type==='message_update'&&activeMessage>=0){const u=e.assistantMessageEvent,m=messages[activeMessage];if(!Array.isArray(m.content))m.content=[];const i=u.contentIndex;if(Number.isInteger(i)){if(u.type==='text_start')m.content[i]={type:'text',text:''};if(u.type==='thinking_start')m.content[i]={type:'thinking',thinking:''};for(const k of ['text','thinking']){if(u.type===k+'_delta'){m.content[i]??={type:k,[k]:''};m.content[i][k]=(m.content[i][k]||'')+u.delta}if(u.type===k+'_end')m.content[i]={type:k,[k]:u.content}}if(u.type==='toolcall_end')m.content[i]=u.toolCall}}
 if(e.type==='message_end'){if(activeMessage>=0&&messages[activeMessage]?.role===e.message.role)messages[activeMessage]=e.message;else messages.push(e.message);activeMessage=-1}
 if(e.type==='tool_execution_start')turnTools++;
 if(e.type?.startsWith('tool_execution_')){const old=tools.get(e.toolCallId)||{};tools.set(e.toolCallId,{...old,id:e.toolCallId,name:e.toolName,args:e.args||old.args,status:e.type==='tool_execution_end'?(e.isError?'失败':'完成'):'执行中',result:e.result||e.partialResult||old.result})}
 if(e.type==='compaction_start')phase='压缩上下文';
 if(e.type==='auto_retry_start')phase=`重试 ${e.attempt}/${e.maxAttempts}`;
 if(e.type==='compaction_end'&&e.errorMessage)notice(e.errorMessage);
 if(e.type==='auto_retry_end'&&e.finalError)notice(e.finalError);
 if(e.type==='extension_error')notice(e.error||'扩展错误');
 if(e.type==='thinking_level_changed')state.thinkingLevel=e.level;
 if(e.type==='extension_ui_request'){
  if(['confirm','select','input','editor'].includes(e.method)){dialogs.push(e);if(e.timeout)setTimeout(()=>{dialogs=dialogs.filter(x=>x.id!==e.id);broadcast()},e.timeout)}
  else if(e.method==='notify')notice(e.message);
  else if(e.method==='set_editor_text')for(const ws of clients)ws.send(JSON.stringify({type:'editor',text:e.text}));
 }
 broadcast();
}
async function start(){
 const session=registry.sessions.find(s=>s.key===registry.active)!;
 const args=['--mode','rpc','--session-dir',path.join(dir,'sessions')];if(session.file)args.push('--session',session.file);
 child=spawn(process.env.PI_CHAT_BIN||'pi',args,{cwd,env:process.env,stdio:['pipe','pipe','pipe']});
 let buffer='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let idx;while((idx=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);if(line.trim())try{handle(JSON.parse(line))}catch{notice('Pi 返回无法解析的协议记录')}}});
 child.stderr.on('data',chunk=>process.stderr.write(chunk));
 const fail=(text:string)=>{dead=true;ready=false;busy=false;phase='进程已停止';for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(text))}pending.clear();notice(text)};
 child.on('error',e=>fail(e.message));child.on('exit',(code,signal)=>fail(`Pi 已退出 (${code??signal})，请重启服务。`));
 await refresh();messages=(await rpc('get_messages')).messages;
 models=(await rpc('get_available_models')).models.map((m:RecordValue)=>({id:m.id,name:m.name,provider:m.provider}));
 commands=(await rpc('get_commands')).commands.map((c:RecordValue)=>({name:c.name,description:c.description}));if(!commands.some((c:RecordValue)=>c.name==='goal'))commands.push({name:'goal',description:'设定目标并自动推进到验收通过'});
 busy=Boolean(state.isStreaming||state.isCompacting);ready=true;phase=busy?'运行中':'就绪';broadcast();
}
async function startGoal(objective:any,verifyRaw:any,maxTurnsRaw:any,maxMinutesRaw:any){
 if(typeof objective!=='string'||!objective.trim()||objective.length>4000)throw new Error('目标不能为空且不超过 4000 字符');
 if(busy||dialogs.length)throw new Error('请先结束当前任务或处理确认请求');
 if(goal.status==='running')throw new Error('已有进行中的目标，先 /goal stop');
 if(goalBusy)throw new Error('上一目标正在评审中，请稍候再试');
 const verify=typeof verifyRaw==='string'&&verifyRaw.trim()?verifyRaw.trim():null;
 goal={status:'running',objective:objective.trim(),verify,maxTurns:Math.min(Math.max(Number(maxTurnsRaw)||8,1),50),maxMinutes:Math.min(Math.max(Number(maxMinutesRaw)||30,1),240),turns:0,startedAt:Date.now(),lastReason:'',history:[]};
 stalledTurns=0;turnTools=0;clearGoalNotices();void saveGoal();
 const s=registry.sessions.find(x=>x.key===registry.active)!;if(s.title==='新对话'){s.title='目标：'+goal.objective.slice(0,24);await save()}
 busy=true;phase='目标启动';broadcast();
 const kick='目标：'+goal.objective+'\n\n验收方式：'+(verify?'命令 `'+verify+'` 退出码为 0':'由独立评审模型根据对话中的证据判定')+'\n\n现在开始执行。每轮结束前给出：做了什么、证据（命令/文件/测试的真实输出）、还差什么。不要只声明完成。';
 try{await rpc('prompt',{message:kick})}catch(e){busy=false;phase='就绪';goal.status='paused';void saveGoal();throw e}
 return goalPublic();
}
async function stopGoal(){
 if(!['running','paused'].includes(goal.status))return goalPublic();
 const wasRunning=goal.status==='running';goal.status='stopped';goal.lastReason='用户停止';clearGoalNotices();void saveGoal();broadcast();
 if(wasRunning&&busy){try{await rpc('clear_queue');await rpc('abort')}catch{}}
 return goalPublic();
}
async function resumeGoal(){
 if(goal.status!=='paused')throw new Error('仅暂停的目标可以继续');
 goal.status='running';goal.startedAt=Date.now();goal.turns=0;goal.lastReason='用户恢复';void saveGoal();await continueGoal('用户恢复目标');return goalPublic();
}
function parseGoalArg(text:string){
 if(!text||/^status$/i.test(text))return {op:'status' as const};
 if(/^(stop|clear|cancel|off|pause)$/i.test(text))return {op:'stop' as const};
 if(/^resume$/i.test(text))return {op:'resume' as const};
 const v=text.match(/--verify(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
 const t=text.match(/--turns(?:=|\s+)(\d+)/);
 const objective=text.replace(/--verify(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/,'').replace(/--turns(?:=|\s+)\d+/,'').trim();
 return {op:'start' as const,objective,verify:v?(v[1]||v[2]||v[3]):null,maxTurns:t?Number(t[1]):8};
}
let mutating=false;
async function command(c:RecordValue){
 if(!ready)throw new Error('Pi 尚未就绪');
 if(c.action==='dialog'){const d=dialogs.find(d=>d.id===c.dialogId);if(!d)throw new Error('此请求已过期');const answer:RecordValue={type:'extension_ui_response',id:d.id};if(c.cancelled)answer.cancelled=true;else if(d.method==='confirm')answer.confirmed=c.confirmed===true;else{if(typeof c.value!=='string'||(d.method==='select'&&!d.options.includes(c.value)))throw new Error('无效选项');answer.value=c.value}await write(answer);dialogs=dialogs.filter(item=>item.id!==d.id);broadcast();return}
 if(c.action==='stop'){const q=await rpc('clear_queue');await rpc('abort');return q}
 if(c.action==='goal-start')return startGoal(c.objective,c.verify,c.maxTurns,c.maxMinutes);
 if(c.action==='goal-stop')return stopGoal();
 if(c.action==='goal-resume')return resumeGoal();
 if(mutating)throw new Error('正在处理上一项操作');mutating=true;
 try{
  if(c.action==='prompt'){
   if(typeof c.message!=='string'||!c.message.trim()||c.message.length>100000)throw new Error('消息不能为空且不能超过 100000 字符');
   if(busy)throw new Error('请等待当前任务完成，或先停止');
   if(/^\/goal(\s|$)/i.test(c.message.trim())){
    const cmd=parseGoalArg(c.message.trim().replace(/^\/goal\s*/i,'').trim());
    const data=cmd.op==='status'?goalPublic():cmd.op==='stop'?await stopGoal():cmd.op==='resume'?await resumeGoal():await startGoal(cmd.objective,cmd.verify,cmd.maxTurns,undefined);
    if(cmd.op!=='status')notice('/goal '+cmd.op+' 已由服务端处理');
    return data;
   }
   const slash=c.message.match(/^\/(\S+)/)?.[1];if(slash&&!commands.some(x=>x.name===slash))throw new Error('此命令不是已加载的扩展、技能或模板；终端专用命令不在网页执行');
   if(goal.status==='running'){goal.status='paused';goal.lastReason='用户插话，目标已暂停（/goal resume 继续）';void saveGoal()}
   busy=true;phase='发送中';broadcast();
   try{await rpc('prompt',{message:c.message})}catch(e){busy=false;phase='就绪';throw e}
   const s=registry.sessions.find(s=>s.key===registry.active)!;if(s.title==='新对话'){s.title=c.message.trim().slice(0,28);await save()}
  }else if(c.action==='new'||c.action==='switch'){
   if(busy||dialogs.length)throw new Error('请先结束当前任务或处理确认请求');
   const target=c.action==='switch'?registry.sessions.find(s=>s.key===c.key):undefined;if(c.action==='switch'&&!target)throw new Error('找不到会话');
   const result=await rpc(target?.file?'switch_session':'new_session',target?.file?{sessionPath:target.file}:{});if(result?.cancelled)throw new Error('扩展取消了会话切换');
   if(target)registry.active=target.key;else{const s={key:randomUUID(),title:'新对话'};registry.sessions.unshift(s);registry.active=s.key}
   tools.clear();messages=(await rpc('get_messages')).messages;await refresh();
  }else if(c.action==='model'){
   if(busy)throw new Error('运行中不能切换模型');if(!models.some(m=>m.id===c.modelId&&m.provider===c.provider))throw new Error('未知模型');await rpc('set_model',{modelId:c.modelId,provider:c.provider});await refresh();
  }else if(c.action==='thinking'){
   if(busy)throw new Error('运行中不能切换思考等级');if(!levels.includes(c.level))throw new Error('不支持的思考等级');await rpc('set_thinking_level',{level:c.level});await refresh();
  }else throw new Error('不支持的操作');
 }finally{mutating=false;broadcast()}
}
const origins=new Set([`http://localhost:${port}`,`http://127.0.0.1:${port}`]);
const allowedHosts=new Set([`localhost:${port}`,`127.0.0.1:${port}`]);
const assets:Record<string,[string,string]>={
 '/':['public/index.html','text/html'], '/app.js':['public/app.js','text/javascript'], '/style.css':['public/style.css','text/css'],
 '/vendor/marked.js':['node_modules/marked/lib/marked.umd.js','text/javascript'], '/vendor/purify.js':['node_modules/dompurify/dist/purify.min.js','text/javascript'],
 '/vendor/katex.js':['node_modules/katex/dist/katex.min.js','text/javascript'], '/vendor/auto-render.js':['node_modules/katex/dist/contrib/auto-render.min.js','text/javascript'], '/vendor/katex.css':['node_modules/katex/dist/katex.min.css','text/css']};
const server=http.createServer(async(req,res)=>{
 if(!allowedHosts.has(req.headers.host||'')||(req.headers.origin&&!origins.has(req.headers.origin))){res.writeHead(403).end();return}
 if(req.method!=='GET'){res.writeHead(405).end();return}
 const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
 if(url.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:ready,phase,goal:{status:goal.status,turns:goal.turns,lastReason:goal.lastReason}}));return}
 let entry=assets[url.pathname];if(/^\/vendor\/fonts\/[\w.-]+\.(woff2?|ttf)$/.test(url.pathname))entry=['node_modules/katex/dist/fonts/'+path.basename(url.pathname),'font/woff2'];
 if(!entry){res.writeHead(404).end();return}try{res.setHeader('Content-Type',entry[1]+'; charset=utf-8');const assetPath=entry[0].startsWith('node_modules/')?(entry[0].startsWith('node_modules/katex/')?path.join(vendorRoot,entry[0].slice('node_modules/katex/'.length)):entry[0].startsWith('node_modules/dompurify/')?path.join(path.dirname(require.resolve('dompurify')),'purify.min.js'):path.join(path.dirname(require.resolve(entry[0].split('/')[1]+'/package.json')),entry[0].split('/').slice(2).join('/'))):path.join(root,entry[0]);res.end(await readFile(assetPath))}catch{res.writeHead(404).end()}
});
const wss=new WebSocketServer({noServer:true,maxPayload:256*1024});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!allowedHosts.has(req.headers.host||'')||!origins.has(req.headers.origin||'')){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req))});
wss.on('connection',ws=>{clients.add(ws);ws.send(JSON.stringify(snapshot()));ws.on('close',()=>clients.delete(ws));ws.on('message',async raw=>{let c:RecordValue;try{c=JSON.parse(raw.toString());if(typeof c.id!=='string')throw new Error('缺少请求编号')}catch{ws.send(JSON.stringify({type:'result',ok:false,error:'无效请求'}));return}try{const data=await command(c);ws.send(JSON.stringify({type:'result',id:c.id,ok:true,data}))}catch(e){ws.send(JSON.stringify({type:'result',id:c.id,ok:false,error:(e as Error).message}))}})});
server.on('error',e=>{console.error(e.message);process.exit(1)});
server.listen(port,'127.0.0.1',()=>{console.log(`Pi Chat http://localhost:${port} · ${cwd}`);void start().catch(e=>notice('初始化失败：'+e.message))});
function shutdown(){server.close();for(const ws of clients)ws.close();child?.stdin.end();setTimeout(()=>{child?.kill('SIGTERM');process.exit()},3000).unref()}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
