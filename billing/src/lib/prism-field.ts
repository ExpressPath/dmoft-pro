import { decodeCauchyMds, encodeCauchyMds } from "./cauchy-erasure";

export const FIELD_COLUMNS = 60;
export const FIELD_ROWS = 34;
export const FIELD_CELL_COUNT = FIELD_COLUMNS * FIELD_ROWS;
export const FIELD_FRAME = {
  width: 960,
  height: 544,
  cellPitch: 16,
  columns: FIELD_COLUMNS,
  rows: FIELD_ROWS,
} as const;
export const FIELD_PROFILE_NAME = "PRISM-FIELD-NATIVE-R2";
export const FIELD_PHASE_COUNT = 16;
export const FIELD_MASK_COUNT = 16;
export const FIELD_INNER_DATA_BYTES = 213;
export const FIELD_INNER_PARITY_BYTES = 42;
export const FIELD_INNER_CODEWORD_BYTES = 255;
export const FIELD_HEADER_BYTES = 32;
export const FIELD_CRC_BYTES = 4;
export const FIELD_SOURCE_SYMBOL_COUNT = 8;
export const FIELD_TARGET_FPS = 10;
export const FIELD_ERASURE_THRESHOLD = 2;
export const FIELD_GEOMETRY_TRACK_MAX_FRAMES = 2;
export const FIELD_GEOMETRY_TRACK_MAX_AGE_MS = 240;
const TRI_ROW_PITCH = Math.sqrt(3) / 2;
const TRI_HEX_RADIUS = 1 / Math.sqrt(3);
const TRI_ROWS = 36;
const TRI_EXTRA_ODD_ROWS = new Set([1, 7, 13, 19, 25, 31]);

export type Point = Readonly<{ x: number; y: number }>;
export type Rgb = Readonly<[number, number, number]>;
export type FieldProfileId = "C8" | "C16" | "C24" | "C32";
export type FieldGeometryId = "SQ60" | "TRI57";
export type FieldCell = Readonly<{
  index: number;
  row: number;
  column: number;
  center: Point;
  latticeCenter: Point;
  neighbours: readonly number[];
}>;
export type FieldGeometry = Readonly<{
  id: FieldGeometryId;
  code: number;
  lattice: "square" | "affine-triangular";
  nominalColumns: number;
  nominalRows: number;
  cellCount: number;
  latticeBounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  cells: readonly FieldCell[];
  rows: readonly (readonly number[])[];
  layout: readonly FieldCell[];
  minimumCenterDistanceAtReference: number;
  minimumDistanceGainOverSquare: number;
}>;
export type FieldProfile = Readonly<{
  id: FieldProfileId;
  code: number;
  bitsPerCell: number;
  palette: readonly Rgb[];
  stripeCount: number;
  innerDataBytes: number;
  innerParityBytes: number;
  innerCodewordBytes: number;
  encodedByteCapacity: number;
  packetBytes: number;
  outerEnvelopeCapacity: number;
  raptorPacketBytes: number;
  sourceSymbolBytes: number;
  outerPaddingBytes: number;
  innerCodeRate: number;
}>;
export type NativeLabObject = Readonly<{
  sessionHex: string;
  message: string;
  profileId: FieldProfileId;
  bytes: Uint8Array;
}>;
export type NativeFieldFrame = Readonly<{
  sessionHex: string;
  sequence: number;
  phase: number;
  maskId: number;
  profileId: FieldProfileId;
  geometryId: FieldGeometryId;
  objectLength: number;
  objectCrc: number;
  raptorPacket: Uint8Array;
  bytes: Uint8Array;
}>;
export type PreparedNativeFieldFrame = Readonly<{
  frame: NativeFieldFrame;
  states: Uint8Array;
  renderedColors: readonly Rgb[];
  maskScore: number;
}>;
export type NativeFieldDecode = Readonly<{
  frame: NativeFieldFrame;
  correctedByteErasures: number;
  reliabilityErasedBytes: number;
  inferredMaskId: number;
}>;
export type AdaptiveProfileObservation = Readonly<{
  profileId: FieldProfileId;
  mutualInformationBits: number;
  frameAcceptance: number;
  processingFps: number;
}>;
export type AdaptiveGeometryObservation = Readonly<{
  geometryId: FieldGeometryId;
  frameAcceptance: number;
  processingFps: number;
  meanCellMutualInformationBits: number;
}>;

const PALETTE_C8: readonly Rgb[] = [
  [18, 18, 18], [225, 45, 50], [235, 205, 28], [35, 180, 65],
  [25, 195, 205], [45, 80, 225], [210, 55, 205], [237, 237, 237],
];

const PALETTE_C16: readonly Rgb[] = [
  [18, 18, 18], [128, 18, 18], [225, 42, 42], [238, 122, 24],
  [238, 218, 30], [132, 222, 38], [25, 155, 58], [25, 142, 136],
  [32, 207, 216], [42, 140, 234], [42, 60, 218], [148, 28, 215],
  [215, 48, 205], [236, 100, 156], [128, 128, 128], [237, 237, 237],
];

const PALETTE_C32: readonly Rgb[] = buildC32Palette();
const PALETTE_C24: readonly Rgb[] = [
  PALETTE_C32[0],
  ...PALETTE_C32.slice(1, 23),
  PALETTE_C32[31],
];

export const FIELD_PROFILES: Readonly<Record<FieldProfileId, FieldProfile>> = Object.freeze({
  C8: createProfile("C8", 1, 3, PALETTE_C8),
  C16: createProfile("C16", 2, 4, PALETTE_C16),
  C24: createProfile("C24", 3, Math.log2(24), PALETTE_C24, 5, 191, 38, 229, 1_147),
  C32: createProfile("C32", 4, 5, PALETTE_C32),
});

export const FIELD_GEOMETRIES: Readonly<Record<FieldGeometryId, FieldGeometry>> = createFieldGeometries();
export const DEFAULT_FIELD_GEOMETRY_ID: FieldGeometryId = "TRI57";
export const FIELD_LAYOUT: readonly FieldCell[] = FIELD_GEOMETRIES[DEFAULT_FIELD_GEOMETRY_ID].layout;
export const FIELD_PROTECTED_DENSITY_GAIN_OVER_C16 = (45 * 45) / 1_230;
export const FIELD_PAYLOAD_FRACTION = 1;

const FRAME_MAGIC = new Uint8Array([0x50, 0x46, 0x4c, 0x44]);
const OBJECT_MAGIC = new Uint8Array([0x50, 0x46, 0x4f, 0x42]);
const FIELD_VERSION = 2;
const OBJECT_MESSAGE = new TextEncoder().encode("PRISM-FIELD-NATIVE-R2-OK");

export function buildNativeLabObject(sessionNonce: Uint8Array, profileId: FieldProfileId): NativeLabObject {
  assertSessionNonce(sessionNonce);
  const profile = FIELD_PROFILES[profileId];
  const length = profile.sourceSymbolBytes * FIELD_SOURCE_SYMBOL_COUNT;
  const bytes = new Uint8Array(length);
  bytes.set(OBJECT_MAGIC, 0);
  bytes[4] = FIELD_VERSION;
  bytes[5] = profile.code;
  bytes.set(sessionNonce, 8);
  bytes[16] = OBJECT_MESSAGE.length;
  bytes.set(OBJECT_MESSAGE, 17);
  let state = seedFromBytes(sessionNonce) ^ Math.imul(profile.code, 0x9e3779b1);
  for (let offset = 17 + OBJECT_MESSAGE.length; offset < bytes.length - FIELD_CRC_BYTES; offset += 1) {
    state = xorshift32(state);
    bytes[offset] = state & 0xff;
  }
  new DataView(bytes.buffer).setUint32(bytes.length - FIELD_CRC_BYTES, crc32(bytes.subarray(0, -FIELD_CRC_BYTES)), false);
  return parseNativeLabObject(bytes);
}

export function parseNativeLabObject(input: Uint8Array): NativeLabObject {
  const bytes = Uint8Array.from(input);
  if (bytes.length < 64 || bytes.length > 0xffff) throw new Error("native object length is invalid");
  assertMagic(bytes, OBJECT_MAGIC, "native object");
  const profile = profileFromCode(bytes[5]);
  if (bytes[4] !== FIELD_VERSION) throw new Error("native object version is unsupported");
  if (bytes.length !== profile.sourceSymbolBytes * FIELD_SOURCE_SYMBOL_COUNT) {
    throw new Error("native object length does not match its color profile");
  }
  const expected = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - FIELD_CRC_BYTES, false);
  if (crc32(bytes.subarray(0, -FIELD_CRC_BYTES)) !== expected) throw new Error("native object CRC32 does not match");
  const messageLength = bytes[16];
  if (messageLength === 0 || 17 + messageLength > bytes.length - FIELD_CRC_BYTES) throw new Error("native object message length is invalid");
  return {
    sessionHex: toHex(bytes.subarray(8, 16)),
    message: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(17, 17 + messageLength)),
    profileId: profile.id,
    bytes,
  };
}

export function prepareNativeFieldFrame(
  sessionNonce: Uint8Array,
  object: Uint8Array,
  sequence: number,
  raptorPacket: Uint8Array,
  profileId: FieldProfileId,
  previousStates: readonly number[] | null = null,
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): PreparedNativeFieldFrame {
  const phase = sequence % FIELD_PHASE_COUNT;
  let selected: PreparedNativeFieldFrame | null = null;
  for (let maskId = 0; maskId < FIELD_MASK_COUNT; maskId += 1) {
    const frame = buildNativeFieldFrame(sessionNonce, object, sequence, phase, maskId, profileId, raptorPacket, geometryId);
    const codeword = encodeInnerCodeword(frame.bytes, FIELD_PROFILES[profileId]);
    const unmasked = encodeCodewordToSymbols(codeword, FIELD_PROFILES[profileId]);
    const masked = applyFieldMask(unmasked, maskId, FIELD_PROFILES[profileId], geometryId);
    const states = placeInterleavedSymbols(masked, geometryId);
    const renderedColors = statesToRenderedColors(states, profileId, phase);
    const maskScore = scoreFieldStates(states, profileId, previousStates, geometryId);
    if (!selected || maskScore > selected.maskScore) selected = { frame, states, renderedColors, maskScore };
  }
  if (!selected) throw new Error("no native field mask could be selected");
  return selected;
}

export function buildNativeFieldFrame(
  sessionNonce: Uint8Array,
  objectInput: Uint8Array,
  sequence: number,
  phase: number,
  maskId: number,
  profileId: FieldProfileId,
  raptorPacket: Uint8Array,
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): NativeFieldFrame {
  assertSessionNonce(sessionNonce);
  const object = parseNativeLabObject(objectInput);
  const profile = FIELD_PROFILES[profileId];
  const geometry = fieldGeometry(geometryId);
  if (object.sessionHex !== toHex(sessionNonce) || object.profileId !== profileId) throw new Error("native object and frame profile do not match");
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff) throw new Error("native sequence must fit uint16");
  if (!Number.isInteger(phase) || phase < 0 || phase >= FIELD_PHASE_COUNT) throw new Error("native phase is invalid");
  validateMask(maskId);
  if (raptorPacket.length !== profile.raptorPacketBytes) throw new Error(`RaptorQ packet must be ${profile.raptorPacketBytes} bytes`);
  const bytes = new Uint8Array(profile.packetBytes);
  bytes.set(FRAME_MAGIC, 0);
  bytes[4] = FIELD_VERSION;
  bytes[5] = profile.code;
  bytes[6] = phase;
  bytes[7] = maskId;
  bytes.set(sessionNonce, 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, sequence, false);
  view.setUint16(18, raptorPacket.length, false);
  view.setUint16(20, object.bytes.length, false);
  view.setUint32(22, crc32(object.bytes), false);
  bytes[26] = profile.palette.length;
  bytes[27] = (geometry.code << 4) | profile.stripeCount;
  view.setUint16(28, geometry.nominalColumns, false);
  view.setUint16(30, geometry.nominalRows, false);
  bytes.set(raptorPacket, FIELD_HEADER_BYTES);
  view.setUint32(bytes.length - FIELD_CRC_BYTES, crc32(bytes.subarray(0, -FIELD_CRC_BYTES)), false);
  return parseNativeFieldFrame(bytes);
}

export function parseNativeFieldFrame(input: Uint8Array): NativeFieldFrame {
  const bytes = Uint8Array.from(input);
  if (bytes.length < FIELD_HEADER_BYTES + FIELD_CRC_BYTES) throw new Error("native frame is too short");
  assertMagic(bytes, FRAME_MAGIC, "native frame");
  const profile = profileFromCode(bytes[5]);
  const geometry = geometryFromCode(bytes[27] >>> 4);
  if (bytes.length !== profile.packetBytes || bytes[4] !== FIELD_VERSION) throw new Error("native frame profile is unsupported");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[6] >= FIELD_PHASE_COUNT
    || bytes[7] >= FIELD_MASK_COUNT
    || bytes[26] !== profile.palette.length
    || (bytes[27] & 0x0f) !== profile.stripeCount
    || view.getUint16(28, false) !== geometry.nominalColumns
    || view.getUint16(30, false) !== geometry.nominalRows
  ) throw new Error("native distributed control is invalid");
  const expected = view.getUint32(bytes.length - FIELD_CRC_BYTES, false);
  if (crc32(bytes.subarray(0, -FIELD_CRC_BYTES)) !== expected) throw new Error("native frame CRC32 does not match");
  const packetLength = view.getUint16(18, false);
  if (packetLength !== profile.raptorPacketBytes) throw new Error("native RaptorQ packet length is invalid");
  if (view.getUint16(20, false) !== profile.sourceSymbolBytes * FIELD_SOURCE_SYMBOL_COUNT) {
    throw new Error("native object length does not match the distributed profile");
  }
  return {
    sessionHex: toHex(bytes.subarray(8, 16)),
    sequence: view.getUint16(16, false),
    phase: bytes[6],
    maskId: bytes[7],
    profileId: profile.id,
    geometryId: geometry.id,
    objectLength: view.getUint16(20, false),
    objectCrc: view.getUint32(22, false),
    raptorPacket: bytes.slice(FIELD_HEADER_BYTES, FIELD_HEADER_BYTES + packetLength),
    bytes,
  };
}

export function decodeNativeFieldSymbols(
  physicalStates: readonly (number | null)[],
  profileId: FieldProfileId,
  knownPhase: number,
  knownMaskId?: number,
  symbolReliabilities?: readonly number[],
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): NativeFieldDecode {
  if (physicalStates.length !== FIELD_CELL_COUNT) throw new Error("native field needs one state per cell");
  const profile = FIELD_PROFILES[profileId];
  const geometry = fieldGeometry(geometryId);
  const interleaved = geometry.layout.map((cell) => physicalStates[cell.index]);
  const masks = knownMaskId === undefined ? Array.from({ length: FIELD_MASK_COUNT }, (_, index) => index) : [knownMaskId];
  const valid: NativeFieldDecode[] = [];
  for (const maskId of masks) {
    const unmasked = removeFieldMask(interleaved, maskId, profile, geometryId);
    const optionalCodeword = decodeSymbolsToOptionalCodeword(unmasked, profile);
    const reliabilityOrders = byteReliabilityOrders(symbolReliabilities, optionalCodeword, profile, geometryId);
    const baseErasures = Array.from({ length: profile.stripeCount }, (_, stripe) => (
      optionalCodeword.slice(stripe * profile.innerCodewordBytes, (stripe + 1) * profile.innerCodewordBytes)
        .filter((value) => value === null).length
    ));
    const budget = Math.min(...baseErasures.map((count, stripe) => (
      Math.max(0, Math.min(profile.innerParityBytes - count, reliabilityOrders[stripe].length))
    )));
    for (const chaseCount of reliabilityChaseCounts(budget)) {
      try {
        const packet = new Uint8Array(profile.packetBytes);
        let correctedByteErasures = 0;
        let reliabilityErasedBytes = 0;
        for (let stripe = 0; stripe < profile.stripeCount; stripe += 1) {
          const start = stripe * profile.innerCodewordBytes;
          const codeword = optionalCodeword.slice(start, start + profile.innerCodewordBytes);
          const count = Math.min(chaseCount, reliabilityOrders[stripe].length);
          for (let index = 0; index < count; index += 1) codeword[reliabilityOrders[stripe][index]] = null;
          const decoded = decodeCauchyMds(codeword, profile.innerDataBytes);
          packet.set(decoded.data, stripe * profile.innerDataBytes);
          correctedByteErasures += decoded.recoveredDataErasures;
          reliabilityErasedBytes += count;
        }
        const frame = parseNativeFieldFrame(packet);
        if (frame.maskId !== maskId || frame.phase !== knownPhase || frame.profileId !== profileId || frame.geometryId !== geometryId) continue;
        valid.push({ frame, correctedByteErasures, reliabilityErasedBytes, inferredMaskId: maskId });
        break;
      } catch {
        // Try deeper soft erasures or the next distributed mask.
      }
    }
  }
  if (valid.length === 0) throw new Error("no distributed mask produced valid MDS stripes and CRC32");
  const first = valid[0];
  if (valid.some((candidate) => candidate.frame.sessionHex !== first.frame.sessionHex || candidate.frame.sequence !== first.frame.sequence)) {
    throw new Error("multiple distributed mask candidates disagree");
  }
  return first;
}

export function renderedFieldColor(profileId: FieldProfileId, state: number, cellIndex: number, phase: number): Rgb {
  const palette = FIELD_PROFILES[profileId].palette;
  if (!Number.isInteger(state) || state < 0 || state >= palette.length) throw new Error("field state is outside the active constellation");
  const base = palette[state];
  const geometry = distributedPilotSign(cellIndex, phase, 0);
  const temporal = distributedPilotSign(cellIndex, phase, 1);
  const redBasis = distributedPilotSign(cellIndex, phase, 2);
  const greenBasis = distributedPilotSign(cellIndex, phase, 3);
  const blueBasis = distributedPilotSign(cellIndex, phase, 4);
  return [
    clampChannel(base[0] + (geometry * 7) + (temporal * 3) + (redBasis * 3)),
    clampChannel(base[1] + (geometry * 7) - (temporal * 3) + (greenBasis * 3)),
    clampChannel(base[2] + (geometry * 7) + (temporal * 3) + (blueBasis * 3)),
  ];
}

export function distributedPilotSign(cellIndex: number, phase: number, channel: number): -1 | 1 {
  const mixed = hash32(
    Math.imul(cellIndex + 1, 0x9e3779b1)
    ^ Math.imul(phase + 1, 0x85ebca6b)
    ^ Math.imul(channel + 1, 0xc2b2ae35),
  );
  return (mixed & 1) === 0 ? -1 : 1;
}

export function selectAdaptiveFieldProfile(observations: readonly AdaptiveProfileObservation[]): FieldProfileId {
  if (observations.length === 0) return "C16";
  let selected = observations[0];
  let selectedScore = -Infinity;
  for (const observation of observations) {
    if (!FIELD_PROFILES[observation.profileId]) throw new Error("adaptive observation uses an unsupported profile");
    const score = Math.max(0, observation.mutualInformationBits)
      * clamp01(observation.frameAcceptance)
      * Math.max(0, observation.processingFps)
      * FIELD_PROFILES[observation.profileId].innerCodeRate;
    if (score > selectedScore) {
      selected = observation;
      selectedScore = score;
    }
  }
  return selected.profileId;
}

export function selectAdaptiveFieldGeometry(observations: readonly AdaptiveGeometryObservation[]): FieldGeometryId {
  if (observations.length === 0) return DEFAULT_FIELD_GEOMETRY_ID;
  let selected = observations[0];
  let selectedScore = -Infinity;
  for (const observation of observations) {
    const geometry = fieldGeometry(observation.geometryId);
    const score = Math.max(0, observation.meanCellMutualInformationBits)
      * clamp01(observation.frameAcceptance)
      * Math.max(0, observation.processingFps);
    const selectedGeometry = fieldGeometry(selected.geometryId);
    if (
      score > selectedScore
      || (score === selectedScore && geometry.minimumCenterDistanceAtReference > selectedGeometry.minimumCenterDistanceAtReference)
    ) {
      selected = observation;
      selectedScore = score;
    }
  }
  return selected.geometryId;
}

export function fieldGeometry(id: FieldGeometryId): FieldGeometry {
  const geometry = FIELD_GEOMETRIES[id];
  if (!geometry) throw new Error("native field geometry is unsupported");
  return geometry;
}

export function applyFieldMask(
  symbols: readonly number[],
  maskId: number,
  profile: FieldProfile,
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): number[] {
  validateMask(maskId);
  if (symbols.length !== FIELD_CELL_COUNT) throw new Error("field mask needs a full codeword");
  const layout = fieldGeometry(geometryId).layout;
  return symbols.map((symbol, index) => modulo(symbol + fieldMaskDelta(maskId, layout[index], profile.palette.length), profile.palette.length));
}

export function removeFieldMask(
  symbols: readonly (number | null)[],
  maskId: number,
  profile: FieldProfile,
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): Array<number | null> {
  validateMask(maskId);
  if (symbols.length !== FIELD_CELL_COUNT) throw new Error("field mask needs a full codeword");
  const layout = fieldGeometry(geometryId).layout;
  return symbols.map((symbol, index) => symbol === null
    ? null
    : modulo(symbol - fieldMaskDelta(maskId, layout[index], profile.palette.length), profile.palette.length));
}

export function encodeBytesToSymbols(bytes: Uint8Array, bitsPerCell: number): number[] {
  const symbols: number[] = [];
  let accumulator = 0;
  let available = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    available += 8;
    while (available >= bitsPerCell) {
      available -= bitsPerCell;
      symbols.push((accumulator >>> available) & ((1 << bitsPerCell) - 1));
      accumulator &= (1 << available) - 1;
    }
  }
  if (available > 0) symbols.push((accumulator << (bitsPerCell - available)) & ((1 << bitsPerCell) - 1));
  return symbols;
}

export function encodeBase24Bytes(bytes: Uint8Array): number[] {
  if (bytes.length > 1_147) throw new Error("C24 codeword exceeds grouped radix capacity");
  const padded = new Uint8Array(1_147);
  padded.set(bytes);
  const symbols: number[] = [];
  for (let group = 0; group < 127; group += 1) {
    symbols.push(...bytesToRadixDigits(padded.subarray(group * 9, (group + 1) * 9), 24, 16));
  }
  symbols.push(...bytesToRadixDigits(padded.subarray(1_143, 1_147), 24, 8));
  if (symbols.length !== FIELD_CELL_COUNT) throw new Error("C24 grouped radix packing did not fill the field");
  return symbols;
}

export function decodeBase24Symbols(symbols: readonly (number | null)[]): Array<number | null> {
  if (symbols.length !== FIELD_CELL_COUNT) throw new Error("C24 grouped radix decoding needs a complete field");
  const bytes: Array<number | null> = [];
  for (let group = 0; group < 127; group += 1) {
    bytes.push(...radixDigitsToOptionalBytes(symbols.slice(group * 16, (group + 1) * 16), 24, 9));
  }
  bytes.push(...radixDigitsToOptionalBytes(symbols.slice(2_032, 2_040), 24, 4));
  return bytes;
}

export function decodeSymbolsToOptionalBytes(symbols: readonly (number | null)[], bitsPerCell: number): Array<number | null> {
  const bits: Array<number | null> = [];
  for (const symbol of symbols) {
    for (let shift = bitsPerCell - 1; shift >= 0; shift -= 1) bits.push(symbol === null ? null : (symbol >>> shift) & 1);
  }
  const bytes: Array<number | null> = [];
  for (let offset = 0; offset + 7 < bits.length; offset += 8) {
    const group = bits.slice(offset, offset + 8);
    if (group.some((bit) => bit === null)) {
      bytes.push(null);
    } else {
      bytes.push(group.reduce<number>((value, bit) => (value << 1) | (bit as number), 0));
    }
  }
  return bytes;
}

export function logicalFieldCellCenter(cell: Pick<FieldCell, "center">): Point {
  return cell.center;
}

export function createFieldRasterOwners(
  geometryId: FieldGeometryId,
  width: number = FIELD_FRAME.width,
  height: number = FIELD_FRAME.height,
): Uint16Array {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("native raster dimensions must be positive integers");
  }
  const owners = new Uint16Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      owners[(y * width) + x] = nearestFieldCellIndex(geometryId, (x + 0.5) / width, v);
    }
  }
  return owners;
}

export function nearestFieldCellIndex(geometryId: FieldGeometryId, u: number, v: number): number {
  const geometry = fieldGeometry(geometryId);
  if (!Number.isFinite(u) || !Number.isFinite(v)) throw new Error("native raster coordinate is not finite");
  if (geometry.id === "SQ60") {
    const column = Math.max(0, Math.min(FIELD_COLUMNS - 1, Math.floor(u * FIELD_COLUMNS)));
    const row = Math.max(0, Math.min(FIELD_ROWS - 1, Math.floor(v * FIELD_ROWS)));
    return (row * FIELD_COLUMNS) + column;
  }
  const latticeX = geometry.latticeBounds.left + (u * geometry.latticeBounds.width);
  const latticeY = geometry.latticeBounds.top + (v * geometry.latticeBounds.height);
  const approximateRow = Math.round((latticeY - TRI_HEX_RADIUS) / TRI_ROW_PITCH);
  let selected = 0;
  let selectedDistance = Infinity;
  for (let row = Math.max(0, approximateRow - 2); row <= Math.min(geometry.rows.length - 1, approximateRow + 2); row += 1) {
    for (const index of nearestRowCandidates(geometry.rows[row], geometry.cells, latticeX)) {
      const center = geometry.cells[index].latticeCenter;
      const distance = ((center.x - latticeX) ** 2) + ((center.y - latticeY) ** 2);
      if (distance < selectedDistance || (distance === selectedDistance && index < selected)) {
        selected = index;
        selectedDistance = distance;
      }
    }
  }
  return selected;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createProfile(
  id: FieldProfileId,
  code: number,
  bitsPerCell: number,
  palette: readonly Rgb[],
  stripeCount = bitsPerCell,
  innerDataBytes = FIELD_INNER_DATA_BYTES,
  innerParityBytes = FIELD_INNER_PARITY_BYTES,
  innerCodewordBytes = FIELD_INNER_CODEWORD_BYTES,
  encodedByteCapacity = stripeCount * innerCodewordBytes,
): FieldProfile {
  if (!Number.isInteger(stripeCount)) throw new Error("profile stripe count must be an integer");
  const packetBytes = stripeCount * innerDataBytes;
  const outerEnvelopeCapacity = packetBytes - FIELD_HEADER_BYTES - FIELD_CRC_BYTES;
  // RFC 6330 symbols are kept eight-byte aligned. Four serialized bytes carry
  // the Payload ID; the sub-eight-byte tail remains protected zero padding.
  const sourceSymbolBytes = Math.floor((outerEnvelopeCapacity - 4) / 8) * 8;
  const raptorPacketBytes = sourceSymbolBytes + 4;
  return {
    id,
    code,
    bitsPerCell,
    palette,
    stripeCount,
    innerDataBytes,
    innerParityBytes,
    innerCodewordBytes,
    encodedByteCapacity,
    packetBytes,
    outerEnvelopeCapacity,
    raptorPacketBytes,
    sourceSymbolBytes,
    outerPaddingBytes: outerEnvelopeCapacity - raptorPacketBytes,
    innerCodeRate: packetBytes / (stripeCount * innerCodewordBytes),
  };
}

function buildC32Palette(): readonly Rgb[] {
  const palette: Rgb[] = [[18, 18, 18]];
  for (let index = 0; index < 30; index += 1) {
    const hue = (index * 137.507764) % 360;
    const saturation = index % 2 === 0 ? 0.82 : 0.68;
    const lightness = index % 3 === 0 ? 0.42 : index % 3 === 1 ? 0.57 : 0.68;
    palette.push(hslToRgb(hue, saturation, lightness));
  }
  palette.push([237, 237, 237]);
  return palette;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const base = sector < 1 ? [chroma, x, 0]
    : sector < 2 ? [x, chroma, 0]
      : sector < 3 ? [0, chroma, x]
        : sector < 4 ? [0, x, chroma]
          : sector < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const offset = lightness - (chroma / 2);
  return base.map((value) => Math.round((value + offset) * 255)) as [number, number, number];
}

function encodeInnerCodeword(packet: Uint8Array, profile: FieldProfile): Uint8Array {
  if (packet.length !== profile.packetBytes) throw new Error("inner packet length does not match profile");
  const codeword = new Uint8Array(profile.stripeCount * profile.innerCodewordBytes);
  for (let stripe = 0; stripe < profile.stripeCount; stripe += 1) {
    const data = packet.subarray(stripe * profile.innerDataBytes, (stripe + 1) * profile.innerDataBytes);
    codeword.set(encodeCauchyMds(data, profile.innerParityBytes), stripe * profile.innerCodewordBytes);
  }
  return codeword;
}

function encodeCodewordToSymbols(codeword: Uint8Array, profile: FieldProfile): number[] {
  if (profile.id === "C24") return encodeBase24Bytes(codeword);
  const symbols = encodeBytesToSymbols(codeword, profile.bitsPerCell);
  if (symbols.length !== FIELD_CELL_COUNT) throw new Error("binary constellation did not fill the field");
  return symbols;
}

function decodeSymbolsToOptionalCodeword(
  symbols: readonly (number | null)[],
  profile: FieldProfile,
): Array<number | null> {
  return profile.id === "C24"
    ? decodeBase24Symbols(symbols).slice(0, profile.stripeCount * profile.innerCodewordBytes)
    : decodeSymbolsToOptionalBytes(symbols, profile.bitsPerCell);
}

function placeInterleavedSymbols(symbols: readonly number[], geometryId: FieldGeometryId): Uint8Array {
  if (symbols.length !== FIELD_CELL_COUNT) throw new Error("native codeword does not fill the complete field");
  const states = new Uint8Array(FIELD_CELL_COUNT);
  fieldGeometry(geometryId).layout.forEach((cell, index) => { states[cell.index] = symbols[index]; });
  return states;
}

function statesToRenderedColors(states: Uint8Array, profileId: FieldProfileId, phase: number): readonly Rgb[] {
  return Array.from(states, (state, index) => renderedFieldColor(profileId, state, index, phase));
}

function createFieldGeometries(): Readonly<Record<FieldGeometryId, FieldGeometry>> {
  const squareRows = Array.from({ length: FIELD_ROWS }, () => [] as number[]);
  const squareDrafts = Array.from({ length: FIELD_CELL_COUNT }, (_, index) => {
    const row = Math.floor(index / FIELD_COLUMNS);
    const column = index % FIELD_COLUMNS;
    squareRows[row].push(index);
    return { index, row, column, latticeCenter: { x: column + 0.5, y: row + 0.5 } };
  });
  const squareCells = finalizeCells(squareDrafts, squareRows, { left: 0, top: 0, width: FIELD_COLUMNS, height: FIELD_ROWS });
  const squareMinimum = minimumReferenceDistance(squareCells);

  const triangularRows = Array.from({ length: TRI_ROWS }, () => [] as number[]);
  const triangularDrafts: Array<{ index: number; row: number; column: number; latticeCenter: Point }> = [];
  for (let row = 0; row < TRI_ROWS; row += 1) {
    const centers: number[] = [];
    if ((row & 1) === 0) {
      for (let column = 0; column < 57; column += 1) centers.push(column + 0.5);
    } else {
      for (let column = 1; column <= 56; column += 1) centers.push(column);
      if (TRI_EXTRA_ODD_ROWS.has(row)) centers.push(((row - 1) / 6) % 2 === 0 ? 0 : 57);
      centers.sort((left, right) => left - right);
    }
    centers.forEach((x, column) => {
      const index = triangularDrafts.length;
      triangularRows[row].push(index);
      triangularDrafts.push({
        index,
        row,
        column,
        latticeCenter: { x, y: TRI_HEX_RADIUS + (row * TRI_ROW_PITCH) },
      });
    });
  }
  if (triangularDrafts.length !== FIELD_CELL_COUNT) throw new Error("triangular field geometry does not contain exactly 2040 cells");
  const triangularBounds = {
    left: -0.5,
    top: 0,
    width: 58,
    height: ((TRI_ROWS - 1) * TRI_ROW_PITCH) + (2 * TRI_HEX_RADIUS),
  } as const;
  const triangularCells = finalizeCells(triangularDrafts, triangularRows, triangularBounds);
  const triangularMinimum = minimumReferenceDistance(triangularCells);
  return Object.freeze({
    SQ60: freezeGeometry({
      id: "SQ60",
      code: 0,
      lattice: "square",
      nominalColumns: FIELD_COLUMNS,
      nominalRows: FIELD_ROWS,
      cellCount: FIELD_CELL_COUNT,
      latticeBounds: { left: 0, top: 0, width: FIELD_COLUMNS, height: FIELD_ROWS },
      cells: squareCells,
      rows: squareRows,
      minimumCenterDistanceAtReference: squareMinimum,
      minimumDistanceGainOverSquare: 1,
    }),
    TRI57: freezeGeometry({
      id: "TRI57",
      code: 1,
      lattice: "affine-triangular",
      nominalColumns: 57,
      nominalRows: TRI_ROWS,
      cellCount: FIELD_CELL_COUNT,
      latticeBounds: triangularBounds,
      cells: triangularCells,
      rows: triangularRows,
      minimumCenterDistanceAtReference: triangularMinimum,
      minimumDistanceGainOverSquare: triangularMinimum / squareMinimum,
    }),
  });
}

function freezeGeometry(
  geometry: Omit<FieldGeometry, "layout">,
): FieldGeometry {
  return Object.freeze({
    ...geometry,
    rows: Object.freeze(geometry.rows.map((row) => Object.freeze([...row]))),
    layout: Object.freeze([...geometry.cells].sort((left, right) => (
      hash32(left.index + 0x51f15e5) - hash32(right.index + 0x51f15e5) || left.index - right.index
    ))),
  });
}

function finalizeCells(
  drafts: readonly { index: number; row: number; column: number; latticeCenter: Point }[],
  rows: readonly (readonly number[])[],
  bounds: Readonly<{ left: number; top: number; width: number; height: number }>,
): readonly FieldCell[] {
  return Object.freeze(drafts.map((draft) => {
    const neighbours: number[] = [];
    for (let row = Math.max(0, draft.row - 1); row <= Math.min(rows.length - 1, draft.row + 1); row += 1) {
      for (const candidateIndex of rows[row]) {
        if (candidateIndex === draft.index) continue;
        const candidate = drafts[candidateIndex];
        const distance = Math.hypot(
          draft.latticeCenter.x - candidate.latticeCenter.x,
          draft.latticeCenter.y - candidate.latticeCenter.y,
        );
        if (distance <= 1.001) neighbours.push(candidateIndex);
      }
    }
    return Object.freeze({
      ...draft,
      center: Object.freeze({
        x: (draft.latticeCenter.x - bounds.left) / bounds.width,
        y: (draft.latticeCenter.y - bounds.top) / bounds.height,
      }),
      latticeCenter: Object.freeze({ ...draft.latticeCenter }),
      neighbours: Object.freeze(neighbours.sort((left, right) => left - right)),
    });
  }));
}

function minimumReferenceDistance(cells: readonly FieldCell[]): number {
  let minimum = Infinity;
  for (const cell of cells) {
    for (const neighbour of cell.neighbours) {
      if (neighbour <= cell.index) continue;
      const other = cells[neighbour];
      minimum = Math.min(minimum, Math.hypot(
        (cell.center.x - other.center.x) * FIELD_FRAME.width,
        (cell.center.y - other.center.y) * FIELD_FRAME.height,
      ));
    }
  }
  if (!Number.isFinite(minimum)) throw new Error("field geometry has no adjacent cells");
  return minimum;
}

function nearestRowCandidates(row: readonly number[], cells: readonly FieldCell[], latticeX: number): readonly number[] {
  let low = 0;
  let high = row.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cells[row[middle]].latticeCenter.x < latticeX) low = middle + 1;
    else high = middle;
  }
  return row.slice(Math.max(0, low - 2), Math.min(row.length, low + 2));
}

function scoreFieldStates(
  states: Uint8Array,
  profileId: FieldProfileId,
  previous: readonly number[] | null,
  geometryId: FieldGeometryId,
): number {
  const palette = FIELD_PROFILES[profileId].palette;
  const geometry = fieldGeometry(geometryId);
  let score = 0;
  for (const cell of geometry.cells) {
    for (const neighbour of cell.neighbours) {
      if (neighbour > cell.index) score += stateDistance(states[cell.index], states[neighbour], palette);
    }
    if (previous && cell.index < previous.length) score += 0.24 * stateDistance(states[cell.index], previous[cell.index], palette);
  }
  return score;
}

function stateDistance(first: number, second: number, palette: readonly Rgb[]): number {
  if (first === second) return -180;
  return Math.hypot(
    palette[first][0] - palette[second][0],
    palette[first][1] - palette[second][1],
    palette[first][2] - palette[second][2],
  );
}

function fieldMaskDelta(maskId: number, cell: FieldCell, radix: number): number {
  const row = cell.row;
  const column = cell.column;
  const values = [
    row + column, (2 * row) + column, row + (2 * column), (3 * row) + column,
    row + (3 * column), (row * column) + row + column, (5 * row) + (3 * column),
    (3 * row) + (5 * column), Math.floor(row / 2) + (7 * column),
    (7 * row) + Math.floor(column / 2), (row * column) + (5 * row) + column,
    (row * column) + row + (5 * column), ((row % 5) * 3) + column,
    row + ((column % 5) * 3), (row * row) + (3 * column), (3 * row) + (column * column),
  ];
  return modulo(values[maskId], radix);
}

function byteReliabilityOrders(
  symbolReliabilities: readonly number[] | undefined,
  codeword: readonly (number | null)[],
  profile: FieldProfile,
  geometryId: FieldGeometryId,
): number[][] {
  if (!symbolReliabilities) return Array.from({ length: profile.stripeCount }, () => []);
  if (symbolReliabilities.length !== FIELD_CELL_COUNT) throw new Error("native reliability vector length is invalid");
  const interleavedReliabilities = fieldGeometry(geometryId).layout.map((cell) => symbolReliabilities[cell.index]);
  const byteReliabilities = Array.from({ length: profile.stripeCount * profile.innerCodewordBytes }, () => Infinity);
  if (profile.id === "C24") {
    for (let group = 0; group < 128; group += 1) {
      const symbolStart = group * 16;
      const symbolCount = group === 127 ? 8 : 16;
      const byteStart = group * 9;
      const byteCount = group === 127 ? 4 : 9;
      const reliability = Math.min(...interleavedReliabilities.slice(symbolStart, symbolStart + symbolCount));
      for (let byte = byteStart; byte < Math.min(byteReliabilities.length, byteStart + byteCount); byte += 1) {
        byteReliabilities[byte] = reliability;
      }
    }
  } else {
    for (let symbol = 0; symbol < interleavedReliabilities.length; symbol += 1) {
      const firstBit = symbol * profile.bitsPerCell;
      const firstByte = Math.floor(firstBit / 8);
      const lastByte = Math.floor((firstBit + profile.bitsPerCell - 1) / 8);
      for (let byte = firstByte; byte <= lastByte && byte < byteReliabilities.length; byte += 1) {
        byteReliabilities[byte] = Math.min(byteReliabilities[byte], interleavedReliabilities[symbol]);
      }
    }
  }
  return Array.from({ length: profile.stripeCount }, (_, stripe) => {
    const start = stripe * profile.innerCodewordBytes;
    return Array.from({ length: profile.innerCodewordBytes }, (_, localByte) => ({
      localByte,
      reliability: byteReliabilities[start + localByte],
    })).filter(({ localByte, reliability }) => codeword[start + localByte] !== null && Number.isFinite(reliability))
      .sort((left, right) => left.reliability - right.reliability || left.localByte - right.localByte)
      .map(({ localByte }) => localByte);
  });
}

function bytesToRadixDigits(bytes: Uint8Array, radix: number, digitCount: number): number[] {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const digits = Array.from({ length: digitCount }, () => 0);
  const base = BigInt(radix);
  for (let index = digitCount - 1; index >= 0; index -= 1) {
    digits[index] = Number(value % base);
    value /= base;
  }
  if (value !== 0n) throw new Error("radix digit group overflowed");
  return digits;
}

function radixDigitsToOptionalBytes(
  digits: readonly (number | null)[],
  radix: number,
  byteCount: number,
): Array<number | null> {
  if (digits.some((digit) => digit === null)) return Array.from({ length: byteCount }, () => null);
  let value = 0n;
  const base = BigInt(radix);
  for (const digit of digits) {
    if (!Number.isInteger(digit) || (digit as number) < 0 || (digit as number) >= radix) {
      return Array.from({ length: byteCount }, () => null);
    }
    value = (value * base) + BigInt(digit as number);
  }
  if (value >= (1n << BigInt(byteCount * 8))) return Array.from({ length: byteCount }, () => null);
  const bytes = Array.from({ length: byteCount }, () => 0);
  for (let index = byteCount - 1; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function reliabilityChaseCounts(budget: number): number[] {
  return Array.from(new Set([0, 1, 2, 4, 8, 12, 20, 28, budget].filter((value) => value >= 0 && value <= budget)))
    .sort((left, right) => left - right);
}

function profileFromCode(code: number): FieldProfile {
  const profile = Object.values(FIELD_PROFILES).find((candidate) => candidate.code === code);
  if (!profile) throw new Error("native color profile code is unsupported");
  return profile;
}

function geometryFromCode(code: number): FieldGeometry {
  const geometry = Object.values(FIELD_GEOMETRIES).find((candidate) => candidate.code === code);
  if (!geometry) throw new Error("native field geometry code is unsupported");
  return geometry;
}

function validateMask(maskId: number) {
  if (!Number.isInteger(maskId) || maskId < 0 || maskId >= FIELD_MASK_COUNT) throw new Error("native mask id is invalid");
}

function assertSessionNonce(sessionNonce: Uint8Array) {
  if (sessionNonce.length !== 8) throw new Error("native session nonce must be exactly eight bytes");
}

function assertMagic(bytes: Uint8Array, magic: Uint8Array, label: string) {
  for (let index = 0; index < magic.length; index += 1) if (bytes[index] !== magic[index]) throw new Error(`${label} magic does not match`);
}

function clampChannel(value: number): number {
  return Math.max(4, Math.min(251, Math.round(value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function seedFromBytes(bytes: Uint8Array): number {
  let state = 0x811c9dc5;
  for (const byte of bytes) state = Math.imul(state ^ byte, 0x01000193) >>> 0;
  return state || 1;
}

function xorshift32(input: number): number {
  let value = input >>> 0 || 1;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function hash32(input: number): number {
  let value = input >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
