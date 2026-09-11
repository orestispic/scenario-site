begin;
set local role postgres;
set local search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(8);
select ok(to_regclass('public.ai_quota_reservations') is not null, 'reservation table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.ai_quota_reservations'::regclass), 'reservation RLS enabled');
select ok(to_regprocedure('public.reserve_ai_quota(uuid,text,text,text,text,text,text,text,text,uuid)') is not null, 'reservation RPC exists');
select ok(not has_function_privilege('authenticated', 'public.reserve_ai_quota(uuid,text,text,text,text,text,text,text,text,uuid)', 'EXECUTE'), 'client cannot reserve quota directly');
select ok(not has_function_privilege('authenticated', 'public.confirm_ai_quota(uuid,uuid)', 'EXECUTE'), 'client cannot confirm usage');
select ok(not has_table_privilege('authenticated', 'public.ai_quota_reservations', 'SELECT'), 'reservations are server-only');
select ok(exists(select 1 from pg_trigger where tgrelid = 'public.ai_usage_events'::regclass and tgname = 'ai_usage_events_immutable'), 'usage is append-only');
select results_eq(
  $$ select public.semantic_version_at_least('0.1.7', '0.1.7') $$,
  array[true],
  'minimum version comparison accepts equality'
);
select * from finish();
rollback;
