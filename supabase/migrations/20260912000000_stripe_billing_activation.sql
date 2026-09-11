-- Phase 3: Stripe test billing, verified event history and activation keys.
-- Append-only migration. Apply after 20260911000000_auth_rls.sql.

alter table public.subscriptions
  add column last_provider_event_created_at timestamptz,
  add column cancel_at_period_end boolean not null default false;

alter table public.entitlement_snapshots
  add column source_event_id text;
create unique index entitlement_snapshots_source_event_idx
  on public.entitlement_snapshots (source_event_id) where source_event_id is not null;

alter table public.activation_keys
  add column configuration_version_id uuid references public.offer_configuration_versions(id),
  add column price_id uuid references public.prices(id),
  add column entitlement_payload jsonb,
  add column device_limit integer check (device_limit is null or device_limit > 0),
  add column offline_grace_days integer check (offline_grace_days is null or offline_grace_days between 0 and 30),
  add column created_by uuid references public.profiles(id),
  add column revoked_by uuid references public.profiles(id),
  add column revocation_reason text;

create table public.stripe_customers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id),
  provider_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stripe_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  price_id uuid not null references public.prices(id),
  provider_session_id text not null unique,
  status text not null check (status in ('open', 'completed', 'expired')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.stripe_webhook_events (
  id bigint generated always as identity primary key,
  provider_event_id text not null unique,
  event_type text not null,
  provider_created_at timestamptz not null,
  payload_sha256 char(64) not null,
  payload jsonb not null,
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'ignored')),
  processed_at timestamptz,
  received_at timestamptz not null default now()
);

create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.subscriptions(id),
  provider_invoice_id text not null unique,
  status text not null,
  currency char(3),
  amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),
  period_starts_at timestamptz,
  period_ends_at timestamptz,
  provider_created_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activation_key_redemptions (
  id uuid primary key default gen_random_uuid(),
  activation_key_id uuid not null references public.activation_keys(id),
  profile_id uuid not null references public.profiles(id),
  entitlement_snapshot_id uuid not null references public.entitlement_snapshots(id),
  device_id uuid references public.devices(id),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  activated_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  unique (activation_key_id, profile_id)
);

create index stripe_checkout_profile_created_idx on public.stripe_checkout_sessions (profile_id, created_at desc);
create index stripe_webhook_type_created_idx on public.stripe_webhook_events (event_type, provider_created_at desc);
create index billing_invoices_subscription_period_idx on public.billing_invoices (subscription_id, period_ends_at desc);
create index activation_redemptions_profile_time_idx on public.activation_key_redemptions (profile_id, activated_at desc);

create trigger stripe_customers_set_updated_at before update on public.stripe_customers
for each row execute function public.set_updated_at();
create trigger billing_invoices_set_updated_at before update on public.billing_invoices
for each row execute function public.set_updated_at();
create trigger stripe_webhook_events_immutable before update or delete on public.stripe_webhook_events
for each row when (old.processing_status <> 'received') execute function public.reject_immutable_history_mutation();
create trigger billing_invoices_immutable before delete on public.billing_invoices
for each row execute function public.reject_immutable_history_mutation();
create trigger activation_key_redemptions_immutable before delete on public.activation_key_redemptions
for each row execute function public.reject_immutable_history_mutation();

create or replace function public.entitlement_payload_for_price(p_price_id uuid, p_offline_until timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
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
    'device_limit', item.device_limit,
    'offline_valid_until', p_offline_until
  )
  from public.prices price
  join public.offer_configuration_items item on item.id = price.offer_configuration_item_id
  where price.id = p_price_id
$$;

create or replace function public.apply_verified_stripe_event(
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_payload jsonb,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
  v_object jsonb := p_payload #> '{data,object}';
  v_customer_ref text := v_object ->> 'customer';
  v_subscription_ref text;
  v_invoice_ref text;
  v_price_ref text;
  v_profile_id uuid;
  v_price_id uuid;
  v_configuration_id uuid;
  v_subscription_id uuid;
  v_status public.subscription_status;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_offline_until timestamptz;
begin
  if p_event_type not in (
    'checkout.session.completed', 'customer.subscription.created',
    'customer.subscription.updated', 'customer.subscription.deleted',
    'invoice.paid', 'invoice.payment_failed'
  ) then
    raise exception 'unsupported_stripe_event';
  end if;

  insert into public.stripe_webhook_events (
    provider_event_id, event_type, provider_created_at, payload_sha256, payload
  ) values (p_event_id, p_event_type, p_event_created_at, p_payload_sha256, p_payload)
  on conflict (provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('replayed', true);
  end if;

  if p_event_type = 'checkout.session.completed' then
    select profile_id into v_profile_id
    from public.stripe_checkout_sessions
    where provider_session_id = v_object ->> 'id'
    for update;
    if v_profile_id is null or v_customer_ref is null then raise exception 'checkout_profile_missing'; end if;

    update public.stripe_checkout_sessions
      set status = 'completed', completed_at = p_event_created_at
      where provider_session_id = v_object ->> 'id';
    insert into public.stripe_customers (profile_id, provider_customer_id)
      values (v_profile_id, v_customer_ref)
      on conflict (profile_id) do update set provider_customer_id = excluded.provider_customer_id, updated_at = now();

    update public.stripe_webhook_events set processing_status = 'processed', processed_at = now()
      where provider_event_id = p_event_id;
    return jsonb_build_object('replayed', false);
  end if;

  select profile_id into v_profile_id from public.stripe_customers where provider_customer_id = v_customer_ref;
  if v_profile_id is null then
    begin v_profile_id := nullif(v_object #>> '{metadata,scenario_profile_id}', '')::uuid;
    exception when invalid_text_representation then v_profile_id := null; end;
  end if;
  if v_profile_id is null then raise exception 'stripe_profile_missing'; end if;
  if v_customer_ref is not null then
    insert into public.stripe_customers (profile_id, provider_customer_id)
      values (v_profile_id, v_customer_ref)
      on conflict (profile_id) do update set provider_customer_id = excluded.provider_customer_id, updated_at = now();
  end if;

  if p_event_type like 'customer.subscription.%' then
    v_subscription_ref := v_object ->> 'id';
    v_price_ref := v_object #>> '{items,data,0,price,id}';
    select id into v_price_id
      from public.prices where provider = 'stripe' and provider_price_id = v_price_ref;
    select id into v_subscription_id from public.subscriptions where provider_subscription_id = v_subscription_ref;

    if v_subscription_id is not null and exists (
      select 1 from public.subscriptions where id = v_subscription_id and last_provider_event_created_at > p_event_created_at
    ) then
      insert into public.subscription_events (subscription_id, provider_event_id, event_type, occurred_at, payload)
        values (v_subscription_id, p_event_id, p_event_type, p_event_created_at, p_payload);
      update public.stripe_webhook_events set processing_status = 'ignored', processed_at = now() where provider_event_id = p_event_id;
      return jsonb_build_object('replayed', false, 'ignoredAsStale', true);
    end if;

    v_status := case
      when p_event_type = 'customer.subscription.deleted' then 'canceled'::public.subscription_status
      when v_object ->> 'status' in ('trialing', 'active', 'past_due', 'paused', 'canceled') then (v_object ->> 'status')::public.subscription_status
      else 'expired'::public.subscription_status end;
    v_period_start := to_timestamp(nullif(v_object ->> 'current_period_start', '')::double precision);
    v_period_end := to_timestamp(nullif(v_object ->> 'current_period_end', '')::double precision);

    insert into public.subscriptions (
      user_id, price_id, provider, provider_subscription_id, status,
      current_period_starts_at, current_period_ends_at, canceled_at,
      cancel_at_period_end, last_provider_event_created_at
    ) values (
      v_profile_id, v_price_id, 'stripe', v_subscription_ref, v_status,
      v_period_start, v_period_end,
      case when v_status = 'canceled' then p_event_created_at else null end,
      coalesce((v_object ->> 'cancel_at_period_end')::boolean, false), p_event_created_at
    ) on conflict (provider_subscription_id) do update set
      price_id = excluded.price_id,
      status = excluded.status,
      current_period_starts_at = excluded.current_period_starts_at,
      current_period_ends_at = excluded.current_period_ends_at,
      canceled_at = excluded.canceled_at,
      cancel_at_period_end = excluded.cancel_at_period_end,
      last_provider_event_created_at = excluded.last_provider_event_created_at,
      updated_at = now()
    returning id into v_subscription_id;

    insert into public.subscription_events (subscription_id, provider_event_id, event_type, occurred_at, payload)
      values (v_subscription_id, p_event_id, p_event_type, p_event_created_at, p_payload);

    if v_status in ('active', 'trialing') and v_price_id is not null and v_period_end > v_period_start then
      select item.configuration_version_id,
             least(v_period_end, v_period_start + make_interval(days => item.offline_grace_days))
        into v_configuration_id, v_offline_until
      from public.prices price join public.offer_configuration_items item on item.id = price.offer_configuration_item_id
      where price.id = v_price_id;
      insert into public.entitlement_snapshots (
        user_id, subscription_id, configuration_version_id, source,
        effective_at, expires_at, payload, source_event_id
      ) values (
        v_profile_id, v_subscription_id, v_configuration_id, 'subscription',
        v_period_start, v_period_end,
        public.entitlement_payload_for_price(v_price_id, v_offline_until), p_event_id
      ) on conflict (source_event_id) where source_event_id is not null do nothing;
    end if;
  else
    v_invoice_ref := v_object ->> 'id';
    v_subscription_ref := coalesce(v_object ->> 'subscription', v_object #>> '{parent,subscription_details,subscription}');
    select id, price_id into v_subscription_id, v_price_id
      from public.subscriptions where provider_subscription_id = v_subscription_ref;
    v_period_start := to_timestamp(nullif(v_object ->> 'period_start', '')::double precision);
    v_period_end := to_timestamp(nullif(v_object ->> 'period_end', '')::double precision);

    insert into public.billing_invoices (
      subscription_id, provider_invoice_id, status, currency, amount_paid_minor,
      period_starts_at, period_ends_at, provider_created_at
    ) values (
      v_subscription_id, v_invoice_ref, case when p_event_type = 'invoice.paid' then 'paid' else 'payment_failed' end,
      upper(nullif(v_object ->> 'currency', '')),
      greatest(coalesce((v_object ->> 'amount_paid')::bigint, 0), 0),
      v_period_start, v_period_end, p_event_created_at
    ) on conflict (provider_invoice_id) do update set
      status = excluded.status, amount_paid_minor = excluded.amount_paid_minor,
      period_starts_at = excluded.period_starts_at, period_ends_at = excluded.period_ends_at,
      provider_created_at = excluded.provider_created_at, updated_at = now();

    if v_subscription_id is not null and not exists (
      select 1 from public.subscriptions where id = v_subscription_id and last_provider_event_created_at > p_event_created_at
    ) then
      update public.subscriptions set
        status = case when p_event_type = 'invoice.paid' then 'active'::public.subscription_status else 'past_due'::public.subscription_status end,
        current_period_starts_at = coalesce(v_period_start, current_period_starts_at),
        current_period_ends_at = coalesce(v_period_end, current_period_ends_at),
        last_provider_event_created_at = p_event_created_at,
        updated_at = now()
      where id = v_subscription_id;
      insert into public.subscription_events (subscription_id, provider_event_id, event_type, occurred_at, payload)
        values (v_subscription_id, p_event_id, p_event_type, p_event_created_at, p_payload);

      if p_event_type = 'invoice.paid' and v_price_id is not null and v_period_end > v_period_start then
        select item.configuration_version_id,
               least(v_period_end, v_period_start + make_interval(days => item.offline_grace_days))
          into v_configuration_id, v_offline_until
        from public.prices price join public.offer_configuration_items item on item.id = price.offer_configuration_item_id
        where price.id = v_price_id;
        insert into public.entitlement_snapshots (
          user_id, subscription_id, configuration_version_id, source,
          effective_at, expires_at, payload, source_event_id
        ) values (
          v_profile_id, v_subscription_id, v_configuration_id, 'subscription',
          v_period_start, v_period_end,
          public.entitlement_payload_for_price(v_price_id, v_offline_until), p_event_id
        ) on conflict (source_event_id) where source_event_id is not null do nothing;
      end if;
    end if;
  end if;

  update public.stripe_webhook_events set processing_status = 'processed', processed_at = now()
    where provider_event_id = p_event_id;
  return jsonb_build_object('replayed', false);
end;
$$;

create or replace function public.redeem_activation_key(
  p_profile_id uuid,
  p_key_hash text,
  p_device_fingerprint_hash text,
  p_platform text,
  p_label text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key public.activation_keys;
  v_snapshot public.entitlement_snapshots;
  v_device public.devices;
  v_redemption public.activation_key_redemptions;
  v_offline_until timestamptz;
begin
  select * into v_key from public.activation_keys where key_hash = p_key_hash for update;
  if v_key.id is null then raise exception 'activation_key_invalid'; end if;
  if v_key.revoked_at is not null then raise exception 'activation_key_revoked'; end if;
  if v_key.expires_at is not null and v_key.expires_at <= now() then raise exception 'activation_key_expired'; end if;
  if v_key.activation_count >= v_key.maximum_activations then raise exception 'activation_limit_reached'; end if;
  if v_key.configuration_version_id is null or v_key.entitlement_payload is null or v_key.device_limit is null or v_key.offline_grace_days is null then raise exception 'activation_key_unconfigured'; end if;
  if exists (select 1 from public.activation_key_redemptions where activation_key_id = v_key.id and profile_id = p_profile_id) then raise exception 'activation_already_used'; end if;

  v_offline_until := least(
    coalesce(v_key.expires_at, now() + make_interval(days => v_key.offline_grace_days)),
    now() + make_interval(days => v_key.offline_grace_days)
  );
  insert into public.entitlement_snapshots (
    user_id, configuration_version_id, source, effective_at, expires_at, payload, source_event_id
  ) values (
    p_profile_id, v_key.configuration_version_id, 'activation_key', now(), v_key.expires_at,
    v_key.entitlement_payload || jsonb_build_object('device_limit', v_key.device_limit, 'offline_valid_until', v_offline_until),
    'activation:' || v_key.id::text || ':' || p_profile_id::text
  ) returning * into v_snapshot;

  select * into v_device from public.activate_device(p_profile_id, p_device_fingerprint_hash, p_platform, p_label);
  insert into public.activation_key_redemptions (
    activation_key_id, profile_id, entitlement_snapshot_id, device_id, expires_at
  ) values (v_key.id, p_profile_id, v_snapshot.id, v_device.id, v_key.expires_at)
  returning * into v_redemption;
  update public.activation_keys set activation_count = activation_count + 1 where id = v_key.id;

  return jsonb_build_object(
    'activation', jsonb_build_object(
      'id', v_redemption.id, 'keySuffix', v_key.key_suffix, 'status', v_redemption.status,
      'activatedAt', v_redemption.activated_at, 'expiresAt', v_redemption.expires_at, 'deviceId', v_redemption.device_id
    ),
    'snapshot', jsonb_build_object(
      'id', v_snapshot.id, 'configurationVersion', v_snapshot.configuration_version_id,
      'issuedAt', v_snapshot.effective_at, 'offlineValidUntil', v_offline_until,
      'entitlements', v_snapshot.payload -> 'entitlements'
    )
  );
end;
$$;

create or replace function public.revoke_activation_key(p_key_id uuid, p_actor_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = p_actor_profile_id and role = 'admin' and deleted_at is null) then
    raise exception 'admin_required';
  end if;
  update public.activation_keys set revoked_at = coalesce(revoked_at, now()), revoked_by = p_actor_profile_id where id = p_key_id;
  if not found then raise exception 'activation_key_missing'; end if;
  update public.activation_key_redemptions set status = 'revoked', revoked_at = coalesce(revoked_at, now())
    where activation_key_id = p_key_id and status = 'active';
end;
$$;

create or replace function public.get_billing_state(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
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

alter table public.stripe_customers enable row level security;
alter table public.stripe_checkout_sessions enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.activation_key_redemptions enable row level security;

create policy stripe_customers_select_own on public.stripe_customers
for select to authenticated using (profile_id = public.current_profile_id());
create policy stripe_checkout_sessions_select_own on public.stripe_checkout_sessions
for select to authenticated using (profile_id = public.current_profile_id());
create policy activation_key_redemptions_select_own on public.activation_key_redemptions
for select to authenticated using (profile_id = public.current_profile_id());
create policy billing_invoices_select_own on public.billing_invoices
for select to authenticated using (
  exists (select 1 from public.subscriptions s where s.id = subscription_id and s.user_id = public.current_profile_id())
);

revoke all on public.stripe_customers, public.stripe_checkout_sessions,
  public.stripe_webhook_events, public.billing_invoices, public.activation_key_redemptions
  from anon, authenticated;
grant select on public.stripe_customers, public.stripe_checkout_sessions,
  public.billing_invoices, public.activation_key_redemptions to authenticated;

revoke all on function public.apply_verified_stripe_event(text, text, timestamptz, jsonb, text) from public, anon, authenticated;
revoke all on function public.redeem_activation_key(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.revoke_activation_key(uuid, uuid) from public, anon, authenticated;
revoke all on function public.entitlement_payload_for_price(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.get_billing_state(uuid) from public, anon, authenticated;
grant execute on function public.apply_verified_stripe_event(text, text, timestamptz, jsonb, text) to service_role;
grant execute on function public.redeem_activation_key(uuid, text, text, text, text) to service_role;
grant execute on function public.revoke_activation_key(uuid, uuid) to service_role;
grant execute on function public.entitlement_payload_for_price(uuid, timestamptz) to service_role;
grant execute on function public.get_billing_state(uuid) to service_role;

comment on table public.stripe_webhook_events is 'Verified Stripe test events only; idempotent by provider_event_id.';
comment on column public.activation_keys.key_hash is 'HMAC-SHA-256 fingerprint produced with the server-only activation pepper; never store plaintext keys.';
comment on column public.entitlement_snapshots.source_event_id is 'Immutable causal identifier preventing duplicate grants from replayed events.';
