import type { EntitlementsResponse, MeResponse, SessionTokens } from "./contracts-v2.ts";

export interface AuthClient {
  signUp(email: string, password: string, displayName: string): Promise<void>;
  signIn(email: string, password: string): Promise<SessionTokens>;
  refreshSession(refreshToken: string): Promise<SessionTokens>;
  requestPasswordReset(email: string): Promise<void>;
  signOut(accessToken: string): Promise<void>;
  getMe(accessToken: string): Promise<MeResponse>;
  getEntitlements(accessToken: string): Promise<EntitlementsResponse>;
}

type SupabaseSessionResponse = { access_token?: string; refresh_token?: string; expires_at?: number };

export function createSupabaseAuthClient(options: { supabaseUrl: string; supabaseAnonKey: string; apiBaseUrl: string; fetcher?: typeof fetch }): AuthClient {
  const fetcher = options.fetcher ?? fetch;
  const supabaseUrl = options.supabaseUrl.replace(/\/$/, "");
  const apiBaseUrl = options.apiBaseUrl.replace(/\/$/, "");

  async function supabase(path: string, body: unknown): Promise<Response> {
    const response = await fetcher(`${supabaseUrl}/auth/v1${path}`, {
      method: "POST",
      headers: { apikey: options.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Le service de compte a refusé la demande.");
    return response;
  }

  async function api<T>(path: string, accessToken: string, method = "GET"): Promise<T> {
    const response = await fetcher(`${apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    if (!response.ok) throw new Error("La session n’est plus valide.");
    return (response.status === 204 ? undefined : response.json()) as Promise<T>;
  }

  async function readSession(response: Response): Promise<SessionTokens> {
    const session = await response.json() as SupabaseSessionResponse;
    if (!session.access_token || !session.refresh_token || !session.expires_at) throw new Error("Session incomplète.");
    return { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: new Date(session.expires_at * 1_000).toISOString() };
  }

  return {
    async signUp(email, password, displayName) { await supabase("/signup", { email, password, data: { display_name: displayName } }); },
    async signIn(email, password) {
      const response = await supabase("/token?grant_type=password", { email, password });
      return readSession(response);
    },
    async refreshSession(refreshToken) { return readSession(await supabase("/token?grant_type=refresh_token", { refresh_token: refreshToken })); },
    async requestPasswordReset(email) { await supabase("/recover", { email }); },
    signOut: (accessToken) => api<void>("/v1/auth/logout", accessToken, "POST"),
    getMe: (accessToken) => api<MeResponse>("/v1/me", accessToken),
    getEntitlements: (accessToken) => api<EntitlementsResponse>("/v1/entitlements", accessToken),
  };
}

/** Test adapter: selects an identity; all rights still come from the local Worker. */
export function createLocalTestAuthClient(apiBaseUrl: string, fetcher: typeof fetch = fetch): AuthClient & {
  signInAs(profile: "discovery" | "author" | "studio"): Promise<SessionTokens>;
} {
  const base = apiBaseUrl.replace(/\/$/, "");
  const api = async <T>(path: string, token: string, method = "GET"): Promise<T> => {
    const response = await fetcher(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    if (!response.ok) throw new Error("Serveur local indisponible.");
    return (response.status === 204 ? undefined : response.json()) as Promise<T>;
  };
  return {
    signUp: async () => { throw new Error("Inscription simulée désactivée."); },
    signIn: async () => { throw new Error("Utilisez un profil local."); },
    refreshSession: async () => { throw new Error("Session locale non renouvelable."); },
    requestPasswordReset: async () => { throw new Error("Récupération simulée désactivée."); },
    signInAs: async (profile) => ({ accessToken: `local-test:${profile}`, refreshToken: "", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    signOut: (token) => api<void>("/v1/auth/logout", token, "POST"),
    getMe: (token) => api<MeResponse>("/v1/me", token),
    getEntitlements: (token) => api<EntitlementsResponse>("/v1/entitlements", token),
  };
}
