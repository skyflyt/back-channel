// Lists against real PostgreSQL (the postgres-roundtrip CI job), through the real REST handler and auth.
// node --experimental-strip-types --import ./route-tests/register-hooks.mjs scripts/lists-integration.mts
//
// The route tests use an in-memory Prisma; this proves the same flows against the database production
// runs: the hand-written migrations apply in order and their CHECK constraints and unique indexes hold,
// the Prisma query shapes lists.ts uses are real (insensitive search, grouped counts, relation filters),
// claims and edits raced under SERIALIZABLE end with one winner and no 503 while the retry bound holds,
// and sharing with a friend (Phase 2) works end to end: friends-only add, the OK rule across two
// accounts from the web and from chat, mentions and the doorbell, reactions, and revocation through the
// real trust route. Phase 3: templates (built in and saved, as JSONB), "Duplicate list", the new CHECK
// constraints and account cascade, and the daily digest's once-a-day claim under overlapping runs.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {NextRequest} from 'next/server';
import {prisma} from '../src/lib/db.ts';
import {listsRoute,tasksWaitingForAgents} from '../src/lib/lists.ts';
import {runListsDigest} from '../src/lib/lists-digest.ts';
import {DELETE as trustDELETE} from '../src/app/api/trust/[handle]/route.ts';

const database=new URL(process.env.DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(database.hostname)&&database.pathname.endsWith('/dispatch_test'),'Dedicated local dispatch_test database required');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

// The job's schema comes from `prisma db push`. Rebuild the Lists tables from the migrations that run in
// production instead, in order, so the SQL under test is the SQL that ships (comments stripped: they
// contain semicolons).
const MIGRATIONS=['20261009200000_task_lists','20261009210000_task_lists_sharing','20261009230000_task_lists_phase3'];
for(const t of ['ListsPreference','TaskListTemplate','TaskListEvent','TaskReaction','TaskMention','TaskAgentOk','TaskEntry','TaskItem','TaskListAgentGrant','TaskListMember','TaskList'])await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}" CASCADE`);
for(const m of MIGRATIONS){
 const sql=readFileSync(new URL(`../prisma/migrations/${m}/migration.sql`,import.meta.url),'utf8').split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
 for(const stmt of sql.split(';').map(s=>s.trim()).filter(Boolean))await prisma.$executeRawUnsafe(stmt);
 console.log(`PASS: the ${m} migration applies to PostgreSQL`);
}

type Agent={id:string;key:string};
type Who=Agent|'person'|'stranger'|'friend';
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
 const friend=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',displayName:'Alex',emailVerifiedAt:new Date()}});
 const f1=await agent(friend.id,'Their agent');
 const cookie=await cookieFor(account.id),strangerCookie=await cookieFor(other.id),friendCookie=await cookieFor(friend.id),csrf='c'+randomBytes(12).toString('base64url');
 const cookies={person:cookie,stranger:strangerCookie,friend:friendCookie};

 async function call(method:string,path:string,who:Who,body?:unknown):Promise<Res>{
  const headers:Record<string,string>={'content-type':'application/json'};
  if(typeof who==='string'){headers.cookie=`bc_session=${cookies[who]}; bc_csrf=${csrf}`;headers['x-bc-csrf']=csrf;}
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

 // The always-on worker (packages/worker, lists mode) never retries a task until its updated_at moves.
 // Edits, reassignments and status changes go through updateMany without setting updatedAt themselves,
 // so prove Prisma's @updatedAt really bumps it there, against PostgreSQL.
 const stamp=async()=>(await prisma.taskItem.findUniqueOrThrow({where:{id:note.id}})).updatedAt.getTime();
 let seen=await stamp();
 for(const [what,body] of [['an edit',{title:'Call the plumber (kitchen)',version:2}],['a reassignment',{assignee:'my_agents'}],['a status change',{status:'blocked',reason:'waiting on the landlord'}]] as const){
  await new Promise(r=>setTimeout(r,15));
  ok(await call('PATCH',`/tasks/${note.id}`,'person',body),what);
  const now=await stamp();
  assert.ok(now>seen,`${what} moves updated_at`);
  seen=now;
 }
 console.log('PASS: edits, reassignments and status changes move updated_at (the worker relies on it)');

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

 // ── Phase 2: sharing with a friend ──
 // Friends are mutual trust: both TrustedPeer rows. A stranger and a handle that doesn't exist get the same answer.
 await prisma.trustedPeer.createMany({data:[{accountId:account.id,trustedAccountId:friend.id,scopeDefaults:[]},{accountId:friend.id,trustedAccountId:account.id,scopeDefaults:[]}]});
 const trip=ok(await call('POST','','person',{name:'Trip',agents:[a1.id]}),'create shared list').list;
 const stranger=await call('POST',`/${trip.id}/members`,'person',{handle:other.handle});
 const unknown=await call('POST',`/${trip.id}/members`,'person',{handle:randomUUID()+'@bc'});
 refused(stranger,403,'not_a_friend','a stranger');
 assert.deepEqual(unknown,stranger,'an unknown handle reads exactly like a stranger');
 refused(await call('POST',`/${trip.id}/members`,a1,{handle:friend.handle}),403,'people_only','an agent can\'t share');
 assert.deepEqual(ok(await call('POST',`/${trip.id}/members`,'person',{handle:friend.handle}),'add friend').members.map((m:{role:string})=>m.role),['owner','member']);
 ok(await call('PUT',`/${trip.id}/agents`,'friend',{agent_id:f1.id,access:'work'}),'friend grants own agent');
 assert.equal((await prisma.taskListEvent.findMany({where:{listId:trip.id}})).map(e=>e.eventType).join(),'member_added');
 console.log('PASS: friends-only add (a stranger and an unknown handle read the same), cookie-only, friend grants own agent');

 // The OK rule across two accounts: the friend's agent waits for the FRIEND's OK; the owner's OK never covers it.
 const airbnb=ok(await call('POST',`/${trip.id}/tasks`,'person',{title:'Book the Airbnb'}),'add').tasks[0];
 refused(await call('POST',`/tasks/${airbnb.id}/claim`,f1,{}),409,'needs_ok','before any OK');
 ok(await call('POST',`/tasks/${airbnb.id}/ok`,'person',{}),'owner OKs her own task: nothing to record');
 refused(await call('POST',`/tasks/${airbnb.id}/claim`,f1,{}),409,'needs_ok','the owner\'s OK is not the friend\'s');
 assert.ok(ok(await call('GET','/plate','friend'),'friend plate').ok_requests.some((t:{id:string})=>t.id===airbnb.id));
 assert.equal(ok(await call('POST',`/tasks/${airbnb.id}/ok`,'friend',{}),'friend OKs').task.agent_may_act.ok,true);
 ok(await call('POST',`/tasks/${airbnb.id}/claim`,f1,{}),'claim after OK');
 const car=ok(await call('POST',`/${trip.id}/tasks`,'person',{title:'Rent a car'}),'add').tasks[0];
 ok(await call('POST',`/tasks/${car.id}/claim`,f1,{ok_from:'user_in_chat'}),'OK\'d in chat, then claimed');
 const oks=await prisma.taskAgentOk.findMany({where:{taskId:{in:[airbnb.id,car.id]}},orderBy:{createdAt:'asc'}});
 assert.deepEqual(oks.map(o=>[o.accountId,o.via,o.viaAgentId]),[[friend.id,'web',null],[friend.id,'user_in_chat',f1.id]]);
 assert.equal((await prisma.taskEntry.findFirst({where:{taskId:car.id,eventType:'ok'}}))?.body,'OK\'d this for their agents (via Their agent)');
 console.log('PASS: the OK rule across two accounts, from the web and from chat');

 // Mentions: an agent mention rings the doorbell until that agent reads the task; a person mention waits on the plate.
 const waitingBefore=await tasksWaitingForAgents(friend.id);
 ok(await call('POST',`/tasks/${car.id}/entries`,'person',{kind:'comment',text:`@their-agent and @${friend.handle.replace(/@bc$/,'')}: return it by 5`}),'comment with mentions');
 assert.deepEqual((await prisma.taskMention.findMany({where:{taskId:car.id}})).map(m=>m.agentId).sort(),[f1.id,null].sort());
 assert.equal(await tasksWaitingForAgents(friend.id),waitingBefore+1);
 ok(await call('GET',`/tasks/${car.id}`,f1),'the mentioned agent reads it');
 assert.equal(await tasksWaitingForAgents(friend.id),waitingBefore);
 assert.equal(ok(await call('GET','/plate','friend'),'friend plate').mentions.length,1);
 console.log('PASS: mentions are recorded, ring until seen, and wait on the person\'s plate');

 // Reactions toggle; the COALESCE unique index holds underneath.
 assert.equal(ok(await call('POST',`/tasks/${car.id}/react`,'friend',{emoji:'👍'}),'react').task.reactions[0].count,1);
 assert.deepEqual(ok(await call('POST',`/tasks/${car.id}/react`,'friend',{emoji:'👍'}),'unreact').task.reactions,[]);
 await prisma.taskReaction.create({data:{taskId:car.id,accountId:friend.id,emoji:'🎉'}});
 await assert.rejects(prisma.taskReaction.create({data:{taskId:car.id,accountId:friend.id,emoji:'🎉'}}),'one each, even with agentId NULL');
 console.log('PASS: reactions toggle, and the unique index holds');

 // Revocation fails closed with no cleanup: one directed row gone and the friend and their agent are out.
 await prisma.trustedPeer.deleteMany({where:{accountId:account.id,trustedAccountId:friend.id}});
 refused(await call('GET',`/${trip.id}`,'friend'),404,'not_available','after the owner untrusts, before any cleanup');
 refused(await call('GET',`/tasks/${car.id}`,f1),404,'not_available','their agent too');
 await prisma.trustedPeer.create({data:{accountId:account.id,trustedAccountId:friend.id,scopeDefaults:[]}});
 ok(await call('GET',`/${trip.id}`,'friend'),'friends again');
 // Then through the real trust route: the friend comes off, their agent's access ends, its claims are released with a line.
 const revoke=await trustDELETE(new NextRequest(`https://back-channel.app/api/trust/${encodeURIComponent(account.handle)}`,{method:'DELETE',headers:{cookie:`bc_session=${friendCookie}; bc_csrf=${csrf}`,'x-bc-csrf':csrf}}),{params:Promise.resolve({handle:account.handle})});
 assert.equal(revoke.status,200);
 assert.equal(await prisma.taskListMember.count({where:{listId:trip.id,accountId:friend.id}}),0);
 assert.equal(await prisma.taskListAgentGrant.count({where:{listId:trip.id,accountId:friend.id}}),0);
 for(const t of [airbnb,car]){
  const row=await prisma.taskItem.findUniqueOrThrow({where:{id:t.id}});
  assert.equal(row.claimAgentId,null);
  assert.match(String((await prisma.taskEntry.findFirst({where:{taskId:t.id,eventType:'member_left'}}))?.body),/^left the list and released "/);
 }
 assert.deepEqual((await prisma.taskListEvent.findMany({where:{listId:trip.id},orderBy:{createdAt:'asc'}})).map(e=>e.eventType),['member_added','member_left']);
 refused(await call('GET',`/${trip.id}`,'friend'),404,'not_available','after the trust route');
 console.log('PASS: revocation fails closed at once, and the trust route cleans up with activity lines');

 // The new CHECK constraints hold underneath the app.
 await assert.rejects(prisma.taskAgentOk.create({data:{taskId:car.id,accountId:other.id,via:'because'}}));
 await assert.rejects(prisma.taskAgentOk.create({data:{taskId:car.id,accountId:other.id,via:'user_in_chat'}}),'a chat OK names its agent');
 await assert.rejects(prisma.taskReaction.create({data:{taskId:car.id,accountId:other.id,emoji:'🔥'}}));
 await assert.rejects(prisma.taskListMember.update({where:{listId_accountId:{listId:trip.id,accountId:account.id}},data:{notify:'always'}}));
 await assert.rejects(prisma.taskListEvent.create({data:{listId:trip.id,eventType:'member_banned',actorAccountId:account.id,subjectAccountId:friend.id}}));
 console.log('PASS: CHECK constraints refuse a bad OK, a chat OK without its agent, an unknown reaction, a bad notify and an unknown list event');

 // ── Phase 3: templates, duplicate, the digest ──
 const packing=ok(await call('POST','','person',{template:'builtin:trip-packing',agents:[a1.id]}),'list from a built-in');
 assert.equal(packing.list.name,'Trip packing');
 const packed=await prisma.taskItem.findMany({where:{listId:packing.list.id},orderBy:{position:'asc'}});
 assert.equal(packed.length,packing.tasks_added);
 assert.equal(packed[0].title,'Passport or ID');
 assert.ok(packed.every(t=>t.createdByAccountId===account.id&&t.createdByAgentId===null&&t.status==='open'));
 const src=ok(await call('POST','','person',{name:'Sprint',agents:[a1.id]}),'sprint').list;
 ok(await call('POST',`/${src.id}/tasks`,'person',{tasks:[{title:'Plan',notes:'Monday, 10:00'},{title:'Demo'}]}),'sprint tasks');
 const saved=ok(await call('POST','/templates','person',{list_id:src.id,name:'Sprint kickoff'}),'save as template').template;
 const stored=await prisma.taskListTemplate.findUniqueOrThrow({where:{id:saved.id}});
 assert.deepEqual(stored.items,[{title:'Plan',notes:'Monday, 10:00'},{title:'Demo',notes:''}],'items round-trip through JSONB');
 const fromSaved=ok(await call('POST','',a1,{template:'sprint kickoff'}),'an agent starts a list from its person\'s template by name');
 assert.deepEqual((await prisma.taskItem.findMany({where:{listId:fromSaved.list.id},orderBy:{position:'asc'}})).map(t=>[t.title,t.createdByAgentId]),[['Plan',a1.id],['Demo',a1.id]]);
 refused(await call('POST','',b1,{template:saved.id}),404,'no_such_template','another account\'s template');
 assert.equal(ok(await call('GET','/templates',a1),'templates').templates.filter((t:{kind:string})=>t.kind==='saved').length,1);
 const copy=ok(await call('POST','','person',{duplicate:src.id}),'duplicate').list;
 assert.equal(copy.name,'Sprint (copy)');
 assert.deepEqual((await prisma.taskEntry.findMany({where:{task:{listId:copy.id}}})).map(e=>e.eventType),['copied','copied']);
 refused(await call('POST','',a1,{duplicate:src.id}),403,'people_only','an agent can\'t duplicate');
 ok(await call('DELETE',`/templates/${saved.id}`,'person'),'delete template');
 assert.equal(await prisma.taskListTemplate.count({where:{id:saved.id}}),0);
 await assert.rejects(prisma.taskListTemplate.create({data:{ownerAccountId:account.id,name:'Empty',items:[]}}),'an empty template');
 await assert.rejects(prisma.taskListTemplate.create({data:{ownerAccountId:account.id,name:'Not a list',items:{title:'x'}}}),'items must be an array');
 await assert.rejects(prisma.listsPreference.create({data:{accountId:account.id,digest:'weekly'}}));
 await assert.rejects(prisma.listsPreference.create({data:{accountId:account.id,digestHour:24}}));
 console.log('PASS: built-in and saved templates (JSONB round trip), duplicate, and the Phase 3 CHECK constraints');

 // Deleting an account deletes its templates and its preference (foreign keys in the migration only).
 const leaving=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid'}});
 await prisma.taskListTemplate.create({data:{ownerAccountId:leaving.id,name:'Mine',items:[{title:'x',notes:''}]}});
 await prisma.listsPreference.create({data:{accountId:leaving.id,digest:'daily'}});
 await prisma.account.delete({where:{id:leaving.id}});
 assert.equal(await prisma.taskListTemplate.count({where:{ownerAccountId:leaving.id}}),0);
 assert.equal(await prisma.listsPreference.count({where:{accountId:leaving.id}}),0);
 console.log('PASS: templates and the digest preference cascade with the account');

 // The digest: turned on through the route, then two overlapping runs claim today's at most once.
 ok(await call('PATCH','/preferences','person',{digest:'daily',digest_hour:0,timezone:'UTC'}),'turn the digest on');
 await prisma.listsPreference.update({where:{accountId:account.id},data:{lastDigestAt:null}});
 const now=new Date();
 const runs=await Promise.all([runListsDigest(now),runListsDigest(now),runListsDigest(now)]);
 const handled=runs.reduce((n,r)=>n+r.sent+r.not_sent+r.empty+r.failed,0);
 assert.equal(handled,1,`one digest across overlapping runs: ${JSON.stringify(runs)}`);
 assert.equal((await prisma.listsPreference.findUniqueOrThrow({where:{accountId:account.id}})).lastDigestAt?.getTime(),now.getTime());
 assert.equal((await runListsDigest(now)).due,0,'and none again today');
 assert.equal((await runListsDigest(new Date(now.getTime()+24*3600_000))).due>=1,true,'tomorrow it is due again');
 console.log('PASS: the daily digest is claimed once per account per day under overlapping runs');
}finally{
 await prisma.$disconnect();
}
