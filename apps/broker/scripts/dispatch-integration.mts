// Run against an isolated migrated PostgreSQL database only.
// node --experimental-strip-types --import ./route-tests/register-hooks.mjs scripts/dispatch-integration.mts
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {NextRequest} from 'next/server';
import {prisma} from '../src/lib/db.ts';
import {dispatch} from '../src/lib/dispatch.ts';
import {identity} from '../../../packages/worker/src/crypto.mjs';
import {Store} from '../../../packages/worker/src/store.mjs';
import {Client,Worker} from '../../../packages/worker/src/worker.mjs';
const database=new URL(process.env.DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(database.hostname)&&database.pathname.endsWith('/dispatch_test'),'Dedicated local dispatch_test database required');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bc-dispatch-integration-'));
const server=http.createServer(async(req,res)=>{
 try{
  let body='';for await(const chunk of req){body+=chunk;if(body.length>800000)throw Error('Too large');}
  const url=new URL(req.url!,'http://127.0.0.1');const parts=url.pathname.split('/').filter(Boolean);
  const operation=parts[2]==='agents'?(req.method==='GET'?'agents':'enroll'):parts[3]?parts[4]:(req.method==='GET'?'tasks':'submit');
  const request=new NextRequest('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers as Record<string,string>,...(req.method!=='GET'?{body:body||'{}'}:{})});
  const response=await dispatch(request,operation as never,parts[3]);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
 }catch{res.writeHead(500);res.end('{}');}
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const broker=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
try{
 const account=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',emailVerifiedAt:new Date()}});
 const other=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',emailVerifiedAt:new Date()}});
 async function agent(accountId:string,name:string){
  const token='bc_'+randomBytes(24).toString('base64url'),keys=identity();
  const row=await prisma.agentToken.create({data:{accountId,name,keyHash:createHash('sha256').update(token).digest('hex')}});
  const config={broker,name,token,agentId:row.id,identity:keys,peers:{},profiles:{}};
  const client=new Client(config);await client.request('/agents',{name,encryptionKey:keys.encryptionKey,signingKey:keys.signingKey});
  return {config,client,store:new Store(path.join(root,name))};
 }
 const a=await agent(account.id,'sender'),b=await agent(account.id,'receiver'),c=await agent(other.id,'outsider');
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);assert.equal(spawnSync('git',['init',workspace],{windowsHide:true}).status,0);
 const fixture=path.resolve('../../packages/worker/test/fixtures/runtime.mjs');
 const actual=process.env.BC_TEST_CODEX_EXE;
 const profile={adapter:actual?'codex':'fixture',testOnly:!actual,executable:actual??process.execPath,cwd:workspace,fixtureScript:fixture,allowedSenders:[a.config.agentId,b.config.agentId],sandbox:'read-only',maxRuntimeMs:120000,maxOutputBytes:32000};
 for(const [local,peer]of [[a,b],[b,a]]){
  local.config.peers={[peer.config.agentId]:{encryptionKey:peer.config.identity.encryptionKey,signingKey:peer.config.identity.signingKey}};
  local.config.profiles={approved:profile};local.store.write('config',local.config);
 }
 const aw=new Worker(a.store),bw=new Worker(b.store);
 const id=await aw.send({targetAgentId:b.config.agentId,profile:'approved',objective:'Return the exact phrase DISPATCH_ROUNDTRIP_OK in your summary. Do not use tools or change files.',continuationProfile:'approved'});
 await bw.cycle();await aw.cycle();await bw.cycle();await aw.cycle();
 const completed=await prisma.dispatchTask.findUniqueOrThrow({where:{id}});
 assert.equal(completed.status,'completed');assert.ok(completed.resultSealed);assert.ok(!completed.sealed.includes('DISPATCH_ROUNDTRIP_OK'));
 assert.equal(aw.journal.continuations[id].state,'completed');
 assert.equal(Object.keys(bw.journal.tasks).length,1);
 console.log('PASS: PostgreSQL + HTTP + encrypted task + runtime + encrypted result + requester continuation');
 const queued=await aw.send({targetAgentId:b.config.agentId,profile:'approved',objective:'Concurrency claim only'});
 const claims=await Promise.allSettled([b.client.request(`/tasks/${queued}/claim`,{}),b.client.request(`/tasks/${queued}/claim`,{})]);
 assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
 await prisma.dispatchTask.update({where:{id:queued},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
 await b.client.request('/tasks');assert.equal((await prisma.dispatchTask.findUniqueOrThrow({where:{id:queued}})).status,'interrupted');
 await assert.rejects(b.client.request(`/tasks/${queued}/claim`,{}));
 assert.equal((await c.client.request('/tasks')).tasks.length,0);
 await assert.rejects(c.client.request(`/tasks/${queued}/claim`,{}));
 console.log('PASS: concurrent database claims have one winner; expired execution does not replay; foreign account isolated');
 const rejected=await aw.send({targetAgentId:b.config.agentId,profile:'missing',objective:'Must never launch'});
 await bw.cycle();assert.equal((await prisma.dispatchTask.findUniqueOrThrow({where:{id:rejected}})).status,'rejected');
 await prisma.agentToken.update({where:{id:b.config.agentId},data:{revokedAt:new Date()}});
 await assert.rejects(b.client.request('/agents'));
 console.log('PASS: policy rejection reported to broker and token revocation enforced');
 console.log(actual?'REAL CODEX ROUNDTRIP PASSED':'FIXTURE ROUNDTRIP PASSED');
}finally{
 await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();
 // Keep isolated evidence/state for review. Never touch production data.
 console.log('Local integration evidence: '+root);
}
