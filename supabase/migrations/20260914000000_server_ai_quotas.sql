-- Phase 5: server-side AI, atomic quota reservations and append-only usage.
-- Apply only after 20260913000000_preproduction_hardening.sql.

create table public.ai_quota_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  entitlement_snapshot_id uuid not null references public.entitlement_snapshots(id),
  configuration_version_id uuid not null references public.offer_configuration_versions(id),
  device_id uuid not null references public.devices(id),
  operation text not null check (operation in ('short_action', 'pdf_import')),
  quota_code text not null,
  idempotency_key_hash char(64) not null,
  request_fingerprint char(64) not null,
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'released', 'uncertain')),
  period_starts_at timestamptz not null,
  period_ends_at timestamptz not null,
  request_id uuid not null unique,
  reserved_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, idempotency_key_hash),
  check (period_ends_at > period_starts_at)
);

create index ai_quota_reservations_count_idx
  on public.ai_quota_reservations (user_id, quota_code, period_starts_at, status);

alter table public.ai_quota_reservations enable row level security;
revoke all on public.ai_quota_reservations from public, anon, authenticated;

create trigger ai_usage_events_immutable before update or delete on public.ai_usage_events
for each row execute function public.reject_immutable_history_mutation();

-- Future entitlement snapshots copy both the value and period from the same
-- immutable configuration version. Existing snapshots can still resolve a
-- unique period from offer_quotas below without being rewritten.
create or replace function public.entitlement_payload_for_price(p_price_id uuid, p_offline_until timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'entitlements', coalesce((
      select jsonb_agg(jsonb_build_object('code', e.entitlement_code, 'enabled', true, 'value', e.value) order by e.entitlement_code)
      from public.offer_entitlements e
      where e.configuration_version_id = item.configuration_version_id and e.offer_id = item.offer_id
    ), '[]'::jsonb),
    'quota_limits', coalesce((
      select jsonb_object_agg(q.quota_code, q.limit_value)
      from public.offer_quotas q
      where q.configuration_version_id = item.configuration_version_id and q.offer_id = item.offer_id
    ), '{}'::jsonb),
    'quota_periods', coalesce((
      select jsonb_object_agg(q.quota_code, q.period)
      from public.offer_quotas q
      where q.configuration_version_id = item.configuration_version_id and q.offer_id = item.offer_id
    ), '{}'::jsonb),
    'device_limit', item.device_limit,
    'offline_valid_until', p_offline_until
  )
  from public.prices price
  join public.offer_configuration_items item on item.id = price.offer_configuration_item_id
  where price.id = p_price_id
$$;

create function public.semantic_version_at_least(p_current text, p_minimum text)
returns boolean language sql immutable set search_path = public as $$
  select case
    when p_current !~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'
      or p_minimum !~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' then false
    else string_to_array(substring(p_current from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::integer[]
      >= string_to_array(substring(p_minimum from '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::integer[]
  end
$$;

create function public.ai_reservation_response(p_reservation_id uuid, p_replayed boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', reservation.id,
    'operation', reservation.operation,
    'status', reservation.status,
    'replayed', p_replayed,
    'snapshotId', reservation.entitlement_snapshot_id,
    'configurationVersion', reservation.configuration_version_id,
    'used', (
      select count(*)::integer from public.ai_quota_reservations counted
      where counted.user_id = reservation.user_id and counted.quota_code = reservation.quota_code
        and counted.period_starts_at = reservation.period_starts_at
        and counted.status in ('reserved', 'succeeded', 'uncertain')
    ),
    'limit', (snapshot.payload #>> array['quota_limits', reservation.quota_code])::integer,
    'periodStartsAt', reservation.period_starts_at,
    'periodEndsAt', reservation.period_ends_at
  )
  from public.ai_quota_reservations reservation
  join public.entitlement_snapshots snapshot on snapshot.id = reservation.entitlement_snapshot_id
  where reservation.id = p_reservation_id
$$;

create function public.reserve_ai_quota(
  p_profile_id uuid,
  p_operation text,
  p_entitlement_code text,
  p_quota_code text,
  p_device_fingerprint_hash text,
  p_platform text,
  p_client_version text,
  p_idempotency_key_hash text,
  p_request_fingerprint text,
  p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_snapshot public.entitlement_snapshots;
  v_device public.devices;
  v_existing public.ai_quota_reservations;
  v_minimum text;
  v_limit integer;
  v_period text;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_used integer;
  v_reservation public.ai_quota_reservations;
begin
  if not ((p_operation = 'short_action' and p_entitlement_code = 'ai_short_action' and p_quota_code = 'ai_short_action')
    or (p_operation = 'pdf_import' and p_entitlement_code = 'ai_pdf_import' and p_quota_code = 'ai_pdf_import')) then
    raise exception 'ai_policy_invalid';
  end if;
  if p_idempotency_key_hash !~ '^[0-9a-f]{64}$' or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ai_fingerprint_invalid';
  end if;
  if p_client_version !~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' then
    raise exception 'invalid_client_version';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai:' || p_profile_id::text || ':' || p_quota_code, 0));

  select * into v_snapshot from public.current_entitlement_snapshot(p_profile_id);
  if v_snapshot.id is null or not exists (
    select 1 from jsonb_array_elements(coalesce(v_snapshot.payload -> 'entitlements', '[]'::jsonb)) entitlement
    where entitlement ->> 'code' = p_entitlement_code and coalesce((entitlement ->> 'enabled')::boolean, false)
  ) then raise exception 'ai_entitlement_missing'; end if;

  select * into v_device from public.devices
  where user_id = p_profile_id and device_fingerprint_hash = p_device_fingerprint_hash
    and platform = p_platform and status = 'active' limit 1;
  if v_device.id is null then raise exception 'ai_device_inactive'; end if;

  select minimum_supported_version into v_minimum from public.client_compatibility_rules
  where platform = p_platform and channel = 'stable' and effective_at <= now()
  order by effective_at desc limit 1;
  if v_minimum is not null and not public.semantic_version_at_least(p_client_version, v_minimum) then
    raise exception 'client_update_required';
  end if;

  select * into v_existing from public.ai_quota_reservations
  where user_id = p_profile_id and idempotency_key_hash = p_idempotency_key_hash;
  if v_existing.id is not null then
    if v_existing.request_fingerprint <> p_request_fingerprint or v_existing.operation <> p_operation then
      raise exception 'ai_idempotency_conflict';
    end if;
    return public.ai_reservation_response(v_existing.id, true);
  end if;

  if coalesce(v_snapshot.payload #>> array['quota_limits', p_quota_code], '') !~ '^[0-9]+$' then
    raise exception 'ai_quota_unconfigured';
  end if;
  v_limit := (v_snapshot.payload #>> array['quota_limits', p_quota_code])::integer;
  v_period := v_snapshot.payload #>> array['quota_periods', p_quota_code];
  if v_period is null then
    select min(period) into v_period from public.offer_quotas
    where configuration_version_id = v_snapshot.configuration_version_id
      and quota_code = p_quota_code and limit_value = v_limit
    having count(distinct period) = 1;
  end if;
  if v_period not in ('month', 'lifetime') then raise exception 'ai_quota_unconfigured'; end if;
  if v_period = 'month' then
    v_period_start := date_trunc('month', now());
    v_period_end := v_period_start + interval '1 month';
  else
    v_period_start := v_snapshot.effective_at;
    v_period_end := coalesce(v_snapshot.expires_at, '9999-12-31 23:59:59+00'::timestamptz);
  end if;
  select count(*)::integer into v_used from public.ai_quota_reservations
  where user_id = p_profile_id and quota_code = p_quota_code and period_starts_at = v_period_start
    and status in ('reserved', 'succeeded', 'uncertain');
  if v_used >= v_limit then raise exception 'ai_quota_exhausted'; end if;

  insert into public.ai_quota_reservations (
    user_id, entitlement_snapshot_id, configuration_version_id, device_id, operation,
    quota_code, idempotency_key_hash, request_fingerprint, period_starts_at, period_ends_at, request_id
  ) values (
    p_profile_id, v_snapshot.id, v_snapshot.configuration_version_id, v_device.id, p_operation,
    p_quota_code, p_idempotency_key_hash, p_request_fingerprint, v_period_start, v_period_end, p_request_id
  ) returning * into v_reservation;
  return public.ai_reservation_response(v_reservation.id, false);
end;
$$;

create function public.confirm_ai_quota(p_profile_id uuid, p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_reservation public.ai_quota_reservations;
begin
  select * into v_reservation from public.ai_quota_reservations
  where id = p_reservation_id and user_id = p_profile_id for update;
  if v_reservation.id is null then raise exception 'ai_request_missing'; end if;
  if v_reservation.status = 'released' then raise exception 'ai_request_released'; end if;
  if v_reservation.status = 'succeeded' then return public.ai_reservation_response(v_reservation.id, true); end if;
  update public.ai_quota_reservations set status = 'succeeded', settled_at = now() where id = v_reservation.id;
  insert into public.ai_usage_events (
    user_id, entitlement_snapshot_id, quota_code, quantity, request_id, metadata
  ) values (
    v_reservation.user_id, v_reservation.entitlement_snapshot_id, v_reservation.quota_code, 1,
    v_reservation.request_id,
    jsonb_build_object('reservation_id', v_reservation.id, 'configuration_version_id', v_reservation.configuration_version_id)
  ) on conflict (request_id) do nothing;
  return public.ai_reservation_response(v_reservation.id, false);
end;
$$;

create function public.release_ai_quota(p_profile_id uuid, p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_reservation public.ai_quota_reservations;
begin
  select * into v_reservation from public.ai_quota_reservations
  where id = p_reservation_id and user_id = p_profile_id for update;
  if v_reservation.id is null then raise exception 'ai_request_missing'; end if;
  if v_reservation.status = 'succeeded' then return public.ai_reservation_response(v_reservation.id, true); end if;
  update public.ai_quota_reservations set status = 'released', settled_at = now() where id = v_reservation.id;
  return public.ai_reservation_response(v_reservation.id, false);
end;
$$;

create function public.mark_ai_quota_uncertain(p_profile_id uuid, p_reservation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_reservation public.ai_quota_reservations;
begin
  select * into v_reservation from public.ai_quota_reservations
  where id = p_reservation_id and user_id = p_profile_id for update;
  if v_reservation.id is null then raise exception 'ai_request_missing'; end if;
  if v_reservation.status = 'reserved' then
    update public.ai_quota_reservations set status = 'uncertain', settled_at = now() where id = v_reservation.id;
  end if;
  return public.ai_reservation_response(v_reservation.id, v_reservation.status <> 'reserved');
end;
$$;

create function public.get_ai_request_status(p_profile_id uuid, p_idempotency_key_hash text)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.ai_reservation_response(id, true) from public.ai_quota_reservations
  where user_id = p_profile_id and idempotency_key_hash = p_idempotency_key_hash
$$;

revoke all on function public.semantic_version_at_least(text, text) from public, anon, authenticated;
revoke all on function public.ai_reservation_response(uuid, boolean) from public, anon, authenticated;
revoke all on function public.reserve_ai_quota(uuid, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.confirm_ai_quota(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_ai_quota(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_ai_quota_uncertain(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_ai_request_status(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_ai_quota(uuid, text, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.confirm_ai_quota(uuid, uuid) to service_role;
grant execute on function public.release_ai_quota(uuid, uuid) to service_role;
grant execute on function public.mark_ai_quota_uncertain(uuid, uuid) to service_role;
grant execute on function public.get_ai_request_status(uuid, text) to service_role;

comment on table public.ai_quota_reservations is
  'Mutable reservation state keyed by account and HMAC idempotency fingerprint; contains no prompt or response text.';
comment on table public.ai_usage_events is
  'Append-only confirmed usage linked to the entitlement snapshot and request_id; contains no AI content.';
