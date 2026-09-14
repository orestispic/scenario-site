-- Avoid SHARE -> UPDATE upgrades when concurrent metadata writes target Version 1.
-- One short transaction lock per project also serializes ACL and branch changes.
create or replace function public.guard_project_branch(p_profile_id uuid,p_scenario_id uuid,p_write boolean default false)
returns void language plpgsql security definer set search_path=public as $$
declare b public.project_branches;p public.cloud_scenarios;r text;
begin
 select * into b from public.project_branches where scenario_id=p_scenario_id;
 if not found then return;end if;
 perform 1 from public.studios where scenario_id=b.project_id for update;
 select * into p from public.cloud_scenarios where id=b.project_id for update;
 select * into b from public.project_branches where id=b.id for share;
 if p.deleted_at is not null or b.deleted_at is not null then raise exception 'studio_not_found';end if;
 r:=case when p.owner_id=p_profile_id then 'owner' else (select role from public.scenario_collaborators where scenario_id=p.id and user_id=p_profile_id and status='active') end;
 if r is null or (p_write and r='viewer') then raise exception 'studio_not_found';end if;
end $$;

-- Sharing always applies to the visible parent, never to an internal backing
-- scenario. Both old and new entry points retain the same parent-first lock order.
alter function public.ensure_project_sharing_v9(uuid,text,text,text,text,text,uuid,text,uuid) rename to ensure_project_sharing_before_branches;
create function public.ensure_project_sharing_v9(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_scenario_id uuid,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.project_branches where scenario_id=p_scenario_id and project_id<>scenario_id) then raise exception 'project_not_found';end if;
 perform pg_advisory_xact_lock(hashtextextended('studio-create:'||p_scenario_id::text,0));
 perform 1 from public.studios where scenario_id=p_scenario_id for update;
 perform 1 from public.cloud_scenarios where id=p_scenario_id for update;
 return public.ensure_project_sharing_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_email_hash,p_display_name,p_scenario_id,p_idempotency_hash,p_request_id);
end $$;
alter function public.create_studio(uuid,text,text,text,text,text,uuid,text,text,uuid) rename to create_studio_before_branches;
create function public.create_studio(p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,p_scenario_id uuid,p_name text,p_idempotency_hash text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.project_branches where scenario_id=p_scenario_id and project_id<>scenario_id) then raise exception 'studio_not_found';end if;
 perform pg_advisory_xact_lock(hashtextextended('studio-create:'||p_scenario_id::text,0));
 perform 1 from public.studios where scenario_id=p_scenario_id for update;
 perform 1 from public.cloud_scenarios where id=p_scenario_id for update;
 return public.create_studio_before_branches(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_email_hash,p_display_name,p_scenario_id,p_name,p_idempotency_hash,p_request_id);
end $$;
revoke all on function public.ensure_project_sharing_before_branches(uuid,text,text,text,text,text,uuid,text,uuid),public.create_studio_before_branches(uuid,text,text,text,text,text,uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.ensure_project_sharing_v9(uuid,text,text,text,text,text,uuid,text,uuid),public.create_studio(uuid,text,text,text,text,text,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.ensure_project_sharing_v9(uuid,text,text,text,text,text,uuid,text,uuid),public.create_studio(uuid,text,text,text,text,text,uuid,text,text,uuid) to service_role;
