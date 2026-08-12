import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  enforceRateLimit: vi.fn(),
  getOrCreateAccount: vi.fn(),
  portalCreate: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authenticate: mocks.authenticate }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock("@/lib/accounts", () => ({ getOrCreateAccount: mocks.getOrCreateAccount }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ billingPortal: { sessions: { create: mocks.portalCreate } } }),
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import { POST } from "../src/app/api/v1/portal/route";

describe("Customer Portal configuration binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ subject: "oidc-user" });
    mocks.enforceRateLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 0 });
    mocks.getOrCreateAccount.mockResolvedValue({
      id: "account-id",
      auth_subject: "oidc-user",
      stripe_customer_id: "cus_fixture",
    });
    mocks.getEnv.mockReturnValue({
      APP_BASE_URL: "https://billing.example.test",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_live_fixture",
    });
    mocks.portalCreate.mockResolvedValue({ url: "https://billing.stripe.test/session" });
  });

  it("pins sessions to the readiness-verified Portal configuration", async () => {
    const response = await POST(new Request("https://billing.example.test/api/v1/portal", {
      method: "POST",
      headers: { Authorization: "Bearer fixture" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.portalCreate).toHaveBeenCalledWith({
      customer: "cus_fixture",
      return_url: "https://billing.example.test/account",
      configuration: "bpc_live_fixture",
    });
  });
});
