import { describe, expect, it } from "vitest";

import {
  C16_PRISM_PALETTE,
  DynamicLabDecoder,
  LAB_ACTIVE_QUIET_MODULES,
  LAB_CHROMA_RADIX,
  LAB_COLOR_CORE_RATIO,
  LAB_FRAME,
  LAB_INNER_CODE_RATE,
  LAB_INNER_CODEWORD_BYTES,
  LAB_INNER_PARITY_BYTES,
  LAB_INNER_STRIPE_CODEWORD_BYTES,
  LAB_INNER_STRIPE_COUNT,
  LAB_OBJECT_BYTES,
  LAB_PACKET_BYTES,
  LAB_PALETTE_SIZE,
  LAB_PROFILE_AREA_GAIN,
  LAB_PROFILE_NAME,
  LAB_RX5_PAYLOAD_GAIN,
  LAB_SOURCE_CHUNK_BYTES,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_SYMBOL_MODULES,
  LAB_SYMBOLS_PER_CODEWORD,
  LAB_VERIFIED_PAYLOAD_DENSITY_GAIN,
  applyPaletteMask,
  buildBootstrapUrl,
  buildDynamicFrame,
  buildLabObject,
  classifyColor,
  colorDistance,
  decodeNibblesToOptionalBytes,
  decodePrismPaletteSymbols,
  encodeBytesToNibbles,
  estimatePalette,
  localizePalette,
  parseBootstrapUrl,
  parseDynamicFrame,
  prepareDynamicFrame,
  projectPoint,
  removePaletteMask,
  solveHomography,
  type Rgb,
} from "../src/lib/optical-lab";

const SESSION = new Uint8Array([0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);
const ORIGIN = "https://example.test";
const OBJECT = buildLabObject(SESSION);
const PREPARED = prepareDynamicFrame(SESSION, OBJECT.bytes, 3);

describe("PRISM-C16 custom dynamic physical layer", () => {
  it("builds a deterministic eight-symbol object with the expanded source geometry", () => {
    expect(OBJECT.sessionHex).toBe("1021324354657687");
    expect(OBJECT.message).toBe("PRISM-C16-CUSTOM-PHY-OK");
    expect(OBJECT.bytes).toHaveLength(LAB_OBJECT_BYTES);
    expect(LAB_OBJECT_BYTES).toBe(3_840);
    expect(LAB_SOURCE_CHUNK_BYTES).toBe(480);
    expect(LAB_SOURCE_CHUNK_COUNT).toBe(8);
  });

  it("fits four finders, distributed calibration, and 1,000 data nibbles in one 41x41 grid", () => {
    const { matrix } = PREPARED;
    const reservedCount = Array.from(matrix.reserved).filter(Boolean).length;
    const globalPilots = matrix.pilots.filter((pilot) => pilot.scope === "global");
    const localPilots = matrix.pilots.filter((pilot) => pilot.scope === "local");

    expect(matrix.size).toBe(LAB_SYMBOL_MODULES);
    expect(matrix.functionStates).toHaveLength(LAB_SYMBOL_MODULES ** 2);
    expect(reservedCount).toBeGreaterThan(250);
    expect(matrix.payloadCells.length).toBeGreaterThanOrEqual(LAB_SYMBOLS_PER_CODEWORD);
    expect(globalPilots).toHaveLength(64);
    expect(localPilots.length).toBeGreaterThanOrEqual(60);
    expect(new Set(globalPilots.map((pilot) => pilot.paletteState))).toEqual(
      new Set(Array.from({ length: LAB_PALETTE_SIZE }, (_, state) => state)),
    );
    for (let state = 0; state < LAB_PALETTE_SIZE; state += 1) {
      const regions = globalPilots
        .filter((pilot) => pilot.paletteState === state)
        .map((pilot) => `${pilot.row < matrix.size / 2 ? "top" : "bottom"}:${pilot.column < matrix.size / 2 ? "left" : "right"}`);
      expect(new Set(regions).size).toBe(4);
    }
    expect(LAB_FRAME.width).toBe((LAB_SYMBOL_MODULES + (2 * LAB_ACTIVE_QUIET_MODULES)) * LAB_FRAME.modulePitch);
    expect(LAB_COLOR_CORE_RATIO).toBe(0.875);
  });

  it("uses all sixteen payload states including true black and white", () => {
    const payloadStates = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const reservedStates = Array.from(PREPARED.matrix.reserved).flatMap((reserved, index) => (
      reserved ? [PREPARED.paletteStates[index]] : []
    ));

    expect(new Set(payloadStates)).toEqual(new Set(Array.from({ length: 16 }, (_, state) => state)));
    expect(new Set(reservedStates)).toEqual(new Set([0, 15]));
    expect(C16_PRISM_PALETTE[0]).toEqual([0, 0, 0]);
    expect(C16_PRISM_PALETTE[15]).toEqual([255, 255, 255]);
  });

  it("keeps every pair of nominal palette states separated in perceptual color space", () => {
    let minimumDistance = Number.POSITIVE_INFINITY;
    for (let first = 0; first < C16_PRISM_PALETTE.length; first += 1) {
      for (let second = first + 1; second < C16_PRISM_PALETTE.length; second += 1) {
        minimumDistance = Math.min(minimumDistance, colorDistance(C16_PRISM_PALETTE[first], C16_PRISM_PALETTE[second]));
      }
    }
    expect(minimumDistance).toBeGreaterThan(18);
  });

  it("encodes every byte as two four-bit optical symbols", () => {
    const bytes = Uint8Array.from({ length: LAB_PACKET_BYTES }, (_, index) => (index * 73 + 19) & 0xff);
    const symbols = encodeBytesToNibbles(bytes);

    expect(symbols).toHaveLength(bytes.length * 2);
    expect(decodeNibblesToOptionalBytes(symbols)).toEqual(Array.from(bytes));
  });

  it("makes all sixteen spatial palette masks exactly reversible", () => {
    const cells = PREPARED.matrix.payloadCells;
    const symbols = Array.from({ length: LAB_SYMBOLS_PER_CODEWORD }, (_, index) => index % LAB_CHROMA_RADIX);
    for (let maskId = 0; maskId < 16; maskId += 1) {
      expect(removePaletteMask(applyPaletteMask(symbols, maskId, cells), maskId, cells)).toEqual(symbols);
    }
  });

  it("decodes a full frame while inferring its reversible mask", () => {
    const observed = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const decoded = decodePrismPaletteSymbols(observed, PREPARED.matrix);

    expect(decoded.frame.sessionHex).toBe(OBJECT.sessionHex);
    expect(decoded.frame.sequence).toBe(3);
    expect(decoded.frame.frameKind).toBe("systematic");
    expect(decoded.repairMode).toBe("triple-cauchy-mds-erasure");
    expect(decoded.correctedByteErasures).toBe(0);
    expect(decoded.inferredMaskId).toBe(PREPARED.frame.maskId);
  });

  it("repairs independent erasures in all three inner-code stripes", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    for (let stripe = 0; stripe < LAB_INNER_STRIPE_COUNT; stripe += 1) {
      for (let byte = 0; byte < 15; byte += 1) {
        observed[((stripe * LAB_INNER_STRIPE_CODEWORD_BYTES) + byte) * 2] = null;
      }
    }

    const decoded = decodePrismPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId);
    expect(decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.correctedByteErasures).toBe(45);
  });

  it("recovers a low-reliability hard substitution with a bounded erasure chase", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    const reliabilities = new Array<number>(observed.length).fill(100);
    for (let nibble = 0; nibble < 2; nibble += 1) {
      const symbolIndex = 40 + nibble;
      observed[symbolIndex] = ((observed[symbolIndex] as number) + 1) % LAB_PALETTE_SIZE;
      reliabilities[symbolIndex] = 0.001;
    }

    expect(() => decodePrismPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId)).toThrow("valid triple MDS");
    const decoded = decodePrismPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId, reliabilities);
    expect(decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.reliabilityErasedBytes).toBe(3);
  });

  it("rejects erasures beyond one stripe's thirty-three-byte repair budget", () => {
    const observed: Array<number | null> = PREPARED.matrix.payloadCells.map((cell) => PREPARED.paletteStates[cell.index]);
    for (let byte = 0; byte <= LAB_INNER_PARITY_BYTES; byte += 1) observed[byte * 2] = null;

    expect(() => decodePrismPaletteSymbols(observed, PREPARED.matrix, PREPARED.frame.maskId)).toThrow("valid triple MDS");
  });

  it("rejects CRC-protected frame modifications", () => {
    const frame = buildDynamicFrame(SESSION, OBJECT.bytes, 0, 4);
    const damaged = Uint8Array.from(frame.bytes);
    damaged[60] ^= 0x20;
    expect(() => parseDynamicFrame(damaged)).toThrow("CRC32");
  });

  it("starts on repair frames and reconstructs without waiting for frame zero", () => {
    const decoder = new DynamicLabDecoder();
    for (let sequence = LAB_SOURCE_CHUNK_COUNT; sequence < 80 && !decoder.canRecoverObject(); sequence += 1) {
      decoder.addFrame(buildDynamicFrame(SESSION, OBJECT.bytes, sequence, sequence % 16));
    }

    expect(decoder.canRecoverObject()).toBe(true);
    expect(decoder.reconstruct().message).toBe("PRISM-C16-CUSTOM-PHY-OK");
  });

  it("improves usable density over both the prior large profile and RX5", () => {
    expect(LAB_INNER_STRIPE_COUNT).toBe(3);
    expect(LAB_INNER_CODEWORD_BYTES).toBe(615);
    expect(LAB_INNER_PARITY_BYTES).toBe(33);
    expect(LAB_INNER_CODE_RATE).toBeCloseTo(516 / 615, 8);
    expect(LAB_PROFILE_AREA_GAIN).toBeGreaterThan(1.8);
    expect(LAB_VERIFIED_PAYLOAD_DENSITY_GAIN).toBeGreaterThan(3.4);
    expect(LAB_RX5_PAYLOAD_GAIN).toBeGreaterThan(2.7);
  });

  it("keeps the web reader URL separate from the custom optical carrier", () => {
    const url = buildBootstrapUrl(ORIGIN);
    expect(url).toBe("https://example.test/o");
    expect(parseBootstrapUrl(url, ORIGIN)).toEqual({ profile: LAB_PROFILE_NAME });
    expect(() => parseBootstrapUrl(`${url}?unexpected=1`, ORIGIN)).toThrow("accepted optical-lab origin");
  });
});

describe("sixteen-state camera calibration and geometry", () => {
  it("adapts all sixteen observed colors through global and local models", () => {
    const shifted: Rgb[][] = C16_PRISM_PALETTE.map(([red, green, blue]) => [
      [clamp((red * 0.82) + 13), clamp((green * 0.91) + 8), clamp((blue * 0.77) + 19)] as Rgb,
      [clamp((red * 0.82) + 15), clamp((green * 0.91) + 7), clamp((blue * 0.77) + 17)] as Rgb,
    ]);
    const global = estimatePalette(shifted);
    const local = localizePalette(global, [shifted[0][0], shifted[15][0]]);

    for (let state = 0; state < LAB_PALETTE_SIZE; state += 1) {
      const decoded = classifyColor(shifted[state][0], local);
      expect(decoded.symbol).toBe(state);
      expect(decoded.erasure).toBe(false);
    }
  });

  it("projects the custom grid through a perspective homography", () => {
    const source = [
      { x: 3.5, y: 3.5 },
      { x: 37.5, y: 3.5 },
      { x: 37.5, y: 37.5 },
      { x: 3.5, y: 37.5 },
    ];
    const destination = [
      { x: 90, y: 110 },
      { x: 630, y: 92 },
      { x: 610, y: 638 },
      { x: 105, y: 620 },
    ];
    const homography = solveHomography(source, destination);

    for (let index = 0; index < source.length; index += 1) {
      const projected = projectPoint(homography, source[index]);
      expect(projected.x).toBeCloseTo(destination[index].x, 7);
      expect(projected.y).toBeCloseTo(destination[index].y, 7);
    }
  });
});

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
