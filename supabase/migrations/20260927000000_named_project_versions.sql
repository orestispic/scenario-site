-- Named versions use independent existing scenario/channel identities. The visible
-- project remains the parent; inherited access is checked again on every operation.
create table public.project_branches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cloud_scenarios(id),
  scenario_id uuid not null unique references public.cloud_scenarios(id),
  name text not null check(length(trim(name)) between 1 and 80),
  revision bigint not null default 1 check(revision>0),
  source_branch_id uuid references public.project_branches(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index project_branch_live_name on public.project_branches(project_id,lower(trim(name))) where deleted_at is null;
create index project_branch_project on public.project_branches(project_id,created_at,id);
create table public.project_branch_commands (
  profile_id uuid not null references public.users(id), operation_id uuid not null,
  project_id uuid not null references public.cloud_scenarios(id), fingerprint text not null,
  response jsonb not null, created_at timestamptz not null default now(), primary key(profile_id,operation_id)
);
alter table public.project_branches enable row level security;
alter table public.project_branch_commands enable row level security;
revoke all on public.project_branches,public.project_branch_commands from public,anon,authenticated;
create trigger branch_commands_immutable before update or delete on public.project_branch_commands for each row execute function public.reject_immutable_history_mutation();

-- Parent membership is canonical, never supplied by the client. A shared lock
-- serializes branch reads/writes with a parent deletion or membership change.
create function public.guard_project_branch(p_profile_id uuid,p_scenario_id uuid,p_write boolean default false)
returns void language plpgsql security definer set search_path=public as $$
declare b public.project_branches; p public.cloud_scenarios; r text;
begin
 select * into b from public.project_branches where scenario_id=p_scenario_id;
 if not found then return; end if;
 perform 1 from public.studios where scenario_id=b.project_id for share;
 select * into p from public.cloud_scenarios where id=b.project_id for share;
 select * into b from public.project_branches where id=b.id for share;
 if p.deleted_at is not null or b.deleted_at is not null then raise exception 'studio_not_found';end if;
 r:=case when p.owner_id=p_profile_id then 'owner' else (select role from public.scenario_collaborators where scenario_id=p.id and user_id=p_profile_id and status='active') end;
 if r is null or (p_write and r='viewer') then raise exception 'studio_not_found';end if;
end $$;

alter function public.authorize_studio_operation(uuid,text,text,text,uuid,text[]) rename to authorize_studio_operation_before_branches;
create function public.authorize_studio_operation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_studio_id uuid default null,p_roles text[] default null)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if p_studio_id is not null then
  perform public.guard_project_branch(p_profile_id,(select scenario_id from public.studios where id=p_studio_id),p_roles is not null and not('viewer'=any(p_roles)));
 end if;
 return public.authorize_studio_operation_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,p_roles);
end $$;

alter function public.guard_cloud_project_write_v9(uuid,uuid,boolean) rename to guard_cloud_project_write_before_branches;
create function public.guard_cloud_project_write_v9(p_profile_id uuid,p_scenario_id uuid,p_restore boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
 perform public.guard_project_branch(p_profile_id,p_scenario_id,true);
 perform public.guard_cloud_project_write_before_branches(p_profile_id,p_scenario_id,p_restore);
end $$;

alter function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) rename to get_cloud_storage_key_before_branches;
create function public.get_cloud_storage_key(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid)
returns text language plpgsql security definer set search_path=public as $$
begin
 perform public.guard_project_branch(p_profile_id,p_scenario_id,false);
 return public.get_cloud_storage_key_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id,p_version_id);
end $$;

-- Acquire the parent before the child studio: all metadata, membership and
-- branch transactions use this lock order to avoid opposite-order deadlocks.
alter function public.project_metadata_v10(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid) rename to project_metadata_before_branches;
create function public.project_metadata_v10(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_request_id uuid,
 p_seed_version_id uuid,p_seed jsonb,p_operation_id uuid,p_changes jsonb,p_fingerprint text,p_snapshot_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform public.guard_project_branch(p_profile_id,p_scenario_id,p_operation_id is not null or p_snapshot_id is not null);
 return public.project_metadata_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id,p_request_id,p_seed_version_id,p_seed,p_operation_id,p_changes,p_fingerprint,p_snapshot_id);
end $$;
revoke all on function public.project_metadata_before_branches(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.project_metadata_v10(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.project_metadata_v10(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid) to service_role;

-- Copy parent grants in the same transaction. Private versions do not acquire
-- collaborators; enabling sharing later creates the independent channels too.
create function public.refresh_branch_access(p_project_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare parent_studio public.studios; b public.project_branches; child_studio uuid;
begin
 select * into parent_studio from public.studios where scenario_id=p_project_id;
 for b in select * from public.project_branches where project_id=p_project_id and scenario_id<>project_id order by scenario_id loop
  insert into public.scenario_collaborators(scenario_id,user_id,role,status,invited_by,updated_at)
   select b.scenario_id,user_id,role,status,invited_by,updated_at from public.scenario_collaborators where scenario_id=p_project_id
   on conflict(scenario_id,user_id) do update set role=excluded.role,status=excluded.status,updated_at=excluded.updated_at;
  update public.scenario_collaborators c set status='revoked',updated_at=now() where c.scenario_id=b.scenario_id
   and not exists(select 1 from public.scenario_collaborators p where p.scenario_id=p_project_id and p.user_id=c.user_id and p.status='active');
  if parent_studio.id is not null then
   insert into public.studios(scenario_id,name,created_by,project_base_version_id)
    select b.scenario_id,left(b.name,120),owner_id,current_version_id from public.cloud_scenarios where id=b.scenario_id
    on conflict(scenario_id) do nothing;
   select id into child_studio from public.studios where scenario_id=b.scenario_id;
   insert into public.studio_memberships(studio_id,profile_id,display_name,role,status,revision,updated_at)
    select child_studio,profile_id,display_name,role,status,revision,updated_at from public.studio_memberships where studio_id=parent_studio.id
    on conflict(studio_id,profile_id) do update set display_name=excluded.display_name,role=excluded.role,status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at;
   update public.studio_memberships m set status='revoked',updated_at=now() where m.studio_id=child_studio
    and not exists(select 1 from public.studio_memberships p where p.studio_id=parent_studio.id and p.profile_id=m.profile_id and p.status='active');
  end if;
 end loop;
end $$;
create function public.propagate_branch_access() returns trigger language plpgsql security definer set search_path=public as $$
declare target uuid;
begin
 if pg_trigger_depth()>1 then return null;end if;
 if tg_table_name='studio_memberships' then select scenario_id into target from public.studios where id=coalesce(new.studio_id,old.studio_id);
 else target:=coalesce(new.scenario_id,old.scenario_id);end if;
 if not exists(select 1 from public.project_branches where scenario_id=target and scenario_id<>project_id) then perform public.refresh_branch_access(target);end if;
 return null;
end $$;
create trigger branch_access_members after insert or update or delete on public.studio_memberships for each row execute function public.propagate_branch_access();
create trigger branch_access_collaborators after insert or update or delete on public.scenario_collaborators for each row execute function public.propagate_branch_access();

-- Ordinary sharing/ownership APIs must never give a version separate permissions.
create function public.protect_branch_invariants() returns trigger language plpgsql security definer set search_path=public as $$
declare parent uuid; parent_studio uuid;
begin
 if tg_table_name='studio_invitations' then
  if exists(select 1 from public.project_branches b join public.studios s on s.scenario_id=b.scenario_id where s.id=new.studio_id and b.scenario_id<>b.project_id) then raise exception 'branch_access_inherited';end if;
 elsif tg_table_name='cloud_scenarios' then
  if exists(select 1 from public.project_branches where scenario_id=new.id and scenario_id<>project_id)
   and (new.owner_id is distinct from old.owner_id or new.deleted_at is distinct from old.deleted_at) then raise exception 'branch_access_inherited';end if;
 elsif tg_table_name='studio_memberships' then
  select b.project_id into parent from public.project_branches b join public.studios s on s.scenario_id=b.scenario_id where s.id=coalesce(new.studio_id,old.studio_id) and b.scenario_id<>b.project_id;
  if parent is not null and pg_trigger_depth()=1 then
   select id into parent_studio from public.studios where scenario_id=parent;
   if tg_op='DELETE' or not exists(select 1 from public.studio_memberships p where p.studio_id=parent_studio and p.profile_id=new.profile_id and p.role=new.role and p.status=new.status and p.revision=new.revision) then raise exception 'branch_access_inherited';end if;
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;
 return new;
end $$;
create trigger branch_invitation_guard before insert on public.studio_invitations for each row execute function public.protect_branch_invariants();
create trigger branch_scenario_guard before update on public.cloud_scenarios for each row execute function public.protect_branch_invariants();
create trigger branch_membership_guard before insert or update or delete on public.studio_memberships for each row execute function public.protect_branch_invariants();

-- Hide backing scenarios from the public projects view without changing the
-- repository's internal lookups used by metadata and snapshot reconstruction.
alter function public.list_cloud_projects_v9(uuid,text,text,text,text,text) rename to list_cloud_projects_before_branches;
create function public.list_cloud_projects_v9(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 result:=public.list_cloud_projects_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_email_hash,p_display_name);
 return jsonb_set(result,'{projects}',coalesce((select jsonb_agg(v) from jsonb_array_elements(result->'projects') v where not exists(select 1 from public.project_branches b where b.scenario_id=(v->>'id')::uuid and b.scenario_id<>b.project_id)),'[]'::jsonb));
end $$;

create function public.project_branch_json(b public.project_branches,p_profile_id uuid) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('id',b.id,'projectId',b.project_id,'name',b.name,'revision',b.revision,'createdAt',b.created_at,'deletedAt',b.deleted_at,'sourceVersionId',b.source_branch_id,
  'project',public.cloud_scenario_json(c,p_profile_id)||jsonb_build_object('sharing',case when counts.members>1 then 'shared' else 'private' end,'memberCount',counts.members,
   'realtimeStudioId',case when access.allowed then s.id else null end,'realtimeBaseVersionId',case when access.allowed and s.id is not null then coalesce(s.project_base_version_id,(select id from public.cloud_scenario_versions where scenario_id=c.id and parent_version_id is null order by version_number limit 1)) else null end,'canShare',false))
 from public.cloud_scenarios c left join public.studios s on s.scenario_id=c.id
 cross join lateral (select 1+count(*)::int members from public.scenario_collaborators sc where sc.scenario_id=c.id and sc.user_id<>c.owner_id and sc.status='active') counts
 cross join lateral (select exists(select 1 from public.current_entitlement_snapshot(p_profile_id) ent,jsonb_array_elements(coalesce(ent.payload->'entitlements','[]'::jsonb)) e where e->>'code'='studio_collaboration' and coalesce((e->>'enabled')::boolean,false)) and exists(select 1 from public.studio_memberships m where m.studio_id=s.id and m.profile_id=p_profile_id and m.status='active') allowed) access
 where c.id=b.scenario_id
$$;

-- One transaction for CAS, deletion of the last version, ACL and idempotency.
-- The artifact is supplied ONLY by the Worker after reading/verifying Storage.
create function public.project_branches_v14(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_project_id uuid,p_command jsonb,p_fingerprint text,p_artifact jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.cloud_scenarios; b public.project_branches; src public.project_branches; st public.studios; source_version public.cloud_scenario_versions;
 authz jsonb; role_name text; op text:=p_command->>'action'; operation uuid:=nullif(p_command->>'operationId','')::uuid;
 old public.project_branch_commands; result jsonb; stamp jsonb; entries jsonb; child uuid; snapshot uuid; new_name text;
begin
 authz:=public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
 -- Same lock order as membership administration / live metadata.
 perform 1 from public.studios where scenario_id=p_project_id for update;
 select * into p from public.cloud_scenarios where id=p_project_id for update;
 if p.id is null or p.deleted_at is not null or exists(select 1 from public.project_branches where scenario_id=p.id and project_id<>p.id) then raise exception 'project_not_found';end if;
 role_name:=case when p.owner_id=p_profile_id then 'owner' else (select role from public.scenario_collaborators where scenario_id=p.id and user_id=p_profile_id and status='active') end;
 if role_name is null then raise exception 'project_not_found';end if;
 if op<>'list' and role_name='viewer' then raise exception 'branch_write_forbidden';end if;
 insert into public.project_branches(id,project_id,scenario_id,name) values(p.id,p.id,p.id,'Version 1') on conflict(scenario_id) do nothing;
 if op='list' then return jsonb_build_object('versions',(select jsonb_agg(public.project_branch_json(v,p_profile_id) order by v.created_at,v.id) from public.project_branches v where v.project_id=p.id));end if;
 if operation is null or p_fingerprint is null or p_fingerprint!~'^[0-9a-f]{64}$' then raise exception 'branch_invalid';end if;
 perform pg_advisory_xact_lock(hashtextextended('branch:'||p_profile_id::text||':'||operation::text,0));
 select * into old from public.project_branch_commands where profile_id=p_profile_id and operation_id=operation;
 if found then
  if old.project_id<>p.id or old.fingerprint<>p_fingerprint then raise exception 'branch_idempotency_conflict';end if;
  return old.response||jsonb_build_object('replayed',true);
 end if;
 if op in ('duplicate','blank') then
  if (select count(*) from public.project_branches where project_id=p.id)>=1000 then raise exception 'branch_limit';end if;
  new_name:=trim(p_command->>'name');
  if length(new_name) not between 1 and 80 or new_name is null then raise exception 'branch_invalid';end if;
  if exists(select 1 from public.project_branches where project_id=p.id and deleted_at is null and lower(trim(name))=lower(new_name)) then raise exception 'branch_name_conflict';end if;
  if op='duplicate' then
   select * into src from public.project_branches where id=(p_command->>'sourceVersionId')::uuid and project_id=p.id and deleted_at is null for share;
   if src.id is null then raise exception 'branch_not_found';end if;
   select * into st from public.studios where scenario_id=src.scenario_id for update;
   select * into source_version from public.cloud_scenario_versions where id=case when st.id is null then (select current_version_id from public.cloud_scenarios where id=src.scenario_id) else coalesce(st.project_base_version_id,(select id from public.cloud_scenario_versions where scenario_id=src.scenario_id and parent_version_id is null order by version_number limit 1)) end;
   if source_version.id is null then raise exception 'branch_not_found';end if;
   stamp:=jsonb_build_object('head',(select current_version_id from public.cloud_scenarios where id=src.scenario_id),'cursor',coalesce((select max(cursor) from public.studio_collaboration_operations where studio_id=st.id),0),'metadata',coalesce((select revision from public.project_metadata_state where scenario_id=src.scenario_id),0));
   if p_artifact is null then
    select coalesce(jsonb_agg(jsonb_build_object('blockId',o.block_id,'operationId',o.operation_id,'actorId',o.actor_profile_id,'logicalClock',o.logical_clock,'tombstone',o.operation_type='block.delete','mutation',o.mutation)),'[]'::jsonb) into entries from
     (select distinct on(block_id) * from public.studio_collaboration_operations where studio_id=st.id and base_version_id=source_version.id order by block_id,logical_clock desc,actor_profile_id desc,operation_id desc) o;
    return jsonb_build_object('source',jsonb_build_object('storageKey',source_version.storage_key,'checksum',source_version.content_checksum,'sizeBytes',source_version.size_bytes,'entries',entries,'registers',(select registers from public.project_metadata_state where scenario_id=src.scenario_id),'stamp',stamp));
   end if;
   if p_artifact->'stamp' is distinct from stamp then raise exception 'branch_source_changed';end if;
  elsif p_artifact is null then return jsonb_build_object('source',null);end if;
  if not coalesce(p_artifact->>'checksum' ~ '^[0-9a-f]{64}$' and (p_artifact->>'sizeBytes')::bigint between 2 and 4194304 and p_artifact->>'storageKey' ~ ('^branches/'||p.id::text||'/[0-9a-f-]+\.scenario$'),false) then raise exception 'branch_invalid';end if;
  child:=gen_random_uuid();snapshot:=gen_random_uuid();
  insert into public.cloud_scenarios(id,owner_id,title) values(child,p.owner_id,p.title);
  insert into public.cloud_scenario_versions(id,scenario_id,parent_version_id,created_by,version_number,kind,content_checksum,storage_key,size_bytes,content_type,format,origin,entitlement_snapshot_id,request_id)
   values(snapshot,child,null,p_profile_id,1,'revision',p_artifact->>'checksum',p_artifact->>'storageKey',(p_artifact->>'sizeBytes')::bigint,'application/vnd.scenario+json','scenario-v1','save',(authz->>'snapshotId')::uuid,p_request_id);
  update public.cloud_scenarios set current_version_id=snapshot where id=child;
  insert into public.project_branches(project_id,scenario_id,name,source_branch_id) values(p.id,child,new_name,src.id) returning * into b;
  perform public.refresh_branch_access(p.id);
 else
  select * into b from public.project_branches where id=(p_command->>'versionId')::uuid and project_id=p.id for update;
  if b.id is null then raise exception 'branch_not_found';end if;
  if (p_command->>'expectedRevision')::bigint is distinct from b.revision then raise exception 'branch_revision_conflict';end if;
  if op='rename' and b.deleted_at is null then
   new_name:=trim(p_command->>'name');
   if new_name is null or length(new_name) not between 1 and 80 then raise exception 'branch_invalid';end if;
   update public.project_branches set name=new_name,revision=revision+1 where id=b.id returning * into b;
  elsif op='delete' and b.deleted_at is null then
   if role_name<>'owner' then raise exception 'branch_owner_required';end if;
   if (select count(*) from public.project_branches where project_id=p.id and deleted_at is null)<2 then raise exception 'branch_last_version';end if;
   update public.project_branches set deleted_at=now(),revision=revision+1 where id=b.id returning * into b;
  elsif op='restore' and b.deleted_at is not null then
   if role_name<>'owner' then raise exception 'branch_owner_required';end if;
   if exists(select 1 from public.project_branches where project_id=p.id and deleted_at is null and lower(trim(name))=lower(trim(b.name))) then raise exception 'branch_name_conflict';end if;
   update public.project_branches set deleted_at=null,revision=revision+1 where id=b.id returning * into b;
  else raise exception 'branch_revision_conflict';end if;
 end if;
 result:=jsonb_build_object('version',public.project_branch_json(b,p_profile_id),'replayed',false);
 insert into public.project_branch_commands(profile_id,operation_id,project_id,fingerprint,response) values(p_profile_id,operation,p.id,p_fingerprint,result);
 insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id,metadata) values(p_profile_id,'project.version_'||op,'cloud_scenario',p.id::text,p_request_id,jsonb_build_object('version_id',b.id,'revision',b.revision));
 return result;
exception when unique_violation then raise exception 'branch_name_conflict';
end $$;

revoke all on function public.authorize_studio_operation_before_branches(uuid,text,text,text,uuid,text[]),public.guard_cloud_project_write_before_branches(uuid,uuid,boolean),public.get_cloud_storage_key_before_branches(uuid,text,text,text,uuid,uuid),public.list_cloud_projects_before_branches(uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.guard_project_branch(uuid,uuid,boolean),public.refresh_branch_access(uuid),public.propagate_branch_access(),public.protect_branch_invariants(),public.project_branch_json(public.project_branches,uuid) from public,anon,authenticated,service_role;
revoke all on function public.authorize_studio_operation(uuid,text,text,text,uuid,text[]),public.guard_cloud_project_write_v9(uuid,uuid,boolean),public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid),public.list_cloud_projects_v9(uuid,text,text,text,text,text),public.project_branches_v14(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid),public.list_cloud_projects_v9(uuid,text,text,text,text,text),public.project_branches_v14(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid) to service_role;
