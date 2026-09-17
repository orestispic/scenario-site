-- Keep contact decisions and project access grants inside one transaction.
alter table public.studio_invitations add column recipient_profile_id uuid references public.profiles(id);

create function public.require_contact_pair_v16(p_host uuid,p_guest uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if p_host=p_guest or not exists(select 1 from public.profiles where id=p_guest and deleted_at is null)
    then raise exception 'contact_required'; end if;
  perform 1 from public.project_contacts where status='accepted'
    and profile_low_id=least(p_host,p_guest) and profile_high_id=greatest(p_host,p_guest) for share;
  if not found then raise exception 'contact_required'; end if;
end $$;

create or replace function public.require_project_contact_v15(p_profile_id uuid,p_email text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target uuid;
begin
  select id into target from public.profiles where lower(email::text)=lower(trim(p_email)) and deleted_at is null;
  if target is null then raise exception 'contact_required'; end if;
  perform public.require_contact_pair_v16(p_profile_id,target);
  return jsonb_build_object('allowed',true,'profileId',target);
end $$;

create function public.create_contact_project_invitation_v16(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_email_hash text,p_display_name text,
  p_studio_id uuid,p_recipient_email_hash text,p_recipient_profile_id uuid,p_recipient_masked text,p_role text,
  p_token_hash text,p_expires_at timestamptz,p_idempotency_hash text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  perform public.authorize_studio_project_operation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_studio_id,array['owner']);
  perform public.require_contact_pair_v16(p_profile_id,p_recipient_profile_id);
  result:=public.create_studio_invitation(p_profile_id,p_fingerprint_hash,p_platform,p_client_version,p_email_hash,p_display_name,
    p_studio_id,p_recipient_email_hash,p_recipient_masked,p_role,p_token_hash,p_expires_at,p_idempotency_hash,p_request_id);
  update public.studio_invitations set recipient_profile_id=p_recipient_profile_id where id=(result#>>'{invitation,id}')::uuid;
  return result;
end $$;

-- Both acceptance routes, including older invitations, check the contact again.
create function public.guard_contact_acceptance_v16() returns trigger
language plpgsql security definer set search_path=public as $$
declare host uuid;
begin
  if new.status='accepted' and old.status is distinct from new.status then
    select c.owner_id into host from public.studios s join public.cloud_scenarios c on c.id=s.scenario_id
      where s.id=new.studio_id and c.deleted_at is null for update of s;
    if host is null or (new.recipient_profile_id is not null and new.recipient_profile_id<>new.accepted_by)
      then raise exception 'contact_required'; end if;
    perform public.require_contact_pair_v16(host,new.accepted_by);
  end if;
  return new;
end $$;
create trigger contact_acceptance_guard before update of status on public.studio_invitations
for each row execute function public.guard_contact_acceptance_v16();

create or replace function public.remove_project_contact_v15(
  p_profile_id uuid,p_fingerprint_hash text,p_platform text,p_client_version text,p_contact_profile_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare s record; m public.studio_memberships; target uuid; request uuid:=gen_random_uuid();
begin
  perform public.authorize_project_reader_v10(p_profile_id,p_fingerprint_hash,p_platform,p_client_version);
  if p_profile_id=p_contact_profile_id then raise exception 'contact_not_found'; end if;
  -- Same parent-first order as project ACL/branch operations, before the contact.
  perform 1 from public.studios st join public.cloud_scenarios c on c.id=st.scenario_id
    where c.owner_id in(p_profile_id,p_contact_profile_id)
      and not exists(select 1 from public.project_branches b where b.scenario_id=c.id and b.project_id<>c.id)
    order by st.id for update of st;
  delete from public.project_contacts where status='accepted'
    and profile_low_id=least(p_profile_id,p_contact_profile_id) and profile_high_id=greatest(p_profile_id,p_contact_profile_id);
  if not found then raise exception 'contact_not_found'; end if;
  for s in select st.id,c.id scenario_id,c.owner_id from public.studios st join public.cloud_scenarios c on c.id=st.scenario_id
    where c.owner_id in(p_profile_id,p_contact_profile_id)
      and not exists(select 1 from public.project_branches b where b.scenario_id=c.id and b.project_id<>c.id) order by st.id loop
    target:=case when s.owner_id=p_profile_id then p_contact_profile_id else p_profile_id end;
    update public.studio_invitations set status='revoked',updated_at=now()
      where studio_id=s.id and recipient_profile_id=target and status='pending';
    update public.studio_memberships set status='revoked',revision=revision+1,updated_at=now()
      where studio_id=s.id and profile_id=target and status='active' returning * into m;
    if found then
      insert into public.studio_membership_revisions(studio_id,profile_id,display_name,role,status,revision,changed_by,request_id)
        values(m.studio_id,m.profile_id,m.display_name,m.role,m.status,m.revision,p_profile_id,request);
      perform public.append_studio_event(s.id,'membership.removed',target,p_profile_id,request);
    end if;
    update public.scenario_collaborators set status='revoked',updated_at=now()
      where scenario_id=s.scenario_id and user_id=target and status='active';
  end loop;
  return jsonb_build_object('updated',true);
end $$;

-- Trash recovery is owner-only. Deleted child versions keep their branch guard.
create or replace function public.guard_cloud_project_write_v9(p_profile_id uuid,p_scenario_id uuid,p_restore boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_restore and exists(select 1 from public.cloud_scenarios where id=p_scenario_id and owner_id=p_profile_id and deleted_at is not null)
    and not exists(select 1 from public.project_branches where scenario_id=p_scenario_id and project_id<>scenario_id) then
    perform public.guard_cloud_project_write_before_branches(p_profile_id,p_scenario_id,true);
  else
    perform public.guard_project_branch(p_profile_id,p_scenario_id,true);
    perform public.guard_cloud_project_write_before_branches(p_profile_id,p_scenario_id,p_restore);
  end if;
end $$;

revoke all on function public.require_contact_pair_v16(uuid,uuid),public.guard_contact_acceptance_v16() from public,anon,authenticated,service_role;
revoke all on function public.create_studio_invitation(uuid,text,text,text,text,text,uuid,text,text,text,text,timestamptz,text,uuid) from service_role;
revoke all on function public.create_contact_project_invitation_v16(uuid,text,text,text,text,text,uuid,text,uuid,text,text,text,timestamptz,text,uuid) from public,anon,authenticated;
grant execute on function public.create_contact_project_invitation_v16(uuid,text,text,text,text,text,uuid,text,uuid,text,text,text,timestamptz,text,uuid) to service_role;
