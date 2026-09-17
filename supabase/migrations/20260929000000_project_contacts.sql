-- Mutual contacts for project sharing. Email is only used for exact discovery;
-- project invitations remain impossible until the recipient accepts.
create table public.project_contacts (
  id uuid primary key default gen_random_uuid(),
  requester_profile_id uuid not null references public.profiles(id) on delete cascade,
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  profile_low_id uuid not null references public.profiles(id) on delete cascade,
  profile_high_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('pending','accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint project_contacts_distinct_profiles check (requester_profile_id <> recipient_profile_id),
  constraint project_contacts_pair_members check (
    requester_profile_id in (profile_low_id, profile_high_id) and
    recipient_profile_id in (profile_low_id, profile_high_id) and
    profile_low_id <> profile_high_id
  ),
  unique (profile_low_id, profile_high_id)
);
create index project_contacts_requester_idx on public.project_contacts(requester_profile_id,status);
create index project_contacts_recipient_idx on public.project_contacts(recipient_profile_id,status);
alter table public.project_contacts enable row level security;
revoke all on public.project_contacts from public,anon,authenticated;

create function public.contact_profile_json_v15(p_profile public.profiles,p_since timestamptz)
returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object(
    'profileId',p_profile.id,
    'displayName',coalesce(nullif(trim(p_profile.display_name),''),split_part(p_profile.email::text,'@',1)),
    'email',p_profile.email::text,
    'since',p_since
  )
$$;

create function public.contact_request_json_v15(p_contact public.project_contacts,p_profile public.profiles)
returns jsonb language sql stable set search_path=public as $$
  select jsonb_build_object(
    'id',p_contact.id,
    'profileId',p_profile.id,
    'displayName',coalesce(nullif(trim(p_profile.display_name),''),split_part(p_profile.email::text,'@',1)),
    'email',p_profile.email::text,
    'createdAt',p_contact.created_at
  )
$$;

create function public.list_project_contacts_v15(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_contacts jsonb; v_received jsonb; v_sent jsonb;
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select coalesce(jsonb_agg(public.contact_profile_json_v15(p,coalesce(c.accepted_at,c.updated_at)) order by lower(coalesce(p.display_name,p.email::text))),'[]'::jsonb)
    into v_contacts
    from public.project_contacts c
    join public.profiles p on p.id=case when c.requester_profile_id=p_profile_id then c.recipient_profile_id else c.requester_profile_id end
   where c.status='accepted' and p_profile_id in(c.requester_profile_id,c.recipient_profile_id) and p.deleted_at is null;
  select coalesce(jsonb_agg(public.contact_request_json_v15(c,p) order by c.created_at desc),'[]'::jsonb)
    into v_received
    from public.project_contacts c join public.profiles p on p.id=c.requester_profile_id
   where c.status='pending' and c.recipient_profile_id=p_profile_id and p.deleted_at is null;
  select coalesce(jsonb_agg(public.contact_request_json_v15(c,p) order by c.created_at desc),'[]'::jsonb)
    into v_sent
    from public.project_contacts c join public.profiles p on p.id=c.recipient_profile_id
   where c.status='pending' and c.requester_profile_id=p_profile_id and p.deleted_at is null;
  return jsonb_build_object('contacts',v_contacts,'receivedRequests',v_received,'sentRequests',v_sent);
end $$;

create function public.request_project_contact_v15(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_target public.profiles; v_existing public.project_contacts; v_low uuid; v_high uuid;
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select * into v_target from public.profiles where lower(email::text)=lower(trim(p_email)) and deleted_at is null;
  if v_target.id is null or v_target.id=p_profile_id then raise exception 'contact_not_found'; end if;
  if p_profile_id::text<v_target.id::text then v_low:=p_profile_id;v_high:=v_target.id;else v_low:=v_target.id;v_high:=p_profile_id;end if;
  perform pg_advisory_xact_lock(hashtextextended(v_low::text||':'||v_high::text,0));
  select * into v_existing from public.project_contacts where profile_low_id=v_low and profile_high_id=v_high for update;
  if v_existing.status='accepted' then raise exception 'contact_already_exists'; end if;
  if v_existing.status='pending' then return jsonb_build_object('updated',true); end if;
  insert into public.project_contacts(requester_profile_id,recipient_profile_id,profile_low_id,profile_high_id,status)
  values(p_profile_id,v_target.id,v_low,v_high,'pending');
  return jsonb_build_object('updated',true);
end $$;

create function public.respond_project_contact_v15(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_request_id uuid,p_decision text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_contact public.project_contacts;
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  if p_decision not in ('accept','decline','cancel') then raise exception 'contact_request_forbidden'; end if;
  select * into v_contact from public.project_contacts where id=p_request_id and status='pending' for update;
  if v_contact.id is null then raise exception 'contact_request_not_found'; end if;
  if p_decision='cancel' then
    if v_contact.requester_profile_id<>p_profile_id then raise exception 'contact_request_forbidden'; end if;
    delete from public.project_contacts where id=v_contact.id;
  else
    if v_contact.recipient_profile_id<>p_profile_id then raise exception 'contact_request_forbidden'; end if;
    if p_decision='accept' then
      update public.project_contacts set status='accepted',accepted_at=now(),updated_at=now() where id=v_contact.id;
    else delete from public.project_contacts where id=v_contact.id;
    end if;
  end if;
  return jsonb_build_object('updated',true);
end $$;

create function public.remove_project_contact_v15(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_contact_profile_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  delete from public.project_contacts
   where status='accepted' and p_profile_id in(requester_profile_id,recipient_profile_id)
     and p_contact_profile_id in(requester_profile_id,recipient_profile_id);
  if not found then raise exception 'contact_not_found'; end if;
  return jsonb_build_object('updated',true);
end $$;

create function public.require_project_contact_v15(p_profile_id uuid,p_email text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_target uuid;
begin
  select id into v_target from public.profiles where lower(email::text)=lower(trim(p_email)) and deleted_at is null;
  if v_target is null or not exists(
    select 1 from public.project_contacts c where c.status='accepted'
      and p_profile_id in(c.requester_profile_id,c.recipient_profile_id)
      and v_target in(c.requester_profile_id,c.recipient_profile_id)
  ) then raise exception 'contact_required'; end if;
  return jsonb_build_object('allowed',true);
end $$;

revoke all on function public.contact_profile_json_v15(public.profiles,timestamptz) from public,anon,authenticated;
revoke all on function public.contact_request_json_v15(public.project_contacts,public.profiles) from public,anon,authenticated;
revoke all on function public.list_project_contacts_v15(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.request_project_contact_v15(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.respond_project_contact_v15(uuid,text,text,text,uuid,text) from public,anon,authenticated;
revoke all on function public.remove_project_contact_v15(uuid,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.require_project_contact_v15(uuid,text) from public,anon,authenticated;
grant execute on function public.list_project_contacts_v15(uuid,text,text,text) to service_role;
grant execute on function public.request_project_contact_v15(uuid,text,text,text,text) to service_role;
grant execute on function public.respond_project_contact_v15(uuid,text,text,text,uuid,text) to service_role;
grant execute on function public.remove_project_contact_v15(uuid,text,text,text,uuid) to service_role;
grant execute on function public.require_project_contact_v15(uuid,text) to service_role;
