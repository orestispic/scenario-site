/* oxlint-disable typescript/no-floating-promises */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260911000000_auth_rls.sql", import.meta.url);
const migration = (await readFile(migrationUrl, "utf8")).toLowerCase();

const protectedTables = [
  "profiles",
  "subscriptions",
  "entitlement_snapshots",
  "activation_keys",
  "devices",
  "ai_usage_events",
  "cloud_scenarios",
  "cloud_scenario_versions",
  "scenario_collaborators",
  "reading_shares",
  "instagram_accounts",
  "instagram_publications",
  "audit_log",
];

describe("migration RLS", () => {
  it("active RLS sur toutes les tables utilisateur", () => {
    for (const table of protectedTables) {
      assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    }
  });

  it("lie les lectures directes au profil authentifié", () => {
    assert.match(migration, /profiles_select_own/);
    assert.match(migration, /auth_user_id = auth\.uid\(\)/);
    for (const table of ["subscriptions", "entitlement_snapshots", "devices", "ai_usage_events"]) {
      assert.match(migration, new RegExp(`create policy ${table}_select_own[\\s\\S]*?current_profile_id\\(\\)`));
    }
  });

  it("interdit les mutations commerciales directes", () => {
    assert.doesNotMatch(migration, /grant (insert|delete) on public\.(subscriptions|entitlement_snapshots|devices|offer_quotas|prices) to authenticated/);
    assert.doesNotMatch(migration, /grant update on public\.(subscriptions|entitlement_snapshots|devices|profiles) to authenticated/);
    assert.match(migration, /grant update \(display_name\) on public\.profiles to authenticated/);
    assert.match(migration, /grant execute on function public\.activate_device[\s\S]*to service_role/);
  });
});
