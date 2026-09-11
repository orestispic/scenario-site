-- Phase 7: append-only Studio collaboration foundations. No previous migration is modified.
create table public.studios (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null unique references public.cloud_scenarios(id),
  name text not null check (char_length(name) between 1 and 120),
  revision bigint not null default 1 check (revision > 0),
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.studio_memberships (
  studio_id uuid not null references public.studios(id),
  profile_id uuid not null references public.users(id),
  display_name text not null check (char_length(display_name) between 1 and 120),
  role text not null check (role in ('owner','editor','viewer')),
  status text not null check (status in ('active','revoked')),
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (studio_id, profile_id)
);
create index studio_memberships_profile_active_idx on public.studio_memberships(profile_id, studio_id) where status='active';

create table public.studio_membership_revisions (
  id bigint generated always as identity primary key,
  studio_id uuid not null references public.studios(id),
  profile_id uuid not null references public.users(id),
  display_name text not null,
  role text not null check (role in ('owner','editor','viewer')),
  status text not null check (status in ('active','revoked')),
  revision bigint not null check (revision > 0),
  changed_by uuid not null references public.users(id),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(studio_id, profile_id, revision),
  unique(request_id, studio_id, profile_id)
);

create table public.studio_invitations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id),
  recipient_email_hash text not null check (recipient_email_hash ~ '^[0-9a-f]{64}$'),
  recipient_masked text not null check (char_length(recipient_masked) between 3 and 254),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  role text not null check (role in ('editor','viewer')),
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired','revoked')),
  expires_at timestamptz not null,
  created_by uuid not null references public.users(id),
  accepted_by uuid references public.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index studio_invitations_recipient_pending_idx on public.studio_invitations(recipient_email_hash, expires_at) where status='pending';
create index studio_invitations_studio_idx on public.studio_invitations(studio_id, created_at desc);

create table public.studio_events (
  cursor bigint generated always as identity primary key,
  studio_id uuid not null references public.studios(id),
  revision bigint not null check (revision > 0),
  event_type text not null check (event_type in ('studio.created','invitation.created','invitation.accepted','invitation.declined','invitation.revoked','membership.role_changed','membership.removed','scenario.version_created')),
  entity_id uuid not null,
  actor_profile_id uuid references public.users(id),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(studio_id, request_id, event_type, entity_id)
);
create index studio_events_catchup_idx on public.studio_events(studio_id, cursor);

create table public.studio_idempotency_keys (
  profile_id uuid not null references public.users(id),
  idempotency_hash text not null check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  request_fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(profile_id, idempotency_hash)
);

alter table public.studios enable row level security;
alter table public.studio_memberships enable row level security;
alter table public.studio_membership_revisions enable row level security;
alter table public.studio_invitations enable row level security;
alter table public.studio_events enable row level security;
alter table public.studio_idempotency_keys enable row level security;

create or replace function public.is_active_studio_member(p_studio_id uuid,p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.studio_memberships where studio_id=p_studio_id and profile_id=p_profile_id and status='active')
$$;
create policy studios_member_select on public.studios for select to authenticated using (
  public.is_active_studio_member(id,public.current_profile_id()));
create policy studio_memberships_member_select on public.studio_memberships for select to authenticated using (
  public.is_active_studio_member(studio_id,public.current_profile_id()));
create policy studio_events_member_select on public.studio_events for select to authenticated using (
  public.is_active_studio_member(studio_id,public.current_profile_id()));
revoke all on public.studio_membership_revisions, public.studio_invitations, public.studio_idempotency_keys from anon, authenticated;

create trigger studio_membership_revisions_immutable before update or delete on public.studio_membership_revisions for each row execute function public.reject_immutable_history_mutation();
create trigger studio_events_immutable before update or delete on public.studio_events for each row execute function public.reject_immutable_history_mutation();
create trigger studio_idempotency_immutable before update or delete on public.studio_idempotency_keys for each row execute function public.reject_immutable_history_mutation();

create or replace function public.audit_studio_event() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id,metadata)
    values(new.actor_profile_id,new.event_type,'studio',new.studio_id::text,new.request_id,jsonb_build_object('entity_id',new.entity_id,'revision',new.revision,'cursor',new.cursor));
  return new;
end $$;
create trigger studio_events_audit after insert on public.studio_events for each row execute function public.audit_studio_event();

create or replace function public.protect_studio_invitation_secrets() returns trigger language plpgsql as $$
begin
  if old.token_hash<>new.token_hash or old.recipient_email_hash<>new.recipient_email_hash or old.studio_id<>new.studio_id then raise exception 'studio_invitation_immutable'; end if;
  return new;
end $$;
create trigger studio_invitation_secrets_immutable before update on public.studio_invitations for each row execute function public.protect_studio_invitation_secrets();

create or replace function public.studio_space_json(p_studio public.studios,p_profile_id uuid) returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('id',p_studio.id,'scenarioId',p_studio.scenario_id,'name',p_studio.name,
    'role',(select role from public.studio_memberships where studio_id=p_studio.id and profile_id=p_profile_id and status='active'),
    'revision',p_studio.revision,'createdAt',p_studio.created_at,'updatedAt',p_studio.updated_at)
$$;
create or replace function public.studio_membership_json(p_member public.studio_memberships) returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('studioId',p_member.studio_id,'profileId',p_member.profile_id,'displayName',p_member.display_name,'role',p_member.role,'status',p_member.status,'revision',p_member.revision,'updatedAt',p_member.updated_at)
$$;
create or replace function public.studio_invitation_json(p_invite public.studio_invitations) returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object('id',p_invite.id,'studioId',p_invite.studio_id,'recipient',p_invite.recipient_masked,'role',p_invite.role,
    'status',case when p_invite.status='pending' and p_invite.expires_at<=now() then 'expired' else p_invite.status end,
    'expiresAt',p_invite.expires_at,'createdAt',p_invite.created_at)
$$;

create or replace function public.authorize_studio_operation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_studio_id uuid default null,p_roles text[] default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_auth jsonb; v_role text;
begin
  v_auth:=public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  if not exists(select 1 from public.entitlement_snapshots s, jsonb_array_elements(coalesce(s.payload->'entitlements','[]'::jsonb)) e
    where s.id=(v_auth->>'snapshotId')::uuid and e->>'code'='studio_collaboration' and coalesce((e->>'enabled')::boolean,false))
    then raise exception 'studio_entitlement_missing'; end if;
  if p_studio_id is not null then
    select m.role into v_role from public.studio_memberships m join public.studios st on st.id=m.studio_id join public.cloud_scenarios s on s.id=st.scenario_id
      where m.studio_id=p_studio_id and m.profile_id=p_profile_id and m.status='active' and s.deleted_at is null;
    if v_role is null or (p_roles is not null and not(v_role=any(p_roles))) then raise exception 'studio_not_found'; end if;
  end if;
  return v_auth||jsonb_build_object('role',v_role);
end $$;

create or replace function public.append_studio_event(p_studio_id uuid,p_event_type text,p_entity_id uuid,p_actor uuid,p_request_id uuid)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_revision bigint; v_cursor bigint;
begin
  select cursor into v_cursor from public.studio_events where studio_id=p_studio_id and request_id=p_request_id and event_type=p_event_type and entity_id=p_entity_id;
  if v_cursor is not null then return v_cursor; end if;
  update public.studios set revision=revision+1,updated_at=now() where id=p_studio_id returning revision into v_revision;
  insert into public.studio_events(studio_id,revision,event_type,entity_id,actor_profile_id,request_id)
    values(p_studio_id,v_revision,p_event_type,p_entity_id,p_actor,p_request_id)
    on conflict(studio_id,request_id,event_type,entity_id) do nothing returning cursor into v_cursor;
  if v_cursor is null then select cursor into v_cursor from public.studio_events where studio_id=p_studio_id and request_id=p_request_id and event_type=p_event_type and entity_id=p_entity_id; end if;
  return v_cursor;
end $$;

create or replace function public.list_studios(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select coalesce(jsonb_agg(public.studio_space_json(s,p_profile_id) order by s.updated_at desc),'[]'::jsonb) into v_result
    from public.studios s join public.studio_memberships m on m.studio_id=s.id
    join public.cloud_scenarios c on c.id=s.scenario_id and c.deleted_at is null
    where m.profile_id=p_profile_id and m.status='active';
  return v_result;
end $$;

create or replace function public.list_received_studio_invitations(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select coalesce(jsonb_agg(public.studio_invitation_json(i) order by i.created_at desc),'[]'::jsonb) into v_result
    from public.studio_invitations i join public.studios s on s.id=i.studio_id join public.cloud_scenarios c on c.id=s.scenario_id and c.deleted_at is null
    where i.recipient_email_hash=p_email_hash and i.status='pending';
  return v_result;
end $$;

create or replace function public.get_studio_detail(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_studio_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_studio public.studios; v_members jsonb; v_invites jsonb; v_role text;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,null);
  select * into v_studio from public.studios where id=p_studio_id;
  select role into v_role from public.studio_memberships where studio_id=p_studio_id and profile_id=p_profile_id and status='active';
  select coalesce(jsonb_agg(public.studio_membership_json(m) order by m.updated_at),'[]'::jsonb) into v_members from public.studio_memberships m where m.studio_id=p_studio_id and m.status='active';
  if v_role='owner' then select coalesce(jsonb_agg(public.studio_invitation_json(i) order by i.created_at desc),'[]'::jsonb) into v_invites from public.studio_invitations i where i.studio_id=p_studio_id; else v_invites:='[]'::jsonb; end if;
  return jsonb_build_object('studio',public.studio_space_json(v_studio,p_profile_id),'members',v_members,'invitations',v_invites);
end $$;

create or replace function public.create_studio(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_scenario_id uuid,p_name text,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_existing public.studio_idempotency_keys; v_studio public.studios; v_member public.studio_memberships; v_fingerprint text:=p_scenario_id::text||':'||p_name; v_response jsonb;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform pg_advisory_xact_lock(hashtextextended('studio-create:'||p_scenario_id::text,0));
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>v_fingerprint then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  if not exists(select 1 from public.cloud_scenarios where id=p_scenario_id and owner_id=p_profile_id and deleted_at is null) then raise exception 'studio_not_found'; end if;
  insert into public.studios(scenario_id,name,created_by) values(p_scenario_id,p_name,p_profile_id) returning * into v_studio;
  insert into public.studio_memberships values(v_studio.id,p_profile_id,p_display_name,'owner','active',1,now()) returning * into v_member;
  insert into public.studio_membership_revisions(studio_id,profile_id,display_name,role,status,revision,changed_by,request_id) values(v_studio.id,p_profile_id,p_display_name,'owner','active',1,p_profile_id,p_request_id);
  insert into public.studio_events(studio_id,revision,event_type,entity_id,actor_profile_id,request_id) values(v_studio.id,1,'studio.created',v_studio.id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('studio',public.studio_space_json(v_studio,p_profile_id),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,v_fingerprint,v_response,now());
  return v_response;
end $$;

create or replace function public.create_studio_invitation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_studio_id uuid,p_recipient_email_hash text,p_recipient_masked text,p_role text,p_token_hash text,p_expires_at timestamptz,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_invite public.studio_invitations; v_existing public.studio_idempotency_keys; v_fingerprint text:=p_studio_id::text||':'||p_recipient_email_hash||':'||p_role; v_response jsonb;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner']);
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>v_fingerprint then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  insert into public.studio_invitations(studio_id,recipient_email_hash,recipient_masked,token_hash,role,expires_at,created_by) values(p_studio_id,p_recipient_email_hash,p_recipient_masked,p_token_hash,p_role,p_expires_at,p_profile_id) returning * into v_invite;
  perform public.append_studio_event(p_studio_id,'invitation.created',v_invite.id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('invitation',public.studio_invitation_json(v_invite),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,v_fingerprint,v_response,now()); return v_response;
end $$;

create or replace function public.accept_studio_invitation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_token_hash text,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_invite public.studio_invitations; v_member public.studio_memberships; v_existing public.studio_idempotency_keys; v_response jsonb; v_next bigint;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>p_token_hash then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  select * into v_invite from public.studio_invitations where token_hash=p_token_hash for update;
  if v_invite.id is null or v_invite.recipient_email_hash<>p_email_hash then raise exception 'studio_not_found'; end if;
  if v_invite.status<>'pending' then raise exception 'invitation_not_pending'; end if;
  if v_invite.expires_at<=now() then update public.studio_invitations set status='expired',updated_at=now() where id=v_invite.id; raise exception 'invitation_expired'; end if;
  update public.studio_invitations set status='accepted',accepted_by=p_profile_id,accepted_at=now(),updated_at=now() where id=v_invite.id;
  select coalesce(revision,0)+1 into v_next from public.studio_memberships where studio_id=v_invite.studio_id and profile_id=p_profile_id;
  v_next:=coalesce(v_next,1);
  insert into public.studio_memberships values(v_invite.studio_id,p_profile_id,p_display_name,v_invite.role,'active',v_next,now())
    on conflict(studio_id,profile_id) do update set display_name=excluded.display_name,role=excluded.role,status='active',revision=excluded.revision,updated_at=now() returning * into v_member;
  insert into public.studio_membership_revisions(studio_id,profile_id,display_name,role,status,revision,changed_by,request_id) values(v_member.studio_id,v_member.profile_id,v_member.display_name,v_member.role,v_member.status,v_member.revision,p_profile_id,p_request_id);
  insert into public.scenario_collaborators(scenario_id,user_id,role,status,invited_by,updated_at) select scenario_id,p_profile_id,v_invite.role,'active',v_invite.created_by,now() from public.studios where id=v_invite.studio_id on conflict(scenario_id,user_id) do update set role=excluded.role,status='active',updated_at=now();
  perform public.append_studio_event(v_invite.studio_id,'invitation.accepted',v_invite.id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('membership',public.studio_membership_json(v_member),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,p_token_hash,v_response,now()); return v_response;
end $$;

create or replace function public.decline_studio_invitation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_token_hash text,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_invite public.studio_invitations; v_response jsonb; v_existing public.studio_idempotency_keys;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>p_token_hash then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  select * into v_invite from public.studio_invitations where token_hash=p_token_hash for update;
  if v_invite.id is null or v_invite.recipient_email_hash<>p_email_hash then raise exception 'studio_not_found'; end if;
  if v_invite.status<>'pending' then raise exception 'invitation_not_pending'; end if;
  if v_invite.expires_at<=now() then update public.studio_invitations set status='expired',updated_at=now() where id=v_invite.id; raise exception 'invitation_expired'; end if;
  update public.studio_invitations set status='declined',updated_at=now() where id=v_invite.id returning * into v_invite;
  perform public.append_studio_event(v_invite.studio_id,'invitation.declined',v_invite.id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('invitation',public.studio_invitation_json(v_invite),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,p_token_hash,v_response,now()) on conflict do nothing; return v_response;
end $$;

create or replace function public.revoke_studio_invitation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_studio_id uuid,p_invitation_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_invite public.studio_invitations; v_response jsonb; v_existing public.studio_idempotency_keys; v_fingerprint text:=p_studio_id::text||':'||p_invitation_id::text;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner']);
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>v_fingerprint then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  update public.studio_invitations set status='revoked',updated_at=now() where id=p_invitation_id and studio_id=p_studio_id and status='pending' returning * into v_invite;
  if v_invite.id is null then raise exception 'invitation_not_pending'; end if;
  perform public.append_studio_event(p_studio_id,'invitation.revoked',p_invitation_id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('invitation',public.studio_invitation_json(v_invite),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,v_fingerprint,v_response,now()); return v_response;
end $$;

create or replace function public.change_studio_member_role(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_studio_id uuid,p_member_profile_id uuid,p_role text,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_member public.studio_memberships; v_response jsonb; v_existing public.studio_idempotency_keys; v_fingerprint text:=p_studio_id::text||':'||p_member_profile_id::text||':'||p_role;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner']);
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>v_fingerprint then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  if p_profile_id=p_member_profile_id then raise exception 'self_role_change_forbidden'; end if;
  select * into v_member from public.studio_memberships where studio_id=p_studio_id and profile_id=p_member_profile_id and status='active' for update;
  if v_member.profile_id is null then raise exception 'studio_not_found'; end if;
  if v_member.role='owner' and p_role<>'owner' and (select count(*) from public.studio_memberships where studio_id=p_studio_id and role='owner' and status='active')=1 then raise exception 'last_owner_required'; end if;
  update public.studio_memberships set role=p_role,revision=revision+1,updated_at=now() where studio_id=p_studio_id and profile_id=p_member_profile_id returning * into v_member;
  insert into public.studio_membership_revisions(studio_id,profile_id,display_name,role,status,revision,changed_by,request_id) values(v_member.studio_id,v_member.profile_id,v_member.display_name,v_member.role,v_member.status,v_member.revision,p_profile_id,p_request_id);
  update public.scenario_collaborators set role=case when p_role='owner' then 'editor' else p_role end,updated_at=now() where scenario_id=(select scenario_id from public.studios where id=p_studio_id) and user_id=p_member_profile_id;
  perform public.append_studio_event(p_studio_id,'membership.role_changed',p_member_profile_id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('membership',public.studio_membership_json(v_member),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,v_fingerprint,v_response,now()); return v_response;
end $$;

create or replace function public.remove_studio_member(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_studio_id uuid,p_member_profile_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_member public.studio_memberships; v_response jsonb; v_existing public.studio_idempotency_keys; v_fingerprint text:=p_studio_id::text||':'||p_member_profile_id::text;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner']);
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then if v_existing.request_fingerprint<>v_fingerprint then raise exception 'studio_idempotency_conflict'; end if; return v_existing.response||jsonb_build_object('replayed',true); end if;
  select * into v_member from public.studio_memberships where studio_id=p_studio_id and profile_id=p_member_profile_id and status='active' for update;
  if v_member.profile_id is null then raise exception 'studio_not_found'; end if;
  if v_member.role='owner' and (select count(*) from public.studio_memberships where studio_id=p_studio_id and role='owner' and status='active')=1 then raise exception 'last_owner_required'; end if;
  update public.studio_memberships set status='revoked',revision=revision+1,updated_at=now() where studio_id=p_studio_id and profile_id=p_member_profile_id returning * into v_member;
  insert into public.studio_membership_revisions(studio_id,profile_id,display_name,role,status,revision,changed_by,request_id) values(v_member.studio_id,v_member.profile_id,v_member.display_name,v_member.role,v_member.status,v_member.revision,p_profile_id,p_request_id);
  update public.scenario_collaborators set status='revoked',updated_at=now() where scenario_id=(select scenario_id from public.studios where id=p_studio_id) and user_id=p_member_profile_id;
  perform public.append_studio_event(p_studio_id,'membership.removed',p_member_profile_id,p_profile_id,p_request_id);
  v_response:=jsonb_build_object('membership',public.studio_membership_json(v_member),'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,v_fingerprint,v_response,now()); return v_response;
end $$;

create or replace function public.list_studio_events(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_studio_id uuid,p_after_cursor bigint,p_limit integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_events jsonb; v_next bigint; v_more boolean;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,null);
  select coalesce(jsonb_agg(jsonb_build_object('studioId',q.studio_id,'cursor',q.cursor,'revision',q.revision,'type',q.event_type,'entityId',q.entity_id,'createdAt',q.created_at) order by q.cursor),'[]'::jsonb),coalesce(max(q.cursor),p_after_cursor)
    into v_events,v_next from (select * from public.studio_events where studio_id=p_studio_id and cursor>p_after_cursor order by cursor limit least(p_limit,500)) q;
  select exists(select 1 from public.studio_events where studio_id=p_studio_id and cursor>v_next) into v_more;
  return jsonb_build_object('events',v_events,'nextCursor',v_next,'hasMore',v_more);
end $$;

create or replace function public.append_studio_version_event(p_scenario_id uuid,p_version_id uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_studio uuid; v_cursor bigint;
begin
  select id into v_studio from public.studios where scenario_id=p_scenario_id;
  if v_studio is null then return jsonb_build_object('recorded',false); end if;
  v_cursor:=public.append_studio_event(v_studio,'scenario.version_created',p_version_id,null,p_request_id);
  return jsonb_build_object('recorded',true,'cursor',v_cursor);
end $$;

revoke all on function public.authorize_studio_operation(uuid,text,text,text,uuid,text[]) from public,anon,authenticated;
revoke all on function public.append_studio_event(uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.audit_studio_event() from public,anon,authenticated;
revoke all on function public.is_active_studio_member(uuid,uuid) from public,anon,authenticated;
grant execute on function public.is_active_studio_member(uuid,uuid) to authenticated,service_role;
revoke all on function public.list_studios(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.list_received_studio_invitations(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.get_studio_detail(uuid,text,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.create_studio(uuid,text,text,text,text,text,uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.create_studio_invitation(uuid,text,text,text,text,text,uuid,text,text,text,text,timestamptz,text,uuid) from public,anon,authenticated;
revoke all on function public.accept_studio_invitation(uuid,text,text,text,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.decline_studio_invitation(uuid,text,text,text,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.revoke_studio_invitation(uuid,text,text,text,text,text,uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.change_studio_member_role(uuid,text,text,text,text,text,uuid,uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.remove_studio_member(uuid,text,text,text,text,text,uuid,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.list_studio_events(uuid,text,text,text,text,text,uuid,bigint,integer) from public,anon,authenticated;
revoke all on function public.append_studio_version_event(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_studios(uuid,text,text,text,text,text) to service_role;
grant execute on function public.list_received_studio_invitations(uuid,text,text,text,text,text) to service_role;
grant execute on function public.get_studio_detail(uuid,text,text,text,text,text,uuid) to service_role;
grant execute on function public.create_studio(uuid,text,text,text,text,text,uuid,text,text,uuid) to service_role;
grant execute on function public.create_studio_invitation(uuid,text,text,text,text,text,uuid,text,text,text,text,timestamptz,text,uuid) to service_role;
grant execute on function public.accept_studio_invitation(uuid,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.decline_studio_invitation(uuid,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.revoke_studio_invitation(uuid,text,text,text,text,text,uuid,uuid,text,uuid) to service_role;
grant execute on function public.change_studio_member_role(uuid,text,text,text,text,text,uuid,uuid,text,text,uuid) to service_role;
grant execute on function public.remove_studio_member(uuid,text,text,text,text,text,uuid,uuid,text,uuid) to service_role;
grant execute on function public.list_studio_events(uuid,text,text,text,text,text,uuid,bigint,integer) to service_role;
grant execute on function public.append_studio_version_event(uuid,uuid,uuid) to service_role;
