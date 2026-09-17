do $$
declare
  v_profile uuid;
  v_snapshot uuid;
  v_device_one public.devices;
  v_device_two public.devices;
  v_challenge uuid;
  v_license uuid:=gen_random_uuid();
  v_error text;
begin
  select id into v_profile from public.profiles
  where email='phase9-owner-zblnsdyaoljnezxdidtx@example.com';
  select id into v_snapshot from public.current_entitlement_snapshot(v_profile);

  -- Replace the legacy fixture row, then prove the hard maximum of two.
  update public.devices set status='revoked',revoked_at=now() where user_id=v_profile;
  select * into v_device_one from public.activate_device_v2(
    v_profile,repeat('1',64),repeat('A',43),
    jsonb_build_object('kty','EC','crv','P-256','x',repeat('B',43),'y',repeat('C',43)),
    'windows','Premier appareil','0.1.12'
  );
  select * into v_device_two from public.activate_device_v2(
    v_profile,repeat('2',64),repeat('D',43),
    jsonb_build_object('kty','EC','crv','P-256','x',repeat('E',43),'y',repeat('F',43)),
    'macos','Deuxième appareil','0.1.12'
  );
  begin
    perform public.activate_device_v2(
      v_profile,repeat('3',64),repeat('G',43),
      jsonb_build_object('kty','EC','crv','P-256','x',repeat('H',43),'y',repeat('I',43)),
      'windows','Troisième appareil','0.1.12'
    );
    raise exception 'third_device_was_accepted';
  exception when others then
    get stacked diagnostics v_error=message_text;
    if v_error<>'device_limit_reached' then raise; end if;
  end;

  insert into public.device_challenges(user_id,device_id,purpose,nonce,expires_at)
    values(v_profile,v_device_one.id,'license_renewal',repeat('J',43),now()+interval '2 minutes')
    returning id into v_challenge;
  perform public.consume_device_challenge(v_profile,v_challenge,'license_renewal',v_device_one.id);
  begin
    perform public.consume_device_challenge(v_profile,v_challenge,'license_renewal',v_device_one.id);
    raise exception 'challenge_replay_was_accepted';
  exception when others then
    get stacked diagnostics v_error=message_text;
    if v_error<>'device_challenge_consumed' then raise; end if;
  end;

  insert into public.device_licenses(
    id,user_id,device_id,entitlement_snapshot_id,key_id,format_version,
    issued_at,entitlement_valid_until,offline_valid_until
  ) values(
    v_license,v_profile,v_device_one.id,v_snapshot,'test-key',2,
    now(),now()+interval '2 hours',now()+interval '1 hour'
  );
  perform public.deactivate_device_v2(v_profile,v_device_one.id);
  if not exists(select 1 from public.device_licenses where id=v_license and revoked_at is not null) then
    raise exception 'device_license_not_revoked';
  end if;
  if (select count(*) from public.devices where user_id=v_profile and status='active')<>1 then
    raise exception 'unexpected_active_device_count';
  end if;
end $$;
