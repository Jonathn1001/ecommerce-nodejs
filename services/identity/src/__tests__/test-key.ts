import { generateKeyPairSync } from "crypto";

// Side-effect module: `config.ts` validates JWT_PRIVATE_KEY at import time, so the key has
// to exist before anything pulls in `../app`. Import this FIRST in a test file — ES imports
// evaluate in source order, which is what makes this work without a top-level await.
const pair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

process.env.JWT_PRIVATE_KEY = pair.privateKey;

export const TEST_PUBLIC_KEY = pair.publicKey;
export const TEST_PRIVATE_KEY = pair.privateKey;
