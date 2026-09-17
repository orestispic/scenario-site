-- An invitation is an access grant from a Studio owner, not a subscription
-- grant for its recipient. A confirmed Senario account may therefore accept a
-- viewer invitation and consult that single project without owning Studio.
-- Creation, management and every write continue to require the paid rights.

create or replace function public.authorize_project_reader_v10(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_minimum text;
begin
  if p_client_version !~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' then raise exception 'invalid_client_version'; end if;
  if not exists(select 1 from public.devices where user_id=p_profile_id and device_fingerprint_hash=p_fingerprint_hash and platform=p_platform and status='active')
    then raise exception 'cloud_device_inactive'; end if;
  select minimum_supported_version into v_minimum from public.client_compatibility_rules
    where platform=p_platform and channel='stable' and effective_at<=now() order by effective_at desc limit 1;
  if v_minimum is not null and not public.semantic_version_at_least(p_client_version,v_minimum)
    then raise exception 'client_update_required'; end if;
  return jsonb_build_object('profileId',p_profile_id);
end $$;

create or replace function public.has_cloud_project_entitlement_v10(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.current_entitlement_snapshot(p_profile_id) s,
      jsonb_array_elements(coalesce(s.payload->'entitlements','[]'::jsonb)) sync,
      jsonb_array_elements(coalesce(s.payload->'entitlements','[]'::jsonb)) versions
    where sync->>'code' in ('cloud_sync','cloud.sync')
      and coalesce((sync->>'enabled')::boolean,false)
      and versions->>'code'='scenario_versions'
      and coalesce((versions->>'enabled')::boolean,false)
  )
$$;

create or replace function public.has_studio_collaboration_entitlement_v10(p_profile_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.current_entitlement_snapshot(p_profile_id) s,
      jsonb_array_elements(coalesce(s.payload->'entitlements','[]'::jsonb)) entitlement
    where entitlement->>'code'='studio_collaboration'
      and coalesce((entitlement->>'enabled')::boolean,false)
  )
$$;

create or replace function public.authorize_cloud_project_read_v10(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_project public.cloud_scenarios; v_role text;
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select * into v_project from public.cloud_scenarios where id=p_scenario_id;
  if v_project.id is null then raise exception 'scenario_not_found'; end if;
  if v_project.owner_id=p_profile_id then
    perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
    v_role:='owner';
  else
    select role into v_role from public.scenario_collaborators
      where scenario_id=p_scenario_id and user_id=p_profile_id and status='active';
    if v_role is null then raise exception 'scenario_not_found'; end if;
  end if;
  return jsonb_build_object('role',v_role);
end $$;

-- The Cloud workspace must open for a guest before acceptance so that its
-- pending invitation is visible. Owners still need Cloud rights; members are
-- listed solely through an active, per-project collaborator grant.
create or replace function public.list_cloud_projects_v9(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_cloud boolean; v_collaboration boolean; v_projects jsonb; v_invites jsonb;
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  v_cloud:=public.has_cloud_project_entitlement_v10(p_profile_id);
  v_collaboration:=v_cloud and public.has_studio_collaboration_entitlement_v10(p_profile_id);
  select coalesce(jsonb_agg(public.cloud_scenario_json(c,p_profile_id)||jsonb_build_object(
      'sharing',case when counts.members>1 then 'shared' else 'private' end,
      'memberCount',counts.members,
      'realtimeStudioId',case when v_collaboration and exists(select 1 from public.studio_memberships m where m.studio_id=s.id and m.profile_id=p_profile_id and m.status='active') then s.id else null end,
      'realtimeBaseVersionId',case when v_collaboration and exists(select 1 from public.studio_memberships m where m.studio_id=s.id and m.profile_id=p_profile_id and m.status='active') then coalesce(s.project_base_version_id,(select v.id from public.cloud_scenario_versions v where v.scenario_id=c.id and v.parent_version_id is null order by v.version_number limit 1)) else null end,
      'canShare',v_collaboration and c.owner_id=p_profile_id and c.deleted_at is null
    ) order by c.updated_at desc),'[]'::jsonb) into v_projects
    from public.cloud_scenarios c left join public.studios s on s.scenario_id=c.id
    cross join lateral (select 1+count(*)::int as members from public.scenario_collaborators sc where sc.scenario_id=c.id and sc.status='active' and sc.user_id<>c.owner_id) counts
    where ((v_cloud and c.owner_id=p_profile_id) or exists(select 1 from public.scenario_collaborators sc where sc.scenario_id=c.id and sc.user_id=p_profile_id and sc.status='active'))
      and not exists(select 1 from public.project_branches b where b.scenario_id=c.id and b.scenario_id<>b.project_id);
  select coalesce(jsonb_agg(public.studio_invitation_json(i) order by i.created_at desc),'[]'::jsonb) into v_invites
    from public.studio_invitations i join public.studios s on s.id=i.studio_id join public.cloud_scenarios c on c.id=s.scenario_id
    where i.recipient_email_hash=p_email_hash and i.status='pending' and i.expires_at>now() and c.deleted_at is null;
  return jsonb_build_object('projects',v_projects,'receivedInvitations',v_invites);
end $$;

create or replace function public.list_cloud_scenarios(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_cloud boolean; v_result jsonb;
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  v_cloud:=public.has_cloud_project_entitlement_v10(p_profile_id);
  select coalesce(jsonb_agg(public.cloud_scenario_json(s,p_profile_id) order by s.updated_at desc),'[]'::jsonb) into v_result
    from public.cloud_scenarios s
    where (v_cloud and s.owner_id=p_profile_id) or exists(select 1 from public.scenario_collaborators c where c.scenario_id=s.id and c.user_id=p_profile_id and c.status='active');
  return v_result;
end $$;

create or replace function public.list_cloud_scenario_versions(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  perform public.authorize_cloud_project_read_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id);
  select coalesce(jsonb_agg(public.cloud_version_json(v) order by v.version_number desc),'[]'::jsonb) into v_result
    from public.cloud_scenario_versions v where v.scenario_id=p_scenario_id;
  return v_result;
end $$;

-- Keep the established branch guard but replace its entitlement-only download
-- check by the project-scoped reader check above.
alter function public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid) rename to get_cloud_storage_key_before_guest_read_v10;
create function public.get_cloud_storage_key(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_key text;
begin
  perform public.authorize_cloud_project_read_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id);
  perform public.guard_project_branch(p_profile_id,p_scenario_id,false);
  select storage_key into v_key from public.cloud_scenario_versions where scenario_id=p_scenario_id and id=p_version_id;
  if v_key is null then raise exception 'scenario_version_not_found'; end if;
  return to_jsonb(v_key);
end $$;

-- Version listing is the last read endpoint used when opening a project. Only
-- its list action is relaxed; every mutation remains delegated to the prior,
-- entitlement-protected v14 implementation.
alter function public.project_branches_v14(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid) rename to project_branches_v14_before_guest_read_v10;
create function public.project_branches_v14(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_project_id uuid,p_command jsonb,p_fingerprint text,p_artifact jsonb,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.cloud_scenarios; role_name text;
begin
  if p_command->>'action'<>'list' then
    return public.project_branches_v14_before_guest_read_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_project_id,p_command,p_fingerprint,p_artifact,p_request_id);
  end if;
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform 1 from public.studios where scenario_id=p_project_id for update;
  select * into p from public.cloud_scenarios where id=p_project_id for update;
  if p.id is null or p.deleted_at is not null or exists(select 1 from public.project_branches where scenario_id=p.id and project_id<>p.id) then raise exception 'project_not_found'; end if;
  role_name:=case when p.owner_id=p_profile_id then 'owner' else (select role from public.scenario_collaborators where scenario_id=p.id and user_id=p_profile_id and status='active') end;
  if role_name is null then raise exception 'project_not_found'; end if;
  if role_name='owner' then perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version); end if;
  insert into public.project_branches(id,project_id,scenario_id,name) values(p.id,p.id,p.id,'Version 1') on conflict(scenario_id) do nothing;
  return jsonb_build_object('versions',(select jsonb_agg(public.project_branch_json(v,p_profile_id) order by v.created_at,v.id) from public.project_branches v where v.project_id=p.id));
end $$;

create or replace function public.respond_project_invitation_v9(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_invitation_id uuid,p_decision text,p_idempotency_hash text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_invite public.studio_invitations; v_studio public.studios; v_member public.studio_memberships; v_existing public.studio_idempotency_keys; v_result jsonb; v_next bigint; v_fingerprint text;
begin
  if p_decision not in ('accept','decline') then raise exception 'invitation_not_pending'; end if;
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform pg_advisory_xact_lock(hashtextextended('project-invitation:'||p_profile_id::text||':'||p_idempotency_hash,0));
  v_fingerprint:='project-v9:'||p_invitation_id::text||':'||p_decision;
  select * into v_invite from public.studio_invitations where id=p_invitation_id;
  if v_invite.id is null or v_invite.recipient_email_hash<>p_email_hash then raise exception 'project_not_found'; end if;
  select * into v_studio from public.studios where id=v_invite.studio_id for update;
  if not exists(select 1 from public.cloud_scenarios where id=v_studio.scenario_id and deleted_at is null) then raise exception 'project_not_found'; end if;
  select * into v_invite from public.studio_invitations where id=p_invitation_id for update;
  select * into v_existing from public.studio_idempotency_keys where profile_id=p_profile_id and idempotency_hash=p_idempotency_hash;
  if v_existing.profile_id is not null then
    if v_existing.request_fingerprint<>v_fingerprint then raise exception 'studio_idempotency_conflict'; end if;
    return v_existing.response||jsonb_build_object('replayed',true);
  end if;
  if v_invite.status<>'pending' then raise exception 'invitation_not_pending'; end if;
  if v_invite.expires_at<=now() then raise exception 'invitation_expired'; end if;
  if p_decision='accept' then
    if v_invite.role<>'viewer' and not public.has_studio_collaboration_entitlement_v10(p_profile_id) then raise exception 'studio_entitlement_missing'; end if;
    select * into v_member from public.studio_memberships where studio_id=v_studio.id and profile_id=p_profile_id for update;
    if v_member.status='active' then raise exception 'invitation_not_pending'; end if;
    v_next:=coalesce(v_member.revision,0)+1;
    insert into public.studio_memberships values(v_studio.id,p_profile_id,p_display_name,v_invite.role,'active',v_next,now())
      on conflict(studio_id,profile_id) do update set display_name=excluded.display_name,role=excluded.role,status='active',revision=excluded.revision,updated_at=now() returning * into v_member;
    insert into public.studio_membership_revisions(studio_id,profile_id,display_name,role,status,revision,changed_by,request_id)
      values(v_member.studio_id,v_member.profile_id,v_member.display_name,v_member.role,v_member.status,v_member.revision,p_profile_id,p_request_id);
    insert into public.scenario_collaborators(scenario_id,user_id,role,status,invited_by,updated_at)
      values(v_studio.scenario_id,p_profile_id,v_invite.role,'active',v_invite.created_by,now())
      on conflict(scenario_id,user_id) do update set role=excluded.role,status='active',updated_at=now();
    update public.studio_invitations set status='accepted',accepted_by=p_profile_id,accepted_at=now(),updated_at=now() where id=p_invitation_id;
    perform public.append_studio_event(v_studio.id,'invitation.accepted',p_invitation_id,p_profile_id,p_request_id);
  else
    update public.studio_invitations set status='declined',updated_at=now() where id=p_invitation_id;
    perform public.append_studio_event(v_studio.id,'invitation.declined',p_invitation_id,p_profile_id,p_request_id);
  end if;
  v_result:=jsonb_build_object('responded',true,'replayed',false);
  insert into public.studio_idempotency_keys values(p_profile_id,p_idempotency_hash,v_fingerprint,v_result,now());
  return v_result;
end $$;

revoke all on function public.authorize_project_reader_v10(uuid,text,text,text),public.has_cloud_project_entitlement_v10(uuid),public.has_studio_collaboration_entitlement_v10(uuid),public.authorize_cloud_project_read_v10(uuid,text,text,text,uuid),public.get_cloud_storage_key_before_guest_read_v10(uuid,text,text,text,uuid,uuid),public.project_branches_v14_before_guest_read_v10(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid) from public,anon,authenticated,service_role;
revoke all on function public.list_cloud_projects_v9(uuid,text,text,text,text,text),public.list_cloud_scenarios(uuid,text,text,text),public.list_cloud_scenario_versions(uuid,text,text,text,uuid),public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid),public.project_branches_v14(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid),public.respond_project_invitation_v9(uuid,text,text,text,text,text,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.list_cloud_projects_v9(uuid,text,text,text,text,text),public.list_cloud_scenarios(uuid,text,text,text),public.list_cloud_scenario_versions(uuid,text,text,text,uuid),public.get_cloud_storage_key(uuid,text,text,text,uuid,uuid),public.project_branches_v14(uuid,text,text,text,uuid,jsonb,text,jsonb,uuid),public.respond_project_invitation_v9(uuid,text,text,text,text,text,uuid,text,text,uuid) to service_role;
