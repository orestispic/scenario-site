'use client';

import { useMemo, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  createLocalTestAuthClient,
  createSupabaseAuthClient,
  type AuthClient,
} from '@/lib/commercial/auth-client';
import type {
  EntitlementsResponse,
  MeResponse,
  SessionTokens,
} from '@/lib/commercial/contracts-v2';
import type { BillingOverviewResponse } from '@/lib/commercial/contracts-v3';

const apiBaseUrl =
  process.env.NEXT_PUBLIC_SCENARIO_API_BASE_URL ?? 'http://127.0.0.1:8787';
const localTestMode =
  process.env.NEXT_PUBLIC_SCENARIO_AUTH_MODE === 'local-test' &&
  process.env.NODE_ENV !== 'production';
type FormSubmitEvent = SyntheticEvent<HTMLFormElement, SubmitEvent>;

function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

export function AccountPortal() {
  const [session, setSession] = useState<SessionTokens | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(
    null,
  );
  const [billing, setBilling] = useState<BillingOverviewResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const client = useMemo<AuthClient>(
    () =>
      localTestMode
        ? createLocalTestAuthClient(apiBaseUrl)
        : createSupabaseAuthClient({
            apiBaseUrl,
            supabaseUrl:
              process.env.NEXT_PUBLIC_SUPABASE_URL ??
              'https://project-ref.supabase.co',
            supabaseAnonKey:
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'not-configured',
          }),
    [],
  );

  async function loadAccount(nextSession: SessionTokens) {
    const [nextMe, nextEntitlements, nextBilling] = await Promise.all([
      client.getMe(nextSession.accessToken),
      client.getEntitlements(nextSession.accessToken),
      client.getBilling(nextSession.accessToken),
    ]);
    setSession(nextSession);
    setMe(nextMe);
    setEntitlements(nextEntitlements);
    setBilling(nextBilling);
  }

  async function submit(action: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Demande impossible.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: FormSubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await submit(
      async () =>
        loadAccount(
          await client.signIn(
            formString(data, 'email'),
            formString(data, 'password'),
          ),
        ),
      'Session ouverte.',
    );
  }

  async function signUp(event: FormSubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await submit(
      () =>
        client.signUp(
          formString(data, 'email'),
          formString(data, 'password'),
          formString(data, 'displayName'),
        ),
      'Vérifiez votre adresse e-mail pour terminer l’inscription.',
    );
  }

  async function recover(event: FormSubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await submit(
      () => client.requestPasswordReset(formString(data, 'email')),
      'Si ce compte existe, un message de récupération a été envoyé.',
    );
  }

  async function startCheckout(selectionId: string) {
    if (!session) return;
    const base = window.location.origin + window.location.pathname;
    const checkout = await client.createCheckoutSession(session.accessToken, {
      selectionId,
      successUrl: `${base}?checkout=success`,
      cancelUrl: `${base}?checkout=canceled`,
    });
    window.location.assign(checkout.checkoutUrl);
  }

  async function openPortal() {
    if (!session) return;
    const portal = await client.createBillingPortal(
      session.accessToken,
      window.location.origin + window.location.pathname,
    );
    window.location.assign(portal.portalUrl);
  }

  if (session && me && entitlements && billing) {
    return (
      <Card className="w-full max-w-2xl border border-slate-200 bg-white/95 shadow-xl shadow-slate-950/5">
        <CardHeader>
          <div className="mb-2 w-fit rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-800">
            Stripe test
          </div>
          <CardTitle className="text-xl">
            {me.account.displayName ?? me.account.email}
          </CardTitle>
          <CardDescription>
            {me.account.email} · session authentifiée
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-3 rounded-xl border border-blue-200 bg-blue-50/70 p-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">Abonnement</p>
              <p className="text-sm text-slate-700">
                {billing.billing.offerDisplayName ?? 'Découverte'} ·{' '}
                {billing.billing.status}
              </p>
              {billing.billing.currentPeriodEndsAt && (
                <p className="text-xs text-slate-600">
                  Période jusqu’au{' '}
                  {new Date(
                    billing.billing.currentPeriodEndsAt,
                  ).toLocaleDateString('fr-FR')}
                  .
                </p>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {billing.offers.map((offer) => (
                <button
                  key={offer.selectionId}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void submit(
                      () => startCheckout(offer.selectionId),
                      'Redirection vers Checkout test.',
                    )
                  }
                  className="rounded-lg border border-blue-200 bg-white p-3 text-left transition hover:border-blue-400 disabled:opacity-50"
                >
                  <span className="block text-sm font-semibold text-slate-900">
                    {offer.displayName} ·{' '}
                    {offer.billingInterval === 'month' ? 'mensuel' : 'annuel'}
                  </span>
                  <span className="text-sm text-slate-600">
                    {new Intl.NumberFormat('fr-FR', {
                      style: 'currency',
                      currency: offer.currency,
                    }).format(offer.unitAmountMinor / 100)}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || billing.billing.source !== 'stripe'}
                onClick={() =>
                  void submit(openPortal, 'Redirection vers le portail test.')
                }
              >
                Gérer l’abonnement
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void submit(
                    async () =>
                      setBilling(await client.getBilling(session.accessToken)),
                    'État actualisé depuis l’API.',
                  )
                }
              >
                Actualiser
              </Button>
            </div>
            <p className="text-xs text-slate-600">
              Le retour de Checkout ne débloque rien : l’état change uniquement
              après webhook Stripe vérifié.
            </p>
          </div>
          <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">
              Droits délivrés par le serveur
            </p>
            <ul className="grid gap-1 text-sm text-slate-600">
              {entitlements.snapshot.entitlements.map((entitlement) => (
                <li key={entitlement.code}>
                  {entitlement.code} —{' '}
                  {entitlement.enabled ? 'actif' : 'inactif'}
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-500">
              Cache signé valable jusqu’au{' '}
              {new Date(entitlements.snapshot.offlineValidUntil).toLocaleString(
                'fr-FR',
              )}
              .
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void submit(async () => {
                await client.signOut(session.accessToken);
                setSession(null);
                setMe(null);
                setEntitlements(null);
                setBilling(null);
              }, 'Session fermée.')
            }
          >
            Se déconnecter
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-xl border border-slate-200 bg-white/95 shadow-xl shadow-slate-950/5">
      <CardHeader>
        <CardTitle className="text-xl">Votre espace Scénario</CardTitle>
        <CardDescription>
          Compte, appareils et droits sont toujours vérifiés côté serveur.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {localTestMode && (
          <div className="grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-950">
              Mode local isolé
            </p>
            <p className="text-sm text-amber-900">
              Choisissez une identité de test. Le Worker local attribue les
              droits.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(['discovery', 'author', 'studio'] as const).map((profile) => (
                <Button
                  key={profile}
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void submit(async () => {
                      const localClient = client as ReturnType<
                        typeof createLocalTestAuthClient
                      >;
                      await loadAccount(await localClient.signInAs(profile));
                    }, 'Profil local chargé.')
                  }
                >
                  {profile}
                </Button>
              ))}
            </div>
          </div>
        )}
        <Tabs defaultValue="signin">
          <TabsList className="grid h-10 w-full grid-cols-3">
            <TabsTrigger value="signin">Connexion</TabsTrigger>
            <TabsTrigger value="signup">Inscription</TabsTrigger>
            <TabsTrigger value="recover">Mot de passe</TabsTrigger>
          </TabsList>
          <TabsContent value="signin">
            <AuthForm
              onSubmit={(event) => void signIn(event)}
              busy={busy}
              submitLabel="Se connecter"
            />
          </TabsContent>
          <TabsContent value="signup">
            <AuthForm
              onSubmit={(event) => void signUp(event)}
              busy={busy}
              submitLabel="Créer le compte"
              includeName
            />
          </TabsContent>
          <TabsContent value="recover">
            <RecoveryForm
              onSubmit={(event) => void recover(event)}
              busy={busy}
            />
          </TabsContent>
        </Tabs>
        {message && (
          <output className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
            {message}
          </output>
        )}
      </CardContent>
    </Card>
  );
}

function AuthForm({
  onSubmit,
  busy,
  submitLabel,
  includeName = false,
}: {
  onSubmit: (event: FormSubmitEvent) => void;
  busy: boolean;
  submitLabel: string;
  includeName?: boolean;
}) {
  return (
    <form className="grid gap-3 pt-4" onSubmit={onSubmit}>
      {includeName && (
        <label
          htmlFor="signup-name"
          className="grid gap-1.5 text-sm font-medium"
        >
          Nom affiché
          <Input
            id="signup-name"
            name="displayName"
            autoComplete="name"
            required
          />
        </label>
      )}
      <label
        htmlFor={includeName ? 'signup-email' : 'signin-email'}
        className="grid gap-1.5 text-sm font-medium"
      >
        Adresse e-mail
        <Input
          id={includeName ? 'signup-email' : 'signin-email'}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </label>
      <label
        htmlFor={includeName ? 'signup-password' : 'signin-password'}
        className="grid gap-1.5 text-sm font-medium"
      >
        Mot de passe
        <Input
          id={includeName ? 'signup-password' : 'signin-password'}
          name="password"
          type="password"
          autoComplete={includeName ? 'new-password' : 'current-password'}
          minLength={8}
          required
        />
      </label>
      <Button className="mt-1 h-10" disabled={busy} type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}

function RecoveryForm({
  onSubmit,
  busy,
}: {
  onSubmit: (event: FormSubmitEvent) => void;
  busy: boolean;
}) {
  return (
    <form className="grid gap-3 pt-4" onSubmit={onSubmit}>
      <p className="text-sm text-slate-600">
        Vous recevrez un lien si cette adresse correspond à un compte.
      </p>
      <label
        htmlFor="recovery-email"
        className="grid gap-1.5 text-sm font-medium"
      >
        Adresse e-mail
        <Input
          id="recovery-email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </label>
      <Button className="mt-1 h-10" disabled={busy} type="submit">
        Envoyer le lien
      </Button>
    </form>
  );
}
