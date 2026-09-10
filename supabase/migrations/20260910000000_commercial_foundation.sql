-- Scénario commercial foundation. Design-only migration: execute only in a future
-- isolated Supabase/PostgreSQL environment after review.
create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired');
create type public.device_status as enum ('active', 'revoked');
create type public.scenario_version_kind as enum ('save', 'restore', 'import', 'revision');
create type public.instagram_publication_status as enum ('draft', 'scheduled', 'publishing', 'published', 'failed', 'canceled');

create table public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email citext not null unique,
  display_name text,
  role text not null default 'customer' check (role in ('customer', 'admin', 'support')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.offers (
  id uuid primary key default gen_random_uuid(),
  offer_code text not null unique,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

create table public.offer_configuration_versions (
  id uuid primary key default gen_random_uuid(),
  version_number bigint not null unique,
  status text not null check (status in ('draft', 'scheduled', 'active', 'retired')),
  effective_at timestamptz,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  checksum text not null,
  immutable_at timestamptz
);

create table public.offer_configuration_items (
  id uuid primary key default gen_random_uuid(),
  configuration_version_id uuid not null references public.offer_configuration_versions(id),
  offer_id uuid not null references public.offers(id),
  locale text not null default 'fr-FR',
  display_name text not null,
  description text,
  billing_period text not null check (billing_period in ('none', 'month', 'year')),
  currency char(3) not null default 'EUR',
  price_minor integer not null check (price_minor >= 0),
  tax_included boolean not null default true,
  offline_grace_days integer not null check (offline_grace_days between 0 and 30),
  device_limit integer not null check (device_limit > 0),
  is_visible boolean not null default true,
  unique (configuration_version_id, offer_id, locale, billing_period)
);

create table public.offer_entitlements (
  id uuid primary key default gen_random_uuid(),
  configuration_version_id uuid not null references public.offer_configuration_versions(id),
  offer_id uuid not null references public.offers(id),
  entitlement_code text not null,
  value jsonb not null default 'true'::jsonb,
  unique (configuration_version_id, offer_id, entitlement_code)
);

create table public.offer_quotas (
  id uuid primary key default gen_random_uuid(),
  configuration_version_id uuid not null references public.offer_configuration_versions(id),
  offer_id uuid not null references public.offers(id),
  quota_code text not null,
  limit_value integer not null check (limit_value >= 0),
  period text not null check (period in ('month', 'lifetime')),
  unique (configuration_version_id, offer_id, quota_code)
);

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  promotion_code text not null unique,
  configuration_version_id uuid not null references public.offer_configuration_versions(id),
  offer_id uuid not null references public.offers(id),
  starts_at timestamptz not null,
  ends_at timestamptz,
  adjustment jsonb not null,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create table public.prices (
  id uuid primary key default gen_random_uuid(),
  offer_configuration_item_id uuid not null references public.offer_configuration_items(id),
  provider text not null default 'stripe',
  provider_price_id text unique,
  active_from timestamptz not null default now(),
  active_until timestamptz,
  created_at timestamptz not null default now(),
  check (active_until is null or active_until > active_from)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  price_id uuid references public.prices(id),
  provider text not null default 'stripe',
  provider_subscription_id text unique,
  status public.subscription_status not null,
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only provider events preserve the factual subscription history even when
-- the current subscription projection changes state.
create table public.subscription_events (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.subscriptions(id),
  provider_event_id text unique,
  event_type text not null,
  occurred_at timestamptz not null,
  payload jsonb not null,
  recorded_at timestamptz not null default now()
);

create table public.entitlement_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  subscription_id uuid references public.subscriptions(id),
  configuration_version_id uuid not null references public.offer_configuration_versions(id),
  source text not null check (source in ('subscription', 'activation_key', 'promotion', 'admin_grant')),
  effective_at timestamptz not null,
  expires_at timestamptz,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table public.activation_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  key_suffix text not null,
  entitlement_snapshot_id uuid references public.entitlement_snapshots(id),
  maximum_activations integer not null check (maximum_activations > 0),
  activation_count integer not null default 0 check (activation_count >= 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  device_fingerprint_hash text not null,
  platform text not null check (platform in ('windows', 'macos')),
  label text,
  status public.device_status not null default 'active',
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, device_fingerprint_hash)
);

create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  entitlement_snapshot_id uuid references public.entitlement_snapshots(id),
  quota_code text not null,
  quantity integer not null default 1 check (quantity > 0),
  occurred_at timestamptz not null default now(),
  request_id uuid not null unique,
  metadata jsonb not null default '{}'::jsonb
);

create table public.cloud_scenarios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id),
  title text not null,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.cloud_scenario_versions (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.cloud_scenarios(id),
  parent_version_id uuid references public.cloud_scenario_versions(id),
  created_by uuid not null references public.users(id),
  version_number integer not null check (version_number > 0),
  kind public.scenario_version_kind not null,
  content_checksum text not null,
  storage_key text not null,
  revision_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (scenario_id, version_number)
);
alter table public.cloud_scenarios add constraint cloud_scenarios_current_version_fk
  foreign key (current_version_id) references public.cloud_scenario_versions(id);

create table public.scenario_collaborators (
  scenario_id uuid not null references public.cloud_scenarios(id),
  user_id uuid not null references public.users(id),
  role text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (scenario_id, user_id)
);

create table public.reading_shares (
  id uuid primary key default gen_random_uuid(),
  scenario_id uuid not null references public.cloud_scenarios(id),
  created_by uuid not null references public.users(id),
  token_hash text not null unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  provider_account_id text,
  encrypted_access_token bytea,
  token_expires_at timestamptz,
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, provider_account_id)
);

create table public.instagram_publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  instagram_account_id uuid references public.instagram_accounts(id),
  status public.instagram_publication_status not null default 'draft',
  caption text,
  media_manifest jsonb not null default '[]'::jsonb,
  scheduled_for timestamptz,
  provider_publication_id text,
  published_at timestamptz,
  analytics jsonb not null default '{}'::jsonb,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references public.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  request_id uuid,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb
);

create table public.client_compatibility_rules (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('windows', 'macos')),
  channel text not null default 'stable',
  minimum_supported_version text not null,
  effective_at timestamptz not null,
  message text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  unique (platform, channel, effective_at)
);

create index ai_usage_events_user_quota_time_idx on public.ai_usage_events (user_id, quota_code, occurred_at);
create index cloud_scenario_versions_scenario_time_idx on public.cloud_scenario_versions (scenario_id, created_at desc);
create index audit_log_entity_time_idx on public.audit_log (entity_type, entity_id, occurred_at desc);
create index subscriptions_user_status_idx on public.subscriptions (user_id, status);

create or replace function public.reject_immutable_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'immutable history cannot be modified or deleted';
end;
$$;

create trigger subscription_events_immutable
before update or delete on public.subscription_events
for each row execute function public.reject_immutable_history_mutation();

create trigger entitlement_snapshots_immutable
before update or delete on public.entitlement_snapshots
for each row execute function public.reject_immutable_history_mutation();

create trigger audit_log_immutable
before update or delete on public.audit_log
for each row execute function public.reject_immutable_history_mutation();

create or replace function public.reject_published_configuration_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.immutable_at is not null then
    raise exception 'published configuration is immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger offer_configuration_versions_published_immutable
before update or delete on public.offer_configuration_versions
for each row execute function public.reject_published_configuration_mutation();

-- RLS policies are intentionally not enabled in this planning migration. Phase 2
-- must define and test explicit policies alongside server access patterns.
