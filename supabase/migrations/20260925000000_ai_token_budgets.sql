-- Token and cost ledger. Service role only; never callable by an end-user JWT.
-- Old request counters remain historical, but the old admission RPC is disabled below.
create table public.ai_token_configuration (
  singleton boolean primary key default true check (singleton),
  version uuid not null default gen_random_uuid(),
  document jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.ai_token_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  operation text not null check (operation in ('short_action','pdf_import')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid not null unique,
  configuration_version uuid not null,
  model text not null,
  input_rate bigint not null check (input_rate > 0), -- nanoEUR/token, rounded UP
  output_rate bigint not null check (output_rate > 0),
  reserved_input bigint not null check (reserved_input > 0),
  reserved_output bigint not null check (reserved_output > 0),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  status text not null default 'reserved' check (status in ('reserved','succeeded','released','uncertain')),
  provider_response_id text,
  budget_anomaly boolean not null default false,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique(user_id,key_hash),
  check ((status = 'succeeded') = (input_tokens is not null and output_tokens is not null))
);
create index ai_token_ledger_user_period on public.ai_token_ledger(user_id,created_at);
alter table public.ai_token_configuration enable row level security;
alter table public.ai_token_ledger enable row level security;
revoke all on public.ai_token_configuration, public.ai_token_ledger from public, anon, authenticated;

-- Read via a SECURITY DEFINER function, not public PostgREST table permissions.
create function public.ai_token_offer(p_profile_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare s public.entitlement_snapshots; code text;
begin
  select * into s from public.current_entitlement_snapshot(p_profile_id);
  if s.id is null or not exists (select 1 from jsonb_array_elements(s.payload->'entitlements') e
    where e->>'code' in ('ai_short_action','ai_pdf_import') and e->>'enabled' = 'true') then return 'discovery'; end if;
  select o.offer_code into code from public.subscriptions sub
    join public.prices p on p.id = sub.price_id
    join public.offer_configuration_items i on i.id = p.offer_configuration_item_id
    join public.offers o on o.id = i.offer_id where sub.id = s.subscription_id;
  if code is not null then return code; end if;
  -- Admin/activation grants: use the trusted snapshot's capability, never client input.
  if exists (select 1 from jsonb_array_elements(s.payload->'entitlements') e
    where e->>'code' = 'studio_collaboration' and e->>'enabled' = 'true') then return 'studio'; end if;
  return 'author_ai';
end $$;

create function public.ai_token_window(p_profile_id uuid, p_start timestamptz, p_end timestamptz, p_tokens bigint, p_cost bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  with sums as (
    select coalesce(sum(input_tokens + output_tokens) filter (where status='succeeded'),0) as used,
      coalesce(sum(reserved_input + reserved_output) filter (where status in ('reserved','uncertain')),0) as held,
      coalesce(sum(input_tokens*input_rate + output_tokens*output_rate) filter (where status='succeeded'),0) as spent,
      coalesce(sum(reserved_input*input_rate + reserved_output*output_rate) filter (where status in ('reserved','uncertain')),0) as held_cost
    from public.ai_token_ledger where user_id=p_profile_id and created_at>=p_start and created_at<p_end
  ) select jsonb_build_object('usedTokens',used,'reservedTokens',held,'limitTokens',p_tokens,
    'usedPercent',case when p_tokens=0 then 0 else round(least(100,used*100.0/p_tokens),2) end,
    'reservedPercent',case when p_tokens=0 then 0 else round(least(100,held*100.0/p_tokens),2) end,
    'costUsedPercent',case when p_cost=0 then 0 else round(least(100,spent*100.0/p_cost),2) end,
    'remainingTokens',greatest(0,p_tokens-used-held),'remainingCost',greatest(0,p_cost-spent-held_cost),
    'resetsAt',p_end) from sums
$$;

create function public.ai_token_budgets(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare cfg jsonb; limits jsonb; d jsonb; m jsonb;
  ds timestamptz := date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
  ms timestamptz := date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
begin
  select document into cfg from public.ai_token_configuration where singleton;
  if cfg is null then raise exception 'ai_policy_unconfigured'; end if;
  limits := cfg->'offers'->public.ai_token_offer(p_profile_id);
  if limits is null then raise exception 'ai_policy_unconfigured'; end if;
  d := public.ai_token_window(p_profile_id,ds,ds+interval '1 day',(limits->>'dailyTokens')::bigint,(limits->>'dailyNanoEur')::bigint);
  m := public.ai_token_window(p_profile_id,ms,(date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC',(limits->>'monthlyTokens')::bigint,(limits->>'monthlyNanoEur')::bigint);
  return jsonb_build_object('daily',d,'monthly',m,'updatedAt',now(), 'blocked',
    not (cfg->>'enabled')::boolean or (d->>'remainingTokens')::bigint=0 or (m->>'remainingTokens')::bigint=0
    or (d->>'remainingCost')::bigint=0 or (m->>'remainingCost')::bigint=0
    or exists(select 1 from public.ai_token_ledger where user_id=p_profile_id and budget_anomaly));
end $$;

create function public.ai_token_result(p_id uuid,p_replayed boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id',id,'operation',operation,'status',status,'replayed',p_replayed,
    'budgets',public.ai_token_budgets(user_id)) from public.ai_token_ledger where id=p_id
$$;

create function public.ai_token_command(p_profile_id uuid,p_action text,p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg public.ai_token_configuration; s public.entitlement_snapshots; r public.ai_token_ledger;
  b jsonb; model_cfg jsonb; op text := p_data->>'operation'; min_version text;
  n bigint; out_n bigint; cost bigint; it bigint; ot bigint;
begin
  -- One lock for BOTH operations and ALL devices/keys. Settlement uses the same lock.
  perform pg_advisory_xact_lock(hashtextextended('ai-tokens:'||p_profile_id::text,0));
  select * into cfg from public.ai_token_configuration where singleton for share;
  if cfg.version is null then raise exception 'ai_policy_unconfigured'; end if;
  if p_action='usage' then return public.ai_token_budgets(p_profile_id); end if;

  if p_action in ('settle','uncertain','status','release') then
    select * into r from public.ai_token_ledger where user_id=p_profile_id and
      (case when p_action='status' then key_hash=p_data->>'keyHash' else id=(p_data->>'id')::uuid end) for update;
    if r.id is null then raise exception 'ai_request_missing'; end if;
    if p_action='settle' then
      it := (p_data->>'inputTokens')::bigint; ot := (p_data->>'outputTokens')::bigint;
      if it is null or ot is null or it<0 or ot<0 or it+ot<1 or it+ot>10000000
        or it+ot<>(p_data->>'totalTokens')::bigint or coalesce(p_data->>'responseId','')='' then raise exception 'ai_usage_invalid'; end if;
      if r.status='succeeded' then
        if r.input_tokens<>it or r.output_tokens<>ot or r.provider_response_id<>p_data->>'responseId' then raise exception 'ai_usage_conflict'; end if;
      elsif r.status='released' then raise exception 'ai_request_released';
      else
        update public.ai_token_ledger set status='succeeded', input_tokens=it,output_tokens=ot,
          provider_response_id=p_data->>'responseId',settled_at=now(),
          budget_anomaly=(it>reserved_input or ot>reserved_output) where id=r.id;
      end if;
    elsif p_action='uncertain' and r.status='reserved' then
      update public.ai_token_ledger set status='uncertain' where id=r.id;
    elsif p_action='release' and r.status='reserved' then
      -- Only explicit provider rejection before generation; no client cancellation/refund RPC.
      update public.ai_token_ledger set status='released',settled_at=now() where id=r.id;
    end if;
    return public.ai_token_result(r.id,p_action='status' or r.status='succeeded');
  end if;

  if p_action not in ('policy','lookup','reserve') or op not in ('short_action','pdf_import') then raise exception 'ai_policy_invalid'; end if;
  select * into s from public.current_entitlement_snapshot(p_profile_id);
  if s.id is null or not exists(select 1 from jsonb_array_elements(s.payload->'entitlements') e
    where e->>'code'=case when op='short_action' then 'ai_short_action' else 'ai_pdf_import' end and e->>'enabled'='true') then
    raise exception 'ai_entitlement_missing'; end if;
  if not exists(select 1 from public.devices where user_id=p_profile_id and status='active'
    and device_fingerprint_hash=p_data->>'deviceFingerprintHash' and platform=p_data->>'platform') then raise exception 'ai_device_inactive'; end if;
  select minimum_supported_version into min_version from public.client_compatibility_rules
    where platform=p_data->>'platform' and channel='stable' and effective_at<=now() order by effective_at desc limit 1;
  if coalesce(p_data->>'clientVersion','') !~ '^[0-9]+\.[0-9]+\.[0-9]+' or
    (min_version is not null and not public.semantic_version_at_least(p_data->>'clientVersion',min_version)) then raise exception 'client_update_required'; end if;
  b := public.ai_token_budgets(p_profile_id);
  if p_action='policy' then return jsonb_build_object('version',cfg.version,'models',cfg.document->'models','budgets',b); end if;
  select * into r from public.ai_token_ledger where user_id=p_profile_id and key_hash=p_data->>'keyHash';
  if r.id is not null then
    if r.operation<>op or r.fingerprint<>p_data->>'fingerprint' then raise exception 'ai_idempotency_conflict'; end if;
    return public.ai_token_result(r.id,true);
  end if;
  if p_action='lookup' then return null; end if;
  if cfg.version::text<>coalesce(p_data->>'version','') then raise exception 'ai_policy_changed'; end if;
  if (b->>'blocked')::boolean then raise exception 'ai_budget_exhausted'; end if;
  model_cfg := cfg.document->'models'->op;
  n := (p_data->>'inputTokens')::bigint; out_n := (model_cfg->>'maxOutputTokens')::bigint;
  if n is null or n<=256 or n>(model_cfg->>'maxInputTokens')::bigint+256 then raise exception 'ai_input_too_large'; end if;
  cost := n*(model_cfg->>'inputNanoEur')::bigint+out_n*(model_cfg->>'outputNanoEur')::bigint;
  if n+out_n>least((b#>>'{daily,remainingTokens}')::bigint,(b#>>'{monthly,remainingTokens}')::bigint)
    or cost>least((b#>>'{daily,remainingCost}')::bigint,(b#>>'{monthly,remainingCost}')::bigint) then raise exception 'ai_budget_exhausted'; end if;
  insert into public.ai_token_ledger(user_id,operation,key_hash,fingerprint,request_id,configuration_version,
    model,input_rate,output_rate,reserved_input,reserved_output)
    values(p_profile_id,op,p_data->>'keyHash',p_data->>'fingerprint',(p_data->>'requestId')::uuid,cfg.version,
      model_cfg->>'model',(model_cfg->>'inputNanoEur')::bigint,(model_cfg->>'outputNanoEur')::bigint,n,out_n) returning * into r;
  return public.ai_token_result(r.id,false);
end $$;

create function public.configure_ai_tokens(p_document jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare entry jsonb; result uuid;
begin
  if jsonb_typeof(p_document->'enabled')<>'boolean' then raise exception 'ai_configuration_invalid'; end if;
  foreach entry in array array[p_document#>'{models,short_action}',p_document#>'{models,pdf_import}'] loop
    if entry is null or coalesce(entry->>'model','') !~ '^[a-zA-Z0-9._-]{1,100}$'
      or coalesce((entry->>'inputNanoEur')::bigint,0) not between 1 and 1000000
      or coalesce((entry->>'outputNanoEur')::bigint,0) not between 1 and 1000000
      or coalesce((entry->>'maxInputTokens')::bigint,0) not between 1 and 200000
      or coalesce((entry->>'maxOutputTokens')::bigint,0) not between 16 and 64000 then raise exception 'ai_configuration_invalid'; end if;
  end loop;
  foreach entry in array array[p_document#>'{offers,discovery}',p_document#>'{offers,author_ai}',p_document#>'{offers,studio}'] loop
    if entry is null or coalesce((entry->>'dailyTokens')::bigint,-1) not between 0 and 100000000
      or coalesce((entry->>'monthlyTokens')::bigint,-1) not between 0 and 1000000000
      or coalesce((entry->>'dailyNanoEur')::bigint,-1) not between 0 and 1000000000000
      or coalesce((entry->>'monthlyNanoEur')::bigint,-1) not between 0 and 10000000000000 then raise exception 'ai_configuration_invalid'; end if;
  end loop;
  insert into public.ai_token_configuration(singleton,document) values(true,p_document)
    on conflict(singleton) do update set document=excluded.document,version=gen_random_uuid(),updated_at=now() returning version into result;
  return result;
end $$;

revoke all on function public.ai_token_offer(uuid),public.ai_token_window(uuid,timestamptz,timestamptz,bigint,bigint),public.ai_token_budgets(uuid),public.ai_token_result(uuid,boolean),public.ai_token_command(uuid,text,jsonb),public.configure_ai_tokens(jsonb) from public,anon,authenticated;
grant execute on function public.ai_token_command(uuid,text,jsonb),public.configure_ai_tokens(jsonb) to service_role;

-- Fail closed during rolling deployments: an old Worker cannot spend with request quotas.
revoke execute on function public.reserve_ai_quota(uuid,text,text,text,text,text,text,text,text,uuid) from service_role;
