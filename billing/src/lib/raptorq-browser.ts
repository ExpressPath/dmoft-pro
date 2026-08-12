import initRaptorQ, { Decoder, Encoder, EncodingPacket } from "raptorq/raptorq.js";

let initialization: Promise<void> | null = null;

export function ensureRaptorQInitialized(): Promise<void> {
  if (!initialization) {
    initialization = initRaptorQ("/raptorq_bg.wasm").then(() => undefined).catch((error: unknown) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

export function createRaptorQPackets(
  object: Uint8Array,
  serializedPacketBytes: number,
  repairPacketsPerBlock = 96,
): Uint8Array[] {
  if (object.length === 0) throw new Error("RaptorQ object must not be empty");
  if (!Number.isSafeInteger(serializedPacketBytes) || serializedPacketBytes < 68) {
    throw new Error("RaptorQ serialized packet is too small");
  }
  if (!Number.isSafeInteger(repairPacketsPerBlock) || repairPacketsPerBlock < 0) {
    throw new Error("RaptorQ repair count is invalid");
  }
  const encoder = Encoder.with_defaults(object, serializedPacketBytes - 4);
  try {
    const packets = encoder.encode(repairPacketsPerBlock).map((packet) => Uint8Array.from(packet));
    if (packets.length === 0 || packets.some((packet) => packet.length !== serializedPacketBytes)) {
      throw new Error("RaptorQ emitted an invalid packet envelope");
    }
    return packets;
  } finally {
    encoder.free();
  }
}

export type RaptorQPacketIdentity = Readonly<{
  sourceBlock: number;
  encodingSymbolId: number;
}>;

export function inspectRaptorQPacket(packet: Uint8Array): RaptorQPacketIdentity {
  const decoded = EncodingPacket.deserialize(packet);
  try {
    return {
      sourceBlock: decoded.source_block_number(),
      encodingSymbolId: decoded.encoding_symbol_id(),
    };
  } finally {
    decoded.free();
  }
}

export class RaptorQObjectDecoder {
  readonly #decoder: Decoder;
  readonly #packetSize: number;
  readonly #accepted = new Set<string>();
  #complete = false;

  constructor(objectLength: number, serializedPacketBytes: number) {
    if (!Number.isSafeInteger(objectLength) || objectLength <= 0) throw new Error("RaptorQ object length is invalid");
    if (!Number.isSafeInteger(serializedPacketBytes) || serializedPacketBytes < 68) throw new Error("RaptorQ packet envelope is invalid");
    this.#decoder = Decoder.with_defaults(BigInt(objectLength), serializedPacketBytes - 4);
    this.#packetSize = serializedPacketBytes;
  }

  get acceptedPacketCount(): number {
    return this.#accepted.size;
  }

  add(packet: Uint8Array): Uint8Array | null {
    if (this.#complete) return null;
    if (packet.length !== this.#packetSize) throw new Error("RaptorQ packet size does not match the session");
    const identity = inspectRaptorQPacket(packet);
    const key = `${identity.sourceBlock}:${identity.encodingSymbolId}`;
    if (this.#accepted.has(key)) return null;
    this.#accepted.add(key);
    const object = this.#decoder.add(packet);
    if (!object) return null;
    this.#complete = true;
    return Uint8Array.from(object);
  }

  free(): void {
    this.#decoder.free();
  }
}
