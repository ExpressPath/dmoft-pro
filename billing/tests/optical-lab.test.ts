import { describe, expect, it } from "vitest";

import {
  C8_QR_PALETTE,
  DynamicLabDecoder,
  LAB_CHROMA_RADIX,
  LAB_OBJECT_BYTES,
  LAB_PACKET_COPIES,
  LAB_PALETTE_SIZE,
  LAB_QR_MODULES,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_SYMBOLS_PER_PACKET,
  applyChromaMask,
  buildBootstrapUrl,
  buildDynamicFrame,
  buildLabObject,
  classifyColor,
  decodeIntegratedPaletteSymbols,
  decodeQuaternaryToBytes,
  encodeBytesToQuaternary,
  estimatePalette,
  isDarkPaletteState,
  localizePalette,
  parseBootstrapUrl,
  parseDynamicFrame,
  prepareDynamicFrame,
  projectPoint,
  relativeLuminance,
  removeChromaMask,
  solveHomography,
  type Rgb,
} from "../src/lib/optical-lab";

const SESSION = new Uint8Array([0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);
const ORIGIN = "https://example.test";
const OBJECT = buildLabObject(SESSION);
const PREPARED = prepareDynamicFrame(SESSION, OBJECT.bytes, 3, ORIGIN);

describe("integrated QR-family dynamic stream", () => {
  it("builds a larger deterministic multi-frame source object", () => {
    expect(OBJECT.sessionHex).toBe("1021324354657687");
    expect(OBJECT.message).toBe("INTEGRATED-DYNAMIC-QR-OK");
    expect(OBJECT.bytes).toHaveLength(LAB_OBJECT_BYTES);
    expect(LAB_OBJECT_BYTES).toBe(1536);
  });

  it("uses one Version 10 QR matrix for geometry, bootstrap, pilots, and chroma payload", () => {
    const { matrix } = PREPARED;
    const reservedCount = Array.from(matrix.reserved).filter(Boolean).length;

    expect(matrix.size).toBe(LAB_QR_MODULES);
    expect(matrix.bits).toHaveLength(LAB_QR_MODULES ** 2);
    expect(reservedCount).toBeGreaterThan(400);
    expect(matrix.payloadCells.length).toBeGreaterThanOrEqual(LAB_SYMBOLS_PER_PACKET * LAB_PACKET_COPIES);
    expect(new Set(matrix.pilots.map((pilot) => pilot.paletteState)).size).toBe(LAB_PALETTE_SIZE);
  });

  it("preserves every underlying QR luminance bit while using black and white as data states", () => {
    const { matrix, paletteStates } = PREPARED;
    const payloadStates = matrix.payloadCells.map((cell) => paletteStates[cell.index]);

    for (let index = 0; index < matrix.bits.length; index += 1) {
      expect(isDarkPaletteState(paletteStates[index])).toBe(matrix.bits[index] === 1);
      if (matrix.reserved[index]) expect(paletteStates[index]).toBe(matrix.bits[index] ? 0 : LAB_CHROMA_RADIX);
    }
    expect(payloadStates).toContain(0);
    expect(payloadStates).toContain(4);
  });

  it("maintains a wide luminance gap between dark and light color quartets", () => {
    const darkMaximum = Math.max(...C8_QR_PALETTE.slice(0, 4).map(relativeLuminance));
    const lightMinimum = Math.min(...C8_QR_PALETTE.slice(4).map(relativeLuminance));

    expect(lightMinimum - darkMaximum).toBeGreaterThan(0.25);
  });

  it("round-trips frame bytes through two-bit chroma symbols", () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 73 + 19) & 0xff;

    const symbols = encodeBytesToQuaternary(bytes);

    expect(symbols).toHaveLength(LAB_SYMBOLS_PER_PACKET);
    expect(Array.from(decodeQuaternaryToBytes(symbols))).toEqual(Array.from(bytes));
  });

  it("makes all 16 chroma masks exactly reversible inside luminance classes", () => {
    const cells = PREPARED.matrix.payloadCells;
    const symbols = Array.from({ length: cells.length }, (_, index) => index % LAB_CHROMA_RADIX);
    for (let maskId = 0; maskId < 16; maskId += 1) {
      expect(removeChromaMask(applyChromaMask(symbols, maskId, cells), maskId, cells)).toEqual(symbols);
    }
  });

  it("decodes the dynamic packet directly from the integrated palette modules", () => {
    const observed = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const decoded = decodeIntegratedPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId);

    expect(decoded.frame.sessionHex).toBe(OBJECT.sessionHex);
    expect(decoded.frame.sequence).toBe(3);
    expect(decoded.frame.frameKind).toBe("systematic");
    expect(decoded.validCopies).toBe(LAB_PACKET_COPIES);
  });

  it("uses the intact spatially interleaved copy when the other has an erasure", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    observed[9] = null;

    const decoded = decodeIntegratedPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId);

    expect(decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.validCopies).toBe(1);
  });

  it("rejects a palette state that violates the QR luminance carrier", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const firstCell = PREPARED.matrix.payloadCells[0];
    observed[0] = PREPARED.matrix.bits[firstCell.index] ? 4 : 0;

    const decoded = decodeIntegratedPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId);

    expect(decoded.validCopies).toBe(1);
  });

  it("rejects CRC-protected frame modification", () => {
    const frame = buildDynamicFrame(SESSION, OBJECT.bytes, 0, 4);
    const damaged = Uint8Array.from(frame.bytes);
    damaged[60] ^= 0x20;

    expect(() => parseDynamicFrame(damaged)).toThrow("CRC32");
  });

  it("starts on repair frames and reconstructs without frame zero", () => {
    const decoder = new DynamicLabDecoder();
    for (let sequence = LAB_SOURCE_CHUNK_COUNT; sequence < 80 && !decoder.canRecoverObject(); sequence += 1) {
      decoder.addFrame(buildDynamicFrame(SESSION, OBJECT.bytes, sequence, sequence % 16));
    }

    expect(decoder.canRecoverObject()).toBe(true);
    expect(decoder.reconstruct().message).toBe("INTEGRATED-DYNAMIC-QR-OK");
  });

  it("carries dynamic control metadata in the same QR luminance matrix", () => {
    const url = buildBootstrapUrl(ORIGIN, PREPARED.frame);

    expect(parseBootstrapUrl(url, ORIGIN)).toEqual({
      sessionHex: OBJECT.sessionHex,
      sequence: PREPARED.frame.sequence,
      maskId: PREPARED.frame.maskId,
    });
  });
});

describe("integrated camera-space calibration and QR geometry", () => {
  it("classifies all eight observed camera-space palette states", () => {
    const shifted: Rgb[][] = [
      [[10, 12, 13], [12, 11, 14]],
      [[175, 37, 39], [177, 35, 41]],
      [[22, 105, 57], [24, 107, 55]],
      [[42, 68, 170], [44, 66, 172]],
      [[235, 238, 240], [237, 236, 242]],
      [[225, 205, 48], [227, 203, 50]],
      [[55, 195, 204], [57, 197, 202]],
      [[220, 130, 207], [222, 128, 209]],
    ];
    const global = estimatePalette(shifted);
    const local = localizePalette(global, shifted.map((samples) => samples[0]));

    const decoded = classifyColor([58, 193, 201], local);

    expect(decoded.symbol).toBe(6);
    expect(decoded.erasure).toBe(false);
    expect(decoded.confidence).toBeGreaterThan(2);
  });

  it("projects the single square QR grid through a perspective homography", () => {
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
