-- Cryptographic device possession and richer device metadata.
-- Append-only migration: legacy fingerprint activations remain attached to the
-- same row and receive a public key on their first v2 activation.

alter table public.devices
  add column if not exists public_key_jwk jsonb,
  add column if not exists key_thumbprint text,
  add column if not exists first_activated_at timestamptz,
  add column if not exists client_version text;

update public.devices
set first_activated_at = coalesce(first_activated_at, created_at)
where first_activated_at is null;

alter table public.devices
  alter column first_activated_at set default now(),
  alter column first_activated_at set not null;

alter table public.devices
  add constraint devices_key_thumbprint_format
  check (key_thumbprint is null or key_thumbprint ~ '^[A-Za-z0-9_-]{43}$') not valid;

alter table public.devices validate constraint devices_key_thumbprint_format;

create unique index if not exists devices_user_key_thumbprint_unique
  on public.devices(user_id, key_thumbprint)
  where key_thumbprint is not null;

create table if not exists public.device_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete cascade,
  purpose text not null check (purpose in ('activation', 'license_renewal')),
  nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists device_challenges_expiry_idx
  on public.device_challenges(expires_at)
  where consumed_at is null;

alter table public.device_challenges enable row level security;
revoke all on public.device_challenges from public, anon, authenticated;

create table if not exists public.device_licenses (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  entitlement_snapshot_id uuid not null references public.entitlement_snapshots(id),
  key_id text not null,
  format_version integer not null check (format_version > 0),
  issued_at timestamptz not null,
  entitlement_valid_until timestamptz not null,
  offline_valid_until timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (offline_valid_until <= entitlement_valid_until),
  check (offline_valid_until > issued_at)
);

create index if not exists device_licenses_device_issued_idx
  on public.device_licenses(device_id, issued_at desc);
alter table public.device_licenses enable row level security;
revoke all on public.device_licenses from public, anon, authenticated;

create or replace function public.consume_device_challenge(
  p_profile_id uuid,
  p_challenge_id uuid,
  p_purpose text,
  p_device_id uuid default null
) returns public.device_challenges
language plpgsql
security definer
set search_path = public
as $$
declare v_challenge public.device_challenges;
begin
  select * into v_challenge
  from public.device_challenges
  where id = p_challenge_id
  for update;

  if v_challenge.id is null
    or v_challenge.user_id <> p_profile_id
    or v_challenge.purpose <> p_purpose
    or v_challenge.device_id is distinct from p_device_id then
    raise exception 'device_challenge_invalid';
  end if;
  if v_challenge.consumed_at is not null then
    raise exception 'device_challenge_consumed';
  end if;
  if v_challenge.expires_at <= now() then
    raise exception 'device_challenge_expired';
  end if;

  update public.device_challenges
  set consumed_at = now()
  where id = v_challenge.id;
  v_challenge.consumed_at := now();
  return v_challenge;
end;
$$;

create or replace function public.activate_device_v2(
  p_profile_id uuid,
  p_device_fingerprint_hash text,
  p_key_thumbprint text,
  p_public_key_jwk jsonb,
  p_platform text,
  p_label text,
  p_client_version text
) returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
  v_device public.devices;
begin
  if p_platform not in ('windows', 'macos') then raise exception 'unsupported_platform'; end if;
  if p_key_thumbprint !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid_device_key'; end if;
  if p_public_key_jwk ->> 'kty' <> 'EC'
    or p_public_key_jwk ->> 'crv' <> 'P-256'
    or coalesce(p_public_key_jwk ->> 'x', '') !~ '^[A-Za-z0-9_-]{43}$'
    or coalesce(p_public_key_jwk ->> 'y', '') !~ '^[A-Za-z0-9_-]{43}$'
    or p_public_key_jwk ? 'd' then
    raise exception 'invalid_device_key';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('device:' || p_profile_id::text, 0));
  select least((payload ->> 'device_limit')::integer, 2)
  into v_limit
  from public.current_entitlement_snapshot(p_profile_id);
  if v_limit is null or v_limit < 1 then raise exception 'missing_device_entitlement'; end if;

  select * into v_device
  from public.devices
  where user_id = p_profile_id
    and (key_thumbprint = p_key_thumbprint
      or (key_thumbprint is null and device_fingerprint_hash = p_device_fingerprint_hash))
  order by (key_thumbprint = p_key_thumbprint) desc
  limit 1
  for update;

  if v_device.id is null and exists(
    select 1 from public.devices
    where user_id=p_profile_id and device_fingerprint_hash=p_device_fingerprint_hash
      and key_thumbprint is not null and key_thumbprint<>p_key_thumbprint
  ) then raise exception 'device_identity_conflict'; end if;

  select count(*) into v_count
  from public.devices
  where user_id = p_profile_id and status = 'active';
  if (v_device.id is null or v_device.status = 'revoked') and v_count >= v_limit then
    raise exception 'device_limit_reached';
  end if;

  if v_device.id is null then
    insert into public.devices(
      user_id, device_fingerprint_hash, public_key_jwk, key_thumbprint,
      platform, label, status, first_activated_at, last_seen_at, revoked_at,
      client_version
    ) values (
      p_profile_id, p_device_fingerprint_hash, p_public_key_jwk,
      p_key_thumbprint, p_platform, left(p_label, 100), 'active', now(), now(),
      null, left(p_client_version, 40)
    ) returning * into v_device;
  else
    update public.devices set
      public_key_jwk = p_public_key_jwk,
      key_thumbprint = p_key_thumbprint,
      platform = p_platform,
      label = left(p_label, 100),
      status = 'active',
      last_seen_at = now(),
      revoked_at = null,
      client_version = left(p_client_version, 40)
    where id = v_device.id
    returning * into v_device;
  end if;
  return v_device;
end;
$$;

-- Keep legacy activation-key redemption under the same hard ceiling during
-- the progressive migration. Hosted clients cannot call the legacy HTTP route.
create or replace function public.activate_device(
  p_profile_id uuid,
  p_device_fingerprint_hash text,
  p_platform text,
  p_label text
) returns public.devices
language plpgsql
security definer
set search_path=public
as $$
declare v_limit integer; v_count integer; v_device public.devices;
begin
  if p_platform not in ('windows','macos') then raise exception 'unsupported_platform'; end if;
  perform pg_advisory_xact_lock(hashtextextended('device:'||p_profile_id::text,0));
  select least((payload->>'device_limit')::integer,2) into v_limit
    from public.current_entitlement_snapshot(p_profile_id);
  if v_limit is null or v_limit<1 then raise exception 'missing_device_entitlement'; end if;
  select * into v_device from public.devices
    where user_id=p_profile_id and device_fingerprint_hash=p_device_fingerprint_hash
    for update;
  select count(*) into v_count from public.devices
    where user_id=p_profile_id and status='active';
  if (v_device.id is null or v_device.status='revoked') and v_count>=v_limit then
    raise exception 'device_limit_reached';
  end if;
  insert into public.devices(user_id,device_fingerprint_hash,platform,label,status,last_seen_at,revoked_at)
    values(p_profile_id,p_device_fingerprint_hash,p_platform,left(p_label,100),'active',now(),null)
  on conflict(user_id,device_fingerprint_hash) do update set
    platform=excluded.platform,label=excluded.label,status='active',last_seen_at=now(),revoked_at=null
  returning * into v_device;
  return v_device;
end;
$$;

create or replace function public.deactivate_device_v2(
  p_profile_id uuid,
  p_device_id uuid
) returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare v_device public.devices;
begin
  perform pg_advisory_xact_lock(hashtextextended('device:' || p_profile_id::text, 0));
  update public.devices
  set status = 'revoked', revoked_at = coalesce(revoked_at, now())
  where id = p_device_id and user_id = p_profile_id
  returning * into v_device;
  if v_device.id is null then raise exception 'device_not_found'; end if;
  update public.device_licenses set revoked_at = coalesce(revoked_at, now())
  where user_id = p_profile_id and device_id = p_device_id and revoked_at is null;
  return v_device;
end;
$$;

create function public.revoke_device_license(
  p_profile_id uuid,
  p_license_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.device_licenses
  set revoked_at = coalesce(revoked_at, now())
  where id = p_license_id and user_id = p_profile_id;
  if not found then raise exception 'license_not_found'; end if;
end;
$$;

revoke all on function public.consume_device_challenge(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.activate_device_v2(uuid, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.activate_device(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.deactivate_device_v2(uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_device_license(uuid, uuid) from public, anon, authenticated;
grant execute on function public.consume_device_challenge(uuid, uuid, text, uuid) to service_role;
grant execute on function public.activate_device_v2(uuid, text, text, jsonb, text, text, text) to service_role;
grant execute on function public.activate_device(uuid, text, text, text) to service_role;
grant execute on function public.deactivate_device_v2(uuid, uuid) to service_role;
grant execute on function public.revoke_device_license(uuid, uuid) to service_role;

comment on column public.devices.public_key_jwk is 'Public P-256 device key. A private member is forbidden.';
comment on table public.device_challenges is 'Short-lived, one-use proof-of-possession challenges. Never exposed through RLS.';
