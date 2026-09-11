begin;
set local role postgres;
set local search_path = public, extensions;
select plan(12);

select has_table('public','cloud_idempotency_keys','phase 6 idempotency ledger exists');
select col_is_pk('public','cloud_scenarios','id','scenario id stays stable');
select has_index('public','cloud_scenario_versions','cloud_scenario_versions_request_id_idx','request id is indexed uniquely');
select has_trigger('public','cloud_scenario_versions','cloud_scenario_versions_immutable','versions are append-only');
select has_function('public','authorize_cloud_operation',array['uuid','text','text','text'],'cloud authorization is server-side');
select has_function('public','sync_cloud_scenario',array['uuid','text','text','text','jsonb','text','text','text','uuid'],'sync is atomic');
select has_function('public','restore_cloud_scenario_version',array['uuid','text','text','text','uuid','uuid','text','uuid'],'restore appends a version');
select policies_are('public','cloud_scenarios',array['cloud_scenarios_select_member'],'scenario RLS is explicit');
select policies_are('public','cloud_idempotency_keys',array[]::text[],'idempotency ledger has no client policy');
select table_privs_are('public','cloud_idempotency_keys','authenticated',array[]::text[],'authenticated cannot mutate ledger');
select function_privs_are('public','sync_cloud_scenario',array['uuid','text','text','text','jsonb','text','text','text','uuid'],'authenticated',array[]::text[],'authenticated cannot call service RPC');
select function_privs_are('public','sync_cloud_scenario',array['uuid','text','text','text','jsonb','text','text','text','uuid'],'service_role',array['EXECUTE'],'service role alone executes sync');

select * from finish();
rollback;
