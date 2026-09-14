-- Preserve the original JSON scalar contract. Returning text coerces the JSON
-- string to a quoted storage path and breaks both legacy and branch downloads.
drop function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid);
create function public.get_cloud_storage_key(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 perform public.guard_project_branch(p_profile_id,p_scenario_id,false);
 return public.get_cloud_storage_key_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id,p_version_id);
end $$;
revoke all on function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) to service_role;
