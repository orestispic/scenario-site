-- Phase 9: preserve the verified raw Stripe event while reconciling subscription
-- periods emitted by Basil/Clover API versions at the subscription-item level.
alter function public.apply_verified_stripe_event(
  text,text,timestamptz,jsonb,text
) rename to apply_verified_stripe_event_phase4;

revoke all on function public.apply_verified_stripe_event_phase4(
  text,text,timestamptz,jsonb,text
) from public,anon,authenticated,service_role;

create function public.apply_verified_stripe_event(
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_payload jsonb,
  p_payload_sha256 text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_result jsonb;
  v_object jsonb:=p_payload #> '{data,object}';
  v_subscription_id uuid;
  v_price_id uuid;
  v_status public.subscription_status;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_configuration_id uuid;
  v_offline_until timestamptz;
begin
  v_result:=public.apply_verified_stripe_event_phase4(
    p_event_id,p_event_type,p_event_created_at,p_payload,p_payload_sha256
  );
  if coalesce((v_result->>'replayed')::boolean,false)
    or p_event_type not like 'customer.subscription.%'
    or v_object ? 'current_period_start'
    or v_object ? 'current_period_end'
  then return v_result; end if;

  v_period_start:=to_timestamp(
    nullif(v_object #>> '{items,data,0,current_period_start}','')::double precision
  );
  v_period_end:=to_timestamp(
    nullif(v_object #>> '{items,data,0,current_period_end}','')::double precision
  );
  if v_period_start is null or v_period_end is null or v_period_end<=v_period_start
    then return v_result; end if;

  select id,price_id,status into v_subscription_id,v_price_id,v_status
    from public.subscriptions
    where provider='stripe' and provider_subscription_id=v_object->>'id'
    for update;
  if v_subscription_id is null then return v_result; end if;

  update public.subscriptions set
    current_period_starts_at=v_period_start,
    current_period_ends_at=v_period_end,
    updated_at=now()
    where id=v_subscription_id;

  if v_status in ('active','trialing') and v_price_id is not null then
    select item.configuration_version_id,
           least(
             v_period_end,
             v_period_start+make_interval(days=>item.offline_grace_days)
           )
      into v_configuration_id,v_offline_until
      from public.prices price
      join public.offer_configuration_items item
        on item.id=price.offer_configuration_item_id
      where price.id=v_price_id;
    if v_configuration_id is not null then
      insert into public.entitlement_snapshots(
        user_id,subscription_id,configuration_version_id,source,
        effective_at,expires_at,payload,source_event_id
      ) select
        subscription.user_id,subscription.id,v_configuration_id,'subscription',
        v_period_start,v_period_end,
        public.entitlement_payload_for_price(v_price_id,v_offline_until),p_event_id
      from public.subscriptions subscription
      where subscription.id=v_subscription_id
      on conflict (source_event_id) where source_event_id is not null do nothing;
    end if;
  end if;
  return v_result;
end $$;

revoke all on function public.apply_verified_stripe_event(
  text,text,timestamptz,jsonb,text
) from public,anon,authenticated;
grant execute on function public.apply_verified_stripe_event(
  text,text,timestamptz,jsonb,text
) to service_role;

comment on function public.apply_verified_stripe_event(
  text,text,timestamptz,jsonb,text
) is 'Processes verified Stripe test events and supports item-level subscription periods without mutating the raw event payload.';
