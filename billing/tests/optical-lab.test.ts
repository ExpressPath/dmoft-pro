import { describe, expect, it } from "vitest";

import {
  C8_QR_PALETTE,
  DynamicLabDecoder,
  LAB_CHROMA_RADIX,
  LAB_FRAME,
  LAB_INNER_CODE_RATE,
  LAB_INNER_CODEWORD_BYTES,
  LAB_INNER_PARITY_BYTES,
  LAB_MICRO_DERIVED_QUIET_MODULES,
  LAB_OBJECT_BYTES,
  LAB_PACKET_BYTES,
  LAB_PALETTE_SIZE,
  LAB_PROFILE_AREA_GAIN,
  LAB_PROFILE_NAME,
  LAB_QR_MODULES,
  LAB_QUIET_ZONE_AREA_GAIN,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_SYMBOLS_PER_CODEWORD,
  LAB_VERIFIED_PAYLOAD_DENSITY_GAIN,
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
    expect(OBJECT.message).toBe("JOINT-MAX-DYNAMIC-QR-OK");
    expect(OBJECT.bytes).toHaveLength(LAB_OBJECT_BYTES);
    expect(LAB_OBJECT_BYTES).toBe(1392);
  });

  it("uses one Version 5 QR matrix with Micro-derived margin and compact pilots", () => {
    const { matrix } = PREPARED;
    const reservedCount = Array.from(matrix.reserved).filter(Boolean).length;
    const globalPilots = matrix.pilots.filter((pilot) => pilot.scope === "global");
    const localPilots = matrix.pilots.filter((pilot) => pilot.scope === "local");

    expect(matrix.size).toBe(LAB_QR_MODULES);
    expect(matrix.bits).toHaveLength(LAB_QR_MODULES ** 2);
    expect(reservedCount).toBeGreaterThan(250);
    expect(matrix.payloadCells.length).toBeGreaterThanOrEqual(LAB_SYMBOLS_PER_CODEWORD);
    expect(globalPilots).toHaveLength(32);
    expect(new Set(globalPilots.map((pilot) => pilot.paletteState)).size).toBe(LAB_PALETTE_SIZE);
    for (let state = 0; state < LAB_PALETTE_SIZE; state += 1) {
      const regions = globalPilots
        .filter((pilot) => pilot.paletteState === state)
        .map((pilot) => `${pilot.row < matrix.size / 2 ? "top" : "bottom"}:${pilot.column < matrix.size / 2 ? "left" : "right"}`);
      expect(new Set(regions).size).toBe(4);
    }
    expect(localPilots).toHaveLength(44);
    expect(matrix.pilots).toHaveLength(76);
    expect(matrix.payloadCells).toHaveLength(1003);
    expect(LAB_FRAME.quietModules).toBe(LAB_MICRO_DERIVED_QUIET_MODULES);
    expect(LAB_FRAME.width).toBe((LAB_QR_MODULES + (2 * LAB_MICRO_DERIVED_QUIET_MODULES)) * LAB_FRAME.modulePitch);
    expect(LAB_QUIET_ZONE_AREA_GAIN).toBeGreaterThan(1.13);
    expect(LAB_PROFILE_AREA_GAIN).toBeGreaterThan(2.2);
    expect(LAB_VERIFIED_PAYLOAD_DENSITY_GAIN).toBeGreaterThan(1.5);
    expect(LAB_INNER_CODEWORD_BYTES).toBe(250);
    expect(LAB_INNER_PARITY_BYTES).toBe(40);
    expect(LAB_INNER_CODE_RATE).toBeCloseTo(0.84, 8);
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
    const bytes = new Uint8Array(LAB_PACKET_BYTES);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 73 + 19) & 0xff;

    const symbols = encodeBytesToQuaternary(bytes);

    expect(symbols).toHaveLength(LAB_PACKET_BYTES * 4);
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
    const decoded = decodeIntegratedPaletteSymbols(observed, PREPARED.matrix);

    expect(decoded.frame.sessionHex).toBe(OBJECT.sessionHex);
    expect(decoded.frame.sequence).toBe(3);
    expect(decoded.frame.frameKind).toBe("systematic");
    expect(decoded.repairMode).toBe("cauchy-mds-erasure");
    expect(decoded.correctedByteErasures).toBe(0);
    expect(decoded.inferredMaskId).toBe(PREPARED.frame.maskId);
  });

  it("repairs erased chroma bytes from the Cauchy MDS parity", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    for (let byte = 0; byte < LAB_INNER_PARITY_BYTES; byte += 1) observed[byte * 4] = null;

    const decoded = decodeIntegratedPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId);

    expect(decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.correctedByteErasures).toBe(LAB_INNER_PARITY_BYTES);
  });

  it("rejects a palette state that violates the QR luminance carrier", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const firstCell = PREPARED.matrix.payloadCells[0];
    observed[0] = PREPARED.matrix.bits[firstCell.index] ? 4 : 0;

    const decoded = decodeIntegratedPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId);

    expect(decoded.correctedByteErasures).toBe(1);
  });

  it("rejects an unmarked within-luminance chroma substitution", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const original = observed[40] as number;
    observed[40] = (original < 4 ? 0 : 4) + (((original % 4) + 1) % 4);

    expect(() => decodeIntegratedPaletteSymbols(
      observed,
      PREPARED.matrix,
      PREPARED.frame.maskId,
    )).toThrow("valid MDS");
  });

  it("rejects byte erasures beyond the forty-byte inner budget", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    for (let byte = 0; byte <= LAB_INNER_PARITY_BYTES; byte += 1) observed[byte * 4] = null;

    expect(() => decodeIntegratedPaletteSymbols(
      observed,
      PREPARED.matrix,
      PREPARED.frame.maskId,
    )).toThrow("valid MDS");
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
    expect(decoder.reconstruct().message).toBe("JOINT-MAX-DYNAMIC-QR-OK");
  });

  it("uses one stable short bootstrap while inferring dynamic control from MDS-protected chroma", () => {
    const url = buildBootstrapUrl(ORIGIN);
    const nextFrame = buildDynamicFrame(SESSION, OBJECT.bytes, 30, 12);

    expect(url).toBe("https://example.test/o");
    expect(buildBootstrapUrl(ORIGIN)).toBe(url);
    expect(nextFrame.sequence).not.toBe(PREPARED.frame.sequence);
    expect(parseBootstrapUrl(url, ORIGIN)).toEqual({ profile: LAB_PROFILE_NAME });
    expect(() => parseBootstrapUrl(`${url}?unexpected=1`, ORIGIN)).toThrow("accepted optical-lab origin");
    expect(() => parseBootstrapUrl("https://attacker.test/o", ORIGIN)).toThrow("accepted optical-lab origin");
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
    const local = localizePalette(global, [shifted[0][0], shifted[4][0]]);

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
