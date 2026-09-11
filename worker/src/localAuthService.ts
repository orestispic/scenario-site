import { AuthenticationError } from './jwt.ts';
import type { LocalTestRepository } from './localTestRepository.ts';
import type { TokenVerifier } from './types.ts';

/** Local-only Supabase-shaped fixture. Not a provider or production authentication service. */
export class LocalAuthService implements TokenVerifier {
  private users = new Map<string, { id: string; passwordHash: string }>();
  private sessions = new Map<
    string,
    {
      userId: string;
      accessToken: string;
      refreshToken: string;
      expires: number;
    }
  >();
  constructor(
    private readonly repository: LocalTestRepository,
    private readonly now = Date.now,
  ) {}
  private async digest(value: string): Promise<string> {
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  async verify(header: string | null) {
    const token = header?.replace(/^Bearer /, '') ?? '';
    const session = [...this.sessions.values()].find(
      (value) => value.accessToken === token,
    );
    if (!session || session.expires <= this.now())
      throw new AuthenticationError();
    return { authUserId: session.userId, accessToken: token };
  }
  async logout(token: string): Promise<void> {
    for (const [id, session] of this.sessions)
      if (session.accessToken === token) this.sessions.delete(id);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = (await request.json()) as Record<string, unknown>;
    if (url.pathname.endsWith('/recover')) return Response.json({});
    const email =
      typeof body.email === 'string' ? body.email.toLowerCase() : '';
    if (url.pathname.endsWith('/signup')) {
      if (
        !email.endsWith('@example.invalid') ||
        typeof body.password !== 'string' ||
        body.password.length < 8
      )
        return Response.json(
          { error: 'invalid_local_registration' },
          { status: 400 },
        );
      if (!this.users.has(email)) {
        const id = crypto.randomUUID();
        this.users.set(email, {
          id,
          passwordHash: await this.digest(email + body.password),
        });
        this.repository.registerLocalUser(id, email, 'Local test');
      }
      return Response.json({});
    }
    if (!url.pathname.endsWith('/token'))
      return new Response(null, { status: 404 });
    let userId: string | undefined;
    if (url.searchParams.get('grant_type') === 'password') {
      const user = this.users.get(email);
      if (
        user &&
        typeof body.password === 'string' &&
        user.passwordHash === (await this.digest(email + body.password))
      )
        userId = user.id;
    } else if (url.searchParams.get('grant_type') === 'refresh_token') {
      const old = this.sessions.get(String(body.refresh_token));
      if (old) {
        userId = old.userId;
        this.sessions.delete(old.refreshToken);
      }
    }
    if (!userId)
      return Response.json({ error: 'invalid_grant' }, { status: 401 });
    const refreshToken = crypto.randomUUID();
    const accessToken = crypto.randomUUID();
    const expires = this.now() + 60_000;
    this.sessions.set(refreshToken, {
      userId,
      accessToken,
      refreshToken,
      expires,
    });
    return Response.json(
      {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Math.floor(expires / 1000),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
