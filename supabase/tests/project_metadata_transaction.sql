-- Run after the candidate migration inside BEGIN / ROLLBACK. Uses only the
-- already-authorized three synthetic preproduction accounts; no durable fixture.
do $$
declare owner_id uuid; editor_id uuid; viewer_id uuid; od text; ed text; vd text;
 scenario uuid:=gen_random_uuid();studio uuid;base uuid;result jsonb;seed jsonb;changes jsonb;
 op uuid:=gen_random_uuid();snapshot uuid:=gen_random_uuid();first_snapshot jsonb;comment jsonb;
 forbidden boolean;field text;invitation uuid;
begin
 select id into owner_id from public.profiles where email='phase9-owner-zblnsdyaoljnezxdidtx@example.com';
 select id into editor_id from public.profiles where email='phase9-editor-zblnsdyaoljnezxdidtx@example.com';
 select id into viewer_id from public.profiles where email='phase9-viewer-zblnsdyaoljnezxdidtx@example.com';
 select device_fingerprint_hash into od from public.devices where user_id=owner_id and status='active' and platform='windows' limit 1;
 select device_fingerprint_hash into ed from public.devices where user_id=editor_id and status='active' and platform='windows' limit 1;
 select device_fingerprint_hash into vd from public.devices where user_id=viewer_id and status='active' and platform='windows' limit 1;
 if owner_id is null or editor_id is null or viewer_id is null or od is null or ed is null or vd is null then raise exception 'synthetic active accounts required';end if;
 result:=public.sync_cloud_scenario(owner_id,od,'windows','0.1.7',jsonb_build_object('scenarioId',scenario,'title','Metadata rollback','parentVersionId',null,'checksum',repeat('f',64),'sizeBytes',2,'contentType','application/vnd.scenario+json','format','scenario-v1','origin','save'),'metadata/rollback',repeat('b',64),repeat('b',64),gen_random_uuid());
 base:=(result#>>'{version,id}')::uuid;
 result:=public.ensure_project_sharing_v9(owner_id,od,'windows','0.1.7',repeat('a',64),'Owner',scenario,repeat('a',64),gen_random_uuid());studio:=(result#>>'{studio,id}')::uuid;
 result:=public.create_studio_invitation(owner_id,od,'windows','0.1.7',repeat('a',64),'Owner',studio,repeat('e',64),'e***@example.invalid','editor',encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),now()+interval '1 hour',repeat('e',64),gen_random_uuid());invitation:=(result#>>'{invitation,id}')::uuid;
 perform public.respond_project_invitation_v9(editor_id,ed,'windows','0.1.7',repeat('e',64),'Editor',invitation,'accept',repeat('e',64),gen_random_uuid());
 result:=public.create_studio_invitation(owner_id,od,'windows','0.1.7',repeat('a',64),'Owner',studio,repeat('d',64),'v***@example.invalid','viewer',encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),now()+interval '1 hour',repeat('d',64),gen_random_uuid());invitation:=(result#>>'{invitation,id}')::uuid;
 perform public.respond_project_invitation_v9(viewer_id,vd,'windows','0.1.7',repeat('d',64),'Viewer',invitation,'accept',repeat('d',64),gen_random_uuid());
 seed:=jsonb_build_object('title',jsonb_build_object('revision',0,'value','Metadata rollback'),'cover.hidden',jsonb_build_object('revision',0,'value',false));
 foreach field in array array['projectName','screenwriter','director','production','duration','version','date','rights','contactName','contactEmail','contactPhone','contactWebsite'] loop seed:=seed||jsonb_build_object('cover.'||field,jsonb_build_object('revision',0,'value',''));end loop;
 comment:='{"id":"thread_test","status":"open","createdAt":"2026-09-12T00:00:00Z","resolvedAt":null,"anchor":{"sceneId":"scene_root","blockId":"block_one","startOffset":0,"endOffset":5,"originalText":"hello","lost":false},"messages":[{"id":"message_one","text":"Synthetic comment","createdAt":"2026-09-12T00:00:00Z","editedAt":null}]}'::jsonb;
 seed:=seed||jsonb_build_object('comment:thread_test',jsonb_build_object('revision',0,'value',comment));
 if not public.valid_project_metadata_registers_v10(seed) or public.valid_project_metadata_registers_v10(null) or public.valid_project_metadata_registers_v10(jsonb_set(seed,'{comment:thread_test,value,anchor,blockId}','123')) then raise exception 'validation failed';end if;
 result:=public.project_metadata_v10(viewer_id,vd,'windows','0.1.7',scenario,gen_random_uuid(),base,seed,null,null,null,null);
 if result#>>'{state,revision}'<>'0' then raise exception 'trusted seed failed';end if;
 changes:=jsonb_build_array(jsonb_build_object('key','cover.projectName','expectedRevision',0,'value','Shared cover'));
 result:=public.project_metadata_v10(owner_id,od,'windows','0.1.7',scenario,gen_random_uuid(),null,null,op,changes,repeat('a',64),null);
 if result->>'status'<>'applied' or result#>>'{state,revision}'<>'1' then raise exception 'write failed';end if;
 result:=public.project_metadata_v10(owner_id,od,'windows','0.1.7',scenario,gen_random_uuid(),null,null,op,changes,repeat('a',64),null);
 if result->>'replayed'<>'true' then raise exception 'replay failed';end if;
 result:=public.project_metadata_v10(editor_id,ed,'windows','0.1.7',scenario,gen_random_uuid(),null,null,gen_random_uuid(),changes,repeat('b',64),null);
 if result->>'status'<>'conflict' or result#>>'{state,revision}'<>'1' then raise exception 'stale write overwrote state';end if;
 result:=public.project_metadata_v10(editor_id,ed,'windows','0.1.7',scenario,gen_random_uuid(),null,null,gen_random_uuid(),jsonb_build_array(jsonb_build_object('key','cover.director','expectedRevision',0,'value','Other field')),repeat('c',64),null);
 if result->>'status'<>'applied' or result#>>'{state,revision}'<>'2' then raise exception 'independent field failed';end if;
 first_snapshot:=public.project_metadata_v10(owner_id,od,'windows','0.1.7',scenario,gen_random_uuid(),null,null,null,null,null,snapshot);
 result:=public.project_metadata_v10(editor_id,ed,'windows','0.1.7',scenario,gen_random_uuid(),null,null,gen_random_uuid(),'[{"key":"comment:thread_test","expectedRevision":0,"value":null}]',repeat('f',64),null);
 if result->>'status'<>'applied' then raise exception 'tombstone failed';end if;
 result:=public.project_metadata_v10(owner_id,od,'windows','0.1.7',scenario,gen_random_uuid(),null,null,null,null,null,snapshot);
 if result->'state'<>first_snapshot->'state' then raise exception 'snapshot changed on retry';end if;
 forbidden:=false;begin
  perform public.project_metadata_v10(viewer_id,vd,'windows','0.1.7',scenario,gen_random_uuid(),null,null,gen_random_uuid(),changes,repeat('a',64),null);
 exception when others then if sqlerrm not like '%studio_not_found%' then raise;end if;forbidden:=true;end;
 if not forbidden then raise exception 'viewer wrote metadata';end if;
 forbidden:=false;begin update public.project_metadata_operations set changes='[]' where scenario_id=scenario;exception when others then forbidden:=true;end;
 if not forbidden then raise exception 'history mutable';end if;
 forbidden:=false;begin delete from public.project_metadata_snapshots where snapshot_id=snapshot;exception when others then forbidden:=true;end;
 if not forbidden then raise exception 'snapshot mutable';end if;
 if exists(select 1 from pg_class where oid in ('public.project_metadata_state'::regclass,'public.project_metadata_operations'::regclass,'public.project_metadata_snapshots'::regclass) and not relrowsecurity) then raise exception 'RLS missing';end if;
 if has_table_privilege('authenticated','public.project_metadata_state','select') or has_function_privilege('authenticated','public.project_metadata_v10(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid)','execute') then raise exception 'direct access exposed';end if;
 perform public.remove_studio_member(owner_id,od,'windows','0.1.7',repeat('a',64),'Owner',studio,editor_id,repeat('f',64),gen_random_uuid());
 forbidden:=false;begin perform public.project_metadata_v10(editor_id,ed,'windows','0.1.7',scenario,gen_random_uuid(),null,null,null,null,null,null);exception when others then if sqlerrm not like '%studio_not_found%' then raise;end if;forbidden:=true;end;
 if not forbidden then raise exception 'revoked metadata access';end if;
end $$;
select 'PASS metadata SQL: three accounts, CAS, replay, snapshots, tombstones, immutable history, RLS and revocation; transaction rolled back' as result;
