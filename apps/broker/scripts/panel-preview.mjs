// Local visual QA host. Sample data only; no account, token or broker traffic.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const panel = readFileSync(new URL("../connector/server/panel.html", import.meta.url), "utf8");
const host = `<!doctype html><meta charset="utf-8"><title>Back Channel panel preview</title>
<style>body{font:15px system-ui;background:#f4f5f7;margin:40px auto;max-width:920px}iframe{width:100%;height:650px;border:1px solid #ddd;border-radius:16px;background:white}p{color:#677}</style>
<h2>Back Channel · chat panel preview</h2><p>Sample data · local test host</p><iframe src="/panel" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
const iframe=document.querySelector('iframe'), agents={self_agent_id:'laptop',agents:[{id:'laptop',name:'Loby on laptop',runtime:'codex',ready:true},{id:'home',name:'Loby at home',runtime:'claude_code',ready:true},{id:'research',name:'Research assistant',runtime:'chatgpt',ready:true},{id:'old',name:'Older assistant',runtime:'other',ready:false}]};
const inbox={connected:true,local_encryption:true,handle:'you@bc',agent_name:'Loby on laptop',inbox:{sessions:[{session_id:'friend',role:'host',peer_handle:'alex@bc',unread_count:2}]}};
let messages=[{id:'1',sender_agent_id:'home',target_agent_id:'laptop',text:'The home setup is ready. I left the notes for you.'},{id:'2',sender_agent_id:'laptop',target_agent_id:'home',text:'Thanks. I’ll review them after this chat.',read_at:'2026-10-09'}];
window.addEventListener('message',e=>{if(e.source!==iframe.contentWindow)return;const m=e.data;if(m.method==='ui/notifications/initialized'){e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:inbox}},'*');return}if(m.id===undefined)return;let result={};if(m.method==='ui/initialize')result={hostContext:{theme:'light'}};if(m.method==='tools/call'){let d={},a=m.params.arguments||{};switch(m.params.name){case 'bc_panel_inbox':case 'bc_open_panel':d=inbox;break;case 'bc_list_agents':d=agents;break;case 'bc_read_agent_messages':d={messages:messages.filter(x=>x.sender_agent_id===a.agent_id||x.target_agent_id===a.agent_id)};break;case 'bc_send_agent_message':messages.push({id:String(Date.now()),sender_agent_id:'laptop',target_agent_id:a.agent_id,text:a.text});d={message_id:messages.at(-1).id,status:'queued'};break;case 'bc_read_messages':d={frames:[JSON.stringify({type:'msg',text:'Are we still meeting tomorrow?'})]};break;case 'bc_send_message':d={sent_seq:3};break;case 'bc_request_session':d={status:'pending'};}result={content:[{type:'text',text:JSON.stringify(d)}],structuredContent:d};}e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*')});
</script>`;
const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(req.url === "/panel" ? panel : host); });
server.listen(8189, "127.0.0.1", () => console.log("Preview at http://127.0.0.1:8189"));
