// Passkeys against real PostgreSQL (the postgres-roundtrip CI job).
// node --experimental-strip-types --import ./route-tests/register-hooks.mjs scripts/passkeys-integration.mts
//
// The route tests use an in-memory Prisma, and this job's schema comes from `prisma db push`, which knows nothing of
// the CHECK constraints the migrations add by hand. So the constraints production runs were never evaluated before
// they shipped, and one of them could not be: its regular expression used a repetition count PostgreSQL refuses
// (over 255), which failed every INSERT into "AccountPasskey" (2026-10-10). This applies the shipped migrations and
// writes the rows src/lib/passkeys.ts writes, so a constraint PostgreSQL cannot evaluate fails here first.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {prisma} from '../src/lib/db.ts';

const database=new URL(process.env.DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(database.hostname)&&database.pathname.endsWith('/dispatch_test'),'Dedicated local dispatch_test database required');

// Rebuild the passkey tables from the migrations that run in production, in order (comments stripped: they
// contain semicolons).
const MIGRATIONS=['20261014090000_account_passkeys','20261016090000_passkey_credential_shape'];
for(const t of ['PasskeyChallenge','AccountPasskey'])await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}" CASCADE`);
for(const m of MIGRATIONS){
 const sql=readFileSync(new URL(`../prisma/migrations/${m}/migration.sql`,import.meta.url),'utf8').split('\n').map(l=>l.replace(/--.*$/,'')).join('\n');
 for(const stmt of sql.split(';').map(s=>s.trim()).filter(Boolean))await prisma.$executeRawUnsafe(stmt);
 console.log(`PASS: the ${m} migration applies to PostgreSQL`);
}

const refused=async(what:string,write:()=>Promise<unknown>)=>{
 await assert.rejects(write,(e:unknown)=>{assert.match(String((e as Error)?.message),/constraint|violates/i,`${what}: refused for another reason: ${(e as Error)?.message}`);return true;},`${what} was accepted`);
};

try{
 const account=await prisma.account.create({data:{handle:randomUUID()+'@bc',email:randomUUID()+'@example.invalid',emailVerifiedAt:new Date()}});
 const passkey=(over:Record<string,unknown>={})=>({accountId:account.id,credentialId:randomBytes(32).toString('base64url'),publicKey:randomBytes(77),counter:BigInt(0),transports:['internal'],label:'This device',...over});

 // What opRegisterVerify writes: a Windows Hello sized credential, then the longest and the shortest ids allowed.
 const first=await prisma.accountPasskey.create({data:passkey()});
 assert.equal((await prisma.accountPasskey.findUnique({where:{credentialId:first.credentialId}}))?.id,first.id);
 await prisma.accountPasskey.create({data:passkey({credentialId:'A'.repeat(1400),label:'Longest id'})});
 await prisma.accountPasskey.create({data:passkey({credentialId:'_',label:'Shortest id',counter:BigInt(4294967295),transports:[]})});
 console.log('PASS: a passkey is stored (the row src/lib/passkeys.ts writes), at both ends of the credential id length');

 // The step-up's counter bump, as opStepUpVerify writes it.
 assert.equal((await prisma.accountPasskey.updateMany({where:{id:first.id,counter:first.counter},data:{counter:BigInt(7),lastUsedAt:new Date()}})).count,1);

 // Every CHECK on "AccountPasskey" is evaluated, and refuses what it is there to refuse.
 await refused('an empty credential id',()=>prisma.accountPasskey.create({data:passkey({credentialId:''})}));
 await refused('a 1401-character credential id',()=>prisma.accountPasskey.create({data:passkey({credentialId:'A'.repeat(1401)})}));
 for(const bad of ['abc+def','abc/def','abc=','abc def','abc\ndef'])await refused(`the credential id ${JSON.stringify(bad)}`,()=>prisma.accountPasskey.create({data:passkey({credentialId:bad})}));
 await refused('an empty public key',()=>prisma.accountPasskey.create({data:passkey({publicKey:Buffer.alloc(0)})}));
 await refused('a 4097-byte public key',()=>prisma.accountPasskey.create({data:passkey({publicKey:randomBytes(4097)})}));
 await refused('a counter over uint32',()=>prisma.accountPasskey.create({data:passkey({counter:BigInt(4294967296)})}));
 await refused('a negative counter',()=>prisma.accountPasskey.create({data:passkey({counter:BigInt(-1)})}));
 await refused('nine transports',()=>prisma.accountPasskey.create({data:passkey({transports:['a','b','c','d','e','f','g','h','i']})}));
 await refused('an empty label',()=>prisma.accountPasskey.create({data:passkey({label:''})}));
 await refused('a 61-character label',()=>prisma.accountPasskey.create({data:passkey({label:'x'.repeat(61)})}));
 console.log('PASS: the AccountPasskey CHECK constraints are evaluated by PostgreSQL and refuse bad rows');

 // The ceremonies, as passkeys.ts writes them: a registration, then a step-up that becomes a grant and is spent.
 const soon=()=>new Date(Date.now()+300_000);
 const challenge=()=>randomBytes(32).toString('base64url');
 const reg=await prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'register',action:null,challenge:challenge(),expiresAt:soon()}});
 assert.equal((await prisma.passkeyChallenge.updateMany({where:{id:reg.id,answeredAt:null},data:{answeredAt:new Date()}})).count,1);
 await prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'register',action:'manage_passkeys',challenge:challenge(),expiresAt:soon()}});
 const step=await prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'step_up',action:'approve_session',targetId:randomUUID(),challenge:challenge(),expiresAt:soon()}});
 await prisma.passkeyChallenge.update({where:{id:step.id},data:{answeredAt:new Date(),grantHash:randomBytes(32).toString('hex'),passkeyId:first.id}});
 await prisma.passkeyChallenge.update({where:{id:step.id},data:{usedAt:new Date()}});
 await prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'step_up',action:'connect_agent',challenge:challenge(),expiresAt:soon()}});
 await refused('a registration with a target',()=>prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'register',targetId:'x',challenge:challenge(),expiresAt:soon()}}));
 await refused('an approval step-up without its target',()=>prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'step_up',action:'approve_session',challenge:challenge(),expiresAt:soon()}}));
 await refused('a connect step-up with a target',()=>prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'step_up',action:'connect_agent',targetId:'x',challenge:challenge(),expiresAt:soon()}}));
 await refused('an unknown step-up action',()=>prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'step_up',action:'anything',challenge:challenge(),expiresAt:soon()}}));
 await refused('a grant on an unanswered challenge',()=>prisma.passkeyChallenge.create({data:{accountId:account.id,kind:'step_up',action:'connect_agent',challenge:challenge(),expiresAt:soon(),grantHash:'g'}}));
 console.log('PASS: the PasskeyChallenge rows passkeys.ts writes are stored, and its CHECK constraints refuse bad rows');

 // Deleting the account deletes its passkeys and ceremonies (foreign keys in the migration only).
 await prisma.account.delete({where:{id:account.id}});
 assert.equal(await prisma.accountPasskey.count({where:{accountId:account.id}}),0);
 assert.equal(await prisma.passkeyChallenge.count({where:{accountId:account.id}}),0);
 console.log('PASS: an account takes its passkeys and ceremonies with it');
}finally{await prisma.$disconnect();}
