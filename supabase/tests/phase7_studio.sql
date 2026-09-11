begin;
select plan(12);

select has_table('public','studios','studios exists');
select has_table('public','studio_memberships','current membership projection exists');
select has_table('public','studio_membership_revisions','append-only membership journal exists');
select has_table('public','studio_invitations','hashed invitations exist');
select has_table('public','studio_events','monotonic event journal exists');
select has_table('public','studio_idempotency_keys','idempotency registry exists');
select col_is_pk('public','studio_events','cursor','event cursor is monotonic primary key');
select col_is_unique('public','studio_invitations','token_hash','invitation hash is unique');
select ok((select relrowsecurity from pg_class where oid='public.studios'::regclass),'studios RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.studio_memberships'::regclass),'memberships RLS enabled');
select ok((select relrowsecurity from pg_class where oid='public.studio_invitations'::regclass),'invitations RLS enabled');
select function_privs_are('public','accept_studio_invitation',array['uuid','text','text','text','text','text','text','text','uuid'],'service_role',array['EXECUTE'],'accept RPC limited to service role');

select * from finish();
rollback;
