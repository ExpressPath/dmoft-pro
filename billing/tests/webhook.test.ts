import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  retrieve: vi.fn(),
  syncSubscription: vi.fn(),
  syncEntitlementsForCustomer: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
  transaction: mocks.transaction,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ subscriptions: { retrieve: mocks.retrieve } }),
}));
vi.mock("@/lib/stripe-sync", () => ({
  stripeId: (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id ?? null,
  syncSubscription: mocks.syncSubscription,
  syncEntitlementsForCustomer: mocks.syncEntitlementsForCustomer,
}));

import { processStripeEvent } from "../src/lib/webhook";

describe("Stripe webhook canonical subscription state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ status: "received", processing_started_at: null }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    mocks.transaction.mockImplementation(async (callback: (value: typeof client) => Promise<unknown>) => callback(client));
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("retrieves the current subscription instead of applying a stale event snapshot", async () => {
    const delivered = { id: "sub_fixture", customer: "cus_fixture", status: "past_due" };
    const canonical = { id: "sub_fixture", customer: "cus_fixture", status: "active" };
    mocks.retrieve.mockResolvedValue(canonical);
    const event = {
      id: "evt_fixture",
      type: "customer.subscription.updated",
      created: 2_000_000_000,
      livemode: false,
      data: { object: delivered },
    } as Stripe.Event;

    await processStripeEvent(event);

    expect(mocks.retrieve).toHaveBeenCalledWith("sub_fixture");
    expect(mocks.syncSubscription).toHaveBeenCalledWith(canonical);
    expect(mocks.syncSubscription).not.toHaveBeenCalledWith(delivered);
    expect(mocks.syncEntitlementsForCustomer).toHaveBeenCalledWith("cus_fixture");
  });
});
