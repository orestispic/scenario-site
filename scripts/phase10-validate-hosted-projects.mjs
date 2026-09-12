import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { collaborativeChecksum } from './phase9-validate-hosted-realtime.mjs';

const projectRef = 'zblnsdyaoljnezxdidtx';
const apiUrl = 'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const env = parseEnvironmentFile(readFileSync('.env.phase9.local', 'utf8'));
const accounts = parseEnvironmentFile(readFileSync('.env.phase9.accounts.local', 'utf8'));
assert.equal(env.SUPABASE_URL.replace(/\/$/, ''), `https://${projectRef}.supabase.co`);
assert.equal(readFileSync('supabase/.temp/project-ref','utf8').trim(), projectRef);
if (!process.argv.includes('--execute')) throw new Error('Pass --execute to create isolated synthetic projects and move them to trash at the end.');
const sessions = new Map();
const created = [];
const channels = [];
const origin = 'http://127.0.0.1:1420';
const hash = (v) => createHash('sha256').update(v).digest('hex');
let version;
let failure;
async function call(path, role, body, key = randomUUID(), expected = [200,201,204]) {
  const response = await fetch(`${apiUrl}${path}`, {method: body === undefined ? 'GET' : 'POST',
    headers: {Origin:origin, Authorization:`Bearer ${sessions.get(role)}`, 'Content-Type':'application/json', 'Idempotency-Key':key,
      'X-Scenario-Client-Version':version, 'X-Scenario-Platform':'windows', 'X-Scenario-Device-Fingerprint':`phase9-${role}-${projectRef}-device`},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(20000)});
  if (!expected.includes(response.status)) {
    const error = await response.json().catch(()=>({}));
    throw new Error(`Hosted phase10 ${role} ${path.replace(/[0-9a-f-]{36}/g,':id')} HTTP ${response.status} (${String(error.code ?? 'unknown')})`);
  }
  return response.status === 204 ? null : response.json();
}
try {
  const config = await (await fetch(`${apiUrl}/v1/config`,{headers:{Origin:origin},signal:AbortSignal.timeout(15000)})).json();
  assert.equal(config.environment,'staging');
  version = config.compatibility.find((v)=>v.platform==='windows').minimumSupportedVersion;
  for(const role of ['owner','editor','viewer']) {
    const prefix=`PHASE9_${role.toUpperCase()}`;
    assert.equal(accounts[`${prefix}_EMAIL`],`phase9-${role}-${projectRef}@example.com`);
    const response=await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:accounts[`${prefix}_EMAIL`],password:accounts[`${prefix}_PASSWORD`]}),signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200,`${role} login`); sessions.set(role,(await response.json()).access_token);
  }
  for(let i=0;i<2;i++) {
    const id=randomUUID(), title=`Validation phase10 ${i+1}`;
    const content=JSON.stringify({formatVersion:1,title,content:{type:'doc',content:[]}});
    await call('/v5/scenarios/sync','owner',{scenarioId:id,title,parentVersionId:null,checksum:hash(content),sizeBytes:Buffer.byteLength(content),contentType:'application/vnd.scenario+json',format:'scenario-v1',origin:'save',content},id);
    created.push(id);
  }
  let list=await call('/v9/projects','owner');
  assert.equal(list.contractVersion,'2026-09-v9');
  assert.ok(created.every((id)=>list.projects.some((p)=>p.id===id&&p.sharing==='private'&&p.realtimeStudioId===null)));
  const sharing=await Promise.all(created.map((id)=>call(`/v9/projects/${id}/sharing`,'owner',{},id)));
  assert.notEqual(sharing[0].studio.id,sharing[1].studio.id);
  assert.equal((await call(`/v9/projects/${created[0]}/sharing`,'owner',{},created[0])).studio.id,sharing[0].studio.id);
  const members=[];
  for(const [index,role] of ['editor','viewer'].entries()) {
    const invitation=await call(`/v6/studios/${sharing[index].studio.id}/invitations`,'owner',{email:accounts[`PHASE9_${role.toUpperCase()}_EMAIL`],role});
    await call(`/v9/project-invitations/${invitation.invitation.id}/respond`,role==='editor'?'viewer':'editor',{decision:'accept'},randomUUID(),[404]);
    const key=randomUUID();
    await call(`/v9/project-invitations/${invitation.invitation.id}/respond`,role,{decision:'accept'},key);
    assert.equal((await call(`/v9/project-invitations/${invitation.invitation.id}/respond`,role,{decision:'accept'},key)).replayed,true);
    list=await call('/v9/projects',role);
    const owned=list.projects.filter((p)=>created.includes(p.id));
    assert.equal(owned.length,1); assert.equal(owned[0].id,created[index]); assert.equal(owned[0].role,role);
    const me=await call('/v1/me',role); members.push(me.account.id);
  }
  await call(`/v9/projects/${created[0]}/sharing`,'editor',{},randomUUID(),[404]);
  await call(`/v6/studios/${sharing[1].studio.id}/members/${members[1]}/role`,'viewer',{role:'owner'},randomUUID(),[404]);
  const studioId=sharing[0].studio.id;
  const prefix=`/v7/studios/${studioId}/realtime`;
  for (const role of ['owner','editor']) {
    const ticket=await call(`${prefix}/tickets`,role,{});
    const connected=await call(`${prefix}/connect`,role,{ticket:ticket.ticket,afterCursor:0});
    channels.push({role,prefix,connectionId:connected.connectionId});
  }
  const ownedProject=(await call('/v9/projects','owner')).projects.find((p)=>p.id===created[0]);
  const operations=await Promise.all(channels.map(async (channel,index)=>{
    const unsigned={studioId,scenarioId:created[0],baseVersionId:ownedProject.realtimeBaseVersionId,operationId:randomUUID(),clientSequence:1,logicalClock:1,
      mutation:{type:'block.upsert',blockId:`phase10-empty-${index}`,afterBlockId:null,block:{type:'paragraph',attrs:{blockId:`phase10-empty-${index}`,scenarioType:'ACTION'}}}};
    const operation={...unsigned,checksum:collaborativeChecksum(unsigned)};
    const result=await call(`${prefix}/operations`,channel.role,{connectionId:channel.connectionId,operation});
    assert.equal(result.status,'applied'); return operation;
  }));
  for(const channel of channels) {
    const poll=await call(`${prefix}/poll`,channel.role,{connectionId:channel.connectionId,afterCursor:0});
    assert.ok(operations.every((op)=>poll.events.some((event)=>event.type==='operation.applied'&&event.operation.operationId===op.operationId)));
  }
  const replay=await call(`${prefix}/operations`,'owner',{connectionId:channels[0].connectionId,operation:operations[0]});
  assert.equal(replay.status,'replayed');
  await call(`/v6/studios/${sharing[0].studio.id}/members/${members[0]}/remove`,'owner',{});
  list=await call('/v9/projects','editor'); assert.ok(!list.projects.some((p)=>p.id===created[0]));
  console.log('PASS hosted Supabase + Cloudflare: two private projects, distinct sharing scopes, three synthetic accounts, invitation acceptance, concurrent Owner/Editor operations, verified ledger poll, replay, denied elevation and revocation.');
} catch (error) { failure = error; }
finally {
  let cleanupFailed=false;
  await Promise.allSettled(channels.map((channel)=>call(`${channel.prefix}/disconnect`,channel.role,{connectionId:channel.connectionId},randomUUID(),[200,403,404])));
  for(const id of created) {
    try { await call(`/v5/scenarios/${id}/delete`,'owner',{}); } catch {cleanupFailed=true;}
  }
  await Promise.allSettled([...sessions.values()].map((token)=>fetch(`${env.SUPABASE_URL}/auth/v1/logout?scope=local`,{method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)})));
  if(cleanupFailed) failure ??= new Error('Synthetic cleanup incomplete; inspect the phase10 test projects.');
  console.log(`Synthetic projects moved to trash: ${created.length}; append-only history retained. Test sessions closed.`);
}
if (failure) throw failure;
