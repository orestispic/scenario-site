-- Read the durable live projection, including annotations, without granting a
-- reader Studio entitlements or returning any storage key to the browser.
create function public.read_project_document_v16(
 p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare st public.studios; v public.cloud_scenario_versions; entries jsonb;
begin
 perform public.authorize_cloud_project_read_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id);
 perform public.guard_project_branch(p_profile_id,p_scenario_id,false);
 perform 1 from public.cloud_scenarios where id=p_scenario_id and deleted_at is null;
 if not found then raise exception 'project_not_found';end if;
 select * into st from public.studios where scenario_id=p_scenario_id for update;
 select * into v from public.cloud_scenario_versions where id=case when st.id is null then
   (select current_version_id from public.cloud_scenarios where id=p_scenario_id)
   else coalesce(st.project_base_version_id,(select id from public.cloud_scenario_versions where scenario_id=p_scenario_id and parent_version_id is null order by version_number limit 1)) end;
 if v.id is null then raise exception 'project_not_found';end if;
 select coalesce(jsonb_agg(jsonb_build_object('blockId',o.block_id,'operationId',o.operation_id,'actorId',o.actor_profile_id,'logicalClock',o.logical_clock,'tombstone',o.operation_type='block.delete','mutation',o.mutation)),'[]'::jsonb) into entries from
  (select distinct on(block_id) * from public.studio_collaboration_operations where studio_id=st.id and base_version_id=v.id order by block_id,logical_clock desc,actor_profile_id desc,operation_id desc) o;
 return jsonb_build_object('source',jsonb_build_object('storageKey',v.storage_key,'checksum',v.content_checksum,'sizeBytes',v.size_bytes,'entries',entries,
   'registers',(select registers from public.project_metadata_state where scenario_id=p_scenario_id)));
end $$;
revoke all on function public.read_project_document_v16(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.read_project_document_v16(uuid,text,text,text,uuid) to service_role;
