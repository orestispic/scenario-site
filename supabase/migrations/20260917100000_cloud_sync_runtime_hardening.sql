-- Phase 8 runtime correction for immutable phase 6 cloud RPCs.
-- Supabase installs pgcrypto in the extensions schema, while the historical
-- SECURITY DEFINER functions use a deliberately restricted public search_path.

create or replace function public.restore_cloud_scenario_version(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_auth jsonb; v_scenario public.cloud_scenarios; v_source public.cloud_scenario_versions; v_version public.cloud_scenario_versions; v_existing public.cloud_idempotency_keys; v_role text; v_response jsonb;
begin
  v_auth:=public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform pg_advisory_xact_lock(hashtextextended('cloud:'||p_scenario_id::text,0));
  select * into v_existing from public.cloud_idempotency_keys where user_id=p_profile_id and idempotency_key_hash=p_idempotency_hash;
  if v_existing.id is not null then
    if v_existing.operation <> 'restore' or v_existing.request_fingerprint <> encode(extensions.digest(p_version_id::text,'sha256'),'hex') then raise exception 'cloud_idempotency_conflict'; end if;
    return v_existing.response||jsonb_build_object('replayed',true);
  end if;
  select * into v_scenario from public.cloud_scenarios where id=p_scenario_id for update;
  select case when v_scenario.owner_id=p_profile_id then 'owner' else role end into v_role from public.scenario_collaborators where scenario_id=p_scenario_id and user_id=p_profile_id and status='active';
  if v_scenario.owner_id<>p_profile_id and coalesce(v_role,'')<>'editor' then raise exception 'scenario_write_forbidden'; end if;
  select * into v_source from public.cloud_scenario_versions where id=p_version_id and scenario_id=p_scenario_id;
  if v_source.id is null then raise exception 'scenario_version_not_found'; end if;
  insert into public.cloud_scenario_versions(scenario_id,parent_version_id,created_by,version_number,kind,content_checksum,storage_key,size_bytes,content_type,format,origin,entitlement_snapshot_id,request_id)
  values(p_scenario_id,v_scenario.current_version_id,p_profile_id,(select coalesce(max(version_number),0)+1 from public.cloud_scenario_versions where scenario_id=p_scenario_id),'restore',v_source.content_checksum,v_source.storage_key,v_source.size_bytes,v_source.content_type,v_source.format,'restore',(v_auth->>'snapshotId')::uuid,p_request_id) returning * into v_version;
  update public.cloud_scenarios set current_version_id=v_version.id,deleted_at=null,updated_at=now() where id=p_scenario_id returning * into v_scenario;
  v_response:=jsonb_build_object('scenario',public.cloud_scenario_json(v_scenario,p_profile_id),'version',public.cloud_version_json(v_version),'replayed',false,'storageKey',v_version.storage_key);
  insert into public.cloud_idempotency_keys(user_id,idempotency_key_hash,request_fingerprint,operation,scenario_id,version_id,response) values(p_profile_id,p_idempotency_hash,encode(extensions.digest(p_version_id::text,'sha256'),'hex'),'restore',p_scenario_id,v_version.id,v_response);
  return v_response;
end $$;

create or replace function public.soft_delete_cloud_scenario(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_scenario public.cloud_scenarios; v_existing public.cloud_idempotency_keys; v_response jsonb; v_fingerprint text;
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  v_fingerprint:=encode(extensions.digest(p_scenario_id::text||':delete','sha256'),'hex');
  select * into v_existing from public.cloud_idempotency_keys where user_id=p_profile_id and idempotency_key_hash=p_idempotency_hash;
  if v_existing.id is not null then
    if v_existing.operation<>'delete' or v_existing.request_fingerprint<>v_fingerprint then raise exception 'cloud_idempotency_conflict'; end if;
    return v_existing.response;
  end if;
  select * into v_scenario from public.cloud_scenarios where id=p_scenario_id for update;
  if v_scenario.owner_id is null then raise exception 'scenario_not_found'; end if;
  if v_scenario.owner_id<>p_profile_id then raise exception 'scenario_delete_forbidden'; end if;
  update public.cloud_scenarios set deleted_at=coalesce(deleted_at,now()),updated_at=now() where id=p_scenario_id returning * into v_scenario;
  v_response:=public.cloud_scenario_json(v_scenario,p_profile_id);
  insert into public.cloud_idempotency_keys(user_id,idempotency_key_hash,request_fingerprint,operation,scenario_id,response)
    values(p_profile_id,p_idempotency_hash,v_fingerprint,'delete',p_scenario_id,v_response);
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id) values(p_profile_id,'cloud.soft_delete','cloud_scenario',p_scenario_id::text,p_request_id);
  return v_response;
end $$;

revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
revoke all on function public.list_cloud_scenarios(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.list_cloud_scenario_versions(uuid,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.restore_cloud_scenario_version(uuid,text,text,text,uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.soft_delete_cloud_scenario(uuid,text,text,text,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) from public, anon, authenticated;

grant execute on function public.list_cloud_scenarios(uuid,text,text,text) to service_role;
grant execute on function public.list_cloud_scenario_versions(uuid,text,text,text,uuid) to service_role;
grant execute on function public.restore_cloud_scenario_version(uuid,text,text,text,uuid,uuid,text,uuid) to service_role;
grant execute on function public.soft_delete_cloud_scenario(uuid,text,text,text,uuid,text,uuid) to service_role;
grant execute on function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) to service_role;
