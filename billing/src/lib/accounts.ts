import type { PoolClient } from "pg";
import { getStripe } from "./stripe";
import { query, transaction } from "./db";
import { HttpError } from "./errors";

export type AccountRow = {
  id: string;
  auth_subject: string;
  stripe_customer_id: string | null;
};

export async function getOrCreateAccount(subject: string): Promise<AccountRow> {
  const result = await query<AccountRow>(
    `INSERT INTO accounts (auth_subject) VALUES ($1)
     ON CONFLICT (auth_subject) DO UPDATE SET updated_at = now()
     RETURNING id, auth_subject, stripe_customer_id`,
    [subject],
  );
  const account = result.rows[0];
  if (!account) throw new Error("Account upsert returned no row");
  return account;
}

export async function ensureStripeCustomer(account: AccountRow): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  return transaction(async (client) => {
    const locked = await client.query<AccountRow>(
      "SELECT id, auth_subject, stripe_customer_id FROM accounts WHERE id = $1 FOR UPDATE",
      [account.id],
    );
    const row = locked.rows[0];
    if (!row) throw new HttpError(404, "account_not_found", "Account does not exist.");
    if (row.stripe_customer_id) return row.stripe_customer_id;
    const customer = await getStripe().customers.create(
      { metadata: { dmoft_account_id: row.id } },
      { idempotencyKey: `dmoft-customer-${row.id}` },
    );
    await client.query(
      "UPDATE accounts SET stripe_customer_id = $1, updated_at = now() WHERE id = $2",
      [customer.id, row.id],
    );
    return customer.id;
  });
}

export async function findAccountByCustomer(
  client: Pick<PoolClient, "query">,
  stripeCustomerId: string,
): Promise<AccountRow | undefined> {
  const result = await client.query<AccountRow>(
    "SELECT id, auth_subject, stripe_customer_id FROM accounts WHERE stripe_customer_id = $1",
    [stripeCustomerId],
  );
  return result.rows[0];
}
