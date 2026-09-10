import Image from "next/image";
import { AccountPortal } from "./account-portal";

export default function Home() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#dbeafe_0,transparent_34%),linear-gradient(145deg,#f8fafc_20%,#eef2ff_100%)] px-5 py-10 text-slate-950 sm:px-8 sm:py-16">
      <div className="mx-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
        <section className="grid gap-6">
          <div className="flex items-center gap-3">
            <Image src="/scenario-logo.png" alt="" width={48} height={48} className="h-12 w-12 rounded-xl shadow-sm" />
            <span className="text-lg font-semibold tracking-tight">Scénario</span>
          </div>
          <div className="grid gap-4">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-blue-700">Espace sécurisé</p>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-[-0.035em] sm:text-5xl">Votre compte reste la source de vérité.</h1>
            <p className="max-w-lg text-base leading-7 text-slate-600">Sessions courtes, droits délivrés par le serveur et appareils contrôlés sans exposer de secret dans l’application.</p>
          </div>
          <div className="grid max-w-lg gap-3 text-sm text-slate-700 sm:grid-cols-3">
            <p className="rounded-xl border border-white/70 bg-white/55 p-3">Jetons Supabase validés par JWKS</p>
            <p className="rounded-xl border border-white/70 bg-white/55 p-3">Cache hors ligne signé</p>
            <p className="rounded-xl border border-white/70 bg-white/55 p-3">Droits non modifiables côté client</p>
          </div>
        </section>
        <section className="flex justify-center lg:justify-end" aria-label="Authentification Scénario">
          <AccountPortal />
        </section>
      </div>
    </main>
  );
}
