-- Deterministic refund/chargeback projection. The verified provider event is
-- immutable; commercial revocation changes authorization, never user files.

alter table public.billing_invoices
  add column if not exists provider_charge_id text;
create unique index if not exists billing_invoices_provider_charge_idx
  on public.billing_invoices(provider_charge_id)
  where provider_charge_id is not null;

-- Keep the charge identifier projected from already verified invoice events.
-- Stripe dispute events normally reference the charge, not the invoice.
update public.billing_invoices invoice set
  provider_charge_id=coalesce(
    webhook.payload #>> '{data,object,charge}',
    webhook.payload #>> '{data,object,payments,data,0,payment,charge}'
  ),
  updated_at=now()
from public.stripe_webhook_events webhook
where invoice.provider_charge_id is null
  and webhook.processing_status='processed'
  and webhook.event_type in ('invoice.paid','invoice.payment_failed')
  and invoice.provider_invoice_id=webhook.payload #>> '{data,object,id}'
  and coalesce(
    webhook.payload #>> '{data,object,charge}',
    webhook.payload #>> '{data,object,payments,data,0,payment,charge}'
  ) is not null;

alter function public.apply_verified_stripe_event(text,text,timestamptz,jsonb,text)
  rename to apply_verified_stripe_event_before_revocations;
revoke all on function public.apply_verified_stripe_event_before_revocations(text,text,timestamptz,jsonb,text)
  from public,anon,authenticated,service_role;

create function public.apply_verified_stripe_event(
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz,
  p_payload jsonb,
  p_payload_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_object jsonb:=p_payload #> '{data,object}';
  v_result jsonb;
  v_previous_hash text;
  v_inserted integer;
  v_invoice_ref text;
  v_charge_ref text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_profile_id uuid;
begin
  if p_event_type not in ('charge.refunded','charge.dispute.created') then
    v_result:=public.apply_verified_stripe_event_before_revocations(
      p_event_id,p_event_type,p_event_created_at,p_payload,p_payload_sha256
    );
    if p_event_type in ('invoice.paid','invoice.payment_failed') then
      update public.billing_invoices set
        provider_charge_id=coalesce(
          v_object->>'charge',
          v_object #>> '{payments,data,0,payment,charge}',
          provider_charge_id
        ),
        updated_at=now()
      where provider_invoice_id=v_object->>'id';
    end if;
    return v_result;
  end if;
  if p_payload -> 'livemode' is distinct from 'false'::jsonb
    or p_payload ->> 'id' is distinct from p_event_id
    or p_payload ->> 'type' is distinct from p_event_type
    or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_test_event';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'stripe-revocation:' || coalesce(v_object->>'customer',v_object->>'charge',p_event_id),0
  ));
  select payload_sha256 into v_previous_hash
  from public.stripe_webhook_events where provider_event_id=p_event_id;
  if v_previous_hash is not null then
    if v_previous_hash<>p_payload_sha256 then raise exception 'event_payload_mismatch'; end if;
    return jsonb_build_object('replayed',true);
  end if;

  v_invoice_ref:=coalesce(
    v_object->>'invoice',
    v_object #>> '{charge,invoice}',
    v_object #>> '{metadata,invoice_id}'
  );
  v_charge_ref:=case
    when p_event_type='charge.refunded' then v_object->>'id'
    else coalesce(v_object->>'charge',v_object #>> '{charge,id}')
  end;
  select invoice.id,invoice.subscription_id,subscription.user_id
    into v_invoice_id,v_subscription_id,v_profile_id
  from public.billing_invoices invoice
  join public.subscriptions subscription on subscription.id=invoice.subscription_id
  where invoice.provider_invoice_id=v_invoice_ref
     or invoice.provider_charge_id=v_charge_ref
  order by (invoice.provider_invoice_id=v_invoice_ref) desc
  limit 1;
  if v_profile_id is null then
    select customer.profile_id into v_profile_id
    from public.stripe_customers customer
    where customer.provider_customer_id=v_object->>'customer';
  end if;
  if v_subscription_id is null or v_profile_id is null then
    raise exception 'stripe_revocation_target_missing';
  end if;

  insert into public.stripe_webhook_events(
    provider_event_id,event_type,provider_created_at,payload_sha256,payload,
    processing_status,processed_at
  ) values (
    p_event_id,p_event_type,p_event_created_at,p_payload_sha256,p_payload,
    'processed',now()
  ) on conflict(provider_event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then return jsonb_build_object('replayed',true); end if;

  update public.billing_invoices set
    status=case when p_event_type='charge.refunded' then 'refunded' else 'chargeback' end,
    updated_at=now()
  where id=v_invoice_id;
  update public.subscriptions set
    status='paused',
    last_provider_event_created_at=greatest(last_provider_event_created_at,p_event_created_at),
    updated_at=now()
  where id=v_subscription_id
    and (last_provider_event_created_at is null or last_provider_event_created_at<=p_event_created_at);
  insert into public.subscription_events(subscription_id,provider_event_id,event_type,occurred_at,payload)
    values(v_subscription_id,p_event_id,p_event_type,p_event_created_at,p_payload)
    on conflict(provider_event_id) do nothing;
  update public.device_licenses set revoked_at=coalesce(revoked_at,now())
    where user_id=v_profile_id and revoked_at is null;
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,request_id)
    values(v_profile_id,'billing.entitlements_revoked','subscription',v_subscription_id::text,null);
  return jsonb_build_object('replayed',false,'entitlementsRevoked',true);
end;
$$;

revoke all on function public.apply_verified_stripe_event(text,text,timestamptz,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.apply_verified_stripe_event(text,text,timestamptz,jsonb,text)
  to service_role;

create or replace function public.current_entitlement_snapshot(p_profile_id uuid)
returns setof public.entitlement_snapshots
language sql
stable
security definer
set search_path=public
as $$
  select snapshot.*
  from public.entitlement_snapshots snapshot
  left join public.subscriptions subscription on subscription.id=snapshot.subscription_id
  where snapshot.user_id=p_profile_id
    and snapshot.effective_at<=now()
    and (snapshot.expires_at is null or snapshot.expires_at>now())
    and (
      snapshot.source<>'subscription'
      or subscription.status in ('active','trialing')
      or (subscription.status='canceled' and subscription.current_period_ends_at>now())
    )
    and (snapshot.source<>'activation_key' or exists(
      select 1 from public.activation_key_redemptions redemption
      join public.activation_keys key on key.id=redemption.activation_key_id
      where redemption.entitlement_snapshot_id=snapshot.id
        and redemption.status='active' and key.revoked_at is null
        and (key.expires_at is null or key.expires_at>now())
    ))
  order by snapshot.effective_at desc,snapshot.created_at desc
  limit 1
$$;

revoke all on function public.current_entitlement_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.current_entitlement_snapshot(uuid) to service_role;
