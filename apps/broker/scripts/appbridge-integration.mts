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
 // The cap under contention: with two slots freed, four more racing for them: exactly two are admitted.
 const live=await Promise.all(opened.map(async r=>(await r.json()).leaseId as string));
 for(const leaseId of live.slice(2))assert.equal((await ab.releaseLease(relayCall('release',{leaseId}))).status,204);
 const racing=await together(4,()=>sessionPass());
 const raced=await Promise.all(racing.map(p=>redeem(p,'session',remote.key.fp)));
 assert.deepEqual(statuses(raced),[200,200,409,409]);
 assert.equal(await leases('session'),4,'the per-phone cap holds under contention');
 assert.equal(await prisma.appBridgeConnectionEvent.count({where:{accountId:account.id}}),6);
 assert.equal(await prisma.appBridgePass.count({where:{passHash:{in:[...pool,...racing].map(sha)},consumedAt:null}}),0,'every pass consumed once, admitted or refused');
 console.log('PASS: concurrent session redeems for one phone never surface a 503, and the cap holds');

 // One pass redeemed four times at once while the relay renews a live lease four times at once.
 const admitted=await Promise.all(raced.filter(r=>r.status===200).map(async r=>(await r.json()).leaseId as string));
 for(const leaseId of [live[1],...admitted])assert.equal((await ab.releaseLease(relayCall('release',{leaseId}))).status,204);
 const once=await sessionPass();
 const [renewed,redeemed]=await Promise.all([together(4,()=>ab.renewLease(relayCall('renew',{leaseId:live[0]}))),together(4,()=>redeem(once,'session',remote.key.fp))]);
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
