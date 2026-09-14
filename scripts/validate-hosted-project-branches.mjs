import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { collaborativeChecksum } from './phase9-validate-hosted-realtime.mjs';
const ref='zblnsdyaoljnezxdidtx', api='https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const env=parseEnvironmentFile(readFileSync('.env.phase9.local','utf8'));
const accounts=parseEnvironmentFile(readFileSync('.env.phase9.accounts.local','utf8'));
assert.equal(env.SUPABASE_URL.replace(/\/$/,''),`https://${ref}.supabase.co`);
assert.equal(readFileSync('supabase/.temp/project-ref','utf8').trim(),ref);
if(!process.argv.includes('--execute'))throw new Error('Use --execute for isolated synthetic projects only.');
const sessions=new Map(),created=[],channels=[];
const hash=v=>createHash('sha256').update(v).digest('hex');
async function call(path,role,body,expected=[200,201,204]) {
  const response=await fetch(api+path,{method:body===undefined?'GET':'POST',headers:{Origin:'http://127.0.0.1:1420',Authorization:`Bearer ${sessions.get(role)}`,'Content-Type':'application/json','Idempotency-Key':body?.operationId??randomUUID(),'X-Scenario-Client-Version':'0.1.12','X-Scenario-Platform':'windows','X-Scenario-Device-Fingerprint':`phase9-${role}-${ref}-device`},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});
  const data=response.status===204?null:await response.json();
  if(!expected.includes(response.status))throw new Error(`Versions ${role} ${path.replace(/[0-9a-f-]{36}/g,':id')} HTTP ${response.status} (${data?.code??'unknown'})`);
  return data;
}
async function download(project) {
  const grant=(await call(`/v5/scenarios/${project.id}/versions/${project.currentVersionId}/download`,'owner')).download;
  assert.equal(new URL(grant.url).origin,env.SUPABASE_URL.replace(/\/$/,''));
  const response=await fetch(grant.url,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);return response.json();
}
async function connect(project,role) {
  const prefix=`/v7/studios/${project.realtimeStudioId}/realtime`, ticket=await call(`${prefix}/tickets`,role,{});
  const joined=await call(`${prefix}/connect`,role,{ticket:ticket.ticket,afterCursor:0});
  const channel={prefix,role,connectionId:joined.connectionId,project};channels.push(channel);return channel;
}
async function edit(channel,text,sequence=1) {
  const p=channel.project,blockId='block_synthetic';
  const unsigned={studioId:p.realtimeStudioId,scenarioId:p.id,baseVersionId:p.realtimeBaseVersionId,operationId:randomUUID(),clientSequence:sequence,logicalClock:sequence,mutation:{type:'block.upsert',blockId,afterBlockId:null,block:{type:'paragraph',attrs:{blockId,scenarioType:'ACTION'},content:[{type:'text',text}]}}};
  const operation={...unsigned,checksum:collaborativeChecksum(unsigned)};
  assert.equal((await call(`${channel.prefix}/operations`,channel.role,{connectionId:channel.connectionId,operation})).status,'applied');return operation;
}
let failure;
try {
  assert.equal((await(await fetch(api+'/v1/config')).json()).environment,'staging');
  for(const role of ['owner','editor','viewer']) {
    const prefix=`PHASE9_${role.toUpperCase()}`;assert.equal(accounts[`${prefix}_EMAIL`],`phase9-${role}-${ref}@example.com`);
    const response=await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:accounts[`${prefix}_EMAIL`],password:accounts[`${prefix}_PASSWORD`]}),signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200,'Synthetic sign-in failed');sessions.set(role,(await response.json()).access_token);
  }
  const id=randomUUID(),title='Synthetic named versions validation';
  const comment={id:'comment_test',status:'open',createdAt:new Date().toISOString(),resolvedAt:null,anchor:{sceneId:'scene_root',blockId:'block_synthetic',startOffset:0,endOffset:5,originalText:'Hello',lost:false},messages:[{id:'message_test',text:'Original comment',createdAt:new Date().toISOString(),editedAt:null}]};
  const content=JSON.stringify({formatVersion:1,title,content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'block_synthetic',scenarioType:'ACTION'},content:[{type:'text',text:'Hello source'}]}]},coverPage:{projectName:'Original cover'},coverPageHidden:false,comments:[comment]});
  await call('/v5/scenarios/sync','owner',{scenarioId:id,title,parentVersionId:null,content,checksum:hash(content),sizeBytes:Buffer.byteLength(content),contentType:'application/vnd.scenario+json',format:'scenario-v1',origin:'save'});created.push(id);
  const path=`/v14/projects/${id}/versions`;
  let versions=(await call(path,'owner')).versions;assert.equal(versions.length,1);
  const blankCommand={action:'blank',operationId:randomUUID(),name:'Blank'};
  const blank=(await call(path,'owner',blankCommand)).version;
  assert.equal((await call(path,'owner',blankCommand)).version.id,blank.id);
  const blankFile=await download(blank.project);assert.deepEqual(blankFile.comments,[]);assert.deepEqual(blankFile.coverPage,{});
  const studio=(await call(`/v9/projects/${id}/sharing`,'owner',{})).studio.id;
  for(const role of ['editor','viewer']) {
    const invitation=await call(`/v6/studios/${studio}/invitations`,'owner',{email:accounts[`PHASE9_${role.toUpperCase()}_EMAIL`],role});
    await call(`/v9/project-invitations/${invitation.invitation.id}/respond`,role,{decision:'accept'});
  }
  versions=(await call(path,'editor')).versions;
  assert.equal(new Set(versions.map(v=>v.project.realtimeStudioId)).size,2);
  assert.ok(versions.every(v=>v.project.memberCount===3&&v.project.role==='editor'));
  assert.ok(!(await call('/v9/projects','owner')).projects.some(p=>p.id===blank.project.id));
  const rootProject=versions.find(v=>v.id===id).project,childProject=versions.find(v=>v.id===blank.id).project;
  const owner=await connect(rootProject,'owner'),editor=await connect(rootProject,'editor'),other=await connect(childProject,'editor');
  const rootOp=await edit(owner,'Source live text'),childOp=await edit(other,'Independent branch text');
  const polled=await call(`${editor.prefix}/poll`,'editor',{connectionId:editor.connectionId,afterCursor:0});
  assert.ok(polled.events.some(e=>e.operation?.operationId===rootOp.operationId));assert.ok(!polled.events.some(e=>e.operation?.operationId===childOp.operationId));
  const metadataPath=`/v10/projects/${id}/metadata`;await call(metadataPath,'owner');
  await call(metadataPath,'editor',{operationId:randomUUID(),changes:[{key:'cover.projectName',value:'Live cover',expectedRevision:0},{key:'comment:comment_test',value:{...comment,messages:[{...comment.messages[0],text:'Live comment'}]},expectedRevision:0}]});
  const duplicate=(await call(path,'editor',{action:'duplicate',operationId:randomUUID(),sourceVersionId:id,name:'Live copy'})).version;
  const duplicateFile=await download(duplicate.project);
  assert.ok(JSON.stringify(duplicateFile.content).includes('Source live text'));assert.ok(!JSON.stringify(duplicateFile.content).includes('Independent branch text'));
  assert.equal(duplicateFile.coverPage.projectName,'Live cover');assert.equal(duplicateFile.comments[0].messages[0].text,'Live comment');
  const childMetadata=(await call(`/v10/projects/${childProject.id}/metadata`,'editor')).state;
  assert.equal(childMetadata.registers['cover.projectName'].value,'');assert.equal(childMetadata.registers['comment:comment_test'],undefined);
  await call(path,'viewer',{action:'blank',operationId:randomUUID(),name:'Forbidden'},[403]);
  await call(path,'editor',{action:'delete',operationId:randomUUID(),versionId:blank.id,expectedRevision:1},[403]);
  await call(path,'owner',{action:'delete',operationId:randomUUID(),versionId:blank.id,expectedRevision:1});
  await call(`/v10/projects/${childProject.id}/metadata`,'editor',undefined,[404]);
  await call(path,'owner',{action:'restore',operationId:randomUUID(),versionId:blank.id,expectedRevision:2});
  await call(`/v10/projects/${childProject.id}/metadata`,'editor');
  const editorId=(await call('/v1/me','editor')).account.id;
  await call(`/v6/studios/${studio}/members/${editorId}/remove`,'owner',{});
  await call(path,'editor',undefined,[404]);await call(`/v10/projects/${childProject.id}/metadata`,'editor',undefined,[404]);
  console.log('PASS hosted versions: three accounts, independent channels, live duplication, cover/comments, blank, replay, viewer denial, soft deletion/restore and inherited revocation.');
} catch(error) { failure=error; }
finally {
  await Promise.allSettled(channels.map(c=>call(`${c.prefix}/disconnect`,c.role,{connectionId:c.connectionId},[200,403,404])));
  for(const id of created) {try{await call(`/v5/scenarios/${id}/delete`,'owner',{});}catch{failure??=new Error('Synthetic project cleanup failed.');}}
  await Promise.allSettled([...sessions.values()].map(token=>fetch(`${env.SUPABASE_URL}/auth/v1/logout?scope=local`,{method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)})));
  console.log(`Synthetic projects moved to trash: ${created.length}. Test sessions closed; immutable history retained.`);
}
if(failure)throw failure;
