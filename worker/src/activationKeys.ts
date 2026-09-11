export function normalizeActivationKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

export function generateActivationKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const encoded = encodeBase32(bytes);
  return `SCN-${encoded.match(/.{1,6}/g)!.join('-')}`;
}

export async function fingerprintActivationKey(
  value: string,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(normalizeActivationKey(value)),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function activationKeySuffix(value: string): string {
  return normalizeActivationKey(value).replaceAll('-', '').slice(-6);
}
