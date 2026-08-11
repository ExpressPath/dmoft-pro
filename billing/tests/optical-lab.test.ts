import { describe, expect, it } from "vitest";

import {
  LAB_PACKET_COPIES,
  LAB_SYMBOLS_PER_PACKET,
  buildLabPacket,
  classifyColor,
  dataCellCoordinates,
  decodeLabGridSymbols,
  encodeLabGridSymbols,
  estimatePalette,
  localizePalette,
  parseLabPacket,
  projectPoint,
  solveHomography,
  type Rgb,
} from "../src/lib/optical-lab";

const SESSION = new Uint8Array([0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);

describe("DMOFT C4 browser lab packet", () => {
  it("round-trips a fixed authenticated lab packet", () => {
    const packet = buildLabPacket(SESSION, 1_800_000_000);
    const decoded = parseLabPacket(packet.bytes);

    expect(decoded.sessionHex).toBe("1021324354657687");
    expect(decoded.timestampSeconds).toBe(1_800_000_000);
    expect(decoded.message).toBe("LIVE-OK!");
  });

  it("rejects a packet whose CRC-protected content changes", () => {
    const packet = buildLabPacket(SESSION, 1_800_000_000);
    const damaged = Uint8Array.from(packet.bytes);
    damaged[22] ^= 0x04;

    expect(() => parseLabPacket(damaged)).toThrow("CRC32");
  });

  it("recovers from one different damaged symbol in every copy", () => {
    const packet = buildLabPacket(SESSION, 1_800_000_000);
    const symbols: Array<number | null> = encodeLabGridSymbols(packet);
    for (let copy = 0; copy < LAB_PACKET_COPIES; copy += 1) {
      const index = (copy * LAB_SYMBOLS_PER_PACKET) + copy;
      symbols[index] = ((symbols[index] ?? 0) + 1) % 4;
    }

    const decoded = decodeLabGridSymbols(symbols);

    expect(decoded.repairMode).toBe("majority-repair");
    expect(decoded.validCopies).toBe(0);
    expect(decoded.packet.sessionHex).toBe(packet.sessionHex);
  });

  it("uses an intact copy when another copy contains erasures", () => {
    const packet = buildLabPacket(SESSION, 1_800_000_000);
    const symbols: Array<number | null> = encodeLabGridSymbols(packet);
    symbols[0] = null;

    const decoded = decodeLabGridSymbols(symbols);

    expect(decoded.repairMode).toBe("direct-copy");
    expect(decoded.validCopies).toBe(2);
  });

  it("reserves enough guarded grid cells for all three copies", () => {
    expect(dataCellCoordinates().length).toBe(540);
    expect(dataCellCoordinates().length).toBeGreaterThan(LAB_PACKET_COPIES * LAB_SYMBOLS_PER_PACKET);
  });
});

describe("DMOFT C4 browser lab optical math", () => {
  it("classifies against observed calibration rather than fixed display RGB", () => {
    const shifted: Rgb[][] = [
      [[180, 55, 65], [182, 53, 64]],
      [[45, 145, 92], [47, 147, 90]],
      [[55, 100, 180], [57, 98, 182]],
      [[205, 175, 55], [207, 173, 53]],
    ];
    const global = estimatePalette(shifted);
    const local = localizePalette(global, shifted.map((samples) => samples[0]));

    const decoded = classifyColor([51, 102, 177], local);

    expect(decoded.symbol).toBe(2);
    expect(decoded.erasure).toBe(false);
    expect(decoded.confidence).toBeGreaterThan(2);
  });

  it("projects logical cells through a perspective homography", () => {
    const source = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const destination = [
      { x: 10, y: 20 },
      { x: 130, y: 16 },
      { x: 118, y: 142 },
      { x: 18, y: 130 },
    ];
    const homography = solveHomography(source, destination);

    for (let index = 0; index < source.length; index += 1) {
      const projected = projectPoint(homography, source[index]);
      expect(projected.x).toBeCloseTo(destination[index].x, 7);
      expect(projected.y).toBeCloseTo(destination[index].y, 7);
    }
  });
});
