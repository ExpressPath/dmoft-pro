import { z } from "zod";
import { HttpError } from "./errors";

export const MAXIMUM_JSON_BODY_BYTES = 64 * 1024;

const devicePublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export const checkoutSchema = z.object({
  plan: z.enum(["pro_monthly", "pro_annual"]),
}).strict();

export const challengeSchema = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("activate"),
    checkout_session_id: z.string().startsWith("cs_").max(255),
    device_public_key: devicePublicKey,
  }).strict(),
  z.object({
    purpose: z.literal("refresh"),
    device_id: z.string().startsWith("dmoft-device-v1-").max(128),
    device_public_key: devicePublicKey,
  }).strict(),
]);

export const activateSchema = z.object({
  challenge_id: z.string().uuid(),
  checkout_session_id: z.string().startsWith("cs_").max(255),
  device_public_key: devicePublicKey,
  device_name: z.string().trim().min(1).max(80),
  signature,
}).strict();

export const refreshSchema = z.object({
  challenge_id: z.string().uuid(),
  device_id: z.string().startsWith("dmoft-device-v1-").max(128),
  device_public_key: devicePublicKey,
  signature,
}).strict();

export const enrollmentChallengeSchema = z.object({
  device_public_key: devicePublicKey,
}).strict();

export const enrollDeviceSchema = z.object({
  challenge_id: z.string().uuid(),
  device_public_key: devicePublicKey,
  device_name: z.string().trim().min(1).max(80),
  signature,
}).strict();

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (parsedLength > MAXIMUM_JSON_BODY_BYTES) {
      throw new HttpError(413, "request_too_large", "JSON request body exceeds 64 KiB.");
    }
  }
  let value: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing request body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      total += chunk.byteLength;
      if (total > MAXIMUM_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large", "JSON request body exceeds 64 KiB.");
      }
      chunks.push(chunk);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, "invalid_request", "Request body does not match the required schema.");
  }
  return result.data;
}
