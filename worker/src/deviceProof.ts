import type { DeviceChallengeRecord } from './types.ts';

function decodeBase64Url(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_signature');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
}

export function randomDeviceNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function deviceChallengeMessage(challenge: Pick<DeviceChallengeRecord, 'id' | 'profileId' | 'deviceId' | 'purpose' | 'nonce' | 'expiresAt'>): string {
  return [
    'senario-device-proof-v1', challenge.id, challenge.profileId,
    challenge.deviceId ?? '-', challenge.purpose, challenge.nonce, challenge.expiresAt,
  ].join('\n');
}

export function validDevicePublicKey(key: JsonWebKey): boolean {
  return key.kty === 'EC' && key.crv === 'P-256' && !key.d &&
    typeof key.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.x) &&
    typeof key.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key.y);
}

export async function deviceKeyThumbprint(key: JsonWebKey): Promise<string> {
  if (!validDevicePublicKey(key)) throw new Error('invalid_device_key');
  const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function verifyDeviceProof(publicKey: JsonWebKey, message: string, signature: string): Promise<boolean> {
  try {
    if (!validDevicePublicKey(publicKey) || signature.length > 256) return false;
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64Url(signature),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

export function deviceRequestMessage(input: {
  method: string; path: string; timestamp: string; nonce: string; bodyDigest: string;
}): string {
  return ['senario-request-proof-v1', input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.bodyDigest].join('\n');
}

export async function sha256Base64Url(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes: ArrayBuffer = typeof value === 'string'
    ? new TextEncoder().encode(value).buffer as ArrayBuffer
    : value instanceof Uint8Array ? Uint8Array.from(value).buffer as ArrayBuffer : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function routeRequiresDeviceProof(pathname: string): boolean {
  return /^\/v(?:4|5|6|7|9|10|14|15|16)\//.test(pathname);
}
