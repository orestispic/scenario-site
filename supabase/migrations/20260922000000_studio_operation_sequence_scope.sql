-- A v8 client_sequence is local to a client instance, not to a profile forever.
-- Reloads and simultaneous devices legitimately reuse sequence 1. Operation UUID
-- plus checksum remain the idempotency key; logical_clock resolves ordering.
-- No historical operation, checksum, cursor, actor or policy is changed.
do $$
declare constraint_name text;
begin
  select conname into strict constraint_name
  from pg_constraint
  where conrelid = 'public.studio_collaboration_operations'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (studio_id, actor_profile_id, client_sequence)';
  execute format('alter table public.studio_collaboration_operations drop constraint %I', constraint_name);
end $$;

create index studio_collaboration_actor_sequence_lookup_idx
  on public.studio_collaboration_operations(studio_id,actor_profile_id,client_sequence);

comment on column public.studio_collaboration_operations.client_sequence is
  'v8 client-instance sequence, not globally unique per actor; operation_id and checksum provide idempotency.';
