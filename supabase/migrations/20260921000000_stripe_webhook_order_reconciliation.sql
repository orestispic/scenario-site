-- Phase 9: reconcile paid invoice projections when Stripe delivers invoice and
-- subscription webhooks in either order. Verified raw events remain immutable.
alter function public.apply_verified_stripe_event(
  text,text,timestamptz,jsonb,text
) rename to apply_verified_stripe_event_phase9_periods;

revoke all on function public.apply_verified_stripe_event_phase9_periods(
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
  v_subscription_ref text;
  v_subscription_id uuid;
begin
  v_result:=public.apply_verified_stripe_event_phase9_periods(
    p_event_id,p_event_type,p_event_created_at,p_payload,p_payload_sha256
  );

  if p_event_type in ('invoice.paid','invoice.payment_failed') then
    v_subscription_ref:=coalesce(
      v_object->>'subscription',
      v_object #>> '{parent,subscription_details,subscription}',
      v_object #>> '{lines,data,0,parent,subscription_item_details,subscription}'
    );
    select id into v_subscription_id
      from public.subscriptions
      where provider='stripe' and provider_subscription_id=v_subscription_ref;
    if v_subscription_id is not null then
      update public.billing_invoices set
        subscription_id=v_subscription_id,
        updated_at=now()
        where provider_invoice_id=v_object->>'id'
          and subscription_id is null;
    end if;
  elsif p_event_type like 'customer.subscription.%' then
    v_subscription_ref:=v_object->>'id';
    select id into v_subscription_id
      from public.subscriptions
      where provider='stripe' and provider_subscription_id=v_subscription_ref;
    if v_subscription_id is not null then
      update public.billing_invoices invoice set
        subscription_id=v_subscription_id,
        updated_at=now()
      from public.stripe_webhook_events webhook
      where invoice.subscription_id is null
        and webhook.processing_status='processed'
        and webhook.event_type in ('invoice.paid','invoice.payment_failed')
        and invoice.provider_invoice_id=webhook.payload #>> '{data,object,id}'
        and coalesce(
          webhook.payload #>> '{data,object,subscription}',
          webhook.payload #>> '{data,object,parent,subscription_details,subscription}',
          webhook.payload #>> '{data,object,lines,data,0,parent,subscription_item_details,subscription}'
        )=v_subscription_ref;
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

-- Repair pre-existing verified test projections without replaying or mutating
-- their append-only event payloads.
update public.billing_invoices invoice set
  subscription_id=subscription.id,
  updated_at=now()
from public.stripe_webhook_events webhook
join public.subscriptions subscription
  on subscription.provider='stripe'
 and subscription.provider_subscription_id=coalesce(
   webhook.payload #>> '{data,object,subscription}',
   webhook.payload #>> '{data,object,parent,subscription_details,subscription}',
   webhook.payload #>> '{data,object,lines,data,0,parent,subscription_item_details,subscription}'
 )
where invoice.subscription_id is null
  and webhook.processing_status='processed'
  and webhook.event_type in ('invoice.paid','invoice.payment_failed')
  and invoice.provider_invoice_id=webhook.payload #>> '{data,object,id}';

comment on function public.apply_verified_stripe_event(
  text,text,timestamptz,jsonb,text
) is 'Processes verified Stripe test events and reconciles invoice/subscription projections independently of webhook delivery order.';
