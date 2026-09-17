import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readVersionCommand, SupabaseProjectBranchRepository, type VersionCommand } from '../src/projectBranches.ts';
import { seedMetadata } from '../../lib/commercial/contracts-v10.ts';
import type { WorkerEnvironment } from '../src/types.ts';
import type { ScenarioObjectStorage } from '../src/cloudSync.ts';
const checksum=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const context={profileId:randomUUID(),fingerprintHash:'f'.repeat(64),platform:'windows' as const,clientVersion:'0.1.12'};
void it('v14 accepts only explicit version commands, never client ACLs or storage keys',()=>{
  const command={action:'blank',operationId:randomUUID(),name:' Version 2 '};
  assert.equal(readVersionCommand(command).name,'Version 2');
  for(const extra of [{role:'owner'},{storageKey:'secret'},{document:{}},{expectedRevision:0}]) assert.throws(()=>readVersionCommand({...command,...extra}));
  assert.throws(()=>readVersionCommand({action:'delete',operationId:randomUUID(),versionId:randomUUID(),expectedRevision:0}));
});
function fixture(corrupt=false, replay=false, revoked=false) {
  const document={formatVersion:1,title:'Projet',content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:'one'},content:[{type:'text',text:'ancien'}]}]},coverPage:{projectName:'Page source'},comments:[],coverPageHidden:false};
  const bytes=new TextEncoder().encode(JSON.stringify(document));
  const writes:Array<{key:string;bytes:Uint8Array}>=[],calls:Array<{p_command:VersionCommand;p_artifact:{stamp:unknown}|null;p_fingerprint:string}>=[];
  const storage:ScenarioObjectStorage={get:async()=>bytes,put:async(input:{key:string;bytes:Uint8Array})=>{writes.push(input);},temporaryDownload:async()=>{throw new Error('Not used');}};
  const fetcher=async(_url:unknown,init?:RequestInit)=>{
    assert.equal(typeof init?.body,'string');
    const body=JSON.parse(init!.body as string) as (typeof calls)[number];calls.push(body);
    if(revoked && calls.length>1)return new Response('project_not_found',{status:400});
    if(replay||body.p_artifact)return Response.json({version:{id:'created'},replayed:replay});
    if(body.p_command?.action==='blank')return Response.json({source:null});
    return Response.json({source:{storageKey:'source',checksum:corrupt?'0'.repeat(64):checksum(bytes),sizeBytes:bytes.length,stamp:{head:'h',cursor:1,metadata:2},registers:seedMetadata({...document,coverPage:{projectName:'Page modifiée'}}),entries:[{blockId:'one',operationId:randomUUID(),actorId:context.profileId,logicalClock:1,tombstone:false,mutation:{type:'block.upsert',blockId:'one',afterBlockId:null,block:{type:'paragraph',attrs:{blockId:'one'},content:[{type:'text',text:'texte en direct'}]}}}]}});
  };
  const repository=new SupabaseProjectBranchRepository({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-server-key'} as WorkerEnvironment,storage,fetcher as typeof fetch);
  return {repository,writes,calls};
}
void it('v14 duplicates the persisted live text and latest cover, with source CAS and fresh storage identity',async()=>{
  const f=fixture(),root=randomUUID();
  await f.repository.change(context,root,{action:'duplicate',operationId:randomUUID(),name:'Copy',sourceVersionId:randomUUID()},randomUUID());
  assert.equal(f.writes.length,1);const file=JSON.parse(new TextDecoder().decode(f.writes[0].bytes));
  assert.equal(file.content.content[0].content[0].text,'texte en direct');assert.equal(file.coverPage.projectName,'Page modifiée');
  assert.ok(f.writes[0].key.startsWith(`branches/${root}/`));assert.notEqual(f.writes[0].key,'source');
  assert.deepEqual(f.calls[1].p_artifact?.stamp,{head:'h',cursor:1,metadata:2});
  assert.equal(f.calls[0].p_fingerprint,f.calls[1].p_fingerprint);
});
void it('v14 rejects corrupt source bytes before creating anything',async()=>{
  const f=fixture(true);await assert.rejects(f.repository.change(context,randomUUID(),{action:'duplicate',operationId:randomUUID(),name:'Copy',sourceVersionId:randomUUID()},randomUUID()),/Intégrité/);
  assert.equal(f.writes.length,0);assert.equal(f.calls.length,1);
});
void it('v14 blank versions contain no inherited cover, comments or text',async()=>{
  const f=fixture();await f.repository.change(context,randomUUID(),{action:'blank',operationId:randomUUID(),name:'Blank'},randomUUID());
  const file=JSON.parse(new TextDecoder().decode(f.writes[0].bytes));assert.deepEqual(file.comments,[]);assert.deepEqual(file.coverPage,{});assert.equal(file.content.content[0].content,undefined);
});
void it('v14 exact replay does not create an extra storage object',async()=>{
  const f=fixture(false,true);await f.repository.change(context,randomUUID(),{action:'blank',operationId:randomUUID(),name:'Blank'},randomUUID());assert.equal(f.writes.length,0);
});
void it('current document downloads include live edits and recheck permission after object storage',async()=>{
 const f=fixture();const doc=await f.repository.readDocument(context,randomUUID());
 assert.equal((doc.coverPage as {projectName:string}).projectName,'Page modifiée');
 assert.match(JSON.stringify(doc.content),/texte en direct/);assert.equal(f.calls.length,2);assert.equal(f.writes.length,0);
 assert.doesNotMatch(JSON.stringify(doc),/storageKey/);
});
void it('current document download rejects corrupted storage before returning any document',async()=>{
 const f=fixture(true);await assert.rejects(f.repository.readDocument(context,randomUUID()),/Intégrité/);
});
void it('revocation while object storage is downloading prevents delivery of a private document',async()=>{
 const f=fixture(false,false,true);await assert.rejects(f.repository.readDocument(context,randomUUID()),(error:{status?:number})=>error.status===404);
});
