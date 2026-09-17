export const COMMERCIAL_CONTRACT_VERSION_V15 = '2026-09-v15' as const;

export interface ContactView {
  profileId: string;
  displayName: string;
  email: string;
  since: string;
}

export interface ContactRequestView {
  id: string;
  profileId: string;
  displayName: string;
  email: string;
  createdAt: string;
}

export interface ContactListResponse {
  contacts: ContactView[];
  receivedRequests: ContactRequestView[];
  sentRequests: ContactRequestView[];
}
