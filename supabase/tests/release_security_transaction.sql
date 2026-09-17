-- Synthetic records only, rolled back by the isolated PostgreSQL harness.
do $$
declare o uuid; e uuid; v uuid; od text; ed text; vd text; p uuid:=gen_random_uuid(); base uuid; studio uuid;
  result jsonb; invitation uuid; denied boolean; branch uuid; auth_id uuid; session_id uuid:=gen_random_uuid();
begin
  select id into o from profiles where email='phase9-owner-zblnsdyaoljnezxdidtx@example.com';
  select id into e from profiles where email='phase9-editor-zblnsdyaoljnezxdidtx@example.com';
  select id into v from profiles where email='phase9-viewer-zblnsdyaoljnezxdidtx@example.com';
  select device_fingerprint_hash into od from devices where user_id=o limit 1;
  select device_fingerprint_hash into ed from devices where user_id=e limit 1;
  select device_fingerprint_hash into vd from devices where user_id=v limit 1;
  select auth_user_id into auth_id from profiles where id=o;
  insert into auth.sessions(id,user_id) values(session_id,auth_id);
  if not public.is_account_session_active_v16(auth_id,session_id) then raise exception 'valid session rejected';end if;
  update auth.users set banned_until=now()+interval '1 day' where id=auth_id;
  if public.is_account_session_active_v16(auth_id,session_id) then raise exception 'suspended session allowed';end if;
  denied:=false;begin perform public.require_contact_pair_v16(o,e);exception when others then if sqlerrm<>'contact_required' then raise;end if;denied:=true;end;
  if not denied then raise exception 'suspended contact sharing allowed';end if;
  update auth.users set banned_until=null where id=auth_id;
  delete from auth.sessions where id=session_id;
  if public.is_account_session_active_v16(auth_id,session_id) then raise exception 'signed out session allowed';end if;
  result:=public.sync_cloud_scenario(o,od,'windows','0.1.12',jsonb_build_object('scenarioId',p,'title','Audit synthetic','parentVersionId',null,'checksum',repeat('f',64),'sizeBytes',2,'contentType','application/vnd.scenario+json','format','scenario-v1','origin','save'),'audit/synthetic',repeat('1',64),repeat('1',64),gen_random_uuid());
  base:=(result#>>'{version,id}')::uuid;
  perform public.project_branches_v14(o,od,'windows','0.1.12',p,'{"action":"list"}',null,null,gen_random_uuid());
  result:=public.project_branches_v14(o,od,'windows','0.1.12',p,jsonb_build_object('action','blank','operationId',gen_random_uuid(),'name','Secondary'),repeat('4',64),jsonb_build_object('storageKey','branches/'||p||'/'||gen_random_uuid()||'.scenario','checksum',repeat('e',64),'sizeBytes',2),gen_random_uuid());
  branch:=(result#>>'{version,project,id}')::uuid;
  result:=public.ensure_project_sharing_v9(o,od,'windows','0.1.12',repeat('a',64),'Owner',p,repeat('2',64),gen_random_uuid()); studio:=(result#>>'{studio,id}')::uuid;
  result:=public.create_contact_project_invitation_v16(o,od,'windows','0.1.12',repeat('a',64),'Owner',studio,repeat('e',64),e,'e***@example.invalid','editor',repeat('c',64),now()+interval '1 hour',repeat('3',64),gen_random_uuid()); invitation:=(result#>>'{invitation,id}')::uuid;
  perform public.respond_project_invitation_v9(e,ed,'windows','0.1.12',repeat('e',64),'Editor',invitation,'accept',repeat('3',64),gen_random_uuid());
  if not exists(select 1 from scenario_collaborators where scenario_id=branch and user_id=e and status='active') then raise exception 'branch grant missing';end if;
  result:=public.read_project_document_v16(e,ed,'windows','0.1.12',p);
  if result#>>'{source,storageKey}'<>'audit/synthetic' then raise exception 'reader projection incorrect';end if;
  denied:=false;begin perform public.read_project_document_v16(v,vd,'windows','0.1.12',p);exception when others then if sqlerrm not in('project_not_found','scenario_not_found','cloud_scenario_forbidden') then raise;end if;denied:=true;end;
  if not denied then raise exception 'uninvited reader accessed document';end if;
  result:=public.create_contact_project_invitation_v16(o,od,'windows','0.1.12',repeat('a',64),'Owner',studio,repeat('f',64),v,'v***@example.invalid','viewer',repeat('d',64),now()+interval '1 hour',repeat('5',64),gen_random_uuid()); invitation:=(result#>>'{invitation,id}')::uuid;
  -- Deleting self must never erase all of one's accepted contacts.
  denied:=false; begin perform public.remove_project_contact_v15(o,od,'windows','0.1.12',o); exception when others then if sqlerrm<>'contact_not_found' then raise;end if; denied:=true;end;
  if not denied then raise exception 'self contact removal allowed';end if;
  perform public.remove_project_contact_v15(e,ed,'windows','0.1.12',o);
  if exists(select 1 from scenario_collaborators where scenario_id in(p,branch) and user_id=e and status='active') then raise exception 'contact removal left branch grant';end if;
  if exists(select 1 from studio_memberships m join studios s on s.id=m.studio_id where s.scenario_id in(p,branch) and m.profile_id=e and m.status='active') then raise exception 'contact removal left realtime grant';end if;
  denied:=false;begin perform public.read_project_document_v16(e,ed,'windows','0.1.12',p);exception when others then if sqlerrm not in('project_not_found','scenario_not_found','cloud_scenario_forbidden') then raise;end if;denied:=true;end;
  if not denied then raise exception 'revoked reader accessed document';end if;
  perform public.remove_project_contact_v15(o,od,'windows','0.1.12',v);
  denied:=false; begin perform public.respond_project_invitation_v9(v,vd,'windows','0.1.12',repeat('f',64),'Viewer',invitation,'accept',repeat('6',64),gen_random_uuid()); exception when others then if sqlerrm not in('invitation_not_pending','contact_required') then raise;end if;denied:=true;end;
  if not denied then raise exception 'removed contact accepted stale invite';end if;
  denied:=false; begin perform public.create_contact_project_invitation_v16(o,od,'windows','0.1.12',repeat('a',64),'Owner',studio,repeat('e',64),e,'e***@example.invalid','viewer',repeat('b',64),now()+interval '1 hour',repeat('7',64),gen_random_uuid()); exception when others then if sqlerrm<>'contact_required' then raise;end if;denied:=true;end;
  if not denied then raise exception 'non-contact invitation allowed';end if;
  if has_function_privilege('service_role','public.create_studio_invitation(uuid,text,text,text,text,text,uuid,text,text,text,text,timestamptz,text,uuid)','EXECUTE') then raise exception 'legacy invitation bypass remains';end if;
  -- Deletion is soft, then the original root can be recovered with every branch.
  perform public.soft_delete_cloud_scenario(o,od,'windows','0.1.12',p,repeat('8',64),gen_random_uuid());
  perform public.restore_cloud_scenario_version(o,od,'windows','0.1.12',p,base,repeat('9',64),gen_random_uuid());
  if exists(select 1 from cloud_scenarios where id=p and deleted_at is not null) then raise exception 'trash restoration failed';end if;
  if (select count(*) from project_branches where project_id=p)<>2 then raise exception 'restore lost branches';end if;
end $$;
