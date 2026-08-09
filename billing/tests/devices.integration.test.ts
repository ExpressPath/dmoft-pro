import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { setPoolForTests, transaction } from "../src/lib/db";
import { parseDevicePublicKey } from "../src/lib/device-crypto";
import { base64urlEncode } from "../src/lib/encoding";
import { resetEnvCacheForTests } from "../src/lib/env";
import { listAccountDevices, revokeAccountDevice } from "../src/lib/devices";
import { getLicenseContext } from "../src/lib/entitlements";
import { refreshDeviceLicense, registerDevice } from "../src/lib/license-service";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl).sequential;

integration("device lifecycle against migrated PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const accountId = randomUUID();
  const challengeId = randomUUID();
  const deviceId = `dmoft-device-v1-${"A".repeat(24)}`;

  beforeAll(async () => {
    setPoolForTests(pool);
    await pool.query(
      "INSERT INTO accounts (id, auth_subject, stripe_customer_id) VALUES ($1, $2, $3)",
      [accountId, `integration-${accountId}`, `cus_${accountId.replaceAll("-", "")}`],
    );
    await pool.query(
      `INSERT INTO devices (id, account_id, public_key, public_key_sha256, display_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, accountId, Buffer.alloc(32, 0x42), "A".repeat(43), "Integration device"],
    );
    await pool.query(
      `INSERT INTO license_challenges
         (id, purpose, account_id, stripe_customer_id, checkout_session_id,
          stripe_subscription_id, terms_version, device_id, device_public_key,
          device_key_sha256, challenge, expires_at, used_at)
       VALUES ($1, 'refresh', $2, $3, NULL, NULL, NULL, $4, $5, $6, 'fixture', now() + interval '5 minutes', now())`,
      [
        challengeId,
        accountId,
        `cus_${accountId.replaceAll("-", "")}`,
        deviceId,
        Buffer.alloc(32, 0x42),
        "A".repeat(43),
      ],
    );
    await pool.query(
      `INSERT INTO issued_licenses
         (jti, challenge_id, account_id, stripe_customer_id, stripe_subscription_id,
          device_id, issued_at, expires_at, grace_until, claims)
       VALUES ($1, $2, $3, $4, 'sub_fixture', $5, now(), now() + interval '1 day',
               now() + interval '2 days', '{}'::jsonb)`,
      [randomUUID(), challengeId, accountId, `cus_${accountId.replaceAll("-", "")}`, deviceId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM stripe_entitlements WHERE stripe_customer_id = $1", [
      `cus_${accountId.replaceAll("-", "")}`,
    ]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    setPoolForTests(undefined);
    await pool.end();
  });

  it("lists, revokes, audits licenses, and is idempotent under the account lock", async () => {
    const listed = await listAccountDevices(accountId);
    expect(listed.devices).toHaveLength(1);
    expect(listed.devices[0]).toMatchObject({ device_id: deviceId, status: "active" });

    const first = await revokeAccountDevice(accountId, deviceId);
    expect(first.status).toBe("revoked");
    expect(first.offline_token_valid_until).not.toBeNull();
    const second = await revokeAccountDevice(accountId, deviceId);
    expect(second.revoked_at).toBe(first.revoked_at);

    const audit = await pool.query<{ status: string; revoked_at: Date | null; license_revoked_at: Date | null }>(
      `SELECT d.status, d.revoked_at, l.revoked_at AS license_revoked_at
         FROM devices d JOIN issued_licenses l ON l.device_id = d.id
        WHERE d.id = $1`,
      [deviceId],
    );
    expect(audit.rows[0]?.status).toBe("revoked");
    expect(audit.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(audit.rows[0]?.license_revoked_at).toBeInstanceOf(Date);
  });

  it("enforces activation subscription and terms bindings at the database boundary", async () => {
    await expect(pool.query(
      `INSERT INTO license_challenges
         (id, purpose, account_id, stripe_customer_id, checkout_session_id,
          device_id, device_public_key, device_key_sha256, challenge, expires_at)
       VALUES ($1, 'activate', $2, $3, 'cs_fixture', $4, $5, $6, 'fixture', now() + interval '5 minutes')`,
      [
        randomUUID(),
        accountId,
        `cus_${accountId.replaceAll("-", "")}`,
        `dmoft-device-v1-${"B".repeat(24)}`,
        Buffer.alloc(32, 0x43),
        "B".repeat(43),
      ],
    )).rejects.toThrow();
  });

  it("serializes concurrent enrollment decisions at the account device limit", async () => {
    const context = {
      accountId,
      stripeCustomerId: `cus_${accountId.replaceAll("-", "")}`,
      subscriptionId: "sub_fixture",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      entitlements: ["camera.live" as const],
      deviceLimit: 1,
      tier: "pro",
      offlineGracePermitted: false,
    };
    const first = parseDevicePublicKey(Buffer.alloc(32, 0x51).toString("base64url"));
    const second = parseDevicePublicKey(Buffer.alloc(32, 0x52).toString("base64url"));
    const results = await Promise.allSettled([
      transaction((client) => registerDevice(client, first, context, "First concurrent device")),
      transaction((client) => registerDevice(client, second, context, "Second concurrent device")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const active = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM devices WHERE account_id = $1 AND status = 'active'",
      [accountId],
    );
    expect(active.rows[0]?.count).toBe("1");
  });

  it("never uses an unrelated active subscription for the license period", async () => {
    const customerId = `cus_${accountId.replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO subscriptions
         (stripe_subscription_id, account_id, stripe_customer_id, status,
          current_period_end, stripe_snapshot)
       VALUES
         ('sub_unrelated', $1, $2, 'active', now() + interval '90 days',
          '{"metadata":{"dmoft_account_id":"unrelated","dmoft_plan":"other","dmoft_terms_version":"2026-08-09"}}'),
         ('sub_qualified', $1, $2, 'active', now() + interval '30 days',
          jsonb_build_object('metadata', jsonb_build_object(
            'dmoft_account_id', $1::text,
            'dmoft_plan', 'pro_monthly',
            'dmoft_terms_version', '2026-08-09'
          )))`,
      [accountId, customerId],
    );
    await pool.query(
      `INSERT INTO stripe_entitlements
         (stripe_customer_id, stripe_entitlement_id, feature_id, lookup_key, livemode)
       VALUES
         ($1, 'ent_fixture_camera', 'feat_camera', 'dmoft_camera_live', false),
         ($1, 'ent_fixture_device', 'feat_device', 'dmoft_devices_1', false),
         ($1, 'ent_fixture_tier', 'feat_tier', 'dmoft_pro', false)`,
      [customerId],
    );
    const context = await getLicenseContext(
      customerId,
      "sub_unrelated",
      pool,
      {
        lookupToEntitlement: { dmoft_camera_live: "camera.live" },
        deviceLimitByLookup: { dmoft_devices_1: 1 },
        tierByLookup: { dmoft_pro: "pro" },
        offlineGraceLookupKeys: [],
      },
    );
    expect(context.subscriptionId).toBe("sub_qualified");
  });

  it("replays a used expired challenge only with the bound active device proof", async () => {
    const issuer = generateKeyPairSync("ed25519");
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: "false",
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
      STRIPE_PRICE_PRO_ANNUAL: "price_annual",
      OIDC_ISSUER: "http://localhost:4000/",
      OIDC_AUDIENCE: "fixture",
      OIDC_JWKS_URL: "http://localhost:4000/jwks",
      APP_BASE_URL: "http://localhost:3000",
      LICENSE_ISSUER: "http://127.0.0.1:3000",
      LICENSE_KEY_ID: "integration-key",
      LICENSE_ED25519_PRIVATE_KEY_PEM: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      LICENSE_ED25519_PUBLIC_KEY_PEM: issuer.publicKey.export({ format: "pem", type: "spki" }).toString(),
    });
    resetEnvCacheForTests();

    const device = generateKeyPairSync("ed25519");
    const rawPublicKey = device.publicKey.export({ format: "der", type: "spki" }).subarray(12);
    const identity = parseDevicePublicKey(base64urlEncode(rawPublicKey));
    const replayChallengeId = randomUUID();
    const challenge = "expired-but-used-and-proof-bound";
    await pool.query(
      `INSERT INTO devices (id, account_id, public_key, public_key_sha256, display_name)
       VALUES ($1, $2, $3, $4, 'Replay device')`,
      [identity.deviceId, accountId, rawPublicKey, identity.publicKeySha256],
    );
    await pool.query(
      `INSERT INTO license_challenges
         (id, purpose, account_id, stripe_customer_id, device_id, device_public_key,
          device_key_sha256, challenge, expires_at, used_at)
       VALUES ($1, 'refresh', $2, $3, $4, $5, $6, $7, now() - interval '1 hour', now())`,
      [
        replayChallengeId,
        accountId,
        `cus_${accountId.replaceAll("-", "")}`,
        identity.deviceId,
        rawPublicKey,
        identity.publicKeySha256,
        challenge,
      ],
    );
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      v: 1,
      iss: "http://127.0.0.1:3000",
      aud: "dmoft-pro",
      sub: `cus_${accountId.replaceAll("-", "")}`,
      jti: randomUUID(),
      iat: now - 100,
      nbf: now - 105,
      exp: now + 1_000,
      grace_until: now + 2_000,
      tier: "pro",
      entitlements: ["camera.live"],
      device_id: identity.deviceId,
      device_key_sha256: identity.publicKeySha256,
      subscription_id: "sub_qualified",
    };
    await pool.query(
      `INSERT INTO issued_licenses
         (jti, challenge_id, account_id, stripe_customer_id, stripe_subscription_id,
          device_id, issued_at, expires_at, grace_until, claims)
       VALUES ($1, $2, $3, $4, 'sub_qualified', $5, to_timestamp($6),
               to_timestamp($7), to_timestamp($8), $9::jsonb)`,
      [
        claims.jti,
        replayChallengeId,
        accountId,
        claims.sub,
        identity.deviceId,
        claims.iat,
        claims.exp,
        claims.grace_until,
        JSON.stringify(claims),
      ],
    );
    await expect(refreshDeviceLicense({
      challengeId: replayChallengeId,
      deviceId: identity.deviceId,
      devicePublicKey: base64urlEncode(rawPublicKey),
      signature: base64urlEncode(Buffer.alloc(64)),
    })).rejects.toMatchObject({ code: "invalid_device_signature" });
    const response = await refreshDeviceLicense({
      challengeId: replayChallengeId,
      deviceId: identity.deviceId,
      devicePublicKey: base64urlEncode(rawPublicKey),
      signature: base64urlEncode(sign(null, Buffer.from(challenge, "utf8"), device.privateKey)),
    });
    expect(response.status).toBe("active");
    expect(response.license_token.split(".")).toHaveLength(3);
  });
});
