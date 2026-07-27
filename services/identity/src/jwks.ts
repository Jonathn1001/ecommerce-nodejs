import { createHash, createPublicKey } from "crypto";

export type SigningKey = { kid: string; privateKey: string; publicKey: string };

// kid = a stable fingerprint of the public key, so a rotated key keeps its identity across
// restarts without anyone maintaining a registry.
export function toSigningKey(privateKey: string): SigningKey {
  const pub = createPublicKey(privateKey);
  const publicKey = pub.export({ type: "spki", format: "pem" }).toString();
  const kid = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  return { kid, privateKey, publicKey };
}

export function toJwks(keys: SigningKey[]): { keys: unknown[] } {
  return {
    keys: keys.map((k) => ({
      ...createPublicKey(k.publicKey).export({ format: "jwk" }),
      kid: k.kid,
      use: "sig",
      alg: "RS256",
    })),
  };
}
