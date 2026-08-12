import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Decoder, Encoder, initSync } from "raptorq/raptorq.js";
import { describe, expect, it } from "vitest";

describe("RFC 6330 RaptorQ outer FEC", () => {
  it("reconstructs an object after systematic packet loss and reordering", () => {
    initSync(readFileSync(resolve("node_modules/raptorq/raptorq_bg.wasm")));
    const object = Uint8Array.from({ length: 6_464 }, (_, index) => (Math.imul(index, 131) + 17) & 0xff);
    const mtu = 808;
    const serializedPacketSize = 812;
    const encoder = Encoder.with_defaults(object, mtu);
    const decoder = Decoder.with_defaults(BigInt(object.length), mtu);
    try {
      const packets = encoder.encode(24);
      expect(packets.every((packet) => packet.length === serializedPacketSize)).toBe(true);
      const received = packets.filter((_, index) => ![0, 2, 5, 8].includes(index)).reverse();
      let reconstructed: Uint8Array | undefined;
      for (const packet of received) {
        reconstructed = decoder.add(packet) ?? reconstructed;
        if (reconstructed) break;
      }
      expect(reconstructed).toEqual(object);
    } finally {
      encoder.free();
      decoder.free();
    }
  });
});
