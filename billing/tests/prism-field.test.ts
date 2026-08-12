import { describe, expect, it } from "vitest";

import {
  FIELD_CELL_COUNT,
  FIELD_COLUMNS,
  FIELD_HEADER_BYTES,
  FIELD_GEOMETRIES,
  FIELD_INNER_CODEWORD_BYTES,
  FIELD_LAYOUT,
  FIELD_OUTER_ASPECT,
  FIELD_OUTER_SHAPE,
  FIELD_OUTER_SHAPE_FILL,
  FIELD_PAYLOAD_FRACTION,
  FIELD_PROFILES,
  FIELD_ROWS,
  applyFieldMask,
  balancedFieldAspect,
  buildNativeLabObject,
  createFieldRasterOwners,
  decodeNativeFieldSymbols,
  decodeBase24Symbols,
  encodeBase24Bytes,
  encodeBytesToSymbols,
  fieldAspectUtilization,
  prepareNativeFieldFrame,
  removeFieldMask,
  renderedFieldColor,
  selectAdaptiveFieldProfile,
  selectAdaptiveFieldGeometry,
} from "../src/lib/prism-field";

const SESSION = new Uint8Array([0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87]);

describe("borderless distributed native field", () => {
  it("uses every touching cell for protected codeword data", () => {
    expect(FIELD_CELL_COUNT).toBe(2_040);
    expect(FIELD_COLUMNS * FIELD_ROWS).toBe(FIELD_CELL_COUNT);
    expect(FIELD_PAYLOAD_FRACTION).toBe(1);
    expect(FIELD_LAYOUT).toHaveLength(FIELD_CELL_COUNT);
    expect(new Set(FIELD_LAYOUT.map((cell) => cell.index)).size).toBe(FIELD_CELL_COUNT);
  });

  it("selects the maximum-fill outer shape and a near-optimal balanced aspect", () => {
    expect(FIELD_OUTER_SHAPE).toBe("rectangle");
    expect(FIELD_OUTER_SHAPE_FILL.rectangle).toBe(1);
    expect(FIELD_OUTER_SHAPE_FILL.rectangle).toBeGreaterThan(FIELD_OUTER_SHAPE_FILL.ellipse);
    expect(FIELD_OUTER_SHAPE_FILL.rectangle).toBeGreaterThan(FIELD_OUTER_SHAPE_FILL["regular-hexagon"]);
    expect(FIELD_OUTER_ASPECT).toBeCloseTo(20 / 13, 8);
    const balanced = balancedFieldAspect(16 / 9, 4 / 3);
    expect(balanced).toBeCloseTo(1.5396, 3);
    expect(fieldAspectUtilization(balanced, 16 / 9)).toBeCloseTo(fieldAspectUtilization(balanced, 4 / 3), 8);
    expect(fieldAspectUtilization(FIELD_OUTER_ASPECT, 16 / 9)).toBeGreaterThan(0.86);
    expect(fieldAspectUtilization(FIELD_OUTER_ASPECT, 4 / 3)).toBeGreaterThan(0.86);
  });

  it("defines exact square and affine-triangular 2,040-cell geometries", () => {
    for (const geometry of Object.values(FIELD_GEOMETRIES)) {
      expect(geometry.cells).toHaveLength(FIELD_CELL_COUNT);
      expect(geometry.layout).toHaveLength(FIELD_CELL_COUNT);
      expect(new Set(geometry.cells.map((cell) => `${cell.center.x}:${cell.center.y}`)).size).toBe(FIELD_CELL_COUNT);
      expect(new Set(geometry.layout.map((cell) => cell.index)).size).toBe(FIELD_CELL_COUNT);
      expect(geometry.cells.every((cell) => cell.neighbours.length >= 2)).toBe(true);
    }
    expect(FIELD_GEOMETRIES.TRI57.minimumCenterDistanceAtReference)
      .toBeGreaterThan(FIELD_GEOMETRIES.SQ60.minimumCenterDistanceAtReference);
    expect(FIELD_GEOMETRIES.TRI57.minimumDistanceGainOverSquare).toBeGreaterThan(1.03);
    expect(FIELD_GEOMETRIES.TRI49.minimumCenterDistanceAtReference)
      .toBeGreaterThan(FIELD_GEOMETRIES.TRI57.minimumCenterDistanceAtReference);
    expect(FIELD_GEOMETRIES.TRI49.minimumDistanceGainOverSquare).toBeGreaterThan(1.09);
  });

  it("rasterizes full-area Voronoi ownership without unassigned pixels", () => {
    for (const geometryId of ["SQ60", "TRI57", "TRI49"] as const) {
      const owners = createFieldRasterOwners(geometryId, 192, 108);
      expect(owners).toHaveLength(192 * 108);
      expect(Math.max(...owners)).toBeLessThan(FIELD_CELL_COUNT);
      expect(new Set(owners).size).toBeGreaterThan(1_500);
    }
  });

  it.each(["C8", "C16", "C24", "C32"] as const)("fills the complete field in %s", (profileId) => {
    const profile = FIELD_PROFILES[profileId];
    expect(profile.encodedByteCapacity).toBeGreaterThanOrEqual(profile.stripeCount * profile.innerCodewordBytes);
    if (profileId !== "C24") {
      const encodedBits = profile.stripeCount * FIELD_INNER_CODEWORD_BYTES * 8;
      expect(profile.stripeCount).toBe(profile.bitsPerCell);
      expect(encodedBits).toBe(FIELD_CELL_COUNT * profile.bitsPerCell);
    }
    expect(profile.raptorPacketBytes + profile.outerPaddingBytes).toBe(profile.packetBytes - FIELD_HEADER_BYTES - 4);
    expect(profile.sourceSymbolBytes).toBe(profile.raptorPacketBytes - 4);
    expect(profile.palette).toHaveLength(2 ** profile.bitsPerCell);
  });

  it.each(["C8", "C16", "C24", "C32"] as const)("round-trips distributed control and payload in %s", (profileId) => {
    const profile = FIELD_PROFILES[profileId];
    const object = buildNativeLabObject(SESSION, profileId);
    const raptorPacket = deterministicBytes(profile.raptorPacketBytes, profile.code);
    const prepared = prepareNativeFieldFrame(SESSION, object.bytes, 19, raptorPacket, profileId);
    const decoded = decodeNativeFieldSymbols(Array.from(prepared.states), profileId, prepared.frame.phase);

    expect(decoded.frame.sessionHex).toBe(prepared.frame.sessionHex);
    expect(decoded.frame.sequence).toBe(19);
    expect(decoded.frame.maskId).toBe(prepared.frame.maskId);
    expect(decoded.frame.raptorPacket).toEqual(raptorPacket);
  });

  it.each(["SQ60", "TRI57", "TRI49"] as const)("authenticates the %s geometry in distributed control", (geometryId) => {
    const profile = FIELD_PROFILES.C16;
    const object = buildNativeLabObject(SESSION, "C16");
    const raptorPacket = deterministicBytes(profile.raptorPacketBytes, geometryId === "SQ60" ? 17 : 29);
    const prepared = prepareNativeFieldFrame(SESSION, object.bytes, 22, raptorPacket, "C16", null, geometryId);
    const decoded = decodeNativeFieldSymbols(
      Array.from(prepared.states),
      "C16",
      prepared.frame.phase,
      undefined,
      undefined,
      geometryId,
    );
    expect(decoded.frame.geometryId).toBe(geometryId);
    expect(decoded.frame.raptorPacket).toEqual(raptorPacket);
  });

  it("packs 24 states groupwise without global carry propagation", () => {
    const bytes = deterministicBytes(FIELD_PROFILES.C24.stripeCount * FIELD_PROFILES.C24.innerCodewordBytes, 44);
    const symbols = encodeBase24Bytes(bytes);
    expect(symbols).toHaveLength(FIELD_CELL_COUNT);
    expect(Math.max(...symbols)).toBeLessThan(24);
    expect(decodeBase24Symbols(symbols).slice(0, bytes.length)).toEqual(Array.from(bytes));

    const erased: Array<number | null> = [...symbols];
    erased[20] = null;
    const decoded = decodeBase24Symbols(erased);
    expect(decoded.slice(9, 18).every((value) => value === null)).toBe(true);
    expect(decoded.slice(0, 9)).toEqual(Array.from(bytes.slice(0, 9)));
  });

  it("recovers distributed erasures without a reserved repair region", () => {
    const profileId = "C16";
    const profile = FIELD_PROFILES[profileId];
    const object = buildNativeLabObject(SESSION, profileId);
    const prepared = prepareNativeFieldFrame(
      SESSION,
      object.bytes,
      7,
      deterministicBytes(profile.raptorPacketBytes, 91),
      profileId,
    );
    const damaged: Array<number | null> = Array.from(prepared.states);
    for (let index = 13; index < FIELD_CELL_COUNT; index += 71) damaged[index] = null;

    const decoded = decodeNativeFieldSymbols(damaged, profileId, prepared.frame.phase);
    expect(decoded.frame.sequence).toBe(7);
    expect(decoded.correctedByteErasures).toBeGreaterThan(0);
  });

  it("uses soft reliability to turn color substitutions into MDS erasures", () => {
    const profileId = "C16";
    const profile = FIELD_PROFILES[profileId];
    const object = buildNativeLabObject(SESSION, profileId);
    const prepared = prepareNativeFieldFrame(
      SESSION,
      object.bytes,
      9,
      deterministicBytes(profile.raptorPacketBytes, 27),
      profileId,
    );
    const damaged = Array.from(prepared.states);
    const reliability = Array.from({ length: FIELD_CELL_COUNT }, () => 10);
    for (const index of [81, 413, 990]) {
      damaged[index] = (damaged[index] + 3) % profile.palette.length;
      reliability[index] = 0;
    }

    const decoded = decodeNativeFieldSymbols(damaged, profileId, prepared.frame.phase, undefined, reliability);
    expect(decoded.frame.sequence).toBe(9);
    expect(decoded.reliabilityErasedBytes).toBeGreaterThan(0);
  });

  it("spreads the protected header across all field quadrants", () => {
    const headerCellCount = Math.ceil((FIELD_HEADER_BYTES * 8) / FIELD_PROFILES.C16.bitsPerCell);
    const quadrants = new Set(FIELD_LAYOUT.slice(0, headerCellCount).map((cell) => (
      `${cell.row < FIELD_ROWS / 2 ? 0 : 1}:${cell.column < FIELD_COLUMNS / 2 ? 0 : 1}`
    )));
    expect(quadrants.size).toBe(4);
  });

  it("keeps all sixteen masks reversible", () => {
    const profile = FIELD_PROFILES.C8;
    const source = Array.from({ length: FIELD_CELL_COUNT }, (_, index) => index % profile.palette.length);
    for (let mask = 0; mask < 16; mask += 1) {
      expect(removeFieldMask(applyFieldMask(source, mask, profile), mask, profile)).toEqual(source);
    }
  });

  it("superimposes phase-varying pilots without consuming a cell", () => {
    const first = renderedFieldColor("C16", 7, 512, 0);
    const second = renderedFieldColor("C16", 7, 512, 1);
    expect(first).not.toEqual(second);
    expect(encodeBytesToSymbols(new Uint8Array(255 * 4), 4)).toHaveLength(FIELD_CELL_COUNT);
  });

  it("selects the profile with the highest measured verified throughput", () => {
    expect(selectAdaptiveFieldProfile([
      { profileId: "C8", mutualInformationBits: 2.8, frameAcceptance: 0.99, processingFps: 12 },
      { profileId: "C16", mutualInformationBits: 3.7, frameAcceptance: 0.94, processingFps: 12 },
      { profileId: "C32", mutualInformationBits: 4.1, frameAcceptance: 0.62, processingFps: 9 },
    ])).toBe("C16");
  });

  it("selects geometry from measured information, acceptance, and processing rate", () => {
    expect(selectAdaptiveFieldGeometry([
      { geometryId: "TRI57", meanCellMutualInformationBits: 3.8, frameAcceptance: 0.94, processingFps: 10 },
      { geometryId: "SQ60", meanCellMutualInformationBits: 3.9, frameAcceptance: 0.98, processingFps: 12 },
    ])).toBe("SQ60");
    expect(selectAdaptiveFieldGeometry([
      { geometryId: "TRI57", meanCellMutualInformationBits: 3.9, frameAcceptance: 0.98, processingFps: 12 },
      { geometryId: "SQ60", meanCellMutualInformationBits: 3.9, frameAcceptance: 0.98, processingFps: 12 },
      { geometryId: "TRI49", meanCellMutualInformationBits: 3.9, frameAcceptance: 0.98, processingFps: 12 },
    ])).toBe("TRI49");
  });
});

function deterministicBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (Math.imul(index + 1, 73) + seed) & 0xff);
}
