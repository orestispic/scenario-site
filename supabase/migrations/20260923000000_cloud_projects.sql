-- Phase 10 / contract v9. A project IS a cloud_scenario; existing studios.scenario_id
-- is already UNIQUE. No account-wide memberships and no history rewrite.
-- Legacy channels retain their original root. New v9 sharing freezes the latest
-- private version, so edits written before sharing cannot disappear on joining.
alter table public.studios add column project_base_version_id uuid references public.cloud_scenario_versions(id);

create function public.validate_project_base_v9() returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op='UPDATE' and old.project_base_version_id is not null and old.project_base_version_id is distinct from new.project_base_version_id then raise exception 'base_version_unavailable'; end if;
  if new.project_base_version_id is not null and not exists(select 1 from public.cloud_scenario_versions where id=new.project_base_version_id and scenario_id=new.scenario_id) then raise exception 'base_version_unavailable'; end if;
  return new;
end $$;
create trigger validate_project_base_v9 before insert or update of project_base_version_id on public.studios for each row execute function public.validate_project_base_v9();
create function public.validate_operation_project_base_v9() returns trigger language plpgsql set search_path=public as $$
begin
  if exists(select 1 from public.studios where id=new.studio_id and project_base_version_id is not null and project_base_version_id<>new.base_version_id) then raise exception 'base_version_unavailable'; end if;
  return new;
end $$;
create trigger validate_operation_project_base_v9 before insert on public.studio_collaboration_operations for each row execute function public.validate_operation_project_base_v9();
revoke all on function public.validate_project_base_v9() from public,anon,authenticated;
revoke all on function public.validate_operation_project_base_v9() from public,anon,authenticated;

create or replace function public.list_cloud_projects_v9(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_auth jsonb; v_collaboration boolean; v_projects jsonb; v_invites jsonb;
begin
  v_auth:=public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  select exists(select 1 from public.entitlement_snapshots s, jsonb_array_elements(coalesce(s.payload->'entitlements','[]'::jsonb)) e
    where s.id=(v_auth->>'snapshotId')::uuid and e->>'code'='studio_collaboration' and coalesce((e->>'enabled')::boolean,false)) into v_collaboration;
  select coalesce(jsonb_agg(public.cloud_scenario_json(c,p_profile_id)||jsonb_build_object(
      'sharing',case when counts.members>1 then 'shared' else 'private' end,
      'memberCount',counts.members,
      'realtimeStudioId',case when v_collaboration and exists(select 1 from public.studio_memberships m where m.studio_id=s.id and m.profile_id=p_profile_id and m.status='active') then s.id else null end,
      'realtimeBaseVersionId',case when v_collaboration and exists(select 1 from public.studio_memberships m where m.studio_id=s.id and m.profile_id=p_profile_id and m.status='active') then coalesce(s.project_base_version_id,(select v.id from public.cloud_scenario_versions v where v.scenario_id=c.id and v.parent_version_id is null order by v.version_number limit 1)) else null end,
      'canShare',v_collaboration and c.owner_id=p_profile_id and c.deleted_at is null
    ) order by c.updated_at desc),'[]'::jsonb) into v_projects
    from public.cloud_scenarios c left join public.studios s on s.scenario_id=c.id
    cross join lateral (select 1+count(*)::int as members from public.scenario_collaborators sc where sc.scenario_id=c.id and sc.status='active' and sc.user_id<>c.owner_id) counts
    where c.owner_id=p_profile_id or exists(select 1 from public.scenario_collaborators sc where sc.scenario_id=c.id and sc.user_id=p_profile_id and sc.status='active');
  select coalesce(jsonb_agg(public.studio_invitation_json(i) order by i.created_at desc),'[]'::jsonb) into v_invites
    from public.studio_invitations i join public.studios s on s.id=i.studio_id join public.cloud_scenarios c on c.id=s.scenario_id
    where v_collaboration and i.recipient_email_hash=p_email_hash and i.status='pending' and i.expires_at>now() and c.deleted_at is null;
  return jsonb_build_object('projects',v_projects,'receivedInvitations',v_invites);
end $$;

create or replace function public.ensure_project_sharing_v9(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_scenario_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_studio public.studios; v_project public.cloud_scenarios; v_result jsonb;
begin
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform pg_advisory_xact_lock(hashtextextended('studio-create:'||p_scenario_id::text,0));
  select * into v_project from public.cloud_scenarios where id=p_scenario_id and owner_id=p_profile_id and deleted_at is null for update;
  if v_project.id is null then raise exception 'project_not_found'; end if;
  select * into v_studio from public.studios where scenario_id=p_scenario_id;
  if v_studio.id is not null then
    perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,v_studio.id,array['owner']);
    return jsonb_build_object('studio',public.studio_space_json(v_studio,p_profile_id),'replayed',true);
  end if;
  v_result:=public.create_studio(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_email_hash,p_display_name,p_scenario_id,left(v_project.title,120),p_idempotency_hash,p_request_id);
  update public.studios set project_base_version_id=v_project.current_version_id where id=(v_result#>>'{studio,id}')::uuid;
  return v_result;
end $$;

-- The id is not a credential. The Worker derives p_email_hash from verified Auth.
-- This RPC never returns an invitation token and is executable only by service_role.
create or replace function public.respond_project_invitation_v9(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_invitation_id uuid,p_decision text,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_invite public.studio_invitations; v_studio public.studios; v_member public.studio_memberships; v_existing public.studio_idempotency_keys; v_result jsonb; v_next bigint; v_fingerprint text;
begin
  if p_decision not in ('accept','decline') then raise exception 'invitation_not_pending'; end if;
  perform public.authorize_studio_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
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
    select * into v_member from public.studio_memberships where studio_id=v_studio.id and profile_id=p_profile_id for update;
    -- A stale invitation must not downgrade an owner or overwrite a newer grant.
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

revoke all on function public.list_cloud_projects_v9(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.ensure_project_sharing_v9(uuid,text,text,text,text,text,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.respond_project_invitation_v9(uuid,text,text,text,text,text,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.list_cloud_projects_v9(uuid,text,text,text,text,text) to service_role;
grant execute on function public.ensure_project_sharing_v9(uuid,text,text,text,text,text,uuid,text,uuid) to service_role;
grant execute on function public.respond_project_invitation_v9(uuid,text,text,text,text,text,uuid,text,text,uuid) to service_role;

-- Authorize again BEFORE reading a historical idempotency result. Sharing
-- revocation and these writes serialize on the Studio row, including retries.
create function public.guard_cloud_project_write_v9(p_profile_id uuid,p_scenario_id uuid,p_restore boolean)
returns void language plpgsql security definer set search_path=public as $$
declare v_project public.cloud_scenarios;
begin
  perform 1 from public.studios where scenario_id=p_scenario_id for update;
  perform pg_advisory_xact_lock(hashtextextended('cloud:'||p_scenario_id::text,0));
  select * into v_project from public.cloud_scenarios where id=p_scenario_id for update;
  if v_project.id is null then
    if p_restore then raise exception 'scenario_not_found'; end if;
    return;
  end if;
  if v_project.owner_id<>p_profile_id and not exists(select 1 from public.scenario_collaborators where scenario_id=p_scenario_id and user_id=p_profile_id and status='active' and role='editor') then raise exception 'scenario_write_forbidden'; end if;
  if v_project.deleted_at is not null and (not p_restore or v_project.owner_id<>p_profile_id) then raise exception 'scenario_deleted'; end if;
end $$;

alter function public.sync_cloud_scenario(uuid,text,text,text,jsonb,text,text,text,uuid) rename to sync_cloud_scenario_v6_implementation;
create function public.sync_cloud_scenario(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_request jsonb,p_storage_key text,p_idempotency_hash text,p_request_fingerprint text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform public.guard_cloud_project_write_v9(p_profile_id,(p_request->>'scenarioId')::uuid,false);
  return public.sync_cloud_scenario_v6_implementation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_request,p_storage_key,p_idempotency_hash,p_request_fingerprint,p_request_id);
end $$;
alter function public.restore_cloud_scenario_version(uuid,text,text,text,uuid,uuid,text,uuid) rename to restore_cloud_scenario_version_v6_implementation;
create function public.restore_cloud_scenario_version(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_scenario_id uuid,p_version_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  perform public.authorize_cloud_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  perform public.guard_cloud_project_write_v9(p_profile_id,p_scenario_id,true);
  return public.restore_cloud_scenario_version_v6_implementation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_scenario_id,p_version_id,p_idempotency_hash,p_request_id);
end $$;
revoke all on function public.guard_cloud_project_write_v9(uuid,uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.sync_cloud_scenario_v6_implementation(uuid,text,text,text,jsonb,text,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.restore_cloud_scenario_version_v6_implementation(uuid,text,text,text,uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.sync_cloud_scenario(uuid,text,text,text,jsonb,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.restore_cloud_scenario_version(uuid,text,text,text,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sync_cloud_scenario(uuid,text,text,text,jsonb,text,text,text,uuid) to service_role;
grant execute on function public.restore_cloud_scenario_version(uuid,text,text,text,uuid,uuid,text,uuid) to service_role;
