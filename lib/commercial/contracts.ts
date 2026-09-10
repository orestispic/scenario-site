/**
 * Contrat serveur commercial v1. Cette définition est maintenue en miroir du
 * contrat client dans scenario-app-commercial/src/commercial/contracts.ts tant
 * qu’un package partagé n’est pas introduit. Toute modification exige un commit
 * coordonné dans les deux worktrees.
 */
export const COMMERCIAL_CONTRACT_VERSION = "2026-09-v1";

export interface ClientCompatibility {
  minimumSupportedVersion: string;
  effectiveAt: string;
  message: string | null;
}

export interface AccountIdentity {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Entitlement {
  code: string;
  enabled: boolean;
  value: unknown;
}

export interface EntitlementSnapshot {
  id: string;
  configurationVersion: string;
  issuedAt: string;
  offlineValidUntil: string;
  entitlements: Entitlement[];
}

export interface AccountOverview {
  account: AccountIdentity;
  entitlementSnapshot: EntitlementSnapshot;
  compatibility: ClientCompatibility;
}

export interface ApiError {
  code: string;
  message: string;
  requestId: string;
}

export interface AccountOverviewRoute {
  readonly method: "GET";
  readonly path: "/api/v1/me/account-overview";
  response: AccountOverview;
}
