import type { WorkerEnvironment } from './types.ts';

export function resolveSupabaseAdminKey(
  environment: Pick<
    WorkerEnvironment,
    'SUPABASE_SECRET_KEY' | 'SUPABASE_SERVICE_ROLE_KEY'
  >,
): string {
  const key =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error('Supabase server key is not configured.');
  return key;
}

export function supabaseAdminHeaders(
  environment: Pick<
    WorkerEnvironment,
    'SUPABASE_SECRET_KEY' | 'SUPABASE_SERVICE_ROLE_KEY'
  >,
): Record<string, string> {
  const key = resolveSupabaseAdminKey(environment);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    apikey: key,
  };

  // New sb_secret_ keys are opaque API keys, not JWTs. The legacy
  // service_role JWT remains supported during the documented transition.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}
