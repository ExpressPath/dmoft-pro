import { createPublicKey } from "node:crypto";

const kid = process.env.LICENSE_KEY_ID;
const pem = process.env.LICENSE_ED25519_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n");
if (!kid || !/^[A-Za-z0-9._-]{1,64}$/.test(kid) || !pem) {
  throw new Error("LICENSE_KEY_ID and LICENSE_ED25519_PUBLIC_KEY_PEM are required");
}
const der = createPublicKey(pem).export({ format: "der", type: "spki" });
const prefix = "302a300506032b6570032100";
if (der.length !== 44 || der.subarray(0, 12).toString("hex") !== prefix) {
  throw new Error("LICENSE_ED25519_PUBLIC_KEY_PEM must contain an Ed25519 key");
}
const output = {
  v: 1,
  keys: [{ kid, alg: "EdDSA", public_key: der.subarray(12).toString("base64url") }],
};
process.stdout.write(`${JSON.stringify(output)}\n`);
