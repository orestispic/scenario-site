import type { OfflineGrantPayload, SignedOfflineGrant } from "../../lib/commercial/contracts-v2.ts";
import type { OfflineGrantSigner } from "./types.ts";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class EcdsaOfflineGrantSigner implements OfflineGrantSigner {
  constructor(
    public readonly keyId: string,
    private readonly privateJwk: JsonWebKey,
    private readonly publicJwk: JsonWebKey,
  ) {}

  async getPublicKey(): Promise<JsonWebKey> {
    return { ...this.publicJwk, d: undefined };
  }

  async sign(payload: OfflineGrantPayload): Promise<SignedOfflineGrant> {
    const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey(
      "jwk",
      this.privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(encodedPayload),
    );
    return {
      format: "scenario.offline-grant.v1",
      algorithm: "ES256",
      keyId: this.keyId,
      payload: encodedPayload,
      signature: encodeBase64Url(new Uint8Array(signature)),
    };
  }
}

export async function createEphemeralOfflineGrantSigner(keyId = "local-ephemeral"): Promise<EcdsaOfflineGrantSigner> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return new EcdsaOfflineGrantSigner(keyId, privateJwk, publicJwk);
}
