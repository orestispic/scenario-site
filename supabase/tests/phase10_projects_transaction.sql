-- Run inside BEGIN + migration + this file + ROLLBACK only, against the existing
-- isolated phase-9 fixtures. No fixture or invitation survives the transaction.
do $$
declare owner_id uuid; editor_id uuid; viewer_id uuid; owner_device text; editor_device text; viewer_device text;
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); studio_id uuid; invitation_id uuid;
  result jsonb; entry jsonb; replay_key text:=repeat('c',64); forbidden boolean:=false; v_request jsonb; base_id uuid;
begin
  select id into owner_id from public.profiles where email='phase9-owner-zblnsdyaoljnezxdidtx@example.com';
  select id into editor_id from public.profiles where email='phase9-editor-zblnsdyaoljnezxdidtx@example.com';
  select id into viewer_id from public.profiles where email='phase9-viewer-zblnsdyaoljnezxdidtx@example.com';
  if owner_id is null or editor_id is null or viewer_id is null then raise exception 'phase9 synthetic accounts required'; end if;
  select device_fingerprint_hash into owner_device from public.devices where user_id=owner_id and status='active' and platform='windows' limit 1;
  select device_fingerprint_hash into editor_device from public.devices where user_id=editor_id and status='active' and platform='windows' limit 1;
  select device_fingerprint_hash into viewer_device from public.devices where user_id=viewer_id and status='active' and platform='windows' limit 1;
  if owner_device is null or editor_device is null or viewer_device is null then raise exception 'active synthetic devices required'; end if;
  insert into public.cloud_scenarios(id,owner_id,title) values(a,owner_id,'Phase10 rollback A'),(b,owner_id,'Phase10 rollback B');
  result:=public.list_cloud_projects_v9(owner_id,owner_device,'windows','0.1.7',repeat('a',64),'Owner');
  select value into entry from jsonb_array_elements(result->'projects') where value->>'id'=a::text;
  if entry->>'sharing'<>'private' or entry->>'realtimeStudioId' is not null then raise exception 'private default failed'; end if;
  v_request:=jsonb_build_object('scenarioId',a,'title','Synthetic','parentVersionId',null,'checksum',repeat('f',64),'sizeBytes',2,'contentType','application/vnd.scenario+json','format','scenario-v1','origin','save');
  result:=public.sync_cloud_scenario(owner_id,owner_device,'windows','0.1.7',v_request,'phase10/rollback',repeat('f',64),repeat('f',64),gen_random_uuid());
  v_request:=v_request||jsonb_build_object('parentVersionId',result#>>'{version,id}');
  result:=public.sync_cloud_scenario(owner_id,owner_device,'windows','0.1.7',v_request,'phase10/rollback',repeat('1',64),repeat('1',64),gen_random_uuid());
  base_id:=(result#>>'{version,id}')::uuid;
  result:=public.ensure_project_sharing_v9(owner_id,owner_device,'windows','0.1.7',repeat('a',64),'Owner',a,repeat('a',64),gen_random_uuid());
  studio_id:=(result#>>'{studio,id}')::uuid;
  result:=public.ensure_project_sharing_v9(owner_id,owner_device,'windows','0.1.7',repeat('a',64),'Owner',a,repeat('a',64),gen_random_uuid());
  if (result#>>'{studio,id}')::uuid<>studio_id then raise exception 'ensure not stable'; end if;
  if (select project_base_version_id from public.studios where id=studio_id) is distinct from base_id then raise exception 'sharing lost latest private version'; end if;
  result:=public.create_studio_invitation(owner_id,owner_device,'windows','0.1.7',repeat('a',64),'Owner',studio_id,repeat('b',64),'e***@example.invalid','editor',encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),now()+interval '1 hour',repeat('b',64),gen_random_uuid());
  invitation_id:=(result#>>'{invitation,id}')::uuid;
  begin
    perform public.respond_project_invitation_v9(viewer_id,viewer_device,'windows','0.1.7',repeat('d',64),'Viewer',invitation_id,'accept',repeat('d',64),gen_random_uuid());
  exception when others then if sqlerrm not like '%project_not_found%' then raise; end if; forbidden:=true; end;
  if not forbidden then raise exception 'third-party invitation accepted'; end if;
  result:=public.respond_project_invitation_v9(editor_id,editor_device,'windows','0.1.7',repeat('b',64),'Editor',invitation_id,'accept',replay_key,gen_random_uuid());
  result:=public.respond_project_invitation_v9(editor_id,editor_device,'windows','0.1.7',repeat('b',64),'Editor',invitation_id,'accept',replay_key,gen_random_uuid());
  if result->>'replayed'<>'true' then raise exception 'idempotent acceptance failed'; end if;
  result:=public.list_cloud_projects_v9(editor_id,editor_device,'windows','0.1.7',repeat('b',64),'Editor');
  if not exists(select 1 from jsonb_array_elements(result->'projects') p where p->>'id'=a::text and p->>'role'='editor' and p->>'sharing'='shared') then raise exception 'shared project missing'; end if;
  if exists(select 1 from jsonb_array_elements(result->'projects') p where p->>'id'=b::text) then raise exception 'cross-project leak'; end if;
  if has_function_privilege('authenticated','public.respond_project_invitation_v9(uuid,text,text,text,text,text,uuid,text,text,uuid)','execute') then raise exception 'RPC exposed to client'; end if;
  v_request:=v_request||jsonb_build_object('parentVersionId',base_id);
  perform public.sync_cloud_scenario(editor_id,editor_device,'windows','0.1.7',v_request,'phase10/rollback',repeat('2',64),repeat('2',64),gen_random_uuid());
  perform public.remove_studio_member(owner_id,owner_device,'windows','0.1.7',repeat('a',64),'Owner',studio_id,editor_id,repeat('e',64),gen_random_uuid());
  result:=public.list_cloud_projects_v9(editor_id,editor_device,'windows','0.1.7',repeat('b',64),'Editor');
  if exists(select 1 from jsonb_array_elements(result->'projects') p where p->>'id'=a::text) then raise exception 'revoked project remains accessible'; end if;
  forbidden:=false;
  begin
    perform public.sync_cloud_scenario(editor_id,editor_device,'windows','0.1.7',v_request,'phase10/rollback',repeat('2',64),repeat('2',64),gen_random_uuid());
  exception when others then if sqlerrm not like '%scenario_write_forbidden%' then raise; end if; forbidden:=true; end;
  if not forbidden then raise exception 'revoked writer replay disclosed a historical response'; end if;
end $$;
select 'PASS phase10 PostgreSQL project isolation, invitations, replay and revocation (rolled back)' as result;
