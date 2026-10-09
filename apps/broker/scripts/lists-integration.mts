// Lists against real PostgreSQL (the postgres-roundtrip CI job), through the real REST handler and auth.
// node --experimental-strip-types --import ./route-tests/register-hooks.mjs scripts/lists-integration.mts
//
// The route tests use an in-memory Prisma; this proves the same flows against the database production
// runs: the hand-written migration applies and its CHECK constraints hold, the Prisma query shapes
// lists.ts uses are real (insensitive search, grouped counts, relation filters), and claims and edits
// raced under SERIALIZABLE end with one winner and no 503 while the retry bound holds.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {NextRequest} from 'next/server';
import {prisma} from '../src/lib/db.ts';
import {listsRoute,tasksWaitingForAgents} from '../src/lib/lists.ts';

const database=new URL(process.env.DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(database.hostname)&&database.pathname.endsWith('/dispatch_test'),'Dedicated local dispatch_test database required');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

// The job's schema comes from `prisma db push`. Rebuild the Lists tables from the migration that runs in
// production instead, so the SQL under test is the SQL that ships (comments stripped: they contain semicolons).
const sql=readFileSync(new URL('../prisma/migrations/20261009200000_task_lists/migration.sql',import.meta.url),'utf8')
 .split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
for(const t of ['TaskEntry','TaskItem','TaskListAgentGrant','TaskListMember','TaskList'])await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}" CASCADE`);
for(const stmt of sql.split(';').map(s=>s.trim()).filter(Boolean))await prisma.$executeRawUnsafe(stmt);
console.log('PASS: the task_lists migration applies to PostgreSQL');

type Agent={id:string;key:string};
type Who=Agent|'person'|'stranger';
type Res={status:number;body:any};// eslint-disable-line @typescript-eslint/no-explicit-any

try{
 const account=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',displayName:'Skylar',emailVerifiedAt:new Date()}});
 const other=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',emailVerifiedAt:new Date()}});
 async function agent(accountId:string,name:string,scope='full'):Promise<Agent>{
  const key=(scope==='full'?'bc_':'bco_')+randomBytes(32).toString('base64url');
  const row=await prisma.agentToken.create({data:{accountId,keyHash:sha(key),name,scope}});
  return {id:row.id,key};
 }
 const a1=await agent(account.id,'Claude Code'),a2=await agent(account.id,'Codex'),hosted=await agent(account.id,'ChatGPT','connector'),b1=await agent(other.id,'Their agent');
 async function cookieFor(accountId:string){
  const raw='cs_'+randomBytes(32).toString('base64url');
  await prisma.sessionCookie.create({data:{token:sha(raw),accountId,expiresAt:new Date(Date.now()+3600_000)}});
  return raw;
 }
 const cookie=await cookieFor(account.id),strangerCookie=await cookieFor(other.id),csrf='c'+randomBytes(12).toString('base64url');

 async function call(method:string,path:string,who:Who,body?:unknown):Promise<Res>{
  const headers:Record<string,string>={'content-type':'application/json'};
  if(who==='person'||who==='stranger'){headers.cookie=`bc_session=${who==='person'?cookie:strangerCookie}; bc_csrf=${csrf}`;headers['x-bc-csrf']=csrf;}
  else headers.authorization=`Bearer ${who.key}`;
  const url='https://back-channel.app/api/lists'+path;
  const req=new NextRequest(url,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const res=await listsRoute(req,new URL(url).pathname.replace(/^\/api\/lists\/?/,'').split('/').filter(Boolean));
  return {status:res.status,body:await res.json()};
 }
 const ok=(r:Res,what:string)=>{assert.equal(r.status,200,`${what}: ${JSON.stringify(r.body)}`);return r.body;};
 const refused=(r:Res,status:number,code:string,what:string)=>{assert.equal(r.status,status,`${what}: ${JSON.stringify(r.body)}`);assert.equal(r.body.error,code,what);};

 // A person creates a list for two of their agents; an agent adds a batch by list name.
 const {list}=ok(await call('POST','','person',{name:'Work',emoji:'🛠',agents:[a1.id,a2.id]}),'create list');
 const added=ok(await call('POST',`/${list.id}/tasks`,a1,{tasks:[
  {title:'Renew the Mimecast cert',due:'2026-10-31'},
  {title:'Patch the core switch',assignee:'my_agents'},
  {title:'Call the plumber',notes:'Kitchen sink'},
 ]}),'add batch').tasks;
 assert.equal(added.length,3);
 refused(await call('POST',`/${list.id}/tasks`,a1,{title:'key bc_'+'A'.repeat(43)}),422,'secret_like','secret refused');
 console.log('PASS: list created with agent grants; a batch added; secret-shaped text refused');

 // Grouped counts, insensitive search, the doorbell's relation filter, and seen-marking from the plate.
 assert.equal(ok(await call('GET','','person'),'lists').lists[0].counts.open,3);
 assert.deepEqual(ok(await call('GET','/search?q=MIMECAST',a1),'search').tasks.map((t:{title:string})=>t.title),['Renew the Mimecast cert']);
 assert.equal(await tasksWaitingForAgents(account.id),1);
 const plate=ok(await call('GET','/plate',a2),'plate');
 assert.ok(plate.up_next.some((t:{title:string})=>t.title==='Patch the core switch'));
 assert.equal(await tasksWaitingForAgents(account.id),0);
 assert.equal(ok(await call('GET','/plate',hosted),'connector plate').lists.length,0,'a hosted agent with no grant sees no lists');
 console.log('PASS: counts, insensitive search, doorbell count and seen-marking work against PostgreSQL');

 // Claims raced across both agents under SERIALIZABLE: one holder, one claimed event, no 503.
 const target=added[0];
 const raced=await Promise.all([a1,a2,a1,a2].map(a=>call('POST',`/tasks/${target.id}/claim`,a,{})));
 assert.ok(!raced.some(r=>r.status===503),`no 503s: ${raced.map(r=>r.status)}`);
 const row=await prisma.taskItem.findUniqueOrThrow({where:{id:target.id}});
 const holder=row.claimAgentId;
 assert.ok(holder===a1.id||holder===a2.id);
 raced.forEach((r,i)=>{const who=[a1,a2,a1,a2][i];if(who.id===holder)ok(r,'holder');else refused(r,409,'already_claimed','loser');});
 assert.equal(await prisma.taskEntry.count({where:{taskId:target.id,eventType:'claimed'}}),1);
 console.log('PASS: racing claims under SERIALIZABLE end with one holder and one claimed event');

 // Two edits made against the same version: one lands, the other hears edit_conflict.
 const note=added[2];
 const edits=await Promise.all([call('PATCH',`/tasks/${note.id}`,a1,{notes:'Under the sink, left side',version:1}),call('PATCH',`/tasks/${note.id}`,'person',{notes:'Call before 5pm',version:1})]);
 assert.deepEqual(edits.map(e=>e.status).sort(),[200,409]);
 assert.equal((await prisma.taskItem.findUniqueOrThrow({where:{id:note.id}})).version,2);
 console.log('PASS: concurrent edits against one version: one lands, one gets edit_conflict');

 // Progress renews the holder's claim; a lapsed claim is released with an activity line on the next read.
 const agentOf=(id:string|null)=>id===a1.id?a1:a2;
 const before=row.claimExpiresAt!.getTime();
 await new Promise(r=>setTimeout(r,20));
 ok(await call('PATCH',`/tasks/${target.id}`,agentOf(holder),{progress:'Checked expiry: Oct 28'}),'progress');
 assert.ok((await prisma.taskItem.findUniqueOrThrow({where:{id:target.id}})).claimExpiresAt!.getTime()>before);
 await prisma.taskItem.update({where:{id:target.id},data:{claimExpiresAt:new Date(Date.now()-1000)}});
 const view=ok(await call('GET',`/${list.id}`,'person'),'get list').tasks.find((t:{id:string})=>t.id===target.id);
 assert.equal(view.status,'open');
 assert.equal(view.claim,null);
 const lapsed=await prisma.taskEntry.findFirst({where:{taskId:target.id,eventType:'lapsed'}});
 assert.match(String(lapsed?.body),/Checked expiry/);
 console.log('PASS: progress renews a claim; a lapse is released and recorded with the last progress');

 // Finish with a summary, then send it back: the agent's claim comes back with a fresh lease.
 ok(await call('POST',`/tasks/${target.id}/claim`,a1,{}),'reclaim');
 refused(await call('POST',`/tasks/${target.id}/done`,a1,{}),400,'summary_required','agent without summary');
 assert.equal(ok(await call('POST',`/tasks/${target.id}/done`,a1,{summary:'Renewed; new expiry 2027-10-28'}),'done').task.status,'done');
 const back=ok(await call('POST',`/tasks/${target.id}/review`,'person',{verdict:'send_back',comment:'Also update the runbook'}),'send back').task;
 assert.equal(back.status,'in_progress');
 assert.equal(back.claim.by.agent_id,a1.id);
 console.log('PASS: finish with summary and send back');

 // The CHECK constraints from the migration hold underneath the app.
 await assert.rejects(prisma.taskItem.update({where:{id:target.id},data:{status:'bogus'}}));
 await assert.rejects(prisma.taskItem.update({where:{id:target.id},data:{claimAgentId:a2.id,claimAccountId:account.id,claimExpiresAt:null}}));
 await assert.rejects(prisma.taskEntry.create({data:{taskId:target.id,kind:'shout',authorAccountId:account.id,body:'x'}}));
 console.log('PASS: CHECK constraints refuse bad status, an agent claim without expiry, and an unknown entry kind');

 // Access: lowering an agent to view releases what it holds; other accounts see nothing; archive blocks writes.
 ok(await call('PUT',`/${list.id}/agents`,'person',{agent_id:a1.id,access:'view'}),'lower access');
 assert.equal((await prisma.taskItem.findUniqueOrThrow({where:{id:target.id}})).claimAgentId,null);
 refused(await call('POST',`/tasks/${target.id}/claim`,a1,{}),403,'not_allowed','view agent claim');
 refused(await call('GET',`/${list.id}`,b1),404,'not_available','another account\'s agent');
 refused(await call('GET',`/${list.id}`,'stranger'),404,'not_available','another person');
 ok(await call('PATCH',`/${list.id}`,'person',{archived:true}),'archive');
 refused(await call('POST',`/${list.id}/tasks`,a2,{title:'More'}),409,'archived','archived write');
 console.log('PASS: access changes, isolation between accounts, and archived lists');
}finally{
 await prisma.$disconnect();
}
