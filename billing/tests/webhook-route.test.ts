import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  processStripeEvent: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ webhooks: { constructEvent: mocks.constructEvent } }),
}));
vi.mock("@/lib/webhook", () => ({ processStripeEvent: mocks.processStripeEvent }));

import { POST } from "../src/app/api/v1/webhooks/stripe/route";

describe("production Stripe webhook mode binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue({
      NODE_ENV: "production",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      WEBHOOK_MAX_BYTES: 1024,
    });
  });

  it("rejects a signed test-mode event before persistence", async () => {
    mocks.constructEvent.mockReturnValue({
      id: "evt_fixture",
      livemode: false,
      type: "checkout.session.completed",
    });
    const response = await POST(new Request(
      "https://billing.example.test/api/v1/webhooks/stripe",
      {
        method: "POST",
        headers: { "stripe-signature": "fixture" },
        body: "{}",
      },
    ));
    expect(response.status).toBe(400);
    expect(mocks.processStripeEvent).not.toHaveBeenCalled();
  });
});
