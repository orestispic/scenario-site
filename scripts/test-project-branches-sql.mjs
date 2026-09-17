import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFile, readdir } from 'node:fs/promises';

// Isolated PostgreSQL, never the hosted database. Supabase-owned auth primitives
// are shimmed; every application migration is executed without modifications.
const db = new PGlite({ extensions: { pgcrypto, citext } });
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}',deleted_at timestamptz,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create extension pgcrypto with schema extensions;
    create extension citext;`);
  const folder = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(folder)).filter(n => n.endsWith('.sql')).sort()) {
    try { await db.exec(await readFile(new URL(name, folder), 'utf8')); }
    catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
  }
  console.log('PASS all migrations applied to isolated PostgreSQL');
  await db.exec(`do $$ declare r text; fixture_email text; begin
    foreach r in array array['owner','editor','viewer'] loop
      fixture_email:='phase9-'||r||'-zblnsdyaoljnezxdidtx@example.com';
      insert into auth.users(id,email) values(gen_random_uuid(),fixture_email);
      perform public.grant_admin_offer(fixture_email::citext,'studio',null,'Isolated PostgreSQL test');
      insert into public.devices(user_id,device_fingerprint_hash,platform)
        select id,repeat(substr(r,1,1),64),'windows' from public.profiles p where p.email=fixture_email::citext;
    end loop;
  end $$;`);
  await db.exec(`insert into public.project_contacts(requester_profile_id,recipient_profile_id,profile_low_id,profile_high_id,status,accepted_at)
    select a.id,b.id,least(a.id,b.id),greatest(a.id,b.id),'accepted',now() from public.profiles a cross join public.profiles b
    where a.email='phase9-owner-zblnsdyaoljnezxdidtx@example.com' and b.email in('phase9-editor-zblnsdyaoljnezxdidtx@example.com','phase9-viewer-zblnsdyaoljnezxdidtx@example.com');`);
  for (const name of ['project_metadata_transaction.sql', 'project_branches_transaction.sql', 'release_security_transaction.sql', 'device_license_transaction.sql']) {
    const sql = await readFile(new URL(`../supabase/tests/${name}`, import.meta.url), 'utf8');
    await db.exec('begin');
    await db.exec(sql);
    await db.exec('rollback');
    console.log(`PASS ${name} (rolled back)`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await db.close(); }
