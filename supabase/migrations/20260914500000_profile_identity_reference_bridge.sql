-- Phase 8 corrective bridge for the immutable phase 0-7 migration chain.
-- Phase 2 renamed public.users to public.profiles, while the immutable phase 6
-- and phase 7 migrations still declare foreign keys against public.users.
-- Keep a private identity-key registry so fresh databases can replay the
-- historical migrations without weakening the canonical profiles table.

create table public.users (
  id uuid primary key references public.profiles(id) on delete cascade
);

insert into public.users(id)
select id from public.profiles
on conflict (id) do nothing;

create or replace function public.mirror_profile_identity_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users(id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger profiles_mirror_identity_key
after insert on public.profiles
for each row execute function public.mirror_profile_identity_key();

alter table public.users enable row level security;
revoke all on public.users from anon, authenticated;
revoke all on function public.mirror_profile_identity_key() from public, anon, authenticated;

comment on table public.users is
  'Private FK compatibility registry. public.profiles remains the canonical identity table.';
