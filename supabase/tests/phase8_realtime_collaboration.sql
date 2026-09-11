begin;
select plan(33);
select has_table('public','users','compatibility identity registry exists');
select ok((select relrowsecurity from pg_class where oid='public.users'::regclass),'compatibility identity registry has RLS enabled');
select has_table('public','studio_collaboration_operations','operation ledger exists');
select has_table('public','studio_collaboration_conflicts','conflict ledger exists');
select has_table('public','studio_collaboration_conflict_resolutions','conflict resolution ledger exists');
select has_table('public','studio_collaboration_snapshots','snapshot ledger exists');
select has_table('public','studio_collaboration_acknowledgements','cursor acknowledgement projection exists');
select has_table('public','studio_collaboration_tickets','ticket registry exists');
select has_table('public','studio_collaboration_compactions','compaction ledger exists');
select has_function('public','consume_studio_collaboration_ticket','atomic ticket consumption exists');
select has_function('public','append_studio_collaboration_operation','atomic operation append exists');
select has_function('public','ack_studio_collaboration_cursor','cursor acknowledgement RPC exists');
select has_function('public','commit_studio_collaboration_snapshot','idempotent compaction RPC exists');
select ok((select relrowsecurity from pg_class where oid='public.studio_collaboration_operations'::regclass),'operations RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.studio_collaboration_tickets'::regclass),'tickets RLS enabled');
select table_privs_are('public','users','authenticated',array[]::text[],'compatibility identity registry is not client-readable');
select function_privs_are('public','mirror_profile_identity_key',array[]::text[],'authenticated',array[]::text[],'compatibility trigger function is not client-callable');
select function_privs_are('public','append_studio_collaboration_operation',array['uuid','text','text','text','uuid','uuid','uuid','uuid','bigint','bigint','text','text','jsonb','text','uuid'],'authenticated',array[]::text[],'authenticated cannot append operations directly');
select function_privs_are('public','append_studio_collaboration_operation',array['uuid','text','text','text','uuid','uuid','uuid','uuid','bigint','bigint','text','text','jsonb','text','uuid'],'service_role',array['EXECUTE'],'service role alone executes operation append');
select function_privs_are('public','list_cloud_scenarios',array['uuid','text','text','text'],'authenticated',array[]::text[],'authenticated cannot call cloud list directly');
select function_privs_are('public','list_cloud_scenarios',array['uuid','text','text','text'],'service_role',array['EXECUTE'],'service role executes cloud list');
select function_privs_are('public','list_cloud_scenario_versions',array['uuid','text','text','text','uuid'],'authenticated',array[]::text[],'authenticated cannot call cloud version list directly');
select function_privs_are('public','list_cloud_scenario_versions',array['uuid','text','text','text','uuid'],'service_role',array['EXECUTE'],'service role executes cloud version list');
select function_privs_are('public','restore_cloud_scenario_version',array['uuid','text','text','text','uuid','uuid','text','uuid'],'authenticated',array[]::text[],'authenticated cannot restore directly');
select function_privs_are('public','restore_cloud_scenario_version',array['uuid','text','text','text','uuid','uuid','text','uuid'],'service_role',array['EXECUTE'],'service role executes restore');
select function_privs_are('public','soft_delete_cloud_scenario',array['uuid','text','text','text','uuid','text','uuid'],'authenticated',array[]::text[],'authenticated cannot delete cloud scenario directly');
select function_privs_are('public','soft_delete_cloud_scenario',array['uuid','text','text','text','uuid','text','uuid'],'service_role',array['EXECUTE'],'service role executes cloud delete');
select function_privs_are('public','get_cloud_storage_key',array['uuid','text','text','text','uuid','uuid'],'authenticated',array[]::text[],'authenticated cannot resolve storage key directly');
select function_privs_are('public','get_cloud_storage_key',array['uuid','text','text','text','uuid','uuid'],'service_role',array['EXECUTE'],'service role resolves storage key');
select is((
  select count(*)::integer
  from pg_constraint c
  join pg_class t on t.oid=c.conrelid
  where c.contype='f' and t.relname like 'studio_collaboration_%'
    and pg_get_constraintdef(c.oid) like '%REFERENCES profiles%'
),6,'new v8 identity foreign keys target canonical profiles');

insert into auth.users(id,email,raw_user_meta_data)
values('a8000000-0000-4000-8000-000000000001','phase8-owner@example.invalid','{}');
select is((
  select count(*)::integer from public.users u
  join public.profiles p on p.id=u.id
  where p.auth_user_id='a8000000-0000-4000-8000-000000000001'
),1,'new auth profile is mirrored into the private compatibility registry');

insert into public.cloud_scenarios(id,owner_id,title)
select 'a8000000-0000-4000-8000-000000000002',id,'Phase 8 ticket test'
from public.profiles where auth_user_id='a8000000-0000-4000-8000-000000000001';
insert into public.studios(id,scenario_id,name,created_by)
select 'a8000000-0000-4000-8000-000000000003','a8000000-0000-4000-8000-000000000002','Phase 8 ticket test',id
from public.profiles where auth_user_id='a8000000-0000-4000-8000-000000000001';
insert into public.studio_collaboration_tickets(ticket_hash,studio_id,profile_id,device_fingerprint_hash,origin_hash,expires_at)
select repeat('a',64),'a8000000-0000-4000-8000-000000000003',id,repeat('b',64),repeat('c',64),now()+interval '1 minute'
from public.profiles where auth_user_id='a8000000-0000-4000-8000-000000000001';
select is(public.consume_studio_collaboration_ticket(repeat('a',64),(select id from public.profiles where auth_user_id='a8000000-0000-4000-8000-000000000001'),repeat('b',64),repeat('c',64),'a8000000-0000-4000-8000-000000000003'),true,'ticket is consumed once');
select is(public.consume_studio_collaboration_ticket(repeat('a',64),(select id from public.profiles where auth_user_id='a8000000-0000-4000-8000-000000000001'),repeat('b',64),repeat('c',64),'a8000000-0000-4000-8000-000000000003'),false,'ticket replay is rejected');
select * from finish();
rollback;
