-- Phase 9: atomically attach a durable-channel compaction to an append-only
-- cloud version. Earlier migrations and public contracts remain unchanged.
create or replace function public.commit_studio_collaboration_snapshot_v2(
  p_profile_id uuid,
  p_fingerprint_hash text,
  p_platform text,
  p_client_version text,
  p_studio_id uuid,
  p_snapshot_id uuid,
  p_version_id uuid,
  p_parent_version_id uuid,
  p_through_cursor bigint,
  p_storage_key text,
  p_checksum text,
  p_size_bytes bigint,
  p_title text,
  p_idempotency_hash text,
  p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_auth jsonb;
  v_studio public.studios;
  v_scenario public.cloud_scenarios;
  v_existing public.studio_collaboration_compactions;
  v_snapshot public.studio_collaboration_snapshots;
  v_parent_snapshot_id uuid;
  v_previous_cursor bigint;
  v_number integer;
begin
  if p_idempotency_hash !~ '^[0-9a-f]{64}$'
    or p_checksum !~ '^[0-9a-f]{64}$'
    or p_storage_key ~ '(^|/)\.\.(/|$)'
    or p_storage_key like '/%'
    or length(p_storage_key) not between 1 and 512
    or p_size_bytes not between 2 and 4194304
    or p_through_cursor < 0
    or length(trim(p_title)) not between 1 and 200
  then raise exception 'collaboration_snapshot_invalid'; end if;

  v_auth:=public.authorize_studio_operation(
    p_profile_id,p_fingerprint_hash,p_platform,p_client_version,
    p_studio_id,array['owner','editor']
  );
  perform pg_advisory_xact_lock(hashtextextended('collab-compact:'||p_studio_id::text,0));

  select * into v_existing from public.studio_collaboration_compactions
    where studio_id=p_studio_id and idempotency_hash=p_idempotency_hash;
  if v_existing.id is not null then
    select * into v_snapshot from public.studio_collaboration_snapshots
      where id=v_existing.snapshot_id;
    if v_snapshot.id<>p_snapshot_id
      or v_snapshot.version_id<>p_version_id
      or v_snapshot.parent_version_id<>p_parent_version_id
      or v_snapshot.through_cursor<>p_through_cursor
      or v_snapshot.storage_key<>p_storage_key
      or v_snapshot.checksum<>p_checksum
    then raise exception 'collaboration_idempotency_conflict'; end if;
    return jsonb_build_object(
      'snapshotId',v_snapshot.id,'versionId',v_snapshot.version_id,
      'cursor',v_snapshot.through_cursor,'checksum',v_snapshot.checksum,
      'replayed',true
    );
  end if;

  select * into v_studio from public.studios where id=p_studio_id;
  if v_studio.id is null then raise exception 'studio_not_found'; end if;
  select * into v_scenario from public.cloud_scenarios
    where id=v_studio.scenario_id for update;
  if v_scenario.id is null or v_scenario.deleted_at is not null
    then raise exception 'scenario_not_found'; end if;
  if split_part(p_storage_key,'/',1) !~ '^[0-9a-f]{64}$'
    or split_part(p_storage_key,'/',2)<>'scenarios'
    or split_part(p_storage_key,'/',3)<>v_scenario.id::text
    or split_part(p_storage_key,'/',4)<>'snapshots'
    or split_part(p_storage_key,'/',5)<>p_snapshot_id::text||'.scenario'
    or split_part(p_storage_key,'/',6)<>''
  then raise exception 'collaboration_snapshot_invalid'; end if;
  if v_scenario.current_version_id is distinct from p_parent_version_id
    then raise exception 'scenario_parent_conflict:%',v_scenario.current_version_id; end if;
  if not exists(
    select 1 from public.cloud_scenario_versions
    where id=p_parent_version_id and scenario_id=v_scenario.id
  ) then raise exception 'base_version_unavailable'; end if;
  if p_through_cursor>coalesce((
    select max(cursor) from public.studio_collaboration_operations
    where studio_id=p_studio_id
  ),0) then raise exception 'collaboration_ledger_incomplete'; end if;

  select id,through_cursor into v_parent_snapshot_id,v_previous_cursor
    from public.studio_collaboration_snapshots
    where studio_id=p_studio_id
    order by through_cursor desc,created_at desc limit 1;
  if p_through_cursor<coalesce(v_previous_cursor,0)
    then raise exception 'collaboration_snapshot_stale'; end if;

  select coalesce(max(version_number),0)+1 into v_number
    from public.cloud_scenario_versions where scenario_id=v_scenario.id;
  insert into public.cloud_scenario_versions(
    id,scenario_id,parent_version_id,created_by,version_number,kind,
    content_checksum,storage_key,size_bytes,content_type,format,origin,
    entitlement_snapshot_id,request_id
  ) values(
    p_version_id,v_scenario.id,p_parent_version_id,p_profile_id,v_number,'revision',
    p_checksum,p_storage_key,p_size_bytes,'application/vnd.scenario+json',
    'scenario-v1','save',(v_auth->>'snapshotId')::uuid,p_request_id
  );
  update public.cloud_scenarios set
    title=left(trim(p_title),200),current_version_id=p_version_id,updated_at=now()
    where id=v_scenario.id;

  insert into public.studio_collaboration_snapshots(
    id,version_id,studio_id,scenario_id,parent_version_id,parent_snapshot_id,
    through_cursor,storage_key,checksum,created_by,entitlement_snapshot_id,request_id
  ) values(
    p_snapshot_id,p_version_id,p_studio_id,v_scenario.id,p_parent_version_id,
    v_parent_snapshot_id,p_through_cursor,p_storage_key,p_checksum,p_profile_id,
    (v_auth->>'snapshotId')::uuid,p_request_id
  ) returning * into v_snapshot;
  insert into public.studio_collaboration_compactions(
    studio_id,snapshot_id,from_cursor,through_cursor,idempotency_hash,request_id,created_by
  ) values(
    p_studio_id,p_snapshot_id,coalesce(v_previous_cursor+1,0),p_through_cursor,
    p_idempotency_hash,p_request_id,p_profile_id
  );
  insert into public.audit_log(
    actor_user_id,action,entity_type,entity_id,request_id,metadata
  ) values(
    p_profile_id,'studio.compaction','studio',p_studio_id::text,p_request_id,
    jsonb_build_object(
      'snapshot_id',p_snapshot_id,'version_id',p_version_id,
      'through_cursor',p_through_cursor
    )
  );
  return jsonb_build_object(
    'snapshotId',v_snapshot.id,'versionId',v_snapshot.version_id,
    'cursor',v_snapshot.through_cursor,'checksum',v_snapshot.checksum,
    'replayed',false
  );
end $$;

revoke all on function public.commit_studio_collaboration_snapshot_v2(
  uuid,text,text,text,uuid,uuid,uuid,uuid,bigint,text,text,bigint,text,text,uuid
) from public,anon,authenticated;
grant execute on function public.commit_studio_collaboration_snapshot_v2(
  uuid,text,text,text,uuid,uuid,uuid,uuid,bigint,text,text,bigint,text,text,uuid
) to service_role;

comment on function public.commit_studio_collaboration_snapshot_v2(
  uuid,text,text,text,uuid,uuid,uuid,uuid,bigint,text,text,bigint,text,text,uuid
) is 'Atomically commits a private collaboration snapshot as an immutable cloud version after object upload.';
