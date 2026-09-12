-- v10 complements the immutable v8 text stream; no historical migration changes.
create table public.project_metadata_state (
 scenario_id uuid primary key references public.cloud_scenarios(id), base_version_id uuid not null references public.cloud_scenario_versions(id),
 revision bigint not null default 0 check(revision>=0), registers jsonb not null check(jsonb_typeof(registers)='object' and pg_column_size(registers)<=524288)
);
create table public.project_metadata_operations (
 actor_id uuid not null references public.profiles(id),operation_id uuid not null,scenario_id uuid not null references public.cloud_scenarios(id),
 fingerprint text not null check(fingerprint~'^[0-9a-f]{64}$'),changes jsonb not null check(jsonb_typeof(changes)='array' and pg_column_size(changes)<=131072),
 response jsonb not null,request_id uuid not null,created_at timestamptz not null default now(),primary key(actor_id,operation_id)
);
create index project_metadata_history_idx on public.project_metadata_operations(scenario_id,created_at,operation_id);
create table public.project_metadata_snapshots (
 snapshot_id uuid primary key,scenario_id uuid not null references public.cloud_scenarios(id),state jsonb not null,
 request_id uuid not null,created_at timestamptz not null default now()
);
alter table public.project_metadata_state enable row level security;
alter table public.project_metadata_operations enable row level security;
alter table public.project_metadata_snapshots enable row level security;
-- No direct client policy: authorized read/write is through the Worker only.
revoke all on public.project_metadata_state,public.project_metadata_operations,public.project_metadata_snapshots from anon,authenticated;
create trigger project_metadata_operations_immutable before update or delete on public.project_metadata_operations for each row execute function public.reject_immutable_history_mutation();
create trigger project_metadata_snapshots_immutable before update or delete on public.project_metadata_snapshots for each row execute function public.reject_immutable_history_mutation();

create function public.valid_project_metadata_registers_v10(p_value jsonb) returns boolean language plpgsql immutable set search_path=public as $$
declare item record; v jsonb; k text; a jsonb; m jsonb;
begin
 if jsonb_typeof(p_value) is distinct from 'object' or octet_length(p_value::text)>524288 then return false;end if;
 if (select count(*) from jsonb_object_keys(p_value))>512 then return false;end if;
 foreach k in array array['title','cover.hidden','cover.projectName','cover.screenwriter','cover.director','cover.production','cover.duration','cover.version','cover.date','cover.rights','cover.contactName','cover.contactEmail','cover.contactPhone','cover.contactWebsite'] loop if not(p_value?k) then return false;end if;end loop;
 for item in select * from jsonb_each(p_value) loop
  if jsonb_typeof(item.value) is distinct from 'object' or jsonb_typeof(item.value->'revision') is distinct from 'number' or (item.value->>'revision')!~'^[0-9]+$' or not(item.value?'value') or (item.value->>'revision')::numeric>9007199254740991 or (select count(*) from jsonb_object_keys(item.value))<>2 then return false;end if;
  v:=item.value->'value';
  if item.key='title' then if jsonb_typeof(v) is distinct from 'string' or length(v#>>'{}') not between 1 and 200 or btrim(v#>>'{}')='' then return false;end if;
  elsif item.key='cover.hidden' then if jsonb_typeof(v) is distinct from 'boolean' then return false;end if;
  elsif item.key=any(array['cover.projectName','cover.screenwriter','cover.director','cover.production','cover.duration','cover.version','cover.date','cover.rights','cover.contactName','cover.contactEmail','cover.contactPhone','cover.contactWebsite']) then if jsonb_typeof(v)<>'string' or length(v#>>'{}')>4096 then return false;end if;
  elsif item.key~'^comment:[a-zA-Z0-9_-]{1,128}$' then
   if v<>'null'::jsonb then
    if jsonb_typeof(v) is distinct from 'object' or v->>'id' is distinct from substring(item.key from 9) or coalesce(v->>'status','') not in ('open','resolved') or jsonb_typeof(v->'anchor') is distinct from 'object' or jsonb_typeof(v->'messages') is distinct from 'array' or octet_length(v::text)>65536 then return false;end if;
    if not(v?&array['id','status','createdAt','resolvedAt','anchor','messages']) or (select count(*) from jsonb_object_keys(v))<>6 or jsonb_typeof(v->'createdAt') is distinct from 'string' then return false;end if;
    perform (v->>'createdAt')::timestamptz;
    if v->'resolvedAt'<>'null'::jsonb then perform (v->>'resolvedAt')::timestamptz;end if;
    a:=v->'anchor';
    if not(a?&array['sceneId','blockId','startOffset','endOffset','originalText','lost']) or (select count(*) from jsonb_object_keys(a))<>6 or jsonb_typeof(a->'sceneId') is distinct from 'string' or jsonb_typeof(a->'blockId') is distinct from 'string' or a->>'sceneId'!~'^[a-zA-Z0-9_-]{1,128}$' or a->>'blockId'!~'^[a-zA-Z0-9_-]{1,128}$' or jsonb_typeof(a->'lost') is distinct from 'boolean' or jsonb_typeof(a->'originalText') is distinct from 'string' or length(a->>'originalText')>16384 then return false;end if;
    if jsonb_typeof(a->'startOffset') is distinct from 'number' or jsonb_typeof(a->'endOffset') is distinct from 'number' or a->>'startOffset'!~'^[0-9]+$' or a->>'endOffset'!~'^[0-9]+$' or (a->>'endOffset')::numeric>4194304 or (a->>'endOffset')::numeric<(a->>'startOffset')::numeric or (a->>'lost'='false' and a->>'startOffset'=a->>'endOffset') then return false;end if;
    if jsonb_array_length(v->'messages') not between 1 and 100 or (select count(distinct value->>'id') from jsonb_array_elements(v->'messages'))<>jsonb_array_length(v->'messages') then return false;end if;
    for m in select * from jsonb_array_elements(v->'messages') loop
     if jsonb_typeof(m) is distinct from 'object' or not(m?&array['id','text','createdAt','editedAt']) or (select count(*) from jsonb_object_keys(m))<>4 or jsonb_typeof(m->'id') is distinct from 'string' or m->>'id'!~'^[a-zA-Z0-9_-]{1,128}$' or jsonb_typeof(m->'text') is distinct from 'string' or length(m->>'text')>16384 or jsonb_typeof(m->'createdAt') is distinct from 'string' then return false;end if;
     perform (m->>'createdAt')::timestamptz;
     if m->'editedAt'<>'null'::jsonb then perform (m->>'editedAt')::timestamptz;end if;
    end loop;
   end if;
  else return false;end if;
 end loop;return true;
exception when others then return false;
end $$;
alter table public.project_metadata_state add constraint metadata_registers_valid check(public.valid_project_metadata_registers_v10(registers));

create function public.project_metadata_v10(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_request_id uuid,
 p_seed_version_id uuid,p_seed jsonb,p_operation_id uuid,p_changes jsonb,p_fingerprint text,p_snapshot_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_studio uuid;v_row public.project_metadata_state;v_old public.project_metadata_operations;v_result jsonb;v_state jsonb;v_changes jsonb;v_change jsonb;v_key text;v_conflicts jsonb:='[]';v_rev bigint;v_snapshot public.project_metadata_snapshots;
begin
 select id into v_studio from public.studios where scenario_id=p_scenario_id for update;
 if v_studio is null then raise exception 'project_not_found';end if;
 perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,v_studio,case when p_operation_id is not null or p_snapshot_id is not null then array['owner','editor'] else null end);
 if p_operation_id is not null then perform pg_advisory_xact_lock(hashtextextended('metadata:'||p_profile_id::text||':'||p_operation_id::text,0));end if;
 select * into v_row from public.project_metadata_state where scenario_id=p_scenario_id for update;
 if v_row.scenario_id is null and p_seed is not null then
  if not exists(select 1 from public.cloud_scenarios where id=p_scenario_id and current_version_id=p_seed_version_id and deleted_at is null) then raise exception 'metadata_seed_stale';end if;
  if not public.valid_project_metadata_registers_v10(p_seed) or exists(select 1 from jsonb_each(p_seed) where value->>'revision'<>'0') then raise exception 'project_metadata_invalid';end if;
  insert into public.project_metadata_state values(p_scenario_id,p_seed_version_id,0,p_seed) returning * into v_row;
  insert into public.project_metadata_snapshots values(gen_random_uuid(),p_scenario_id,jsonb_build_object('scenarioId',p_scenario_id,'baseVersionId',v_row.base_version_id,'revision',0,'registers',v_row.registers),p_request_id,now());
 end if;
 if v_row.scenario_id is null then return jsonb_build_object('state',null,'status','current','conflictKeys','[]'::jsonb,'replayed',false);end if;
 if p_operation_id is not null then
  if p_fingerprint is null or p_fingerprint!~'^[0-9a-f]{64}$' or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 32 or octet_length(p_changes::text)>131072 then raise exception 'project_metadata_invalid';end if;
  select * into v_old from public.project_metadata_operations where actor_id=p_profile_id and operation_id=p_operation_id;
  if v_old.actor_id is not null then if v_old.fingerprint<>p_fingerprint or v_old.scenario_id<>p_scenario_id then raise exception 'metadata_idempotency_conflict';end if;return v_old.response||jsonb_build_object('replayed',true);end if;
  if (select count(distinct value->>'key') from jsonb_array_elements(p_changes))<>jsonb_array_length(p_changes) then raise exception 'project_metadata_invalid';end if;
  v_changes:=v_row.registers;v_rev:=v_row.revision+1;
  for v_change in select * from jsonb_array_elements(p_changes) loop
   v_key:=v_change->>'key';
   if v_key is null or jsonb_typeof(v_change->'expectedRevision') is distinct from 'number' or coalesce(v_change->>'expectedRevision','')!~'^[0-9]+$' or not(v_change?'value') then raise exception 'project_metadata_invalid';end if;
   if coalesce((v_row.registers->v_key->>'revision')::bigint,0)<>(v_change->>'expectedRevision')::bigint then v_conflicts:=v_conflicts||to_jsonb(v_key);end if;
   v_changes:=jsonb_set(v_changes,array[v_key],jsonb_build_object('revision',v_rev,'value',v_change->'value'));
  end loop;
  if not public.valid_project_metadata_registers_v10(v_changes) then raise exception 'project_metadata_invalid';end if;
  if jsonb_array_length(v_conflicts)=0 then
   update public.project_metadata_state set revision=v_rev,registers=v_changes where scenario_id=p_scenario_id returning * into v_row;
   update public.cloud_scenarios set title=v_changes->'title'->>'value',updated_at=now() where id=p_scenario_id;
  end if;
 end if;
 v_state:=jsonb_build_object('scenarioId',p_scenario_id,'baseVersionId',v_row.base_version_id,'revision',v_row.revision,'registers',v_row.registers);
 if p_snapshot_id is not null then
  insert into public.project_metadata_snapshots values(p_snapshot_id,p_scenario_id,v_state,p_request_id,now()) on conflict(snapshot_id) do nothing;
  select * into v_snapshot from public.project_metadata_snapshots where snapshot_id=p_snapshot_id;
  if v_snapshot.scenario_id<>p_scenario_id then raise exception 'metadata_idempotency_conflict';end if;v_state:=v_snapshot.state;
 end if;
 v_result:=jsonb_build_object('state',v_state,'status',case when p_operation_id is null then 'current' when jsonb_array_length(v_conflicts)>0 then 'conflict' else 'applied' end,'conflictKeys',v_conflicts,'replayed',false);
 if p_operation_id is not null then
  insert into public.project_metadata_operations values(p_profile_id,p_operation_id,p_scenario_id,p_fingerprint,p_changes,v_result,p_request_id,now());
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id,metadata) values(p_profile_id,case when jsonb_array_length(v_conflicts)>0 then 'metadata.conflict' else 'metadata.updated' end,'cloud_scenario',p_scenario_id::text,p_request_id,jsonb_build_object('revision',v_row.revision,'changed_fields',jsonb_array_length(p_changes)));
 end if;return v_result;
end $$;
revoke all on function public.valid_project_metadata_registers_v10(jsonb) from public,anon,authenticated;
revoke all on function public.project_metadata_v10(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.project_metadata_v10(uuid,text,text,text,uuid,uuid,uuid,jsonb,uuid,jsonb,text,uuid) to service_role;
