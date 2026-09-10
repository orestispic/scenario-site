-- Phase 2: Supabase identity mapping, least-privilege grants and RLS.
-- Apply after 20260910000000_commercial_foundation.sql on an isolated project.

alter table public.users rename to profiles;
alter table public.profiles alter column auth_user_id set not null;
alter table public.profiles
  add constraint profiles_auth_user_fk
  foreign key (auth_user_id) references auth.users(id) on delete cascade;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger subscriptions_set_updated_at before update on public.subscriptions
for each row execute function public.set_updated_at();
create trigger cloud_scenarios_set_updated_at before update on public.cloud_scenarios
for each row execute function public.set_updated_at();
create trigger instagram_publications_set_updated_at before update on public.instagram_publications
for each row execute function public.set_updated_at();

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (auth_user_id, email, display_name, role)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    'customer'
  );
  return new;
end;
$$;

create trigger auth_user_created_profile
after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where auth_user_id = auth.uid() and deleted_at is null
$$;

-- Device activation is server-only and atomic. The device limit is read from the
-- immutable entitlement snapshot; the caller cannot submit or override it.
create or replace function public.activate_device(
  p_profile_id uuid,
  p_device_fingerprint_hash text,
  p_platform text,
  p_label text
)
returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_active_count integer;
  v_device public.devices;
begin
  if p_platform not in ('windows', 'macos') then
    raise exception 'unsupported_platform';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_profile_id::text));

  select (payload ->> 'device_limit')::integer
    into v_limit
  from public.entitlement_snapshots
  where user_id = p_profile_id
    and effective_at <= now()
    and (expires_at is null or expires_at > now())
  order by effective_at desc, created_at desc
  limit 1;

  if v_limit is null or v_limit < 1 then
    raise exception 'missing_device_entitlement';
  end if;

  select count(*) into v_active_count
  from public.devices
  where user_id = p_profile_id and status = 'active';

  select * into v_device
  from public.devices
  where user_id = p_profile_id
    and device_fingerprint_hash = p_device_fingerprint_hash;

  if v_device.id is null and v_active_count >= v_limit then
    raise exception 'device_limit_reached';
  end if;

  if v_device.id is not null and v_device.status = 'revoked' and v_active_count >= v_limit then
    raise exception 'device_limit_reached';
  end if;

  insert into public.devices (
    user_id, device_fingerprint_hash, platform, label, status, last_seen_at, revoked_at
  ) values (
    p_profile_id, p_device_fingerprint_hash, p_platform, left(p_label, 100), 'active', now(), null
  )
  on conflict (user_id, device_fingerprint_hash) do update set
    platform = excluded.platform,
    label = excluded.label,
    status = 'active',
    last_seen_at = now(),
    revoked_at = null
  returning * into v_device;

  return v_device;
end;
$$;

-- Every public table is protected. Service-role requests bypass RLS only inside
-- the API Worker; browser/client roles receive the explicit grants below.
alter table public.profiles enable row level security;
alter table public.offers enable row level security;
alter table public.offer_configuration_versions enable row level security;
alter table public.offer_configuration_items enable row level security;
alter table public.offer_entitlements enable row level security;
alter table public.offer_quotas enable row level security;
alter table public.promotions enable row level security;
alter table public.prices enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_events enable row level security;
alter table public.entitlement_snapshots enable row level security;
alter table public.activation_keys enable row level security;
alter table public.devices enable row level security;
alter table public.ai_usage_events enable row level security;
alter table public.cloud_scenarios enable row level security;
alter table public.cloud_scenario_versions enable row level security;
alter table public.scenario_collaborators enable row level security;
alter table public.reading_shares enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.instagram_publications enable row level security;
alter table public.audit_log enable row level security;
alter table public.client_compatibility_rules enable row level security;

create policy profiles_select_own on public.profiles
for select to authenticated
using (auth_user_id = auth.uid() and deleted_at is null);
create policy profiles_update_own on public.profiles
for update to authenticated
using (auth_user_id = auth.uid() and deleted_at is null)
with check (auth_user_id = auth.uid() and deleted_at is null);

create policy subscriptions_select_own on public.subscriptions
for select to authenticated using (user_id = public.current_profile_id());
create policy entitlement_snapshots_select_own on public.entitlement_snapshots
for select to authenticated using (user_id = public.current_profile_id());
create policy devices_select_own on public.devices
for select to authenticated using (user_id = public.current_profile_id());
create policy ai_usage_events_select_own on public.ai_usage_events
for select to authenticated using (user_id = public.current_profile_id());
create policy cloud_scenarios_select_own on public.cloud_scenarios
for select to authenticated using (owner_id = public.current_profile_id() and deleted_at is null);
create policy cloud_scenario_versions_select_own on public.cloud_scenario_versions
for select to authenticated using (
  exists (
    select 1 from public.cloud_scenarios s
    where s.id = scenario_id and s.owner_id = public.current_profile_id() and s.deleted_at is null
  )
);
create policy scenario_collaborators_select_own on public.scenario_collaborators
for select to authenticated using (user_id = public.current_profile_id());
create policy reading_shares_select_own on public.reading_shares
for select to authenticated using (created_by = public.current_profile_id());
create policy instagram_accounts_select_own on public.instagram_accounts
for select to authenticated using (user_id = public.current_profile_id());
create policy instagram_publications_select_own on public.instagram_publications
for select to authenticated using (user_id = public.current_profile_id());

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.subscriptions to authenticated;
grant select on public.entitlement_snapshots to authenticated;
grant select on public.devices to authenticated;
grant select on public.ai_usage_events to authenticated;
grant select on public.cloud_scenarios to authenticated;
grant select on public.cloud_scenario_versions to authenticated;
grant select on public.scenario_collaborators to authenticated;
grant select on public.reading_shares to authenticated;
grant select on public.instagram_accounts to authenticated;
grant select on public.instagram_publications to authenticated;

revoke all on function public.activate_device(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.activate_device(uuid, text, text, text) to service_role;
revoke all on function public.current_profile_id() from public, anon;
grant execute on function public.current_profile_id() to authenticated, service_role;

comment on column public.profiles.role is
  'customer, support or admin; mutable only by audited service-role API operations';
comment on table public.activation_keys is
  'Server-only. Plain activation keys must never be stored; key_hash uses a server-side pepper.';
