-- Phase 8: append-only collaborative operation and snapshot ledger.
-- Presence and heartbeats are deliberately ephemeral in the channel, not PostgreSQL.
create table public.studio_collaboration_operations (
  operation_id uuid primary key,
  studio_id uuid not null references public.studios(id),
  scenario_id uuid not null references public.cloud_scenarios(id),
  base_version_id uuid not null references public.cloud_scenario_versions(id),
  actor_profile_id uuid not null references public.users(id),
  client_sequence bigint not null check (client_sequence > 0),
  logical_clock bigint not null check (logical_clock > 0),
  operation_type text not null check (operation_type in ('block.upsert','block.delete')),
  block_id text not null check (length(block_id) between 1 and 128),
  mutation jsonb not null check (jsonb_typeof(mutation)='object' and pg_column_size(mutation) <= 65536),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  request_id uuid not null,
  cursor bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique(studio_id, actor_profile_id, client_sequence),
  unique(studio_id, operation_id),
  unique(studio_id, cursor)
);
create index studio_collaboration_operations_catchup_idx on public.studio_collaboration_operations(studio_id,cursor);
create index studio_collaboration_operations_block_idx on public.studio_collaboration_operations(studio_id,block_id,logical_clock desc,actor_profile_id desc,operation_id desc);

create table public.studio_collaboration_conflicts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id),
  scenario_id uuid not null references public.cloud_scenarios(id),
  operation_id uuid not null references public.studio_collaboration_operations(operation_id),
  winning_operation_id uuid references public.studio_collaboration_operations(operation_id),
  reason text not null check (reason in ('concurrent_same_block','stale_tombstone','cursor_too_old','base_version_unavailable','scenario_deleted')),
  request_id uuid not null,
  created_at timestamptz not null default now()
);
create index studio_collaboration_conflicts_history_idx on public.studio_collaboration_conflicts(studio_id,created_at desc);

create table public.studio_collaboration_conflict_resolutions (
  id uuid primary key default gen_random_uuid(),
  conflict_id uuid not null references public.studio_collaboration_conflicts(id),
  studio_id uuid not null references public.studios(id),
  resolved_by uuid not null references public.users(id),
  resolution text not null check (resolution in ('accept_remote','keep_local','create_copy')),
  recovery_scenario_id uuid references public.cloud_scenarios(id),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(conflict_id,resolved_by,resolution)
);
create index studio_collaboration_conflict_resolutions_idx on public.studio_collaboration_conflict_resolutions(studio_id,created_at desc);

create table public.studio_collaboration_snapshots (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique,
  studio_id uuid not null references public.studios(id),
  scenario_id uuid not null references public.cloud_scenarios(id),
  parent_version_id uuid not null references public.cloud_scenario_versions(id),
  parent_snapshot_id uuid references public.studio_collaboration_snapshots(id),
  through_cursor bigint not null check (through_cursor >= 0),
  storage_key text not null check (length(storage_key) between 1 and 512 and storage_key !~ '(^|/)\.\.(/|$)' and storage_key !~ '^/'),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.users(id),
  entitlement_snapshot_id uuid not null references public.entitlement_snapshots(id),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(studio_id,through_cursor,checksum)
);
create index studio_collaboration_snapshots_history_idx on public.studio_collaboration_snapshots(studio_id,created_at desc);

create table public.studio_collaboration_acknowledgements (
  studio_id uuid not null references public.studios(id),
  profile_id uuid not null references public.users(id),
  device_fingerprint_hash text not null check (device_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  cursor bigint not null check (cursor >= 0),
  updated_at timestamptz not null default now(),
  primary key(studio_id,profile_id,device_fingerprint_hash)
);

create table public.studio_collaboration_tickets (
  ticket_hash text primary key check (ticket_hash ~ '^[0-9a-f]{64}$'),
  studio_id uuid not null references public.studios(id),
  profile_id uuid not null references public.users(id),
  device_fingerprint_hash text not null check (device_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  origin_hash text not null check (origin_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  maximum_uses smallint not null default 1 check (maximum_uses=1),
  use_count smallint not null default 0 check (use_count between 0 and 1),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index studio_collaboration_tickets_expiry_idx on public.studio_collaboration_tickets(expires_at) where use_count=0 and revoked_at is null;

create table public.studio_collaboration_compactions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id),
  snapshot_id uuid not null references public.studio_collaboration_snapshots(id),
  from_cursor bigint not null check (from_cursor >= 0),
  through_cursor bigint not null check (through_cursor >= from_cursor),
  idempotency_hash text not null check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid not null,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique(studio_id,idempotency_hash)
);

alter table public.studio_collaboration_operations enable row level security;
alter table public.studio_collaboration_conflicts enable row level security;
alter table public.studio_collaboration_conflict_resolutions enable row level security;
alter table public.studio_collaboration_snapshots enable row level security;
alter table public.studio_collaboration_acknowledgements enable row level security;
alter table public.studio_collaboration_tickets enable row level security;
alter table public.studio_collaboration_compactions enable row level security;

create policy studio_collaboration_operations_select_member on public.studio_collaboration_operations for select to authenticated using(public.is_active_studio_member(studio_id,public.current_profile_id()));
create policy studio_collaboration_conflicts_select_member on public.studio_collaboration_conflicts for select to authenticated using(public.is_active_studio_member(studio_id,public.current_profile_id()));
create policy studio_collaboration_conflict_resolutions_select_member on public.studio_collaboration_conflict_resolutions for select to authenticated using(public.is_active_studio_member(studio_id,public.current_profile_id()));
create policy studio_collaboration_snapshots_select_member on public.studio_collaboration_snapshots for select to authenticated using(public.is_active_studio_member(studio_id,public.current_profile_id()));
create policy studio_collaboration_compactions_select_member on public.studio_collaboration_compactions for select to authenticated using(public.is_active_studio_member(studio_id,public.current_profile_id()));
revoke all on public.studio_collaboration_operations,public.studio_collaboration_conflicts,public.studio_collaboration_conflict_resolutions,public.studio_collaboration_snapshots,public.studio_collaboration_acknowledgements,public.studio_collaboration_tickets,public.studio_collaboration_compactions from anon,authenticated;
grant select on public.studio_collaboration_operations,public.studio_collaboration_conflicts,public.studio_collaboration_conflict_resolutions,public.studio_collaboration_snapshots,public.studio_collaboration_compactions to authenticated;

create trigger studio_collaboration_operations_immutable before update or delete on public.studio_collaboration_operations for each row execute function public.reject_immutable_history_mutation();
create trigger studio_collaboration_conflicts_immutable before update or delete on public.studio_collaboration_conflicts for each row execute function public.reject_immutable_history_mutation();
create trigger studio_collaboration_conflict_resolutions_immutable before update or delete on public.studio_collaboration_conflict_resolutions for each row execute function public.reject_immutable_history_mutation();
create trigger studio_collaboration_snapshots_immutable before update or delete on public.studio_collaboration_snapshots for each row execute function public.reject_immutable_history_mutation();
create trigger studio_collaboration_compactions_immutable before update or delete on public.studio_collaboration_compactions for each row execute function public.reject_immutable_history_mutation();

create or replace function public.consume_studio_collaboration_ticket(p_ticket_hash text,p_profile_id uuid,p_fingerprint_hash text,p_origin_hash text,p_studio_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_updated integer;
begin
  update public.studio_collaboration_tickets set use_count=use_count+1
  where ticket_hash=p_ticket_hash and profile_id=p_profile_id and studio_id=p_studio_id
    and device_fingerprint_hash=p_fingerprint_hash and origin_hash=p_origin_hash
    and use_count=0 and revoked_at is null and expires_at>now();
  get diagnostics v_updated=row_count;
  return v_updated=1;
end $$;

create or replace function public.append_studio_collaboration_operation(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,
  p_studio_id uuid,p_scenario_id uuid,p_base_version_id uuid,p_operation_id uuid,
  p_client_sequence bigint,p_logical_clock bigint,p_operation_type text,p_block_id text,
  p_mutation jsonb,p_checksum text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_auth jsonb; v_existing public.studio_collaboration_operations; v_current public.studio_collaboration_operations; v_inserted public.studio_collaboration_operations; v_conflict uuid;
begin
  v_auth:=public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner','editor']);
  if (select scenario_id from public.studios where id=p_studio_id)<>p_scenario_id then raise exception 'collaboration_scope_invalid'; end if;
  if not exists(select 1 from public.cloud_scenario_versions where id=p_base_version_id and scenario_id=p_scenario_id) then raise exception 'base_version_unavailable'; end if;
  if p_operation_type not in ('block.upsert','block.delete') or p_checksum !~ '^[0-9a-f]{64}$' or pg_column_size(p_mutation)>65536 then raise exception 'collaboration_operation_invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('collab:'||p_studio_id::text||':'||p_block_id,0));
  select * into v_existing from public.studio_collaboration_operations where studio_id=p_studio_id and operation_id=p_operation_id;
  if v_existing.operation_id is not null then
    if v_existing.checksum<>p_checksum then raise exception 'collaboration_idempotency_conflict'; end if;
    return jsonb_build_object('status','replayed','cursor',v_existing.cursor,'operationId',v_existing.operation_id);
  end if;
  select * into v_current from public.studio_collaboration_operations where studio_id=p_studio_id and block_id=p_block_id order by logical_clock desc,actor_profile_id desc,operation_id desc limit 1;
  insert into public.studio_collaboration_operations(operation_id,studio_id,scenario_id,base_version_id,actor_profile_id,client_sequence,logical_clock,operation_type,block_id,mutation,checksum,request_id)
    values(p_operation_id,p_studio_id,p_scenario_id,p_base_version_id,p_profile_id,p_client_sequence,p_logical_clock,p_operation_type,p_block_id,p_mutation,p_checksum,p_request_id) returning * into v_inserted;
  if v_current.operation_id is not null and v_current.actor_profile_id<>p_profile_id and v_current.base_version_id=p_base_version_id then
    insert into public.studio_collaboration_conflicts(studio_id,scenario_id,operation_id,winning_operation_id,reason,request_id)
      values(p_studio_id,p_scenario_id,p_operation_id,
        case when (p_logical_clock,p_profile_id,p_operation_id)>(v_current.logical_clock,v_current.actor_profile_id,v_current.operation_id) then p_operation_id else v_current.operation_id end,
        case when v_current.operation_type='block.delete' and (p_logical_clock,p_profile_id,p_operation_id)<(v_current.logical_clock,v_current.actor_profile_id,v_current.operation_id) then 'stale_tombstone' else 'concurrent_same_block' end,p_request_id)
      returning id into v_conflict;
  end if;
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id,metadata)
    values(p_profile_id,case when v_conflict is null then 'studio.operation_applied' else 'studio.operation_conflict' end,'studio',p_studio_id::text,p_request_id,jsonb_build_object('cursor',v_inserted.cursor,'operation_type',p_operation_type));
  return jsonb_build_object('status',case when v_conflict is null then 'applied' else 'conflict' end,'cursor',v_inserted.cursor,'operationId',p_operation_id,'conflictId',v_conflict);
end $$;

create or replace function public.ack_studio_collaboration_cursor(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_studio_id uuid,p_cursor bigint)
returns bigint language plpgsql security definer set search_path=public as $$
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,null);
  insert into public.studio_collaboration_acknowledgements(studio_id,profile_id,device_fingerprint_hash,cursor) values(p_studio_id,p_profile_id,p_fingerprint_hash,p_cursor)
  on conflict(studio_id,profile_id,device_fingerprint_hash) do update set cursor=greatest(public.studio_collaboration_acknowledgements.cursor,excluded.cursor),updated_at=now();
  return p_cursor;
end $$;

create or replace function public.commit_studio_collaboration_snapshot(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_studio_id uuid,
  p_parent_version_id uuid,p_parent_snapshot_id uuid,p_through_cursor bigint,p_storage_key text,p_checksum text,
  p_version_id uuid,p_idempotency_hash text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_auth jsonb; v_existing public.studio_collaboration_compactions; v_snapshot public.studio_collaboration_snapshots;
begin
  v_auth:=public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner','editor']);
  perform pg_advisory_xact_lock(hashtextextended('collab-compact:'||p_studio_id::text,0));
  select * into v_existing from public.studio_collaboration_compactions where studio_id=p_studio_id and idempotency_hash=p_idempotency_hash;
  if v_existing.id is not null then select * into v_snapshot from public.studio_collaboration_snapshots where id=v_existing.snapshot_id; return jsonb_build_object('snapshotId',v_snapshot.id,'versionId',v_snapshot.version_id,'cursor',v_snapshot.through_cursor,'checksum',v_snapshot.checksum,'replayed',true); end if;
  if p_parent_snapshot_id is not null and not exists(select 1 from public.studio_collaboration_snapshots where id=p_parent_snapshot_id and studio_id=p_studio_id) then raise exception 'snapshot_parent_invalid'; end if;
  insert into public.studio_collaboration_snapshots(version_id,studio_id,scenario_id,parent_version_id,parent_snapshot_id,through_cursor,storage_key,checksum,created_by,entitlement_snapshot_id,request_id)
    values(p_version_id,p_studio_id,(select scenario_id from public.studios where id=p_studio_id),p_parent_version_id,p_parent_snapshot_id,p_through_cursor,p_storage_key,p_checksum,p_profile_id,(v_auth->>'snapshotId')::uuid,p_request_id) returning * into v_snapshot;
  insert into public.studio_collaboration_compactions(studio_id,snapshot_id,from_cursor,through_cursor,idempotency_hash,request_id,created_by)
    values(p_studio_id,v_snapshot.id,coalesce((select max(through_cursor)+1 from public.studio_collaboration_snapshots where studio_id=p_studio_id and id<>v_snapshot.id),0),p_through_cursor,p_idempotency_hash,p_request_id,p_profile_id);
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id,metadata) values(p_profile_id,'studio.compaction','studio',p_studio_id::text,p_request_id,jsonb_build_object('snapshot_id',v_snapshot.id,'through_cursor',p_through_cursor));
  return jsonb_build_object('snapshotId',v_snapshot.id,'versionId',v_snapshot.version_id,'cursor',v_snapshot.through_cursor,'checksum',v_snapshot.checksum,'replayed',false);
end $$;

revoke all on function public.consume_studio_collaboration_ticket(text,uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.append_studio_collaboration_operation(uuid,text,text,text,uuid,uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.ack_studio_collaboration_cursor(uuid,text,text,text,uuid,bigint) from public,anon,authenticated;
revoke all on function public.commit_studio_collaboration_snapshot(uuid,text,text,text,uuid,uuid,uuid,bigint,text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.consume_studio_collaboration_ticket(text,uuid,text,text,uuid) to service_role;
grant execute on function public.append_studio_collaboration_operation(uuid,text,text,text,uuid,uuid,uuid,uuid,bigint,bigint,text,text,jsonb,text,uuid) to service_role;
grant execute on function public.ack_studio_collaboration_cursor(uuid,text,text,text,uuid,bigint) to service_role;
grant execute on function public.commit_studio_collaboration_snapshot(uuid,text,text,text,uuid,uuid,uuid,bigint,text,text,uuid,text,uuid) to service_role;
