// AppBridge relay gate under real PostgreSQL SERIALIZABLE contention.
// Run against an isolated migrated PostgreSQL database only (the postgres-roundtrip CI job):
// node --experimental-strip-types --import ./route-tests/register-hooks.mjs scripts/appbridge-integration.mts
//
// Every AppBridge transaction is SERIALIZABLE, and the ones exercised here race on the same rows the way
// real clients do: a phone's pooled connections redeem at once (every redeem reads the account's live
// leases for the caps, then inserts one), the relay renews while a PC reconnects, a rotated credential's
// first requests arrive together. Postgres aborts the losers with 40001. Those aborts are expected; none
// may reach a caller as a 503 while the retry bound holds, and no race may breach a cap or let a one-use
// code or pass be used twice.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomInt,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {NextRequest} from 'next/server';
import {prisma} from '../src/lib/db.ts';
import * as ab from '../src/lib/appbridge.ts';
const database=new URL(process.env.DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(database.hostname)&&database.pathname.endsWith('/dispatch_test'),'Dedicated local dispatch_test database required');
const relay=generateKeyPairSync('ed25519');
process.env.APPBRIDGE_REMOTE_ACCESS='on';
process.env.APPBRIDGE_RELAY_PUBLIC_KEY=relay.publicKey.export({type:'spki',format:'der'}).toString('base64');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const base='https://back-channel.app/api/appbridge/v1';
type Key={spki:string;fp:string;sign:(m:string)=>string};
function p256():Key{
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const der=publicKey.export({type:'spki',format:'der'});
 return {spki:der.toString('base64'),fp:createHash('sha256').update(der).digest('hex').toUpperCase(),sign:m=>sign('sha256',Buffer.from(m),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
}
const call=(method:string,path:string,credential?:string,body?:unknown)=>new NextRequest(base+path,{method,headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
function relayCall(route:string,body:unknown){
 const path=`/api/appbridge/v1/relay/${route}`,raw=JSON.stringify(body),seconds=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('base64url');
 const sig=sign(null,Buffer.from(`appbridge-relay-broker-v1\nPOST\n${path}\n${seconds}\n${nonce}\n${sha(raw)}`),relay.privateKey).toString('base64url');
 return new NextRequest('https://back-channel.app'+path,{method:'POST',body:raw,headers:{'content-type':'application/json',authorization:`AppBridge-Relay v1.${seconds}.${nonce}.${sig}`}});
}
// Statuses, sorted: a 503 anywhere fails the deepEqual that follows it.
const statuses=(rs:Response[])=>rs.map(r=>r.status).sort((a,b)=>a-b);
const together=<T,>(n:number,f:(i:number)=>Promise<T>)=>Promise.all(Array.from({length:n},(_,i)=>f(i)));
try{
 const account=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',emailVerifiedAt:new Date()}});
 await prisma.appBridgeEntitlement.create({data:{accountId:account.id,feature:ab.FEATURE,active:true}});
 const alphabet='ABCDEFGHJKMNPQRSTUVWXYZ23456789',part=()=>Array.from({length:4},()=>alphabet[randomInt(0,alphabet.length)]).join('');
 async function deviceCode(role:string){
  const code=`ABD-${part()}-${part()}`;
  await prisma.appBridgeDeviceCode.create({data:{codeHash:sha(code),accountId:account.id,role,expiresAt:new Date(Date.now()+600_000)}});
  return code;
 }
 const exchange=(code:string,role:string,key:Key)=>ab.exchangeDevice(call('POST','/devices/exchange',undefined,{code,role,connectorSpki:key.spki,proof:key.sign(`appbridge-device-exchange-v1:${code}`)}));

 // One device code, four devices racing to register with it: exactly one wins, the rest are told it is used.
 const hostCode=await deviceCode('host'),keys=[p256(),p256(),p256(),p256()];
 const exchanged=await Promise.all(keys.map(k=>exchange(hostCode,'host',k)));
 assert.deepEqual(statuses(exchanged),[200,410,410,410]);
 const won=exchanged.findIndex(r=>r.status===200);
 const host={...(await exchanged[won].json()) as {deviceId:string;credential:string},key:keys[won]};
 assert.equal(await prisma.appBridgeDevice.count({where:{accountId:account.id}}),1);
 assert.equal(await prisma.appBridgeCredential.count({where:{accountId:account.id}}),1);
 const remoteKey=p256(),remoteRes=await exchange(await deviceCode('remote'),'remote',remoteKey);assert.equal(remoteRes.status,200);
 const remote={...(await remoteRes.json()) as {deviceId:string;credential:string},key:remoteKey};
 console.log('PASS: a device code raced by four exchanges registers exactly one device');

 assert.equal((await ab.setRelay(call('PUT','/hosts/self/relay',host.credential,{enabled:true}))).status,200);
 // The host re-sends its attestation while the first is in flight: a unique race on one pairing row.
 assert.deepEqual(statuses(await together(4,()=>ab.attestPairing(call('PUT','/hosts/self/pairings/enr-1',host.credential,{remoteDeviceId:remote.deviceId}),'enr-1'))),[204,204,204,204]);
 assert.equal(await prisma.appBridgePairing.count({where:{hostDeviceId:host.deviceId}}),1);
 console.log('PASS: concurrent identical attestations are idempotent, one pairing row');

 const sessionPass=async()=>{const r=await ab.issueSessionPass(call('POST','/relay/passes',remote.credential,{hostDeviceId:host.deviceId,enrollmentId:'enr-1'}));assert.equal(r.status,200);return (await r.json()).pass as string;};
 const presencePass=async()=>{const r=await ab.issuePresencePass(call('POST','/relay/presence-passes',host.credential,{}));assert.equal(r.status,200);return (await r.json()).pass as string;};
 const redeem=(pass:string,purpose:string,fp:string)=>ab.redeemPass(relayCall('redeem',{pass,purpose,connectorSpkiSha256:fp}));
 const leases=(purpose:string)=>prisma.appBridgeLease.count({where:{accountId:account.id,purpose,expiresAt:{gt:new Date()}}});

 // A phone opens its pooled connections at once (at most 4 to one PC): four redeems, each reading the
 // account's live leases for the caps and inserting one. All four are admitted, none 503.
 const pool=await together(4,()=>sessionPass());
 const opened=await Promise.all(pool.map(p=>redeem(p,'session',remote.key.fp)));
 assert.deepEqual(statuses(opened),[200,200,200,200]);
 assert.equal(await leases('session'),4);
 // The per-PC cap under contention: with two slots freed, four more race for them. The newest connection
 // wins this phone's own slots to this PC, so all four are admitted and its oldest are superseded: still 4.
 const live=await Promise.all(opened.map(async r=>(await r.json()).leaseId as string));
 for(const leaseId of live.slice(2))assert.equal((await ab.releaseLease(relayCall('release',{leaseId}))).status,204);
 const racing=await together(4,()=>sessionPass());
 const raced=await Promise.all(racing.map(p=>redeem(p,'session',remote.key.fp)));
 assert.deepEqual(statuses(raced),[200,200,200,200]);
 assert.equal(await leases('session'),4,'the per-phone cap holds under contention: never 5 to one PC');
 const admitted=await Promise.all(raced.map(async r=>(await r.json()).leaseId as string));
 assert.equal(await prisma.appBridgeLease.count({where:{id:{in:live.slice(0,2)}}}),0,'the two oldest were superseded');
 assert.equal(await prisma.appBridgeLease.count({where:{id:{in:admitted}}}),4,'the four newest hold the slots');
 assert.equal(await prisma.appBridgeConnectionEvent.count({where:{accountId:account.id}}),8);
 assert.equal(await prisma.appBridgePass.count({where:{passHash:{in:[...pool,...racing].map(sha)},consumedAt:null}}),0,'every pass consumed once');
 console.log('PASS: concurrent session redeems for one phone never surface a 503; the newest supersede the oldest, never 5 to one PC');

 // One pass redeemed four times at once while the relay renews a live lease four times at once.
 for(const leaseId of admitted.slice(1))assert.equal((await ab.releaseLease(relayCall('release',{leaseId}))).status,204);
 const once=await sessionPass();
 const [renewed,redeemed]=await Promise.all([together(4,()=>ab.renewLease(relayCall('renew',{leaseId:admitted[0]}))),together(4,()=>redeem(once,'session',remote.key.fp))]);
 assert.deepEqual(statuses(renewed),[200,200,200,200]);
 assert.deepEqual(statuses(redeemed),[200,403,403,403]);
 assert.equal(await leases('session'),2,'the one pass opened one lease');
 console.log('PASS: a pass redeemed four times at once is admitted exactly once; renewals ride through');

 // A laptop on more than one PC: 4 connections per PC, 8 in total. It holds 2 to the first PC; four
 // racing redeems to a second PC are all admitted (6 in total), then four racing for the last 2 slots
 // (two to the first PC, two to a third) admit exactly two.
 const pcs=[];
 for(let i=0;i<2;i++){
  const key=p256(),res=await exchange(await deviceCode('host'),'host',key);assert.equal(res.status,200);
  const pc={...(await res.json()) as {deviceId:string;credential:string},key};
  assert.equal((await ab.setRelay(call('PUT','/hosts/self/relay',pc.credential,{enabled:true}))).status,200);
  assert.equal((await ab.attestPairing(call('PUT',`/hosts/self/pairings/enr-pc-${i}`,pc.credential,{remoteDeviceId:remote.deviceId}),`enr-pc-${i}`)).status,204);
  pcs.push(pc);
 }
 const passTo=async(hostDeviceId:string,enrollmentId:string)=>{const r=await ab.issueSessionPass(call('POST','/relay/passes',remote.credential,{hostDeviceId,enrollmentId}));assert.equal(r.status,200);return (await r.json()).pass as string;};
 const second=await together(4,()=>passTo(pcs[0].deviceId,'enr-pc-0'));
 assert.deepEqual(statuses(await Promise.all(second.map(p=>redeem(p,'session',remote.key.fp)))),[200,200,200,200]);
 const last=[...await together(2,()=>sessionPass()),...await together(2,()=>passTo(pcs[1].deviceId,'enr-pc-1'))];
 assert.deepEqual(statuses(await Promise.all(last.map(p=>redeem(p,'session',remote.key.fp)))),[200,200,409,409]);
 assert.equal(await leases('session'),8,'8 per remote across PCs holds under contention');
 const perPc=await prisma.appBridgeLease.groupBy({by:['hostDeviceId'],where:{accountId:account.id,purpose:'session',expiresAt:{gt:new Date()}},_count:true});
 assert.ok(perPc.every(g=>g._count<=4),'4 per PC holds under contention');
 console.log('PASS: a laptop on several PCs: 4 per PC and 8 in total hold under concurrent redeems, no 503');

 // A PC reconnecting its waiting connection: the per-account presence cap (4) holds under contention too.
 for(let i=0;i<2;i++)assert.equal((await redeem(await presencePass(),'presence',host.key.fp)).status,200);
 const presence=await together(4,()=>presencePass());
 assert.deepEqual(statuses(await Promise.all(presence.map(p=>redeem(p,'presence',host.key.fp)))),[200,200,409,409]);
 assert.equal(await leases('presence'),4);
 console.log('PASS: concurrent presence redeems never surface a 503, and the presence cap holds');

 // Device takeover (Skylar, 2026-09-25). Three remotes relayed at once: a fourth is told at pass issue
 // which devices are busy (409 devices_busy), takes over the oldest, and its pass redeems; every one of
 // the taken device's legs gets 404 at its next renewal. Then two waiting devices take over the same
 // device at once: exactly one takeover happens, neither sees a 503, and redeem's 3-remote limit, the
 // backstop, admits only one of them.
 const takenLeases=await prisma.appBridgeLease.findMany({where:{accountId:account.id,purpose:'session',remoteDeviceId:remote.deviceId,expiresAt:{gt:new Date()}},select:{id:true}});
 assert.ok(takenLeases.length>0);
 const phones=[];
 for(let i=0;i<5;i++){
  const key=p256(),res=await exchange(await deviceCode('remote'),'remote',key);assert.equal(res.status,200);
  const phone={...(await res.json()) as {deviceId:string;credential:string},key,enr:`enr-phone-${i}`};
  assert.equal((await ab.attestPairing(call('PUT',`/hosts/self/pairings/${phone.enr}`,host.credential,{remoteDeviceId:phone.deviceId}),phone.enr)).status,204);
  phones.push(phone);
 }
 const passFor=(p:typeof phones[number],takeover?:string)=>ab.issueSessionPass(call('POST','/relay/passes',p.credential,{hostDeviceId:host.deviceId,enrollmentId:p.enr,...(takeover?{takeover}:{})}));
 for(const p of phones.slice(0,2)){const r=await passFor(p);assert.equal(r.status,200);assert.equal((await redeem((await r.json()).pass,'session',p.key.fp)).status,200);}
 const busy=await passFor(phones[2]);
 assert.equal(busy.status,409);assert.equal(busy.headers.get('cache-control'),'no-store');
 const refusal=await busy.json() as {error:string;devices:{deviceId:string;label:string|null;since:string}[]};
 assert.equal(refusal.error,'devices_busy');
 assert.deepEqual(refusal.devices.map(d=>d.deviceId),[remote.deviceId,phones[0].deviceId,phones[1].deviceId],'the other busy devices, oldest first');
 assert.ok(refusal.devices.every(d=>Object.keys(d).sort().join()==='deviceId,label,since'),'nothing but id, label and since');
 const took=await passFor(phones[2],refusal.devices[0].deviceId);assert.equal(took.status,200);
 assert.equal((await redeem((await took.json()).pass,'session',phones[2].key.fp)).status,200,"the taker's pass redeems");
 for(const {id} of takenLeases)assert.equal((await ab.renewLease(relayCall('renew',{leaseId:id}))).status,404,"the taken device's next renewal is 404");
 const takeovers=()=>prisma.accountAudit.count({where:{accountId:account.id,eventType:'appbridge.device_takeover'}});
 assert.equal(await takeovers(),1);
 console.log('PASS: a fourth device is told who is busy, takes over the oldest, redeems; the taken legs end at renewal');
 const takers=await Promise.all(phones.slice(3).map(p=>passFor(p,phones[0].deviceId)));
 assert.deepEqual(statuses(takers),[200,200],'two takeovers of one device at once: no 503');
 assert.equal(await prisma.appBridgeLease.count({where:{accountId:account.id,purpose:'session',remoteDeviceId:phones[0].deviceId}}),0);
 assert.equal(await takeovers(),2,'the device was taken over once: the re-run found it no longer busy');
 const racedPasses=await Promise.all(takers.map(async r=>(await r.json()).pass as string));
 assert.deepEqual(statuses(await Promise.all(racedPasses.map((p,i)=>redeem(p,'session',phones[3+i].key.fp)))),[200,409],"redeem's 3-remote limit is the backstop");
 const relayed=await prisma.appBridgeLease.findMany({where:{accountId:account.id,purpose:'session',expiresAt:{gt:new Date()}},select:{remoteDeviceId:true},distinct:['remoteDeviceId']});
 assert.equal(relayed.length,3,'never a fourth remote');
 assert.equal(await leases('presence'),4,'presence leases are never displaced');
 console.log('PASS: concurrent takeovers of one device take it over once, never 503, and never admit a fourth remote');

 // Remote app sessions (docs/remote-app-sessions.md): the PC's "agent" lease under contention. With three
 // phones relayed, four agent passes for one approved session redeemed at once admit exactly the agent
 // budget (2) and never touch a phone's lease; then the person's Stop (the real route: session ended and its
 // leases deleted in one serializable transaction) races four renewals. No 503, and no lease outlives it.
 const agentToken=await prisma.agentToken.create({data:{accountId:account.id,keyHash:sha(randomUUID()),name:'Integration agent'}});
 const remoteSession=await prisma.remoteAppSession.create({data:{accountId:account.id,hostDeviceId:host.deviceId,agentTokenId:agentToken.id,goal:'Integration check',
  appAllowList:['QuickBooks'],minutes:30,status:'active',consentBy:account.id,consentVia:'web',startedAt:new Date(),expiresAt:new Date(Date.now()+30*60_000)}});
 const agentPass=async()=>{const r=await ab.issueAgentPass(call('POST','/relay/agent-passes',host.credential,{sessionId:remoteSession.id}));assert.equal(r.status,200);return (await r.json()).pass as string;};
 const phonesBefore=await leases('session');
 const agentRedeemed=await Promise.all((await together(4,()=>agentPass())).map(p=>redeem(p,'agent',host.key.fp)));
 assert.deepEqual(statuses(agentRedeemed),[200,200,409,409],'the agent budget holds under contention');
 assert.equal(await leases('agent'),2);
 assert.equal(await leases('session'),phonesBefore,'an agent lease never displaces a phone');
 const agentLeaseIds=await Promise.all(agentRedeemed.filter(r=>r.status===200).map(async r=>(await r.json()).leaseId as string));
 const rawCookie='cs_'+randomBytes(32).toString('base64url');
 await prisma.sessionCookie.create({data:{token:sha(rawCookie),accountId:account.id,expiresAt:new Date(Date.now()+3_600_000)}});
 const {remoteAppRoute}=await import('../src/lib/remote-app.ts');
 const stopReq=new NextRequest(`https://back-channel.app/api/remote-app/sessions/${remoteSession.id}/stop`,{method:'POST',headers:{'content-type':'application/json',cookie:`bc_session=${rawCookie}; bc_csrf=tok`,'x-bc-csrf':'tok'}});
 const [duringStop,stopped]=await Promise.all([together(4,i=>ab.renewLease(relayCall('renew',{leaseId:agentLeaseIds[i%2]}))),remoteAppRoute(stopReq,['sessions',remoteSession.id,'stop'])]);
 assert.equal(stopped.status,200,'the stop commits');
 assert.ok(duringStop.every(r=>[200,403,404].includes(r.status)),`renewals racing a stop never 503: ${statuses(duringStop)}`);
 assert.equal(await leases('agent'),0,'no agent lease outlives the stop');
 for(const leaseId of agentLeaseIds)assert.equal((await ab.renewLease(relayCall('renew',{leaseId}))).status,404);
 assert.equal((await prisma.remoteAppSession.findUniqueOrThrow({where:{id:remoteSession.id}})).endReason,'user_stop');
 assert.equal((await ab.issueAgentPass(call('POST','/relay/agent-passes',host.credential,{sessionId:remoteSession.id}))).status,403,'a stopped session never reopens');
 assert.equal(await leases('session'),phonesBefore,'and the phones were never touched');
 console.log('PASS: agent leases keep their own budget under contention, and a stop racing renewals leaves none alive');

 // Remote support (docs/remote-support.md): one code, five temporary clients redeeming it at once, each with its
 // own fresh key. Exactly one wins, with a session pinned to its key; every other one gets the uniform answer (never
 // a 503 or a second session). Then the winner's signed Allow, its "support" lease, and the person's Stop racing the
 // relay's renewals: no lease outlives the stop.
 process.env.ADMIN_EMAILS=account.email!;
 const {supportRoute}=await import('../src/lib/remote-support.ts');
 const supportAgent=await prisma.agentToken.create({data:{accountId:account.id,keyHash:sha(randomUUID()),name:'Support agent'}});
 const supportCode=`BCS-${part()}-${part()}`,mintedAt=new Date();
 const invite=await prisma.supportInvite.create({data:{accountId:account.id,agentTokenId:supportAgent.id,forName:'Integration',task:'Integration check',minutes:20,
  status:'minted',codeHash:sha(supportCode),mintedAt,codeExpiresAt:new Date(mintedAt.getTime()+15*60_000)}});
 const supportCall=(path:string[],body:unknown,credential?:string)=>supportRoute(new NextRequest(`https://back-channel.app/api/support/${path.join('/')}`,
  {method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(body)}),path);
 const racers=[p256(),p256(),p256(),p256(),p256()];
 const redemptions=await Promise.all(racers.map(k=>supportCall(['redeem'],{code:supportCode,keySpki:k.spki,proof:k.sign(`bc-support-redeem-v1:${supportCode}`)})));
 assert.deepEqual(statuses(redemptions),[200,410,410,410,410],'one code raced by five clients: exactly one redeems it');
 const winner=redemptions.findIndex(r=>r.status===200);
 const losers=await Promise.all(redemptions.filter((_,i)=>i!==winner).map(r=>r.json() as Promise<{error:string}>));
 assert.ok(losers.every(l=>l.error==='code_invalid'),'every loser gets the uniform answer');
 const helper=await redemptions[winner].json() as {sessionId:string;credential:string};
 const supportSessions=await prisma.remoteAppSession.findMany({where:{accountId:account.id,kind:'support'}});
 assert.equal(supportSessions.length,1,'one session');
 assert.equal(supportSessions[0].supportKeySha256,racers[winner].fp,'pinned to the winning key');
 const redeemedInvite=await prisma.supportInvite.findUniqueOrThrow({where:{id:invite.id}});
 assert.deepEqual([redeemedInvite.status,redeemedInvite.sessionId],['redeemed',helper.sessionId]);
 assert.equal(await prisma.accountAudit.count({where:{accountId:account.id,eventType:'support.redeemed'}}),1);
 console.log('PASS: one support code raced by five clients is redeemed exactly once, pinned to the first key, no 503');
 assert.equal((await supportCall(['client','allow'],{proof:racers[winner].sign(`bc-support-allow-v1:${helper.sessionId}`)},helper.credential)).status,200);
 const supportPass=async()=>{const r=await ab.issueSupportPass(call('POST','/relay/support-passes',helper.credential,{}));assert.equal(r.status,200);return (await r.json()).pass as string;};
 const supportRedeemed=await Promise.all((await together(3,()=>supportPass())).map(p=>redeem(p,'support',racers[winner].fp)));
 assert.deepEqual(statuses(supportRedeemed),[200,200,409],'the support budget (2) holds under contention');
 const supportLeaseIds=await Promise.all(supportRedeemed.filter(r=>r.status===200).map(async r=>(await r.json()).leaseId as string));
 // The support relay path (vault design/support-relay-contract.md §2): two of the account's own devices race four requests
 // for the issuer connector's pass to this running session. Exactly one device is pinned (its two requests get passes,
 // the other's two get 409 support_client_pinned), never a 503 or a half pin; then its passes redeemed at once admit
 // exactly the support-client budget (2), beside the helper's own legs.
 const issuers:{deviceId:string;credential:string;key:Key}[]=[];
 for(let i=0;i<2;i++){const key=p256(),res=await exchange(await deviceCode('remote'),'remote',key);assert.equal(res.status,200);issuers.push({...(await res.json()) as {deviceId:string;credential:string},key});}
 const clientPass=(d:typeof issuers[number])=>ab.issueSupportClientPass(call('POST','/relay/support-client-passes',d.credential,{sessionId:helper.sessionId}));
 const pinRace=await together(4,i=>clientPass(issuers[i%2]));
 assert.deepEqual(statuses(pinRace),[200,200,409,409],'two devices racing for one session: one is pinned, the other refused, no 503');
 const pinned=await prisma.remoteAppSession.findUniqueOrThrow({where:{id:helper.sessionId}});
 const pinnedAt=issuers.findIndex(d=>d.deviceId===pinned.supportClientDeviceId);
 assert.ok(pinnedAt>=0,'pinned to one of the two devices');
 assert.equal(pinned.supportClientKeySha256,issuers[pinnedAt].key.fp,'its key, with it');
 const raceBodies=await Promise.all(pinRace.map(r=>r.json() as Promise<{pass?:string;host?:string;executorSecretSha256?:string|null;error?:string}>));
 assert.ok(pinRace.every((r,i)=>r.status===200?i%2===pinnedAt:raceBodies[i].error==='support_client_pinned'),'every pass went to the pinned device');
 assert.ok(raceBodies.filter(b=>b.pass).every(b=>b.host===racers[winner].fp&&b.executorSecretSha256===pinned.executorSecretHash),"each names the helper's key and the session's secret hash");
 const issuerPasses=[...raceBodies.flatMap(b=>b.pass?[b.pass]:[]),(await (await clientPass(issuers[pinnedAt])).json()).pass as string];
 const clientRedeemed=await Promise.all(issuerPasses.map(p=>redeem(p,'support-client',issuers[pinnedAt].key.fp)));
 assert.deepEqual(statuses(clientRedeemed),[200,200,409],'the support-client budget (2) holds under contention');
 assert.equal(await leases('support-client'),2);
 assert.equal(await leases('support'),2,"and the helper's legs are never touched");
 console.log('PASS: two devices racing for the issuer pin pin exactly one, no 503; the support-client budget holds under contention');
 const supportStopReq=new NextRequest(`https://back-channel.app/api/support/invites/${invite.id}/stop`,{method:'POST',headers:{'content-type':'application/json',cookie:`bc_session=${rawCookie}; bc_csrf=tok`,'x-bc-csrf':'tok'}});
 const [renewedDuringStop,supportStopped]=await Promise.all([together(4,i=>ab.renewLease(relayCall('renew',{leaseId:supportLeaseIds[i%2]}))),supportRoute(supportStopReq,['invites',invite.id,'stop'])]);
 assert.equal(supportStopped.status,200,'the stop commits');
 assert.ok(renewedDuringStop.every(r=>[200,403,404].includes(r.status)),`renewals racing a support stop never 503: ${statuses(renewedDuringStop)}`);
 assert.equal(await leases('support'),0,'no support lease outlives the stop');
 assert.equal(await leases('support-client'),0,"nor any of the issuer connector's");
 assert.equal((await prisma.remoteAppSession.findUniqueOrThrow({where:{id:helper.sessionId}})).endReason,'user_stop');
 assert.equal((await ab.issueSupportPass(call('POST','/relay/support-passes',helper.credential,{}))).status,403,'a stopped support session never reopens');
 assert.equal((await clientPass(issuers[pinnedAt])).status,403,'not for the issuer either');
 console.log('PASS: the helper\'s support lease keeps its own budget, and the person\'s Stop racing renewals leaves none alive');

 // The job's schema comes from `prisma db push`, which carries none of the hand-written CHECKs. Replay the shipped
 // Phase A and support migrations into a scratch schema (the AppBridge pass and lease tables stubbed as the
 // 20260924030000 migration left them), so the SQL that ships is the SQL under test, and probe the constraints that
 // keep support rows honest. Comments are stripped before splitting: they contain semicolons.
 {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS support_migration CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA support_migration');
  const scratch=new PrismaClient({datasources:{db:{url:`${process.env.DATABASE_URL}?schema=support_migration`}}});
  try{
   for(const t of ['AppBridgePass','AppBridgeLease'])await scratch.$executeRawUnsafe(`CREATE TABLE "${t}" ("id" TEXT PRIMARY KEY,"purpose" TEXT NOT NULL,"accountId" TEXT NOT NULL,
    "hostDeviceId" TEXT NOT NULL,"remoteDeviceId" TEXT,"enrollmentId" TEXT,"expiresAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "${t}_purpose_check" CHECK ("purpose" IN ('session','presence')))`);
   for(const name of ['20261009220000_remote_app_sessions','20261010090000_remote_support','20261011090000_support_relay_path']){
    const sql=readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`,import.meta.url),'utf8').split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
    for(const stmt of sql.split(';').map(x=>x.trim()).filter(Boolean))await scratch.$executeRawUnsafe(stmt);
   }
   console.log('PASS: the remote_app_sessions, remote_support and support_relay_path migrations apply to PostgreSQL');
   const fp='AB'.repeat(32),cred='c'.repeat(64),relayId=`support_${'A'.repeat(22)}`;
   const session=(over:Record<string,string>={})=>{
    const v:Record<string,string>={id:`'${randomUUID()}'`,accountId:"'a'",kind:"'support'",hostDeviceId:`'${relayId}'`,agentTokenId:"'g'",goal:"'Fix the printer'",appAllowList:"'{}'",
     status:"'awaiting_consent'",minutes:'30',supportKeySha256:`'${fp}'`,supportKeySpki:"'spki'",supportCredentialHash:`'${cred}'`,supportCredentialExpiresAt:'now()',helperLabel:"'Mom'",...over};
    const cols=Object.keys(v).filter(k=>v[k]!=='DEFAULT');
    return `INSERT INTO "RemoteAppSession" (${cols.map(c=>`"${c}"`).join(',')}) VALUES (${cols.map(c=>v[c]).join(',')})`;
   };
   const agent={kind:"'agent'",hostDeviceId:"'pcShop000000000000000A'",appAllowList:"'{QuickBooks}'",supportKeySha256:'DEFAULT',supportKeySpki:'DEFAULT',
    supportCredentialHash:'DEFAULT',supportCredentialExpiresAt:'DEFAULT',helperLabel:'DEFAULT'};
   const running={status:"'active'",consentVia:"'helper'",startedAt:'now()',expiresAt:"now() + interval '30 minutes'"};
   const ok=async(sql:string,why:string)=>{try{await scratch.$executeRawUnsafe(sql);}catch(e){assert.fail(`${why}: ${e instanceof Error?e.message:e}`);}};
   const no=async(sql:string,why:string)=>{await assert.rejects(scratch.$executeRawUnsafe(sql),/23514|check constraint/,why);};
   await ok(session(),'a support session waiting for Allow');
   await ok(session({...running,supportCredentialHash:`'${'d'.repeat(64)}'`}),'a support session allowed on the helped screen');
   await ok(session({status:"'ended'",endReason:"'reported'",endedAt:'now()',supportCredentialHash:`'${'e'.repeat(64)}'`,removal:"'unconfirmed'",removalAt:'now()'}),'reported, with a receipt');
   await ok(session(agent),'an agent session is unchanged');
   await no(session({minutes:'46'}),'support is capped at 45 minutes');
   await no(session({...running,minutes:'45',expiresAt:"now() + interval '46 minutes'"}),'and so is its running window');
   await no(session({hostDeviceId:"'pcShop000000000000000A'"}),'a support session never names a device');
   await no(session({appAllowList:"'{Printers}'"}),'a support session has no app list');
   await no(session({...agent,appAllowList:"'{}'"}),'an agent session still needs 1 to 8 apps');
   await no(session({...running,consentVia:"'web'"}),'support consent is on the helped screen, never the dashboard');
   await no(session({...agent,...running,consentVia:"'helper'"}),'and an agent session is never helper-approved');
   await no(session({...running,status:"'blocked'"}),'a support session never pauses');
   await no(session({supportCredentialHash:'DEFAULT'}),'a support session is always pinned to a credential');
   await no(session({...agent,helperLabel:"'Mom'"}),'support columns are for support sessions only');
   await no(session({supportKeySha256:`'${'ab'.repeat(32)}'`}),'the key fingerprint is uppercase hex');
   const invite=(over:Record<string,string>={})=>{
    const v:Record<string,string>={id:`'${randomUUID()}'`,accountId:"'a'",agentTokenId:"'g'",forName:"'Mom'",task:"'Fix the printer'",minutes:'30',status:"'requested'",...over};
    return `INSERT INTO "SupportInvite" (${Object.keys(v).map(c=>`"${c}"`).join(',')}) VALUES (${Object.values(v).join(',')})`;
   };
   const mintedCols=(h:string)=>({status:"'minted'",codeHash:`'${h.repeat(64)}'`,mintedAt:"'2026-10-10T14:00:00Z'",codeExpiresAt:"'2026-10-10T14:15:00Z'"});
   await ok(invite(),'a request');
   await ok(invite(mintedCols('1')),'a minted code, 15 minutes');
   await ok(invite({...mintedCols('2'),status:"'withdrawn'"}),'withdrawn after minting keeps its hash');
   await ok(invite({...mintedCols('3'),status:"'redeemed'",redeemedAt:'now()',sessionId:`'${randomUUID()}'`}),'redeemed, naming its session');
   await no(invite({...mintedCols('4'),codeExpiresAt:"'2026-10-10T14:16:00Z'"}),'a code works 15 minutes at most');
   await no(invite({...mintedCols('5'),status:"'redeemed'",redeemedAt:'now()'}),'redeemed always names its session');
   await no(invite({codeHash:`'${'6'.repeat(64)}'`}),'a request has no code');
   await no(invite({...mintedCols('7'),codeHash:"'BCS-ABCD-EFGH'"}),'never a readable code, only its hash');
   await no(invite({minutes:'46'}),'45 minutes at most');
   await no(invite({task:"''"}),'a task is never empty');
   await ok(`INSERT INTO "RemoteAppActionLog" ("sessionId","action","target","outcome") VALUES ('s','invoke','Remove device','declined')`,'declined is an outcome');
   await no(`INSERT INTO "RemoteAppActionLog" ("sessionId","action","outcome") VALUES ('s','observe','maybe')`,'and outcomes are still fixed');
   await ok(`INSERT INTO "AppBridgePass" ("id","purpose","accountId","hostDeviceId","remoteAppSessionId","expiresAt") VALUES ('p1','support','a','${relayId}','s',now())`,'a support pass names its session');
   await no(`INSERT INTO "AppBridgePass" ("id","purpose","accountId","hostDeviceId","expiresAt") VALUES ('p2','support','a','${relayId}',now())`,'always');
   await no(`INSERT INTO "AppBridgeLease" ("id","purpose","accountId","hostDeviceId","remoteAppSessionId","expiresAt") VALUES ('l1','presence','a','h','s',now())`,'and nothing else does');
   console.log('PASS: the support CHECK constraints hold: 45 minutes, pinned keys, helper consent, no app list, hashed codes, bound passes');
   // 20261011090000_support_relay_path: the issuer pin, the executor secret's hash, and 'support-client' passes and leases.
   const issuerId="'issuerLaptop0000000000'",issuerKey=`'${'CD'.repeat(32)}'`,secretHash=`'${'5'.repeat(64)}'`;
   await ok(session({supportClientDeviceId:issuerId,supportClientKeySha256:issuerKey,executorSecretHash:secretHash,supportCredentialHash:`'${'9'.repeat(64)}'`}),'a support session with its issuer pinned and a secret hash');
   await ok(session({...running,executorSecretHash:secretHash,executorSecretIssuedAt:'now()',supportCredentialHash:`'${'8'.repeat(64)}'`}),'a secret handed out');
   await ok(session({...agent,executorSecretHash:secretHash}),'an agent session (v1.1) has a secret hash too');
   await no(session({...agent,supportClientDeviceId:issuerId,supportClientKeySha256:issuerKey}),'only a support session has an issuer pin');
   await no(session({supportClientKeySha256:issuerKey}),'the pin is a device and its key together');
   await no(session({supportClientDeviceId:issuerId}),'never a device without its key');
   await no(session({supportClientDeviceId:issuerId,supportClientKeySha256:`'${'cd'.repeat(32)}'`}),'the issuer key is uppercase hex');
   await no(session({executorSecretHash:`'${'5'.repeat(63)}'`}),'the secret hash is a sha256 hex digest');
   await no(session({executorSecretHash:`'${'E'.repeat(64)}'`}),'in lowercase hex');
   await no(session({executorSecretHash:`'${['abx','x'.repeat(43)].join('_')}'`}),'never the secret itself');
   await no(session({...running,executorSecretIssuedAt:'now()'}),'a secret handed out always has a hash');
   await ok(`INSERT INTO "AppBridgePass" ("id","purpose","accountId","hostDeviceId","remoteDeviceId","remoteAppSessionId","expiresAt") VALUES ('p3','support-client','a','${relayId}',${issuerId},'s',now())`,'a support-client pass names its session and the issuer device');
   await ok(`INSERT INTO "AppBridgeLease" ("id","purpose","accountId","hostDeviceId","remoteDeviceId","remoteAppSessionId","expiresAt") VALUES ('l2','support-client','a','${relayId}',${issuerId},'s',now())`,'and so does its lease');
   await no(`INSERT INTO "AppBridgePass" ("id","purpose","accountId","hostDeviceId","remoteDeviceId","expiresAt") VALUES ('p4','support-client','a','${relayId}',${issuerId},now())`,'always its session');
   await no(`INSERT INTO "AppBridgeLease" ("id","purpose","accountId","hostDeviceId","remoteAppSessionId","expiresAt") VALUES ('l3','support-client','a','${relayId}','s',now())`,'always the issuer device');
   await no(`INSERT INTO "AppBridgePass" ("id","purpose","accountId","hostDeviceId","remoteDeviceId","enrollmentId","remoteAppSessionId","expiresAt") VALUES ('p5','support-client','a','${relayId}',${issuerId},'enr','s',now())`,'never an enrollment');
   await no(`INSERT INTO "AppBridgeLease" ("id","purpose","accountId","hostDeviceId","remoteDeviceId","remoteAppSessionId","expiresAt") VALUES ('l4','support-host','a','${relayId}',${issuerId},'s',now())`,'purposes are still fixed');
   console.log('PASS: the support relay path CHECK constraints hold: support-only issuer pins, key and device together, hashed secrets, bound support-client passes and leases');
  }finally{
   await scratch.$disconnect();
   await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS support_migration CASCADE');
  }
 }

 // A rotated credential's first requests arrive together: each ends the predecessor, once.
 const rotated=await ab.rotateCredential(call('POST','/devices/self/credential',host.credential));assert.equal(rotated.status,200);
 const next=(await rotated.json()).credential as string;
 assert.deepEqual(statuses(await together(4,()=>ab.getSelf(call('GET','/devices/self',next)))),[200,200,200,200]);
 assert.ok((await prisma.appBridgeCredential.findUniqueOrThrow({where:{keyHash:sha(host.credential)}})).revokedAt,'the predecessor ended');
 assert.equal((await prisma.appBridgeCredential.findUniqueOrThrow({where:{keyHash:sha(next)}})).replacesKeyHash,null);
 assert.equal((await ab.getSelf(call('GET','/devices/self',host.credential))).status,401);
 console.log('PASS: concurrent first uses of a rotated credential never surface a 503');
 console.log('APPBRIDGE CONTENTION PASSED');
}finally{
 await prisma.$disconnect();
}
