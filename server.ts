import http from 'node:http';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
const root=path.dirname(fileURLToPath(import.meta.url));
const cwd=path.resolve(process.env.PI_CHAT_CWD || process.cwd());
const port=Number(process.env.PI_CHAT_PORT||8791);
const dir=path.join(root,'state');await mkdir(path.join(dir,'sessions'),{recursive:true});
type RecordValue=Record<string,any>;
type Session={key:string;title:string;file?:string};
let registry:{active:string;sessions:Session[]};
try{registry=JSON.parse(await readFile(path.join(dir,'registry.json'),'utf8'))}catch{const key=randomUUID();registry={active:key,sessions:[{key,title:'新对话'}]}}
async function save(){await writeFile(path.join(dir,'registry.json.tmp'),JSON.stringify(registry,null,2));const {rename}=await import('node:fs/promises');await rename(path.join(dir,'registry.json.tmp'),path.join(dir,'registry.json'))}
let child:ChildProcessWithoutNullStreams, dead=false,ready=false,busy=false,phase='启动中',state:RecordValue={},messages:RecordValue[]=[],models:RecordValue[]=[],levels:string[]=[],commands:RecordValue[]=[],dialogs:RecordValue[]=[],notices:string[]=[],activeMessage=-1;
const tools=new Map<string,RecordValue>();
const pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const clients=new Set<WebSocket>();
let revision=0,timer:ReturnType<typeof setTimeout>|undefined;
function snapshot(){return {type:'snapshot',revision:++revision,ready,busy,phase,state:{sessionId:state.sessionId,thinkingLevel:state.thinkingLevel,model:state.model?{id:state.model.id,provider:state.model.provider}:null},sessions:registry.sessions.map(({key,title})=>({key,title})),active:registry.active,messages,tools:[...tools.values()],models,levels,commands,dialogs,notices}}
function broadcast(){if(timer)return;timer=setTimeout(()=>{timer=undefined;const data=JSON.stringify(snapshot());for(const ws of clients){if(ws.bufferedAmount>8e6){ws.close(1013,'Reconnect');continue}if(ws.readyState===WebSocket.OPEN)ws.send(data)}},70)}
function notice(s:string){notices.push(s);notices=notices.slice(-8);broadcast()}
function write(record:RecordValue){return new Promise<void>((resolve,reject)=>{if(dead||!child?.stdin.writable)return reject(new Error('Pi 进程不可用，请重启服务'));child.stdin.write(JSON.stringify(record)+'\n',e=>e?reject(e):resolve())})}
function rpc(type:string,fields:RecordValue={}){const id=randomUUID();return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${type} 响应超时；未自动重发，请检查当前状态`))},120000);pending.set(id,{resolve,reject,timer});write({type,...fields,id}).catch(e=>{clearTimeout(timer);pending.delete(id);reject(e)})})}
async function refresh(){state=await rpc('get_state');levels=(await rpc('get_available_thinking_levels')).levels;const s=registry.sessions.find(s=>s.key===registry.active)!;if(state.sessionFile)s.file=state.sessionFile;await save();broadcast()}
function handle(e:RecordValue){
 if(e.type==='response'){const p=pending.get(e.id);if(p){clearTimeout(p.timer);pending.delete(e.id);e.success?p.resolve(e.data):p.reject(new Error(e.error||'Pi 命令失败'))}return}
 if(e.type==='agent_start'){busy=true;phase='运行中'}
 if(e.type==='agent_settled'){busy=false;phase='就绪';activeMessage=-1;void refresh().catch(e=>notice(e.message))}
 if(e.type==='message_start'){messages.push(e.message);activeMessage=messages.length-1}
 if(e.type==='message_update'&&activeMessage>=0){const u=e.assistantMessageEvent,m=messages[activeMessage];if(!Array.isArray(m.content))m.content=[];const i=u.contentIndex;if(Number.isInteger(i)){if(u.type==='text_start')m.content[i]={type:'text',text:''};if(u.type==='thinking_start')m.content[i]={type:'thinking',thinking:''};for(const k of ['text','thinking']){if(u.type===k+'_delta'){m.content[i]??={type:k,[k]:''};m.content[i][k]=(m.content[i][k]||'')+u.delta}if(u.type===k+'_end')m.content[i]={type:k,[k]:u.content}}if(u.type==='toolcall_end')m.content[i]=u.toolCall}}
 if(e.type==='message_end'){if(activeMessage>=0&&messages[activeMessage]?.role===e.message.role)messages[activeMessage]=e.message;else messages.push(e.message);activeMessage=-1}
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
 commands=(await rpc('get_commands')).commands.map((c:RecordValue)=>({name:c.name,description:c.description}));
 busy=Boolean(state.isStreaming||state.isCompacting);ready=true;phase=busy?'运行中':'就绪';broadcast();
}
let mutating=false;
async function command(c:RecordValue){
 if(!ready)throw new Error('Pi 尚未就绪');
 if(c.action==='dialog'){const d=dialogs.find(d=>d.id===c.dialogId);if(!d)throw new Error('此请求已过期');const answer:RecordValue={type:'extension_ui_response',id:d.id};if(c.cancelled)answer.cancelled=true;else if(d.method==='confirm')answer.confirmed=c.confirmed===true;else{if(typeof c.value!=='string'||(d.method==='select'&&!d.options.includes(c.value)))throw new Error('无效选项');answer.value=c.value}await write(answer);dialogs=dialogs.filter(item=>item.id!==d.id);broadcast();return}
 if(c.action==='stop'){const q=await rpc('clear_queue');await rpc('abort');return q}
 if(mutating)throw new Error('正在处理上一项操作');mutating=true;
 try{
  if(c.action==='prompt'){
   if(typeof c.message!=='string'||!c.message.trim()||c.message.length>100000)throw new Error('消息不能为空且不能超过 100000 字符');
   if(busy)throw new Error('请等待当前任务完成，或先停止');
   const slash=c.message.match(/^\/(\S+)/)?.[1];if(slash&&!commands.some(x=>x.name===slash))throw new Error('此命令不是已加载的扩展、技能或模板；终端专用命令不在网页执行');
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
 if(url.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:ready,phase}));return}
 let entry=assets[url.pathname];if(/^\/vendor\/fonts\/[\w.-]+\.(woff2?|ttf)$/.test(url.pathname))entry=['node_modules/katex/dist/fonts/'+path.basename(url.pathname),'font/woff2'];
 if(!entry){res.writeHead(404).end();return}try{res.setHeader('Content-Type',entry[1]+'; charset=utf-8');res.end(await readFile(path.join(root,entry[0])))}catch{res.writeHead(404).end()}
});
const wss=new WebSocketServer({noServer:true,maxPayload:256*1024});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!allowedHosts.has(req.headers.host||'')||!origins.has(req.headers.origin||'')){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req))});
wss.on('connection',ws=>{clients.add(ws);ws.send(JSON.stringify(snapshot()));ws.on('close',()=>clients.delete(ws));ws.on('message',async raw=>{let c:RecordValue;try{c=JSON.parse(raw.toString());if(typeof c.id!=='string')throw new Error('缺少请求编号')}catch{ws.send(JSON.stringify({type:'result',ok:false,error:'无效请求'}));return}try{const data=await command(c);ws.send(JSON.stringify({type:'result',id:c.id,ok:true,data}))}catch(e){ws.send(JSON.stringify({type:'result',id:c.id,ok:false,error:(e as Error).message}))}})});
server.listen(port,'127.0.0.1',()=>console.log(`Pi Chat http://localhost:${port} · ${cwd}`));
void start().catch(e=>notice('初始化失败：'+e.message));
function shutdown(){server.close();for(const ws of clients)ws.close();child?.stdin.end();setTimeout(()=>{child?.kill('SIGTERM');process.exit()},3000).unref()}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
