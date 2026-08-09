import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_TERMS_VERSION } from "../src/lib/terms";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getOrCreateAccount: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  enforceRateLimit: vi.fn(),
  checkoutCreate: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authenticate: mocks.authenticate }));
vi.mock("@/lib/accounts", () => ({
  getOrCreateAccount: mocks.getOrCreateAccount,
  ensureStripeCustomer: mocks.ensureStripeCustomer,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: mocks.checkoutCreate } } }),
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import { POST } from "../src/app/api/v1/checkout/route";

describe("Checkout terms consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ subject: "oidc-user" });
    mocks.getOrCreateAccount.mockResolvedValue({ id: "account-id", auth_subject: "oidc-user" });
    mocks.ensureStripeCustomer.mockResolvedValue("cus_fixture");
    mocks.enforceRateLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 0 });
    mocks.getEnv.mockReturnValue({
      STRIPE_PRICE_PRO_MONTHLY: "price_monthly",
      STRIPE_PRICE_PRO_ANNUAL: "price_annual",
      APP_BASE_URL: "https://billing.test",
    });
    mocks.checkoutCreate.mockResolvedValue({ id: "cs_fixture", url: "https://checkout.stripe.test/1" });
  });

  it("requires Stripe TOS acceptance and versions session and subscription metadata", async () => {
    const request = new Request("https://billing.test/api/v1/checkout", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
        "Idempotency-Key": "fixture-key",
      },
      body: JSON.stringify({ plan: "pro_monthly" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        consent_collection: { terms_of_service: "required" },
        metadata: expect.objectContaining({ dmoft_terms_version: CURRENT_TERMS_VERSION }),
        subscription_data: {
          metadata: expect.objectContaining({ dmoft_terms_version: CURRENT_TERMS_VERSION }),
        },
      }),
      { idempotencyKey: "checkout:account-id:fixture-key" },
    );
  });
});
