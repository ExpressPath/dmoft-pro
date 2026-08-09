import { timingSafeEqual } from "node:crypto";
import { query } from "./db";
import { createChallengeText, parseDevicePublicKey, type ChallengePurpose } from "./device-crypto";
import { getEnv } from "./env";
import { HttpError } from "./errors";
import { getStripe } from "./stripe";
import { refreshCustomerBillingProjection, stripeId } from "./stripe-sync";
import { getLicenseContext } from "./entitlements";
import { CURRENT_TERMS_VERSION } from "./terms";

export type ChallengeResponse = { challenge_id: string; challenge: string; expires_at: number };

async function persistChallenge(input: {
  purpose: ChallengePurpose;
  accountId: string;
  stripeCustomerId: string;
  checkoutSessionId?: string;
  stripeSubscriptionId?: string;
  termsVersion?: string;
  devicePublicKey: string;
}): Promise<ChallengeResponse> {
  const identity = parseDevicePublicKey(input.devicePublicKey);
  const expiresAt = Math.floor(Date.now() / 1000) + getEnv().CHALLENGE_TTL_SECONDS;
  const generated = createChallengeText({
    purpose: input.purpose,
    deviceId: identity.deviceId,
    deviceKeySha256: identity.publicKeySha256,
    checkoutSessionId: input.checkoutSessionId,
    expiresAt,
  });
  await query(
    `INSERT INTO license_challenges
       (id, purpose, account_id, stripe_customer_id, checkout_session_id,
        stripe_subscription_id, terms_version, device_id, device_public_key,
        device_key_sha256, challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12))`,
    [
      generated.challengeId,
      input.purpose,
      input.accountId,
      input.stripeCustomerId,
      input.checkoutSessionId ?? null,
      input.stripeSubscriptionId ?? null,
      input.termsVersion ?? null,
      identity.deviceId,
      identity.rawPublicKey,
      identity.publicKeySha256,
      generated.challenge,
      expiresAt,
    ],
  );
  return { challenge_id: generated.challengeId, challenge: generated.challenge, expires_at: expiresAt };
}

export async function createActivationChallenge(
  authenticatedAccountId: string,
  checkoutSessionId: string,
  devicePublicKey: string,
): Promise<ChallengeResponse> {
  const session = await getStripe().checkout.sessions.retrieve(checkoutSessionId, { expand: ["subscription"] });
  const customerId = stripeId(session.customer);
  const subscription = session.subscription && typeof session.subscription !== "string" ? session.subscription : null;
  const metadataPlan = session.metadata?.dmoft_plan;
  if (
    session.status !== "complete"
    || session.mode !== "subscription"
    || !["paid", "no_payment_required"].includes(session.payment_status)
    || !customerId
    || !session.client_reference_id
    || session.metadata?.dmoft_account_id !== session.client_reference_id
    || session.metadata?.dmoft_terms_version !== CURRENT_TERMS_VERSION
    || session.consent?.terms_of_service !== "accepted"
    || !["pro_monthly", "pro_annual"].includes(metadataPlan ?? "")
    || !subscription
    || subscription.metadata.dmoft_account_id !== session.client_reference_id
    || subscription.metadata.dmoft_plan !== metadataPlan
    || subscription.metadata.dmoft_terms_version !== CURRENT_TERMS_VERSION
    || !["active", "trialing", "past_due"].includes(subscription.status)
  ) {
    throw new HttpError(403, "checkout_not_eligible", "Checkout does not represent an eligible subscription.");
  }
  const accountResult = await query<{ id: string; stripe_customer_id: string | null }>(
    "SELECT id, stripe_customer_id FROM accounts WHERE id = $1",
    [session.client_reference_id],
  );
  const account = accountResult.rows[0];
  if (
    !account
    || account.id !== authenticatedAccountId
    || account.stripe_customer_id !== customerId
  ) {
    throw new HttpError(403, "checkout_not_linked", "Checkout is not linked to a DMOFT account.");
  }
  const activationResult = await query<{
    account_id: string;
    consumed_at: Date | null;
    stripe_subscription_id: string | null;
    terms_version: string | null;
  }>(
    `INSERT INTO checkout_activations
       (stripe_checkout_session_id, account_id, stripe_subscription_id, terms_version, terms_accepted_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (stripe_checkout_session_id) DO UPDATE SET
       stripe_subscription_id = COALESCE(checkout_activations.stripe_subscription_id, EXCLUDED.stripe_subscription_id),
       terms_version = COALESCE(checkout_activations.terms_version, EXCLUDED.terms_version),
       terms_accepted_at = COALESCE(checkout_activations.terms_accepted_at, EXCLUDED.terms_accepted_at)
     RETURNING account_id, consumed_at, stripe_subscription_id, terms_version`,
    [checkoutSessionId, account.id, subscription.id, CURRENT_TERMS_VERSION],
  );
  if (
    activationResult.rows[0]?.account_id !== account.id
    || activationResult.rows[0]?.stripe_subscription_id !== subscription.id
    || activationResult.rows[0]?.terms_version !== CURRENT_TERMS_VERSION
  ) {
    throw new HttpError(403, "checkout_not_linked", "Checkout activation account binding is invalid.");
  }
  if (activationResult.rows[0]?.consumed_at) {
    throw new HttpError(409, "checkout_already_activated", "This Checkout Session has already activated a device.");
  }
  await refreshCustomerBillingProjection(customerId, subscription);
  return persistChallenge({
    purpose: "activate",
    accountId: account.id,
    stripeCustomerId: customerId,
    checkoutSessionId,
    stripeSubscriptionId: subscription.id,
    termsVersion: CURRENT_TERMS_VERSION,
    devicePublicKey,
  });
}

export async function createRefreshChallenge(
  deviceId: string,
  devicePublicKey: string,
): Promise<ChallengeResponse> {
  const identity = parseDevicePublicKey(devicePublicKey);
  if (identity.deviceId !== deviceId) {
    throw new HttpError(400, "device_binding_mismatch", "Device identifier does not match the public key.");
  }
  const result = await query<{
    account_id: string;
    stripe_customer_id: string;
    public_key: Buffer;
  }>(
    `SELECT d.account_id, a.stripe_customer_id, d.public_key
       FROM devices d JOIN accounts a ON a.id = d.account_id
      WHERE d.id = $1 AND d.status = 'active'`,
    [deviceId],
  );
  const device = result.rows[0];
  if (!device?.stripe_customer_id || !timingSafeEqual(device.public_key, identity.rawPublicKey)) {
    throw new HttpError(404, "active_device_not_found", "Active device was not found.");
  }
  await refreshCustomerBillingProjection(device.stripe_customer_id);
  return persistChallenge({
    purpose: "refresh",
    accountId: device.account_id,
    stripeCustomerId: device.stripe_customer_id,
    devicePublicKey,
  });
}

export async function createEnrollmentChallenge(
  accountId: string,
  stripeCustomerId: string,
  devicePublicKey: string,
): Promise<ChallengeResponse> {
  await refreshCustomerBillingProjection(stripeCustomerId);
  const context = await getLicenseContext(stripeCustomerId);
  if (context.accountId !== accountId) {
    throw new HttpError(403, "account_binding_mismatch", "Billing customer is not linked to this account.");
  }
  return persistChallenge({
    purpose: "enroll",
    accountId,
    stripeCustomerId,
    devicePublicKey,
  });
}
