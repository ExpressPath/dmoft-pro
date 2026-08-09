import Stripe from "stripe";
import { getEnv } from "./env";

let client: Stripe | undefined;

export function getStripe(): Stripe {
  if (!client) {
    client = new Stripe(getEnv().STRIPE_SECRET_KEY, {
      apiVersion: "2026-07-29.dahlia",
      appInfo: { name: "DMOFT Pro Billing", version: "0.1.0" },
      maxNetworkRetries: 2,
      typescript: true,
    });
  }
  return client;
}
