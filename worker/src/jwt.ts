import type { AuthenticatedIdentity, TokenVerifier } from './types.ts';
import { CommercialRepositoryError } from './types.ts';

export class AuthenticationError extends Error {
  constructor(message = 'Authentification requise.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

type JwtHeader = { alg?: string; kid?: string };
type JwtPayload = {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
};
type Jwks = { keys?: JsonWebKey[] };

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function audienceMatches(
  actual: string | string[] | undefined,
  expected: string,
): boolean {
  return typeof actual === 'string'
    ? actual === expected
    : Array.isArray(actual) && actual.includes(expected);
}

export class SupabaseJwksTokenVerifier implements TokenVerifier {
  private jwks: Jwks | null = null;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private fetching: Promise<Jwks> | null = null;

  constructor(
    private readonly supabaseUrl: string,
    private readonly audience = 'authenticated',
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async verify(
    authorizationHeader: string | null,
  ): Promise<AuthenticatedIdentity> {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? '');
    if (!match) throw new AuthenticationError();

    const token = match[1];
    const segments = token.split('.');
    if (segments.length !== 3) throw new AuthenticationError('Jeton invalide.');

    let header: JwtHeader;
    let payload: JwtPayload;
    try {
      header = decodeJson<JwtHeader>(segments[0]);
      payload = decodeJson<JwtPayload>(segments[1]);
    } catch {
      throw new AuthenticationError('Jeton invalide.');
    }

    if (!header.kid || !['RS256', 'ES256'].includes(header.alg ?? '')) {
      throw new AuthenticationError('Algorithme de jeton refusé.');
    }

    const findKey = (keys: Jwks) =>
      keys.keys?.find(
        (candidate) =>
          (candidate as JsonWebKey & { kid?: string }).kid === header.kid,
      );
    let jwk = findKey(await this.getJwks());
    if (!jwk && this.now() - this.fetchedAt >= 10_000)
      jwk = findKey(await this.getJwks(true));
    if (!jwk) throw new AuthenticationError('Clé de signature inconnue.');

    const algorithm =
      header.alg === 'RS256'
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
        : { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, [
      'verify',
    ]);
    const verified = await crypto.subtle.verify(
      algorithm,
      key,
      toArrayBuffer(decodeBase64Url(segments[2])),
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    );
    if (!verified)
      throw new AuthenticationError('Signature de jeton invalide.');

    const nowSeconds = Math.floor(this.now() / 1000);
    const issuer = `${this.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
    if (
      !payload.sub ||
      payload.iss !== issuer ||
      !audienceMatches(payload.aud, this.audience)
    ) {
      throw new AuthenticationError('Claims de jeton invalides.');
    }
    if (
      !payload.exp ||
      payload.exp <= nowSeconds ||
      (payload.nbf !== undefined && payload.nbf > nowSeconds)
    ) {
      throw new AuthenticationError('Jeton expiré ou pas encore valide.');
    }
    return { authUserId: payload.sub, accessToken: token };
  }

  private async getJwks(force = false): Promise<Jwks> {
    if (this.jwks && !force && this.now() - this.fetchedAt < 300_000)
      return this.jwks;
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      try {
        // Cloudflare's native fetch must not be invoked as an object method.
        const fetcher = this.fetcher;
        const response = await fetcher(
          `${this.supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
          {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) throw new Error('JWKS unavailable');
        const keys = (await response.json()) as Jwks;
        if (!Array.isArray(keys.keys)) throw new Error('Invalid JWKS');
        this.jwks = keys;
        this.fetchedAt = this.now();
        return keys;
      } catch {
        throw new CommercialRepositoryError(
          503,
          'authentication_unavailable',
          'Service de session temporairement indisponible.',
        );
      }
    })().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }
}
