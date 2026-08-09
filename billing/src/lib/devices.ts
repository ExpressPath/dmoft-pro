import { transaction, query } from "./db";
import { HttpError } from "./errors";

const DEVICE_ID_PATTERN = /^dmoft-device-v1-[A-Za-z0-9_-]{24}$/;

type DeviceRow = {
  id: string;
  display_name: string;
  status: "active" | "revoked";
  first_activated_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
};

export type DeviceDocument = {
  device_id: string;
  device_name: string;
  status: "active" | "revoked";
  first_activated_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

function document(row: DeviceRow): DeviceDocument {
  return {
    device_id: row.id,
    device_name: row.display_name,
    status: row.status,
    first_activated_at: row.first_activated_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}

export function validateDeviceId(deviceId: string): string {
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new HttpError(400, "invalid_device_id", "Device identifier is invalid.");
  }
  return deviceId;
}

export async function listAccountDevices(accountId: string): Promise<{ devices: DeviceDocument[] }> {
  const result = await query<DeviceRow>(
    `SELECT id, display_name, status, first_activated_at, last_seen_at, revoked_at
       FROM devices
      WHERE account_id = $1
      ORDER BY first_activated_at, id`,
    [accountId],
  );
  return { devices: result.rows.map(document) };
}

export async function revokeAccountDevice(
  accountId: string,
  requestedDeviceId: string,
): Promise<DeviceDocument & { offline_token_valid_until: string | null }> {
  const deviceId = validateDeviceId(requestedDeviceId);
  return transaction(async (client) => {
    const account = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      [accountId],
    );
    if (!account.rows[0]) {
      throw new HttpError(404, "account_not_found", "Account does not exist.");
    }
    const selected = await client.query<DeviceRow>(
      `SELECT id, display_name, status, first_activated_at, last_seen_at, revoked_at
         FROM devices
        WHERE id = $1 AND account_id = $2
        FOR UPDATE`,
      [deviceId, accountId],
    );
    let row = selected.rows[0];
    if (!row) {
      throw new HttpError(404, "device_not_found", "Device does not belong to this account.");
    }
    if (row.status !== "revoked") {
      const updated = await client.query<DeviceRow>(
        `UPDATE devices
            SET status = 'revoked', revoked_at = now(), last_seen_at = now()
          WHERE id = $1
        RETURNING id, display_name, status, first_activated_at, last_seen_at, revoked_at`,
        [deviceId],
      );
      row = updated.rows[0] ?? row;
    }
    await client.query(
      "UPDATE issued_licenses SET revoked_at = COALESCE(revoked_at, now()) WHERE device_id = $1",
      [deviceId],
    );
    const offline = await client.query<{ valid_until: Date | null }>(
      "SELECT max(grace_until) AS valid_until FROM issued_licenses WHERE device_id = $1 AND grace_until > now()",
      [deviceId],
    );
    return {
      ...document(row),
      offline_token_valid_until: offline.rows[0]?.valid_until?.toISOString() ?? null,
    };
  });
}
