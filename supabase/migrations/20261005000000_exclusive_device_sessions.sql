-- One short-lived online usage lease per account. Two devices may stay
-- registered, but only the device holding this lease can use protected
-- cloud, AI and collaboration routes at a given time.

create table if not exists public.device_usage_sessions (
  user_id uuid primary key references public.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  lease_id uuid not null default gen_random_uuid(),
  acquired_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > last_heartbeat_at)
);

create index if not exists device_usage_sessions_expiry_idx
  on public.device_usage_sessions(expires_at);
alter table public.device_usage_sessions enable row level security;
revoke all on public.device_usage_sessions from public, anon, authenticated;

create or replace function public.claim_device_session_v17(
  p_profile_id uuid,
  p_device_id uuid,
  p_force boolean default false,
  p_ttl_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_session public.device_usage_sessions;
  v_device public.devices;
  v_now timestamptz:=clock_timestamp();
  v_ttl integer:=greatest(30,least(coalesce(p_ttl_seconds,90),300));
begin
  perform pg_advisory_xact_lock(hashtextextended('device-session:'||p_profile_id::text,0));
  select * into v_device from public.devices
    where id=p_device_id and user_id=p_profile_id and status='active'
    for update;
  if v_device.id is null then raise exception 'device_revoked'; end if;
  if v_device.public_key_jwk is null or v_device.key_thumbprint is null then
    raise exception 'device_key_upgrade_required';
  end if;

  select * into v_session from public.device_usage_sessions
    where user_id=p_profile_id for update;
  if v_session.user_id is not null
    and v_session.expires_at>v_now
    and v_session.device_id<>p_device_id
    and not p_force then
    select * into v_device from public.devices where id=v_session.device_id;
    return jsonb_build_object(
      'status','conflict',
      'expiresAt',v_session.expires_at,
      'activeDevice',jsonb_build_object(
        'id',v_device.id,
        'label',v_device.label,
        'platform',v_device.platform,
        'lastSeenAt',v_device.last_seen_at,
        'firstActivatedAt',v_device.first_activated_at,
        'clientVersion',v_device.client_version
      )
    );
  end if;

  insert into public.device_usage_sessions(
    user_id,device_id,lease_id,acquired_at,last_heartbeat_at,expires_at
  ) values (
    p_profile_id,p_device_id,gen_random_uuid(),v_now,v_now,v_now+make_interval(secs=>v_ttl)
  ) on conflict(user_id) do update set
    device_id=excluded.device_id,
    lease_id=case
      when public.device_usage_sessions.device_id=excluded.device_id
       and public.device_usage_sessions.expires_at>v_now
       and not p_force
      then public.device_usage_sessions.lease_id
      else excluded.lease_id
    end,
    acquired_at=case
      when public.device_usage_sessions.device_id=excluded.device_id
       and public.device_usage_sessions.expires_at>v_now
       and not p_force
      then public.device_usage_sessions.acquired_at
      else v_now
    end,
    last_heartbeat_at=v_now,
    expires_at=excluded.expires_at
  returning * into v_session;

  update public.devices set last_seen_at=v_now where id=p_device_id;
  return jsonb_build_object(
    'status','claimed','leaseId',v_session.lease_id,
    'deviceId',v_session.device_id,'expiresAt',v_session.expires_at
  );
end;
$$;

create or replace function public.heartbeat_device_session_v17(
  p_profile_id uuid,
  p_device_id uuid,
  p_lease_id uuid,
  p_ttl_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_session public.device_usage_sessions;
  v_now timestamptz:=clock_timestamp();
  v_ttl integer:=greatest(30,least(coalesce(p_ttl_seconds,90),300));
begin
  update public.device_usage_sessions set
    last_heartbeat_at=v_now,
    expires_at=v_now+make_interval(secs=>v_ttl)
  where user_id=p_profile_id and device_id=p_device_id and lease_id=p_lease_id
    and expires_at>v_now
    and exists(select 1 from public.devices where id=p_device_id and user_id=p_profile_id and status='active')
  returning * into v_session;
  if v_session.user_id is null then return jsonb_build_object('status','replaced'); end if;
  update public.devices set last_seen_at=v_now where id=p_device_id;
  return jsonb_build_object(
    'status','active','leaseId',v_session.lease_id,
    'deviceId',v_session.device_id,'expiresAt',v_session.expires_at
  );
end;
$$;

create or replace function public.release_device_session_v17(
  p_profile_id uuid,
  p_device_id uuid,
  p_lease_id uuid
) returns boolean
language plpgsql
security definer
set search_path=public
as $$
begin
  delete from public.device_usage_sessions
  where user_id=p_profile_id and device_id=p_device_id and lease_id=p_lease_id;
  return found;
end;
$$;

create or replace function public.is_device_session_active_v17(
  p_profile_id uuid,
  p_device_id uuid
) returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1 from public.device_usage_sessions session
    join public.devices device on device.id=session.device_id
    where session.user_id=p_profile_id and session.device_id=p_device_id
      and session.expires_at>clock_timestamp()
      and device.user_id=p_profile_id and device.status='active'
  )
$$;

-- Device removal immediately releases an exclusive session held by it.
create or replace function public.deactivate_device_v2(
  p_profile_id uuid,
  p_device_id uuid
) returns public.devices
language plpgsql
security definer
set search_path=public
as $$
declare v_device public.devices;
begin
  perform pg_advisory_xact_lock(hashtextextended('device:'||p_profile_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('device-session:'||p_profile_id::text,0));
  update public.devices
  set status='revoked',revoked_at=coalesce(revoked_at,now())
  where id=p_device_id and user_id=p_profile_id
  returning * into v_device;
  if v_device.id is null then raise exception 'device_not_found'; end if;
  delete from public.device_usage_sessions
    where user_id=p_profile_id and device_id=p_device_id;
  update public.device_licenses set revoked_at=coalesce(revoked_at,now())
    where user_id=p_profile_id and device_id=p_device_id and revoked_at is null;
  return v_device;
end;
$$;

revoke all on function public.claim_device_session_v17(uuid,uuid,boolean,integer) from public,anon,authenticated;
revoke all on function public.heartbeat_device_session_v17(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.release_device_session_v17(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.is_device_session_active_v17(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_device_session_v17(uuid,uuid,boolean,integer) to service_role;
grant execute on function public.heartbeat_device_session_v17(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.release_device_session_v17(uuid,uuid,uuid) to service_role;
grant execute on function public.is_device_session_active_v17(uuid,uuid) to service_role;

comment on table public.device_usage_sessions is
  'Short-lived server-authoritative lease enforcing one online active device per account.';
