import { describe, expect, it } from "vitest";

import {
  DynamicLabDecoder,
  LAB_OBJECT_BYTES,
  LAB_PACKET_COPIES,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_SYMBOLS_PER_PACKET,
  applySymbolMask,
  buildBootstrapUrl,
  buildDynamicFrame,
  buildLabObject,
  classifyColor,
  dataCellCoordinates,
  decodeDynamicGridSymbols,
  decodeRadix6ToBytes,
  encodeBytesToRadix6,
  estimatePalette,
  localizePalette,
  parseBootstrapUrl,
  parseDynamicFrame,
  prepareDynamicFrame,
  projectPoint,
  removeSymbolMask,
  selectVisualMask,
  solveHomography,
  type Rgb,
} from "../src/lib/optical-lab";

const SESSION = new Uint8Array([0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);

describe("Prism C6 dynamic browser stream", () => {
  it("builds a deterministic multi-frame source object", () => {
    const object = buildLabObject(SESSION);

    expect(object.sessionHex).toBe("1021324354657687");
    expect(object.message).toBe("STARTLESS-DYNAMIC-OK");
    expect(object.bytes).toHaveLength(LAB_OBJECT_BYTES);
  });

  it("round-trips arbitrary bytes through fixed-width base-6 mapping", () => {
    const bytes = new Uint8Array(64);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 73 + 19) & 0xff;

    const symbols = encodeBytesToRadix6(bytes);

    expect(symbols).toHaveLength(LAB_SYMBOLS_PER_PACKET);
    expect(Array.from(decodeRadix6ToBytes(symbols))).toEqual(Array.from(bytes));
    expect(() => decodeRadix6ToBytes(new Array(25).fill(5))).toThrow("canonical");
  });

  it("makes all 16 visual masks exactly reversible", () => {
    const symbols = Array.from({ length: dataCellCoordinates().length }, (_, index) => index % 6);
    for (let maskId = 0; maskId < 16; maskId += 1) {
      expect(removeSymbolMask(applySymbolMask(symbols, maskId), maskId)).toEqual(symbols);
    }
    expect(selectVisualMask(symbols).maskId).toBeGreaterThanOrEqual(0);
  });

  it("encodes a self-describing frame in two guarded C6 copies", () => {
    const object = buildLabObject(SESSION);
    const prepared = prepareDynamicFrame(SESSION, object.bytes, 3);
    const decoded = decodeDynamicGridSymbols(prepared.displayedSymbols, prepared.frame.maskId);

    expect(decoded.frame.sessionHex).toBe(object.sessionHex);
    expect(decoded.frame.sequence).toBe(3);
    expect(decoded.frame.frameKind).toBe("systematic");
    expect(decoded.frame.equationMask).toBe(1 << 3);
    expect(decoded.validCopies).toBe(LAB_PACKET_COPIES);
  });

  it("uses the intact optical copy when the other has an erasure", () => {
    const object = buildLabObject(SESSION);
    const prepared = prepareDynamicFrame(SESSION, object.bytes, 8);
    const damaged: Array<number | null> = [...prepared.displayedSymbols];
    damaged[5] = null;

    const decoded = decodeDynamicGridSymbols(damaged, prepared.frame.maskId);

    expect(decoded.frame.frameKind).toBe("repair");
    expect(decoded.validCopies).toBe(1);
  });

  it("rejects CRC-protected frame modification", () => {
    const object = buildLabObject(SESSION);
    const frame = buildDynamicFrame(SESSION, object.bytes, 0, 4);
    const damaged = Uint8Array.from(frame.bytes);
    damaged[33] ^= 0x20;

    expect(() => parseDynamicFrame(damaged)).toThrow("CRC32");
  });

  it("reconstructs from systematic frames received out of order", () => {
    const object = buildLabObject(SESSION);
    const decoder = new DynamicLabDecoder();
    for (let sequence = LAB_SOURCE_CHUNK_COUNT - 1; sequence >= 0; sequence -= 1) {
      decoder.addFrame(buildDynamicFrame(SESSION, object.bytes, sequence, sequence % 16));
    }

    expect(decoder.progress().rank).toBe(LAB_SOURCE_CHUNK_COUNT);
    expect(Array.from(decoder.reconstruct().bytes)).toEqual(Array.from(object.bytes));
  });

  it("starts after frame zero and reconstructs from repair equations only", () => {
    const object = buildLabObject(SESSION);
    const decoder = new DynamicLabDecoder();
    for (let sequence = LAB_SOURCE_CHUNK_COUNT; sequence < 80 && !decoder.canRecoverObject(); sequence += 1) {
      decoder.addFrame(buildDynamicFrame(SESSION, object.bytes, sequence, sequence % 16));
    }

    expect(decoder.canRecoverObject()).toBe(true);
    expect(decoder.reconstruct().message).toBe("STARTLESS-DYNAMIC-OK");
  });

  it("carries the session, sequence, and mask in the monochrome QR control plane", () => {
    const object = buildLabObject(SESSION);
    const frame = buildDynamicFrame(SESSION, object.bytes, 42, 13);
    const url = buildBootstrapUrl("https://example.test", frame);

    expect(parseBootstrapUrl(url, "https://example.test")).toEqual({
      sessionHex: object.sessionHex,
      sequence: 42,
      maskId: 13,
    });
    expect(() => parseBootstrapUrl(url, "https://wrong.test")).toThrow("origin");
  });

  it("reserves enough guarded cells for both 64-byte base-6 copies", () => {
    expect(dataCellCoordinates()).toHaveLength(522);
    expect(dataCellCoordinates().length).toBeGreaterThan(LAB_PACKET_COPIES * LAB_SYMBOLS_PER_PACKET);
  });
});

describe("Prism C6 optical calibration and geometry", () => {
  it("classifies against six observed camera-space colors", () => {
    const shifted: Rgb[][] = [
      [[180, 55, 65], [182, 53, 64]],
      [[45, 145, 92], [47, 147, 90]],
      [[55, 100, 180], [57, 98, 182]],
      [[205, 175, 55], [207, 173, 53]],
      [[42, 158, 169], [44, 160, 167]],
      [[165, 72, 168], [167, 70, 170]],
    ];
    const global = estimatePalette(shifted);
    const local = localizePalette(global, shifted.map((samples) => samples[0]));

    const decoded = classifyColor([47, 156, 166], local);

    expect(decoded.symbol).toBe(4);
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
