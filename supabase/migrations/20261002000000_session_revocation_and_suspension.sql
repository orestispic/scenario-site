-- Service-only session validation; no auth schema rows are exposed to clients.
create function public.is_account_session_active_v16(p_auth_user_id uuid,p_session_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
    join public.profiles p on p.auth_user_id=u.id
    where s.id=p_session_id and s.user_id=p_auth_user_id
      and (s.not_after is null or s.not_after>now())
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
      and p.deleted_at is null)
$$;
revoke all on function public.is_account_session_active_v16(uuid,uuid) from public,anon,authenticated;
grant execute on function public.is_account_session_active_v16(uuid,uuid) to service_role;

create function public.contact_account_active_v16(p_profile_id uuid) returns boolean
language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles p join auth.users u on u.id=p.auth_user_id
    where p.id=p_profile_id and p.deleted_at is null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()))
$$;
revoke all on function public.contact_account_active_v16(uuid) from public,anon,authenticated,service_role;

create function public.guard_contact_accounts_v16() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if not public.contact_account_active_v16(new.requester_profile_id)
    or not public.contact_account_active_v16(new.recipient_profile_id)
    then raise exception 'contact_not_found';end if;
  return new;
end $$;
revoke all on function public.guard_contact_accounts_v16() from public,anon,authenticated,service_role;
create trigger contact_accounts_guard before insert or update of status on public.project_contacts
for each row execute function public.guard_contact_accounts_v16();

create or replace function public.require_contact_pair_v16(p_host uuid,p_guest uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if p_host=p_guest or not public.contact_account_active_v16(p_host)
    or not public.contact_account_active_v16(p_guest) then raise exception 'contact_required';end if;
  perform 1 from public.project_contacts where status='accepted'
    and profile_low_id=least(p_host,p_guest) and profile_high_id=greatest(p_host,p_guest) for share;
  if not found then raise exception 'contact_required';end if;
end $$;
