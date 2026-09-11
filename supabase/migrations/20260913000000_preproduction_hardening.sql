-- Phase 4: append-only corrections. Keep the phase 0–3 files immutable.
-- Serialize provider projections before the old function reads current state.
alter function public.apply_verified_stripe_event(text, text, timestamptz, jsonb, text)
  rename to apply_verified_stripe_event_phase3;
revoke all on function public.apply_verified_stripe_event_phase3(text, text, timestamptz, jsonb, text)
  from public, anon, authenticated, service_role;

create function public.apply_verified_stripe_event(
  p_event_id text, p_event_type text, p_event_created_at timestamptz,
  p_payload jsonb, p_payload_sha256 text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_previous_hash text;
begin
  if p_payload -> 'livemode' is distinct from 'false'::jsonb
    or p_payload ->> 'id' is distinct from p_event_id
    or p_payload ->> 'type' is distinct from p_event_type
    or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_test_event';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('stripe:' || coalesce(p_payload #>> '{data,object,customer}', p_event_id), 0));
  select payload_sha256 into v_previous_hash from public.stripe_webhook_events where provider_event_id = p_event_id;
  if v_previous_hash is not null and v_previous_hash <> p_payload_sha256 then raise exception 'event_payload_mismatch'; end if;
  return public.apply_verified_stripe_event_phase3(p_event_id, p_event_type, p_event_created_at, p_payload, p_payload_sha256);
end;
$$;
revoke all on function public.apply_verified_stripe_event(text, text, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_verified_stripe_event(text, text, timestamptz, jsonb, text) to service_role;

create function public.ignore_stale_invoice_update() returns trigger language plpgsql set search_path = public as $$
begin
  if new.provider_created_at < old.provider_created_at then return old; end if;
  return new;
end;
$$;
create trigger billing_invoice_order before update on public.billing_invoices
for each row execute function public.ignore_stale_invoice_update();

-- An immutable snapshot stays in history, but a revoked/expired key cannot
-- continue authorizing new network operations or refreshing an offline grant.
create function public.current_entitlement_snapshot(p_profile_id uuid)
returns setof public.entitlement_snapshots language sql stable security definer set search_path = public as $$
  select snapshot.* from public.entitlement_snapshots snapshot
  where snapshot.user_id = p_profile_id and snapshot.effective_at <= now()
    and (snapshot.expires_at is null or snapshot.expires_at > now())
    and (snapshot.source <> 'activation_key' or exists (
      select 1 from public.activation_key_redemptions redemption
      join public.activation_keys key on key.id = redemption.activation_key_id
      where redemption.entitlement_snapshot_id = snapshot.id and redemption.status = 'active'
        and key.revoked_at is null and (key.expires_at is null or key.expires_at > now())
    ))
  order by snapshot.effective_at desc, snapshot.created_at desc limit 1
$$;
revoke all on function public.current_entitlement_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.current_entitlement_snapshot(uuid) to service_role;

create or replace function public.activate_device(p_profile_id uuid, p_device_fingerprint_hash text, p_platform text, p_label text)
returns public.devices language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_count integer; v_device public.devices;
begin
  if p_platform not in ('windows', 'macos') then raise exception 'unsupported_platform'; end if;
  perform pg_advisory_xact_lock(hashtext(p_profile_id::text));
  select (payload ->> 'device_limit')::integer into v_limit from public.current_entitlement_snapshot(p_profile_id);
  if v_limit is null or v_limit < 1 then raise exception 'missing_device_entitlement'; end if;
  select count(*) into v_count from public.devices where user_id = p_profile_id and status = 'active';
  select * into v_device from public.devices where user_id = p_profile_id and device_fingerprint_hash = p_device_fingerprint_hash;
  if (v_device.id is null or v_device.status = 'revoked') and v_count >= v_limit then raise exception 'device_limit_reached'; end if;
  insert into public.devices(user_id, device_fingerprint_hash, platform, label, status, last_seen_at, revoked_at)
    values (p_profile_id, p_device_fingerprint_hash, p_platform, left(p_label, 100), 'active', now(), null)
    on conflict (user_id, device_fingerprint_hash) do update set platform = excluded.platform, label = excluded.label,
      status = 'active', last_seen_at = now(), revoked_at = null returning * into v_device;
  return v_device;
end;
$$;

create or replace function public.redeem_activation_key(
  p_profile_id uuid, p_key_hash text, p_device_fingerprint_hash text, p_platform text, p_label text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_key public.activation_keys; v_snapshot public.entitlement_snapshots;
  v_device public.devices; v_redemption public.activation_key_redemptions; v_until timestamptz;
begin
  select * into v_key from public.activation_keys where key_hash = p_key_hash for update;
  if v_key.id is null then raise exception 'activation_key_invalid'; end if;
  if v_key.revoked_at is not null then raise exception 'activation_key_revoked'; end if;
  if v_key.expires_at is not null and v_key.expires_at <= now() then raise exception 'activation_key_expired'; end if;
  if v_key.activation_count >= v_key.maximum_activations then raise exception 'activation_limit_reached'; end if;
  if v_key.configuration_version_id is null or v_key.entitlement_payload is null or v_key.device_limit is null or v_key.offline_grace_days is null then raise exception 'activation_key_unconfigured'; end if;
  perform pg_advisory_xact_lock(hashtext(p_profile_id::text));
  if exists(select 1 from public.activation_key_redemptions where activation_key_id = v_key.id and profile_id = p_profile_id) then raise exception 'activation_already_used'; end if;
  v_until := least(coalesce(v_key.expires_at, now() + make_interval(days => v_key.offline_grace_days)), now() + make_interval(days => v_key.offline_grace_days));
  insert into public.entitlement_snapshots(user_id, configuration_version_id, source, effective_at, expires_at, payload, source_event_id)
    values(p_profile_id, v_key.configuration_version_id, 'activation_key', now(), v_key.expires_at,
      v_key.entitlement_payload || jsonb_build_object('device_limit', v_key.device_limit, 'offline_valid_until', v_until),
      'activation:' || v_key.id::text || ':' || p_profile_id::text) returning * into v_snapshot;
  insert into public.activation_key_redemptions(activation_key_id, profile_id, entitlement_snapshot_id, expires_at)
    values(v_key.id, p_profile_id, v_snapshot.id, v_key.expires_at) returning * into v_redemption;
  select * into v_device from public.activate_device(p_profile_id, p_device_fingerprint_hash, p_platform, p_label);
  update public.activation_key_redemptions set device_id = v_device.id where id = v_redemption.id;
  update public.activation_keys set activation_count = activation_count + 1 where id = v_key.id;
  return jsonb_build_object(
    'activation', jsonb_build_object('id', v_redemption.id, 'keySuffix', v_key.key_suffix, 'status', v_redemption.status,
      'activatedAt', v_redemption.activated_at, 'expiresAt', v_redemption.expires_at, 'deviceId', v_device.id),
    'snapshot', jsonb_build_object('id', v_snapshot.id, 'configurationVersion', v_snapshot.configuration_version_id,
      'issuedAt', v_snapshot.effective_at, 'offlineValidUntil', v_until, 'entitlements', v_snapshot.payload -> 'entitlements'));
end;
$$;

-- No browser ever needs ciphertext or provider identifiers for Instagram.
revoke select on public.instagram_accounts from authenticated;
grant select(id, user_id, connected_at, revoked_at, created_at) on public.instagram_accounts to authenticated;
