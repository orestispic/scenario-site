-- The root studio is both the original text channel and the project's access
-- administration. Deleting Version 1 must close its text channel, not its ACL UI.
create function public.authorize_studio_project_operation(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_studio_id uuid default null,p_roles text[] default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare scenario uuid;
begin
 select scenario_id into scenario from public.studios where id=p_studio_id;
 if exists(select 1 from public.project_branches where scenario_id=scenario and scenario_id<>project_id) then
  perform public.guard_project_branch(p_profile_id,scenario,p_roles is not null and not('viewer'=any(p_roles)));
 else
  perform 1 from public.studios where id=p_studio_id for update;
  perform 1 from public.cloud_scenarios where id=scenario for update;
 end if;
 return public.authorize_studio_operation_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,p_roles);
end $$;
-- Change only the authorization call in these established administration RPCs.
-- Text, tickets, ledger and metadata RPCs keep the strict version guard.
do $$ declare definition text;routine regprocedure;
begin
 for routine in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname=any(array['get_studio_detail','create_studio_invitation','revoke_studio_invitation','change_studio_member_role','remove_studio_member','list_studio_events']) loop
  definition:=pg_get_functiondef(routine);
  if position('public.authorize_studio_operation(' in definition)=0 then raise exception 'administration_authorization_missing';end if;
  execute replace(definition,'public.authorize_studio_operation(','public.authorize_studio_project_operation(');
 end loop;
end $$;
create function public.authorize_studio_version_v14(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_studio_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare authz jsonb;
begin
 authz:=public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,null);
 return jsonb_build_object('studioId',p_studio_id,'scenarioId',(select scenario_id from public.studios where id=p_studio_id),'role',authz->>'role');
end $$;
revoke all on function public.authorize_studio_project_operation(uuid,text,text,text,uuid,text[]) from public,anon,authenticated,service_role;
revoke all on function public.authorize_studio_version_v14(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.authorize_studio_version_v14(uuid,text,text,text,uuid) to service_role;
