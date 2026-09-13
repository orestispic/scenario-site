-- Server-only administrative offer grants for support, QA and founder accounts.
-- These grants never impersonate a Stripe payment and remain immutable/audited.

create function public.grant_admin_offer(
  p_profile_email citext,
  p_offer_code text,
  p_expires_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_item public.offer_configuration_items;
  v_snapshot public.entitlement_snapshots;
  v_payload jsonb;
  v_offline_until timestamptz;
begin
  if p_offer_code not in ('author_ai', 'studio') then
    raise exception 'admin_offer_invalid';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'admin_offer_expiration_invalid';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 or length(p_reason) > 500 then
    raise exception 'admin_offer_reason_invalid';
  end if;

  select * into v_profile
  from public.profiles
  where email = p_profile_email and deleted_at is null
  limit 1;
  if v_profile.id is null then raise exception 'admin_offer_profile_missing'; end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-offer:' || v_profile.id::text, 0));

  select snapshot.* into v_snapshot
  from public.current_entitlement_snapshot(v_profile.id) snapshot
  where snapshot.source = 'admin_grant'
    and snapshot.payload ->> 'offer_code' = p_offer_code
    and snapshot.expires_at is not distinct from p_expires_at
  limit 1;
  if v_snapshot.id is not null then
    return jsonb_build_object(
      'snapshotId', v_snapshot.id,
      'offerCode', p_offer_code,
      'replayed', true
    );
  end if;

  select item.* into v_item
  from public.offer_configuration_items item
  join public.offer_configuration_versions version on version.id = item.configuration_version_id
  join public.offers offer on offer.id = item.offer_id
  where version.status = 'active'
    and version.effective_at <= now()
    and offer.offer_code = p_offer_code
  order by version.effective_at desc, (item.billing_period = 'month') desc, item.created_at desc
  limit 1;
  if v_item.id is null then raise exception 'admin_offer_configuration_missing'; end if;

  v_offline_until := least(
    coalesce(p_expires_at, now() + make_interval(days => v_item.offline_grace_days)),
    now() + make_interval(days => v_item.offline_grace_days)
  );
  select jsonb_build_object(
    'offer_code', p_offer_code,
    'offer_display_name', v_item.display_name,
    'billing_interval', v_item.billing_period,
    'entitlements', coalesce((
      select jsonb_agg(
        jsonb_build_object('code', entitlement.entitlement_code, 'enabled', true, 'value', entitlement.value)
        order by entitlement.entitlement_code
      )
      from public.offer_entitlements entitlement
      where entitlement.configuration_version_id = v_item.configuration_version_id
        and entitlement.offer_id = v_item.offer_id
    ), '[]'::jsonb),
    'quota_limits', coalesce((
      select jsonb_object_agg(quota.quota_code, quota.limit_value)
      from public.offer_quotas quota
      where quota.configuration_version_id = v_item.configuration_version_id
        and quota.offer_id = v_item.offer_id
    ), '{}'::jsonb),
    'quota_periods', coalesce((
      select jsonb_object_agg(quota.quota_code, quota.period)
      from public.offer_quotas quota
      where quota.configuration_version_id = v_item.configuration_version_id
        and quota.offer_id = v_item.offer_id
    ), '{}'::jsonb),
    'device_limit', v_item.device_limit,
    'offline_valid_until', v_offline_until
  ) into v_payload;

  insert into public.entitlement_snapshots (
    user_id, configuration_version_id, source, effective_at, expires_at, payload
  ) values (
    v_profile.id, v_item.configuration_version_id, 'admin_grant', now(), p_expires_at, v_payload
  ) returning * into v_snapshot;

  insert into public.audit_log (action, entity_type, entity_id, request_id, metadata)
  values (
    'admin.offer_granted', 'profile', v_profile.id::text, gen_random_uuid(),
    jsonb_build_object(
      'snapshotId', v_snapshot.id,
      'offerCode', p_offer_code,
      'expiresAt', p_expires_at,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'snapshotId', v_snapshot.id,
    'offerCode', p_offer_code,
    'replayed', false
  );
end;
$$;

revoke all on function public.grant_admin_offer(citext, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.grant_admin_offer(citext, text, timestamptz, text)
  to service_role;

create or replace function public.get_billing_state(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_build_object(
      'status', 'active',
      'offerCode', snapshot.payload ->> 'offer_code',
      'offerDisplayName', snapshot.payload ->> 'offer_display_name',
      'billingInterval', snapshot.payload ->> 'billing_interval',
      'currentPeriodStartsAt', snapshot.effective_at,
      'currentPeriodEndsAt', snapshot.expires_at,
      'cancelAtPeriodEnd', false,
      'lastPaymentStatus', null,
      'source', 'admin_grant',
      'testMode', true
    )
    from public.current_entitlement_snapshot(p_profile_id) snapshot
    where snapshot.source = 'admin_grant'
      and snapshot.payload ->> 'offer_code' in ('author_ai', 'studio')
    limit 1
  ), (
    select jsonb_build_object(
      'status', subscription.status,
      'offerCode', offer.offer_code,
      'offerDisplayName', item.display_name,
      'billingInterval', item.billing_period,
      'currentPeriodStartsAt', subscription.current_period_starts_at,
      'currentPeriodEndsAt', subscription.current_period_ends_at,
      'cancelAtPeriodEnd', subscription.cancel_at_period_end,
      'lastPaymentStatus', invoice.status,
      'source', 'stripe',
      'testMode', true
    )
    from public.subscriptions subscription
    left join public.prices price on price.id = subscription.price_id
    left join public.offer_configuration_items item on item.id = price.offer_configuration_item_id
    left join public.offers offer on offer.id = item.offer_id
    left join lateral (
      select case when status = 'paid' then 'paid' else 'failed' end as status
      from public.billing_invoices where subscription_id = subscription.id order by provider_created_at desc limit 1
    ) invoice on true
    where subscription.user_id = p_profile_id
    order by subscription.updated_at desc limit 1
  ), (
    select jsonb_build_object(
      'status', case when redemption.expires_at is not null and redemption.expires_at <= now() then 'expired' else 'active' end,
      'offerCode', offer.offer_code,
      'offerDisplayName', item.display_name,
      'billingInterval', item.billing_period,
      'currentPeriodStartsAt', redemption.activated_at,
      'currentPeriodEndsAt', redemption.expires_at,
      'cancelAtPeriodEnd', false,
      'lastPaymentStatus', null,
      'source', 'activation_key',
      'testMode', true
    )
    from public.activation_key_redemptions redemption
    join public.activation_keys activation_key on activation_key.id = redemption.activation_key_id
    left join public.prices price on price.id = activation_key.price_id
    left join public.offer_configuration_items item on item.id = price.offer_configuration_item_id
    left join public.offers offer on offer.id = item.offer_id
    where redemption.profile_id = p_profile_id and redemption.status = 'active'
    order by redemption.activated_at desc limit 1
  ), jsonb_build_object(
    'status', 'none', 'offerCode', null, 'offerDisplayName', null,
    'billingInterval', null, 'currentPeriodStartsAt', null, 'currentPeriodEndsAt', null,
    'cancelAtPeriodEnd', false, 'lastPaymentStatus', null, 'source', null, 'testMode', true
  ))
$$;

revoke all on function public.get_billing_state(uuid) from public, anon, authenticated;
grant execute on function public.get_billing_state(uuid) to service_role;

