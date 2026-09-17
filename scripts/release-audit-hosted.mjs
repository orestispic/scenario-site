// Synthetic preproduction accounts only. Leaves the new audit project intact.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';
const ref = 'zblnsdyaoljnezxdidtx';
const api = 'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const environment = parseEnvironmentFile(readFileSync('.env.phase9.local', 'utf8'));
const credentials = parseEnvironmentFile(readFileSync('.env.phase9.accounts.local', 'utf8'));
assert.equal(environment.SUPABASE_URL.replace(/\/$/, ''), `https://${ref}.supabase.co`);
const authBase = `https://${ref}.supabase.co/auth/v1`;
const sessions = [];
const sessionsOnly = process.argv.includes('--sessions-only');
async function request(session, path, body, key = randomUUID(), allowed = [200,201]) {
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${session.token}`, Origin: 'https://senario-app-preproduction.pages.dev',
      'Content-Type':'application/json', 'X-Scenario-Device-Fingerprint':session.device,
      'X-Scenario-Platform':'windows','X-Scenario-Client-Version':'0.1.12', 'Idempotency-Key':key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert(allowed.includes(response.status), `${path}: HTTP ${response.status} (${payload.code ?? 'unknown'})`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return payload;
}
try {
  for (const definition of accountDefinitions(ref)) {
    const prefix = `PHASE9_${definition.role.toUpperCase()}`;
    assert.equal(credentials[`${prefix}_EMAIL`], definition.email);
    const response = await fetch(`${authBase}/token?grant_type=password`, {method:'POST',headers:{apikey:environment.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:definition.email,password:credentials[`${prefix}_PASSWORD`]})});
    assert.equal(response.status,200,`Synthetic ${definition.role} login`);
    const value = await response.json();
    const session = {...definition,token:value.access_token,device:`phase9-${definition.role}-${ref}-device`};
    sessions.push(session);
    session.profileId = (await request(session,'/v1/me')).account.id;
    if (!sessionsOnly) await request(session,'/v1/devices/activate',{fingerprint:session.device,label:`Phase 9 ${definition.role}`,platform:'windows'});
  }
  if (!sessionsOnly) {
  const [owner, outsider, viewer] = sessions;
  const id = randomUUID();
  const document = {formatVersion:1,title:`Audit publication ${new Date().toISOString()}`,content:{type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID(),scenarioType:'SCENE_HEADING'},content:[{type:'text',text:'INT. AUDIT SYNTHÉTIQUE — JOUR'}]},{type:'paragraph',attrs:{blockId:randomUUID(),scenarioType:'ACTION'},content:[{type:'text',text:'Texte de vérification — accents, € et confidentialité.'}]}]},coverPage:{projectName:'Audit synthétique'},coverPageHidden:false,comments:[],characters:[],locations:[],times:[],savedAt:new Date().toISOString()};
  const content=JSON.stringify(document), key=randomUUID();
  const body={scenarioId:id,title:document.title,parentVersionId:null,content,checksum:createHash('sha256').update(content).digest('hex'),sizeBytes:Buffer.byteLength(content),contentType:'application/vnd.scenario+json',format:'scenario-v1',origin:'save'};
  const saved=await request(owner,'/v5/scenarios/sync',body,key);
  const replay=await request(owner,'/v5/scenarios/sync',body,key);
  assert.equal(saved.version.id,replay.version.id);
  assert.deepEqual((await request(owner,`/v16/scenarios/${id}/document`)).document,document);
  await request(outsider,`/v16/scenarios/${id}/document`,undefined,randomUUID(),[403,404]);
  await request(owner,`/v14/projects/${id}/versions`);
  const command={action:'duplicate',operationId:randomUUID(),sourceVersionId:id,name:'Copie audit'};
  await request(owner,`/v14/projects/${id}/versions`,command,command.operationId);
  const versions=(await request(owner,`/v14/projects/${id}/versions`)).versions;
  assert.equal(versions.length,2);
  for(const version of versions) assert.equal((await request(owner,`/v16/scenarios/${version.project.id}/document`)).document.content.content[1].content[0].text,document.content.content[1].content[0].text);
  console.log(`PASS private creation, idempotent retry, download, versions, outsider denial. Preserved synthetic project: ${id}`);
  const contacts=await request(owner,'/v15/contacts');
  if(!contacts.contacts.some(c=>c.profileId===viewer.profileId)) {
    await request(owner,'/v15/contact-requests',{email:viewer.email});
    const received=await request(viewer,'/v15/contacts');
    const invitation=received.receivedRequests.find(r=>r.profileId===owner.profileId);
    if(invitation) await request(viewer,`/v15/contact-requests/${invitation.id}/respond`,{decision:'accept'});
    else {
      const pending=(await request(owner,'/v15/contacts')).receivedRequests.find(r=>r.profileId===viewer.profileId);
      assert(pending,'A pending synthetic contact request must exist');
      await request(owner,`/v15/contact-requests/${pending.id}/respond`,{decision:'accept'});
    }
  }
  assert((await request(viewer,'/v15/contacts')).contacts.some(c=>c.profileId===owner.profileId));
  const sharing=await request(owner,`/v9/projects/${id}/sharing`,{});
  const invited=await request(owner,`/v6/studios/${sharing.studio.id}/invitations`,{email:viewer.email,role:'viewer'});
  await request(viewer,`/v16/scenarios/${id}/document`,undefined,randomUUID(),[403,404]);
  await request(viewer,`/v9/project-invitations/${invited.invitation.id}/respond`,{decision:'accept'});
  assert((await request(viewer,'/v9/projects')).projects.some(p=>p.id===id && p.role==='viewer'));
  assert.equal((await request(viewer,`/v16/scenarios/${id}/document`)).document.content.content[1].content[0].text,document.content.content[1].content[0].text);
  const readerVersions=(await request(viewer,`/v14/projects/${id}/versions`)).versions;
  assert.equal(readerVersions.length,2);
  console.log('PASS mutual contacts, invitation acceptance, reader project listing and current document access.');
  }
} finally {
  for (const session of sessions) {
    const result=await fetch(`${authBase}/logout?scope=local`,{method:'POST',headers:{apikey:environment.SUPABASE_ANON_KEY,Authorization:`Bearer ${session.token}`}});
    assert(result.ok,'Synthetic session logout');
    await request(session,'/v1/me',undefined,randomUUID(),[401]);
  }
  console.log('PASS all test sessions logged out; their old JWTs are rejected. No project or account deleted.');
}
