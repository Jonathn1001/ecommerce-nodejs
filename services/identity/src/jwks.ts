import { createHash, createPublicKey } from "crypto";

// A key as published in the JWKS — enough to verify, never enough to sign. This is
// deliberately the widest type any "previous key" (verify-only, kept alive across a
// rotation) can ever be: there is no `privateKey` field to misread as signing material.
export type PublishableKey = { kid: string; publicKey: string };

// The active key: everything a PublishableKey has, plus the private half `signAccess`
// actually signs with. Only `toSigningKey` ever produces one of these.
export type SigningKey = PublishableKey & { privateKey: string };

function fingerprint(publicKeyPem: string): string {
  // kid = a stable fingerprint of the public key, so a rotated key keeps its identity
  // across restarts without anyone maintaining a registry.
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

export function toSigningKey(privateKey: string): SigningKey {
  const pub = createPublicKey(privateKey);
  const publicKey = pub.export({ type: "spki", format: "pem" }).toString();
  return { kid: fingerprint(publicKey), privateKey, publicKey };
}

// For a key whose private half identity never held — e.g. the previous key kept around only
// so tokens signed before a rotation still verify. Same fingerprint as `toSigningKey` would
// derive for the same key pair, but the return type makes it impossible to pull a signing key
// back out of a publish-only entry.
export function toPublishableKey(publicKey: string): PublishableKey {
  const pub = createPublicKey(publicKey);
  const pem = pub.export({ type: "spki", format: "pem" }).toString();
  return { kid: fingerprint(pem), publicKey: pem };
}

export function toJwks(keys: PublishableKey[]): { keys: unknown[] } {
  return {
    keys: keys.map((k) => ({
      ...createPublicKey(k.publicKey).export({ format: "jwk" }),
      kid: k.kid,
      use: "sig",
      alg: "RS256",
    })),
  };
}
