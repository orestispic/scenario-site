import type { SessionTokens, MeResponse } from './contracts-v2.ts';
import type { BillingOverviewResponse, CheckoutSessionResponse, BillingPortalResponse } from './contracts-v3.ts';
import { readPublicBetaCatalog } from './contracts-v11.ts';

export type BrowserAccountConfig = { apiBaseUrl: string; supabaseUrl: string; supabaseKey: string };

export function validateBrowserConfig(config: BrowserAccountConfig): boolean {
  try {
    const api = new URL(config.apiBaseUrl);
    const auth = new URL(config.supabaseUrl);
    return [api, auth].every((url) => url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === '/') &&
      /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.supabaseKey);
  } catch { return false; }
}

/** Take once, strip BEFORE any request/render. Confirmation remains explicit. */
export function takeRecoveryHash(url: URL, replace: (url: string) => void): string | null {
  const link = takeEmailLink(url, replace);
  return link?.type === 'recovery' ? link.tokenHash : null;
}

export type EmailLink = { type: 'recovery' | 'signup'; tokenHash: string };
export function takeEmailLink(url: URL, replace: (url: string) => void): EmailLink | null {
  const fragment = new URLSearchParams(url.hash.slice(1));
  const hash = fragment.get('token_hash') ?? url.searchParams.get('token_hash');
  const type = fragment.get('type') ?? url.searchParams.get('type');
  const sensitive = ['token_hash', 'access_token', 'refresh_token', 'code', 'error', 'error_description', 'type'];
  if (sensitive.some((key) => url.searchParams.has(key) || fragment.has(key))) {
    // No redirect/next parameter survives a recovery link.
    replace(`${url.pathname}#compte`);
  }
  return (type === 'recovery' || type === 'signup') && hash && /^[a-f0-9]{32,128}$/i.test(hash)
    ? { type, tokenHash: hash } : null;
}

export function safeStripeUrl(value: string, kind: 'checkout' | 'portal', testMode: boolean): string {
  const url = new URL(value);
  const host = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
  if (!testMode || url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password)
    throw new Error('Lien de paiement test refusé.');
  return url.href;
}

/** Access AND refresh tokens are memory-only; one renewal at a time.
 * Logout aborts all in-flight operations before revoking this session.
 * No automatic mutation retries after uncertain network responses.
 */
export class BrowserAccount {
  private session: SessionTokens | null = null;
  private generation = 0;
  private pending = new Set<AbortController>();
  private renewing: Promise<string> | null = null;
  constructor(private config: BrowserAccountConfig,
    private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {
    if (!validateBrowserConfig(config)) throw new Error('Espace compte non configuré.');
  }
  private async request<T>(url: string, body?: unknown, token?: string, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const epoch = this.generation;
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      // Native browser fetch must not receive BrowserAccount as its `this`.
      const fetcher = this.fetcher;
      const response = await fetcher(url, {
        method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json',
          ...(url.startsWith(`${this.config.supabaseUrl}/auth/v1/`) ? { apikey: this.config.supabaseKey } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (epoch !== this.generation) throw new Error('Session fermée.');
      if (!response.ok) {
        if (response.status === 401) throw new Error('Session expirée. Reconnectez-vous.');
        if (response.status === 429) throw new Error('Trop de demandes. Réessayez dans une minute.');
        throw new Error('Demande refusée. Vérifiez vos informations ou réessayez plus tard.');
      }
      const result = response.status === 204 ? undefined : await response.json();
      if (epoch !== this.generation) throw new Error('Session fermée.');
      return result as T;
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'))
        throw new Error('Connexion interrompue. Vérifiez le résultat avant de renouveler une demande.');
      throw error;
    } finally { clearTimeout(timer); this.pending.delete(controller); }
  }
  private auth<T>(path: string, body: unknown, token?: string, method?: string) {
    return this.request<T>(`${this.config.supabaseUrl}/auth/v1/${path}`, body, token, method);
  }
  private accept(value: unknown): string {
    const body = value as { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
    const expires = body.expires_at ? body.expires_at * 1_000 : this.now() + Number(body.expires_in) * 1_000;
    if (!body.access_token || !body.refresh_token || !Number.isFinite(expires) || expires <= this.now())
      throw new Error('Session invalide.');
    this.session = { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(expires).toISOString() };
    return body.access_token;
  }
  async signIn(email: string, password: string) {
    this.clear();
    this.accept(await this.auth('token?grant_type=password', { email, password }));
  }
  async signUp(email: string, password: string, displayName: string) {
    await this.auth('signup', { email, password, data: { display_name: displayName } });
  }
  async recover(email: string) { await this.auth('recover', { email }); }
  async confirmEmail(tokenHash: string) {
    if (!/^[a-f0-9]{32,128}$/i.test(tokenHash)) throw new Error('Lien de confirmation invalide.');
    this.clear();
    const epoch = this.generation;
    try { this.accept(await this.auth('verify', { token_hash: tokenHash, type: 'signup' })); }
    finally { if (epoch === this.generation) await this.signOut(); }
  }
  async resetPassword(tokenHash: string, password: string) {
    this.clear();
    const epoch = this.generation;
    try {
      const token = this.accept(await this.auth('verify', { token_hash: tokenHash, type: 'recovery' }));
      await this.auth('user', { password }, token, 'PUT');
    } finally { if (epoch === this.generation) await this.signOut(); }
  }
  async token(): Promise<string> {
    if (!this.session) throw new Error('Connectez-vous pour continuer.');
    if (Date.parse(this.session.expiresAt) - this.now() > 60_000) return this.session.accessToken;
    if (!this.renewing) {
      const epoch = this.generation;
      const refreshToken = this.session.refreshToken;
      const renewal = this.auth('token?grant_type=refresh_token', { refresh_token: refreshToken })
        .then((value) => { if (epoch !== this.generation) throw new Error('Session fermée.'); return this.accept(value); })
        .catch((error) => { if (epoch === this.generation) this.clear(); throw error; })
        .finally(() => { if (this.renewing === renewal) this.renewing = null; });
      this.renewing = renewal;
    }
    return this.renewing;
  }
  async account() {
    const token = await this.token();
    const [me, billing] = await Promise.all([
      this.request<MeResponse>(`${this.config.apiBaseUrl}/v1/me`, undefined, token),
      this.request<BillingOverviewResponse>(`${this.config.apiBaseUrl}/v2/billing`, undefined, token),
    ]);
    return { me, billing };
  }
  async catalog() { return readPublicBetaCatalog(await this.request(`${this.config.apiBaseUrl}/v11/catalog`)); }
  async checkout(selectionId: string, returnUrl: string) {
    const response = await this.request<CheckoutSessionResponse>(`${this.config.apiBaseUrl}/v2/checkout/sessions`, {
      selectionId, successUrl: returnUrl, cancelUrl: returnUrl,
    }, await this.token());
    return safeStripeUrl(response.checkoutUrl, 'checkout', response.testMode);
  }
  async portal(returnUrl: string) {
    const response = await this.request<BillingPortalResponse>(`${this.config.apiBaseUrl}/v2/billing/portal-sessions`, { returnUrl }, await this.token());
    return safeStripeUrl(response.portalUrl, 'portal', response.testMode);
  }
  clear() {
    this.generation++;
    this.session = null;
    this.renewing = null;
    for (const request of this.pending) request.abort();
    this.pending.clear();
  }
  async signOut() {
    const token = this.session?.accessToken;
    this.clear();
    if (token) await this.request(`${this.config.apiBaseUrl}/v1/auth/logout`, {}, token);
  }
}
