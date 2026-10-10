// Temporary (soak evidence, removed with .github/workflows/appbridge-contention-soak.yml): the largest bursts
// the caps allow, against real PostgreSQL. A laptop opening all 8 of its pairs at once (4 to each of two PCs,
// MAX_PAIRS_PER_REMOTE) must be admitted 8 times; 8 presence redeems racing for the account's 4 presence slots
// must admit 4 and refuse 4 with 409. A 503 anywhere is a refused connection.
// node --experimental-strip-types --import ./route-tests/register-hooks.mjs scripts/appbridge-burst-soak.mts
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
const statuses=(rs:Response[])=>rs.map(r=>r.status).sort((a,b)=>a-b);
try{
 const account=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',emailVerifiedAt:new Date()}});
 await prisma.appBridgeEntitlement.create({data:{accountId:account.id,feature:ab.FEATURE,active:true}});
 const alphabet='ABCDEFGHJKMNPQRSTUVWXYZ23456789',part=()=>Array.from({length:4},()=>alphabet[randomInt(0,alphabet.length)]).join('');
 async function device(role:string){
  const code=`ABD-${part()}-${part()}`,key=p256();
  await prisma.appBridgeDeviceCode.create({data:{codeHash:sha(code),accountId:account.id,role,expiresAt:new Date(Date.now()+600_000)}});
  const r=await ab.exchangeDevice(call('POST','/devices/exchange',undefined,{code,role,connectorSpki:key.spki,proof:key.sign(`appbridge-device-exchange-v1:${code}`)}));
  assert.equal(r.status,200);return {...(await r.json()) as {deviceId:string;credential:string},key};
 }
 const laptop=await device('remote'),pcs=[await device('host'),await device('host')];
 for(const [i,pc] of pcs.entries()){
  assert.equal((await ab.setRelay(call('PUT','/hosts/self/relay',pc.credential,{enabled:true}))).status,200);
  assert.equal((await ab.attestPairing(call('PUT',`/hosts/self/pairings/enr-${i}`,pc.credential,{remoteDeviceId:laptop.deviceId}),`enr-${i}`)).status,204);
 }
 const issue=async(pc:number)=>{const r=await ab.issueSessionPass(call('POST','/relay/passes',laptop.credential,{hostDeviceId:pcs[pc].deviceId,enrollmentId:`enr-${pc}`}));assert.equal(r.status,200);return (await r.json()).pass as string;};
 const passes:string[]=[];for(let i=0;i<8;i++)passes.push(await issue(i%2));
 const started=Date.now();
 const sessions=await Promise.all(passes.map(pass=>ab.redeemPass(relayCall('redeem',{pass,purpose:'session',connectorSpkiSha256:laptop.key.fp}))));
 const sessionMs=Date.now()-started;
 const presencePasses:string[]=[];
 for(let i=0;i<8;i++){const r=await ab.issuePresencePass(call('POST','/relay/presence-passes',pcs[i%2].credential,{}));assert.equal(r.status,200);presencePasses.push((await r.json()).pass);}
 const t2=Date.now();
 const presence=await Promise.all(presencePasses.map((pass,i)=>ab.redeemPass(relayCall('redeem',{pass,purpose:'presence',connectorSpkiSha256:pcs[i%2].key.fp}))));
 const presenceMs=Date.now()-t2;
 console.log(`BURST session=${JSON.stringify(statuses(sessions))} ${sessionMs}ms presence=${JSON.stringify(statuses(presence))} ${presenceMs}ms`);
 assert.deepEqual(statuses(sessions),[200,200,200,200,200,200,200,200],'a laptop opening all 8 pairs at once is admitted 8 times');
 assert.equal(await prisma.appBridgeLease.count({where:{accountId:account.id,purpose:'session'}}),8);
 assert.deepEqual(statuses(presence),[200,200,200,200,409,409,409,409],'8 presence redeems for 4 slots: 4 admitted, 4 refused, none 503');
 assert.equal(await prisma.appBridgeLease.count({where:{accountId:account.id,purpose:'presence'}}),4);
 console.log('BURST PASSED');
}finally{
 await prisma.$disconnect();
}
