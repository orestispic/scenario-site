-- Run only on disposable local or explicitly isolated linked Supabase test.
begin;
set local role postgres;
set local search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(10);
select ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'), 'RLS on every public table');
select ok(not has_table_privilege('authenticated', 'public.entitlement_snapshots', 'INSERT'), 'no client grant insertion');
select ok(not has_table_privilege('authenticated', 'public.activation_keys', 'SELECT'), 'key hashes inaccessible');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE'), 'role escalation denied');
select ok(not has_column_privilege('authenticated', 'public.instagram_accounts', 'encrypted_access_token', 'SELECT'), 'provider token ciphertext inaccessible');
select ok(not has_function_privilege('authenticated', 'public.apply_verified_stripe_event(text,text,timestamptz,jsonb,text)', 'EXECUTE'), 'no forged webhooks');
select ok(not has_function_privilege('service_role', 'public.apply_verified_stripe_event_phase3(text,text,timestamptz,jsonb,text)', 'EXECUTE'), 'legacy RPC cannot bypass hardening');
select ok(has_function_privilege('service_role', 'public.current_entitlement_snapshot(uuid)', 'EXECUTE'), 'server current entitlement access');
insert into auth.users(id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'rls-owner@example.invalid', '{}'),
  ('a0000000-0000-4000-8000-000000000002', 'rls-other@example.invalid', '{}');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-000000000001', true);
select is((select count(*)::integer from public.profiles), 1, 'owner sees only own profile');
select is((select count(*)::integer from public.profiles where auth_user_id = 'a0000000-0000-4000-8000-000000000002'), 0, 'cross-account profile denied');
select * from finish();
rollback;
