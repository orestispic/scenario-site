-- Synthetic fixtures only; the caller wraps this entire script in rollback.
do $$
declare owner_id uuid;editor_id uuid;viewer_id uuid;od text;ed text;vd text;
 project uuid:=gen_random_uuid();base uuid;studio uuid;child uuid;branch uuid;child_studio uuid;
 result jsonb;command jsonb;artifact jsonb;prepared jsonb;op uuid:=gen_random_uuid();invitation uuid;
 denied boolean; seed jsonb;field text;
begin
 select id into owner_id from public.profiles where email='phase9-owner-zblnsdyaoljnezxdidtx@example.com';
 select id into editor_id from public.profiles where email='phase9-editor-zblnsdyaoljnezxdidtx@example.com';
 select id into viewer_id from public.profiles where email='phase9-viewer-zblnsdyaoljnezxdidtx@example.com';
 select device_fingerprint_hash into od from public.devices where user_id=owner_id and status='active' limit 1;
 select device_fingerprint_hash into ed from public.devices where user_id=editor_id and status='active' limit 1;
 select device_fingerprint_hash into vd from public.devices where user_id=viewer_id and status='active' limit 1;
 result:=public.sync_cloud_scenario(owner_id,od,'windows','0.1.12',jsonb_build_object('scenarioId',project,'title','Branches rollback','parentVersionId',null,'checksum',repeat('f',64),'sizeBytes',2,'contentType','application/vnd.scenario+json','format','scenario-v1','origin','save'),'branches/test',repeat('b',64),repeat('b',64),gen_random_uuid());
  base:=(result#>>'{version,id}')::uuid;
 if public.get_cloud_storage_key(owner_id,od,'windows','0.1.12',project,base) is distinct from to_jsonb('branches/test'::text) then raise exception 'download scalar contract changed';end if;
 result:=public.project_branches_v14(owner_id,od,'windows','0.1.12',project,'{"action":"list"}',null,null,gen_random_uuid());
 if jsonb_array_length(result->'versions')<>1 or result#>>'{versions,0,project,realtimeBaseVersionId}' is not null or result#>>'{versions,0,project,memberCount}'<>'1' then raise exception 'invalid private catalog';end if;
 command:=jsonb_build_object('action','blank','operationId',op,'name','Version 2');
 artifact:=jsonb_build_object('storageKey','branches/'||project||'/'||gen_random_uuid()||'.scenario','checksum',repeat('c',64),'sizeBytes',100);
 result:=public.project_branches_v14(owner_id,od,'windows','0.1.12',project,command,repeat('c',64),artifact,gen_random_uuid());
 branch:=(result#>>'{version,id}')::uuid;child:=(result#>>'{version,project,id}')::uuid;
 if branch=project or child=project then raise exception 'branches share identity';end if;
 result:=public.project_branches_v14(owner_id,od,'windows','0.1.12',project,command,repeat('c',64),artifact,gen_random_uuid());
 if result->>'replayed'<>'true' or (result#>>'{version,id}')::uuid<>branch then raise exception 'non idempotent creation';end if;
 result:=public.list_cloud_projects_v9(owner_id,od,'windows','0.1.12',repeat('a',64),'Owner');
 if exists(select 1 from jsonb_array_elements(result->'projects') p where (p->>'id')::uuid=child) then raise exception 'child exposed as project';end if;
 -- Sharing an existing private project propagates to every version.
 result:=public.ensure_project_sharing_v9(owner_id,od,'windows','0.1.12',repeat('a',64),'Owner',project,repeat('a',64),gen_random_uuid());studio:=(result#>>'{studio,id}')::uuid;
 result:=public.create_studio_invitation(owner_id,od,'windows','0.1.12',repeat('a',64),'Owner',studio,repeat('e',64),'e***@example.invalid','editor',encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),now()+interval '1 hour',repeat('e',64),gen_random_uuid());invitation:=(result#>>'{invitation,id}')::uuid;
 perform public.respond_project_invitation_v9(editor_id,ed,'windows','0.1.12',repeat('e',64),'Editor',invitation,'accept',repeat('e',64),gen_random_uuid());
 result:=public.create_studio_invitation(owner_id,od,'windows','0.1.12',repeat('a',64),'Owner',studio,repeat('d',64),'v***@example.invalid','viewer',encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),now()+interval '1 hour',repeat('d',64),gen_random_uuid());invitation:=(result#>>'{invitation,id}')::uuid;
 perform public.respond_project_invitation_v9(viewer_id,vd,'windows','0.1.12',repeat('d',64),'Viewer',invitation,'accept',repeat('d',64),gen_random_uuid());
 select id into child_studio from public.studios where scenario_id=child;
 if child_studio is null or child_studio=studio then raise exception 'channel isolation missing';end if;
 perform public.authorize_studio_operation(editor_id,ed,'windows','0.1.12',child_studio,array['editor']);
 perform public.authorize_studio_operation(viewer_id,vd,'windows','0.1.12',child_studio,array['viewer']);
 denied:=false;begin perform public.project_branches_v14(viewer_id,vd,'windows','0.1.12',project,command,repeat('c',64),artifact,gen_random_uuid());exception when others then if sqlerrm<>'branch_write_forbidden' then raise;end if;denied:=true;end;
 if not denied then raise exception 'viewer created branch';end if;
 -- Independent metadata stores and CAS on a live duplication source.
 seed:=jsonb_build_object('title',jsonb_build_object('revision',0,'value','Branches rollback'),'cover.hidden',jsonb_build_object('revision',0,'value',false));
 foreach field in array array['projectName','screenwriter','director','production','duration','version','date','rights','contactName','contactEmail','contactPhone','contactWebsite'] loop seed:=seed||jsonb_build_object('cover.'||field,jsonb_build_object('revision',0,'value',''));end loop;
 perform public.project_metadata_v10(owner_id,od,'windows','0.1.12',project,gen_random_uuid(),base,seed,null,null,null,null);
 command:=jsonb_build_object('action','duplicate','operationId',gen_random_uuid(),'sourceVersionId',project,'name','Copy');
 prepared:=public.project_branches_v14(editor_id,ed,'windows','0.1.12',project,command,repeat('f',64),null,gen_random_uuid());
 if prepared#>>'{source,storageKey}'<>'branches/test' then raise exception 'wrong source';end if;
 artifact:=artifact||jsonb_build_object('stamp',prepared#>'{source,stamp}');
 perform public.project_metadata_v10(editor_id,ed,'windows','0.1.12',project,gen_random_uuid(),null,null,gen_random_uuid(),'[{"key":"cover.projectName","expectedRevision":0,"value":"New cover"}]',repeat('a',64),null);
 denied:=false;begin perform public.project_branches_v14(editor_id,ed,'windows','0.1.12',project,command,repeat('f',64),artifact,gen_random_uuid());exception when others then if sqlerrm<>'branch_source_changed' then raise;end if;denied:=true;end;
 if not denied then raise exception 'stale source copied';end if;
 -- Deletion and restore do not touch the parent or sibling bytes.
 command:=jsonb_build_object('action','delete','operationId',gen_random_uuid(),'versionId',branch,'expectedRevision',1);
 denied:=false;begin perform public.project_branches_v14(editor_id,ed,'windows','0.1.12',project,command,repeat('d',64),null,gen_random_uuid());exception when others then if sqlerrm<>'branch_owner_required' then raise;end if;denied:=true;end;
 if not denied then raise exception 'editor deleted branch';end if;
 perform public.project_branches_v14(owner_id,od,'windows','0.1.12',project,command,repeat('d',64),null,gen_random_uuid());
 denied:=false;begin perform public.authorize_studio_operation(owner_id,od,'windows','0.1.12',child_studio,array['owner']);exception when others then if sqlerrm<>'studio_not_found' then raise;end if;denied:=true;end;
 if not denied then raise exception 'deleted branch writable';end if;
 command:=jsonb_build_object('action','delete','operationId',gen_random_uuid(),'versionId',project,'expectedRevision',1);
 denied:=false;begin perform public.project_branches_v14(owner_id,od,'windows','0.1.12',project,command,repeat('e',64),null,gen_random_uuid());exception when others then if sqlerrm<>'branch_last_version' then raise;end if;denied:=true;end;
 if not denied then raise exception 'last version deleted';end if;
 command:=jsonb_build_object('action','restore','operationId',gen_random_uuid(),'versionId',branch,'expectedRevision',2);
 perform public.project_branches_v14(owner_id,od,'windows','0.1.12',project,command,repeat('a',64),null,gen_random_uuid());
 perform public.authorize_studio_operation(editor_id,ed,'windows','0.1.12',child_studio,array['editor']);
 if (select current_version_id from public.cloud_scenarios where id=project)<>base then raise exception 'parent overwritten';end if;
 -- Revocation on the project removes access to every branch, including a
 -- previously cached channel id. Direct table writes and helper RPCs are denied.
 perform public.remove_studio_member(owner_id,od,'windows','0.1.12',repeat('a',64),'Owner',studio,editor_id,repeat('f',64),gen_random_uuid());
 denied:=false;begin perform public.authorize_studio_operation(editor_id,ed,'windows','0.1.12',child_studio,array['editor']);exception when others then if sqlerrm<>'studio_not_found' then raise;end if;denied:=true;end;
 if not denied then raise exception 'revocation bypass';end if;
 if has_table_privilege('authenticated','public.project_branches','INSERT') or has_function_privilege('authenticated','public.project_branches_v14(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid)','EXECUTE') then raise exception 'RLS bypass';end if;
end $$;
