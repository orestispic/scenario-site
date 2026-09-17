import { AuthenticationError } from './jwt.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';
import { detachedFetch } from './detachedFetch.ts';

/** JWT signatures alone do not detect logout or an administratively suspended account. */
export function createActiveSessionCheck(environment: WorkerEnvironment, fetcher: typeof fetch = fetch) {
  return async (authUserId: string, sessionId: string): Promise<void> => {
    try {
      const response = await detachedFetch(fetcher, `${environment.SUPABASE_URL}/rest/v1/rpc/is_account_session_active_v16`, {
        method: 'POST',
        headers: { ...supabaseAdminHeaders(environment), 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_auth_user_id: authUserId, p_session_id: sessionId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Session check unavailable');
      if (await response.json() !== true) throw new AuthenticationError('Session expirée. Reconnectez-vous.');
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new CommercialRepositoryError(503, 'authentication_unavailable', 'Service de session temporairement indisponible.');
    }
  };
}
