-- Phase 6 is append-only. Existing cloud tables are extended in place; no prior migration changes.
alter table public.cloud_scenario_versions
  add column size_bytes bigint not null default 1 check (size_bytes between 1 and 8388608),
  add column content_type text not null default 'application/vnd.scenario+json'
    check (content_type = 'application/vnd.scenario+json'),
  add column format text not null default 'scenario-v1' check (format = 'scenario-v1'),
  add column origin text not null default 'save'
    check (origin in ('save', 'import', 'offline_replay', 'restore')),
  add column entitlement_snapshot_id uuid references public.entitlement_snapshots(id),
  add column request_id uuid;

alter table public.cloud_scenario_versions alter column size_bytes drop default;
-- Legacy phase-0 rows may predate snapshots/request ids. The v6 RPC always writes both;
-- partial uniqueness preserves those rows without fabricating audit provenance.
create unique index cloud_scenario_versions_request_id_idx on public.cloud_scenario_versions(request_id) where request_id is not null;
create index cloud_scenarios_owner_updated_idx on public.cloud_scenarios(owner_id, updated_at desc);
create index cloud_scenario_versions_parent_idx on public.cloud_scenario_versions(scenario_id, parent_version_id);

alter table public.scenario_collaborators
  add column status text not null default 'active' check (status in ('invited', 'active', 'revoked')),
  add column invited_by uuid references public.users(id),
  add column updated_at timestamptz not null default now();

create table public.cloud_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('sync', 'restore', 'delete')),
  scenario_id uuid not null references public.cloud_scenarios(id),
  version_id uuid references public.cloud_scenario_versions(id),
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key_hash)
);
create index cloud_idempotency_scenario_idx on public.cloud_idempotency_keys(scenario_id, created_at desc);

alter table public.cloud_idempotency_keys enable row level security;
revoke all on public.cloud_idempotency_keys from anon, authenticated;

drop trigger if exists cloud_scenario_versions_immutable on public.cloud_scenario_versions;
create trigger cloud_scenario_versions_immutable before update or delete on public.cloud_scenario_versions
for each row execute function public.reject_immutable_history_mutation();
drop trigger if exists cloud_idempotency_keys_immutable on public.cloud_idempotency_keys;
create trigger cloud_idempotency_keys_immutable before update or delete on public.cloud_idempotency_keys
for each row execute function public.reject_immutable_history_mutation();

create or replace function public.cloud_scenario_json(p_scenario public.cloud_scenarios, p_profile_id uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_scenario.id, 'title', p_scenario.title,
    'role', case when p_scenario.owner_id = p_profile_id then 'owner'
      else (select role from public.scenario_collaborators where scenario_id = p_scenario.id and user_id = p_profile_id and status = 'active') end,
    'currentVersionId', p_scenario.current_version_id, 'deletedAt', p_scenario.deleted_at,
    'createdAt', p_scenario.created_at, 'updatedAt', p_scenario.updated_at)
$$;

create or replace function public.cloud_version_json(p_version public.cloud_scenario_versions)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p_version.id, 'scenarioId', p_version.scenario_id, 'authorId', p_version.created_by,
    'parentVersionId', p_version.parent_version_id, 'versionNumber', p_version.version_number,
    'checksum', p_version.content_checksum, 'sizeBytes', p_version.size_bytes,
    'contentType', p_version.content_type, 'format', p_version.format, 'origin', p_version.origin,
    'entitlementSnapshotId', p_version.entitlement_snapshot_id, 'requestId', p_version.request_id,
    'createdAt', p_version.created_at)
$$;

create or replace function public.authorize_cloud_operation(
  p_profile_id uuid, p_fingerprint_hash text, p_platform text, p_client_version text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_snapshot public.entitlement_snapshots; v_minimum text;
begin
  if p_client_version !~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' then raise exception 'invalid_client_version'; end if;
  select * into v_snapshot from public.current_entitlement_snapshot(p_profile_id);
  if v_snapshot.id is null or not exists (
    select 1 from jsonb_array_elements(coalesce(v_snapshot.payload -> 'entitlements', '[]'::jsonb)) e
    where e ->> 'code' in ('cloud_sync', 'cloud.sync') and coalesce((e ->> 'enabled')::boolean, false)
  ) or not exists (
    select 1 from jsonb_array_elements(coalesce(v_snapshot.payload -> 'entitlements', '[]'::jsonb)) e
    where e ->> 'code' = 'scenario_versions' and coalesce((e ->> 'enabled')::boolean, false)
  ) then raise exception 'cloud_entitlement_missing'; end if;
  if not exists (select 1 from public.devices where user_id = p_profile_id and device_fingerprint_hash = p_fingerprint_hash and platform = p_platform and status = 'active')
    then raise exception 'cloud_device_inactive'; end if;
  select minimum_supported_version into v_minimum from public.client_compatibility_rules
    where platform = p_platform and channel = 'stable' and effective_at <= now() order by effective_at desc limit 1;
  if v_minimum is not null and not public.semantic_version_at_least(p_client_version, v_minimum)
    then raise exception 'client_update_required'; end if;
  return jsonb_build_object('snapshotId', v_snapshot.id);
end $$;

create or replace function public.sync_cloud_scenario(
  p_profile_id uuid, p_fingerprint_hash text, p_platform text, p_client_version text,
  p_request jsonb, p_storage_key text, p_idempotency_hash text,
  p_request_fingerprint text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_auth jsonb; v_scenario public.cloud_scenarios; v_version public.cloud_scenario_versions;
  v_existing public.cloud_idempotency_keys; v_number integer; v_role text; v_response jsonb;
begin
  if p_idempotency_hash !~ '^[0-9a-f]{64}$' or p_request_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'cloud_fingerprint_invalid'; end if;
  if p_storage_key ~ '(^|/)\.\.(/|$)' or p_storage_key like '/%' or length(p_storage_key) > 512 then raise exception 'cloud_storage_key_invalid'; end if;
  v_auth := public.authorize_cloud_operation(p_profile_id, p_fingerprint_hash, p_platform, p_client_version);
  perform pg_advisory_xact_lock(hashtextextended('cloud:' || (p_request ->> 'scenarioId'), 0));
  select * into v_existing from public.cloud_idempotency_keys where user_id = p_profile_id and idempotency_key_hash = p_idempotency_hash;
  if v_existing.id is not null then
    if v_existing.request_fingerprint <> p_request_fingerprint or v_existing.operation <> 'sync' then raise exception 'cloud_idempotency_conflict'; end if;
    return v_existing.response || jsonb_build_object('replayed', true);
  end if;
  select * into v_scenario from public.cloud_scenarios where id = (p_request ->> 'scenarioId')::uuid for update;
  if v_scenario.id is null then
    if p_request ->> 'parentVersionId' is not null then raise exception 'scenario_not_found'; end if;
    insert into public.cloud_scenarios(id, owner_id, title) values ((p_request ->> 'scenarioId')::uuid, p_profile_id, left(p_request ->> 'title', 200)) returning * into v_scenario;
  else
    select case when v_scenario.owner_id = p_profile_id then 'owner' else role end into v_role
      from public.scenario_collaborators where scenario_id = v_scenario.id and user_id = p_profile_id and status = 'active';
    if v_scenario.owner_id <> p_profile_id and coalesce(v_role, '') <> 'editor' then raise exception 'scenario_write_forbidden'; end if;
    if v_scenario.deleted_at is not null then raise exception 'scenario_deleted'; end if;
    if v_scenario.current_version_id is distinct from nullif(p_request ->> 'parentVersionId', '')::uuid
      then raise exception 'scenario_parent_conflict:%', v_scenario.current_version_id; end if;
  end if;
  select coalesce(max(version_number), 0) + 1 into v_number from public.cloud_scenario_versions where scenario_id = v_scenario.id;
  insert into public.cloud_scenario_versions(scenario_id,parent_version_id,created_by,version_number,kind,content_checksum,storage_key,size_bytes,content_type,format,origin,entitlement_snapshot_id,request_id)
  values (v_scenario.id, nullif(p_request ->> 'parentVersionId','')::uuid, p_profile_id, v_number,
    case when p_request ->> 'origin' = 'import' then 'import'::public.scenario_version_kind else 'save'::public.scenario_version_kind end,
    p_request ->> 'checksum', p_storage_key, (p_request ->> 'sizeBytes')::bigint,
    p_request ->> 'contentType', p_request ->> 'format', p_request ->> 'origin',
    (v_auth ->> 'snapshotId')::uuid, p_request_id) returning * into v_version;
  update public.cloud_scenarios set title = left(p_request ->> 'title', 200), current_version_id = v_version.id, updated_at = now() where id = v_scenario.id returning * into v_scenario;
  v_response := jsonb_build_object('scenario', public.cloud_scenario_json(v_scenario,p_profile_id),'version',public.cloud_version_json(v_version),'replayed',false);
  insert into public.cloud_idempotency_keys(user_id,idempotency_key_hash,request_fingerprint,operation,scenario_id,version_id,response)
    values (p_profile_id,p_idempotency_hash,p_request_fingerprint,'sync',v_scenario.id,v_version.id,v_response);
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id,metadata)
    values (p_profile_id,'cloud.version_created','cloud_scenario',v_scenario.id::text,p_request_id,jsonb_build_object('version_id',v_version.id,'origin',v_version.origin));
  return v_response;
end $$;

create or replace function public.list_cloud_scenarios(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select coalesce(jsonb_agg(public.cloud_scenario_json(s,p_profile_id) order by s.updated_at desc),'[]'::jsonb) into v_result
  from public.cloud_scenarios s where s.owner_id=p_profile_id or exists(select 1 from public.scenario_collaborators c where c.scenario_id=s.id and c.user_id=p_profile_id and c.status='active');
  return v_result;
end $$;

create or replace function public.list_cloud_scenario_versions(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  if not exists(select 1 from public.cloud_scenarios s where s.id=p_scenario_id and (s.owner_id=p_profile_id or exists(select 1 from public.scenario_collaborators c where c.scenario_id=s.id and c.user_id=p_profile_id and c.status='active'))) then raise exception 'scenario_not_found'; end if;
  select coalesce(jsonb_agg(public.cloud_version_json(v) order by v.version_number desc),'[]'::jsonb) into v_result from public.cloud_scenario_versions v where v.scenario_id=p_scenario_id;
  return v_result;
end $$;

create or replace function public.restore_cloud_scenario_version(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_auth jsonb; v_scenario public.cloud_scenarios; v_source public.cloud_scenario_versions; v_version public.cloud_scenario_versions; v_existing public.cloud_idempotency_keys; v_role text; v_response jsonb;
begin
  v_auth:=public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform pg_advisory_xact_lock(hashtextextended('cloud:'||p_scenario_id::text,0));
  select * into v_existing from public.cloud_idempotency_keys where user_id=p_profile_id and idempotency_key_hash=p_idempotency_hash;
  if v_existing.id is not null then
    if v_existing.operation <> 'restore' or v_existing.request_fingerprint <> encode(digest(p_version_id::text,'sha256'),'hex') then raise exception 'cloud_idempotency_conflict'; end if;
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
  insert into public.cloud_idempotency_keys(user_id,idempotency_key_hash,request_fingerprint,operation,scenario_id,version_id,response) values(p_profile_id,p_idempotency_hash,encode(digest(p_version_id::text,'sha256'),'hex'),'restore',p_scenario_id,v_version.id,v_response);
  return v_response;
end $$;

create or replace function public.soft_delete_cloud_scenario(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_scenario public.cloud_scenarios; v_existing public.cloud_idempotency_keys; v_response jsonb; v_fingerprint text;
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  v_fingerprint:=encode(digest(p_scenario_id::text||':delete','sha256'),'hex');
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

create or replace function public.get_cloud_storage_key(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select v.storage_key into v_key from public.cloud_scenario_versions v join public.cloud_scenarios s on s.id=v.scenario_id
  where v.scenario_id=p_scenario_id and v.id=p_version_id and (s.owner_id=p_profile_id or exists(select 1 from public.scenario_collaborators c where c.scenario_id=s.id and c.user_id=p_profile_id and c.status='active'));
  if v_key is null then raise exception 'scenario_version_not_found'; end if;
  return to_jsonb(v_key);
end $$;

drop policy if exists cloud_scenarios_select_own on public.cloud_scenarios;
create policy cloud_scenarios_select_member on public.cloud_scenarios for select to authenticated using (
  owner_id=public.current_profile_id() or exists(select 1 from public.scenario_collaborators c where c.scenario_id=id and c.user_id=public.current_profile_id() and c.status='active'));
drop policy if exists cloud_scenario_versions_select_own on public.cloud_scenario_versions;
create policy cloud_scenario_versions_select_member on public.cloud_scenario_versions for select to authenticated using (
  exists(select 1 from public.cloud_scenarios s where s.id=scenario_id and (s.owner_id=public.current_profile_id() or exists(select 1 from public.scenario_collaborators c where c.scenario_id=s.id and c.user_id=public.current_profile_id() and c.status='active'))));

revoke all on function public.authorize_cloud_operation(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.sync_cloud_scenario(uuid,text,text,text,jsonb,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.authorize_cloud_operation(uuid,text,text,text) to service_role;
grant execute on function public.sync_cloud_scenario(uuid,text,text,text,jsonb,text,text,text,uuid) to service_role;
grant execute on function public.list_cloud_scenarios(uuid,text,text,text) to service_role;
grant execute on function public.list_cloud_scenario_versions(uuid,text,text,text,uuid) to service_role;
grant execute on function public.restore_cloud_scenario_version(uuid,text,text,text,uuid,uuid,text,uuid) to service_role;
grant execute on function public.soft_delete_cloud_scenario(uuid,text,text,text,uuid,text,uuid) to service_role;
grant execute on function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) to service_role;
