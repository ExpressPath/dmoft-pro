import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getOrCreateAccount: vi.fn(),
  createActivationChallenge: vi.fn(),
  createRefreshChallenge: vi.fn(),
  activateDevice: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authenticate: mocks.authenticate }));
vi.mock("@/lib/accounts", () => ({ getOrCreateAccount: mocks.getOrCreateAccount }));
vi.mock("@/lib/challenges", () => ({
  createActivationChallenge: mocks.createActivationChallenge,
  createRefreshChallenge: mocks.createRefreshChallenge,
}));
vi.mock("@/lib/license-service", () => ({ activateDevice: mocks.activateDevice }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: mocks.enforceRateLimit }));

import { POST as challengePost } from "../src/app/api/v1/licenses/challenge/route";
import { POST as activatePost } from "../src/app/api/v1/licenses/activate/route";

const deviceKey = "A".repeat(43);
const signature = "A".repeat(86);

describe("OIDC-bound initial activation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ subject: "oidc-user-1" });
    mocks.getOrCreateAccount.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      auth_subject: "oidc-user-1",
      stripe_customer_id: "cus_fixture",
    });
    mocks.enforceRateLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: 0 });
  });

  it("passes the authenticated account into activation challenge creation", async () => {
    mocks.createActivationChallenge.mockResolvedValue({
      challenge_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      challenge: "fixture",
      expires_at: 2_000_000_000,
    });
    const request = new Request("https://billing.test/api/v1/licenses/challenge", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        purpose: "activate",
        checkout_session_id: "cs_test_fixture",
        device_public_key: deviceKey,
      }),
    });
    const response = await challengePost(request);
    expect(response.status).toBe(201);
    expect(mocks.authenticate).toHaveBeenCalledWith(request);
    expect(mocks.createActivationChallenge).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "cs_test_fixture",
      deviceKey,
    );
  });

  it("passes the authenticated account into activation completion", async () => {
    mocks.activateDevice.mockResolvedValue({
      license_token: "a.b.c",
      status: "active",
      refresh_after: 2_000_000_000,
    });
    const request = new Request("https://billing.test/api/v1/licenses/activate", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        challenge_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        checkout_session_id: "cs_test_fixture",
        device_public_key: deviceKey,
        device_name: "Laptop",
        signature,
      }),
    });
    const response = await activatePost(request);
    expect(response.status).toBe(200);
    expect(mocks.activateDevice).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      checkoutSessionId: "cs_test_fixture",
    }));
  });
});
