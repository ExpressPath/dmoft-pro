export const LAB_FRAME = {
  width: 768,
  height: 496,
  qrX: 32,
  qrY: 32,
  qrSize: 256,
  dataX: 304,
  dataY: 32,
  dataColumns: 24,
  dataRows: 24,
  cellPitch: 18,
  coloredCoreRatio: 0.75,
  tileSize: 8,
  calibrationX: 32,
  calibrationY: 320,
  calibrationColumns: 8,
  calibrationRows: 4,
  calibrationPitch: 24,
} as const;

export const LAB_PROFILE_NAME = "PRISM-C6-DYNAMIC-LAB2";
export const LAB_BOOTSTRAP_PREFIX = "PRISM-DYN2";
export const LAB_TARGET_FPS = 8;
export const LAB_RADIX = 6;
export const LAB_PACKET_BYTES = 64;
export const LAB_PACKET_COPIES = 2;
export const LAB_SOURCE_CHUNK_BYTES = 24;
export const LAB_SOURCE_CHUNK_COUNT = 8;
export const LAB_OBJECT_BYTES = LAB_SOURCE_CHUNK_BYTES * LAB_SOURCE_CHUNK_COUNT;
export const LAB_ERASURE_THRESHOLD = 2;

export const C6_PALETTE = [
  [220, 35, 45],
  [25, 165, 75],
  [35, 85, 215],
  [235, 195, 30],
  [20, 178, 190],
  [190, 55, 185],
] as const;

const PACKET_MAGIC = new Uint8Array([0x44, 0x4d, 0x4f, 0x46]);
const OBJECT_MAGIC = new Uint8Array([0x50, 0x47, 0x44, 0x4f]);
const FRAME_VERSION = 2;
const C6_PROFILE_CODE = 6;
const OUTER_XOR_CODE = 1;
const RADIX_BLOCK_BYTES = 8;
const RADIX_DIGITS_PER_BLOCK = 25;
const FRAME_CRC_OFFSET = 60;
const OBJECT_CRC_OFFSET = LAB_OBJECT_BYTES - 4;
const OBJECT_MESSAGE = new TextEncoder().encode("STARTLESS-DYNAMIC-OK");
const PILOTS = [
  { x: 0, y: 0, symbol: 0 },
  { x: 7, y: 0, symbol: 1 },
  { x: 0, y: 7, symbol: 2 },
  { x: 7, y: 7, symbol: 3 },
  { x: 3, y: 0, symbol: 4 },
  { x: 4, y: 7, symbol: 5 },
] as const;
const PILOT_KEYS = new Set(PILOTS.map(({ x, y }) => `${x}:${y}`));

export const LAB_SYMBOLS_PER_PACKET = (LAB_PACKET_BYTES / RADIX_BLOCK_BYTES) * RADIX_DIGITS_PER_BLOCK;

export type Point = Readonly<{ x: number; y: number }>;
export type Rgb = Readonly<[number, number, number]>;
type CellSlot = Readonly<Point & { column: number; row: number }>;

export type PaletteModel = Readonly<{
  means: readonly Rgb[];
  inverseVariances: readonly Rgb[];
}>;

export type SoftClassification = Readonly<{
  symbol: number;
  secondSymbol: number;
  confidence: number;
  erasure: boolean;
}>;

export type DynamicLabObject = Readonly<{
  sessionHex: string;
  message: string;
  bytes: Uint8Array;
}>;

export type DynamicLabFrame = Readonly<{
  sessionHex: string;
  sequence: number;
  maskId: number;
  frameKind: "systematic" | "repair";
  equationMask: number;
  objectLength: number;
  objectCrc: number;
  payload: Uint8Array;
  bytes: Uint8Array;
}>;

export type PreparedDynamicFrame = Readonly<{
  frame: DynamicLabFrame;
  displayedSymbols: number[];
  maskScore: number;
}>;

export type FrameGridDecode = Readonly<{
  frame: DynamicLabFrame;
  repairMode: "direct-copy" | "dual-copy-consensus";
  validCopies: number;
}>;

export type BootstrapControl = Readonly<{
  sessionHex: string;
  sequence: number;
  maskId: number;
}>;

export type DecoderProgress = Readonly<{
  rank: number;
  required: number;
  acceptedFrames: number;
  duplicateFrames: number;
  sessionHex: string | null;
}>;

export function buildLabObject(sessionNonce: Uint8Array): DynamicLabObject {
  assertSessionNonce(sessionNonce);
  const bytes = new Uint8Array(LAB_OBJECT_BYTES);
  bytes.set(OBJECT_MAGIC, 0);
  bytes[4] = 0;
  bytes[5] = FRAME_VERSION;
  bytes[6] = C6_PROFILE_CODE;
  bytes[7] = OUTER_XOR_CODE;
  bytes.set(sessionNonce, 8);
  bytes[16] = OBJECT_MESSAGE.length;
  bytes.set(OBJECT_MESSAGE, 17);

  let state = seedFromBytes(sessionNonce) ^ 0xa5c31f27;
  for (let offset = 17 + OBJECT_MESSAGE.length; offset < OBJECT_CRC_OFFSET; offset += 1) {
    state = xorshift32(state);
    bytes[offset] = state & 0xff;
  }
  new DataView(bytes.buffer).setUint32(OBJECT_CRC_OFFSET, crc32(bytes.subarray(0, OBJECT_CRC_OFFSET)), false);
  return parseLabObject(bytes);
}

export function parseLabObject(input: Uint8Array): DynamicLabObject {
  const bytes = Uint8Array.from(input);
  if (bytes.length !== LAB_OBJECT_BYTES) throw new Error(`lab object must be ${LAB_OBJECT_BYTES} bytes`);
  assertMagic(bytes, OBJECT_MAGIC, "lab object");
  if (bytes[4] !== 0 || bytes[5] !== FRAME_VERSION || bytes[6] !== C6_PROFILE_CODE || bytes[7] !== OUTER_XOR_CODE) {
    throw new Error("lab object profile is not supported");
  }
  const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(OBJECT_CRC_OFFSET, false);
  if (crc32(bytes.subarray(0, OBJECT_CRC_OFFSET)) !== expectedCrc) throw new Error("lab object CRC32 does not match");
  const messageLength = bytes[16];
  if (messageLength === 0 || 17 + messageLength > OBJECT_CRC_OFFSET) throw new Error("lab object message length is invalid");
  const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(17, 17 + messageLength));
  return { sessionHex: toHex(bytes.subarray(8, 16)), message, bytes };
}

export function prepareDynamicFrame(
  sessionNonce: Uint8Array,
  object: Uint8Array,
  sequence: number,
  previousDisplayedSymbols: readonly number[] | null = null,
): PreparedDynamicFrame {
  const placeholder = buildDynamicFrame(sessionNonce, object, sequence, 0);
  const placeholderSymbols = buildUnmaskedGridSymbols(placeholder);
  const selected = selectVisualMask(placeholderSymbols, previousDisplayedSymbols);
  const frame = buildDynamicFrame(sessionNonce, object, sequence, selected.maskId);
  const displayedSymbols = applySymbolMask(buildUnmaskedGridSymbols(frame), selected.maskId);
  return { frame, displayedSymbols, maskScore: scoreDisplayedSymbols(displayedSymbols, previousDisplayedSymbols) };
}

export function buildDynamicFrame(
  sessionNonce: Uint8Array,
  objectInput: Uint8Array,
  sequence: number,
  maskId: number,
): DynamicLabFrame {
  assertSessionNonce(sessionNonce);
  if (objectInput.length !== LAB_OBJECT_BYTES) throw new Error(`dynamic lab object must be ${LAB_OBJECT_BYTES} bytes`);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff) throw new Error("frame sequence must fit uint16");
  if (!Number.isInteger(maskId) || maskId < 0 || maskId > 15) throw new Error("mask id must be between 0 and 15");
  const object = parseLabObject(objectInput);
  if (object.sessionHex !== toHex(sessionNonce)) throw new Error("object and frame sessions do not match");

  const frameKind = sequence < LAB_SOURCE_CHUNK_COUNT ? "systematic" : "repair";
  const equationMask = frameKind === "systematic"
    ? 1 << sequence
    : repairEquationMask(sessionNonce, sequence);
  const payload = xorObjectChunks(object.bytes, equationMask);
  const bytes = new Uint8Array(LAB_PACKET_BYTES);
  bytes.set(PACKET_MAGIC, 0);
  bytes[4] = 0;
  bytes[5] = FRAME_VERSION;
  bytes[6] = frameKind === "systematic" ? 0 : 1;
  bytes[7] = C6_PROFILE_CODE;
  bytes.set(sessionNonce, 8);
  new DataView(bytes.buffer).setUint16(16, sequence, false);
  bytes[18] = maskId;
  bytes[19] = LAB_SOURCE_CHUNK_COUNT;
  bytes[20] = LAB_SOURCE_CHUNK_BYTES;
  bytes[21] = LAB_SOURCE_CHUNK_BYTES;
  bytes[22] = equationMask;
  bytes[23] = OUTER_XOR_CODE;
  new DataView(bytes.buffer).setUint16(24, object.bytes.length, false);
  new DataView(bytes.buffer).setUint32(26, crc32(object.bytes), false);
  bytes.set(payload, 30);
  new DataView(bytes.buffer).setUint32(FRAME_CRC_OFFSET, crc32(bytes.subarray(0, FRAME_CRC_OFFSET)), false);
  return parseDynamicFrame(bytes);
}

export function parseDynamicFrame(input: Uint8Array): DynamicLabFrame {
  const bytes = Uint8Array.from(input);
  if (bytes.length !== LAB_PACKET_BYTES) throw new Error(`dynamic frame must be ${LAB_PACKET_BYTES} bytes`);
  assertMagic(bytes, PACKET_MAGIC, "dynamic frame");
  if (bytes[4] !== 0 || bytes[5] !== FRAME_VERSION || bytes[7] !== C6_PROFILE_CODE || bytes[23] !== OUTER_XOR_CODE) {
    throw new Error("dynamic frame profile is not supported");
  }
  if (bytes[6] !== 0 && bytes[6] !== 1) throw new Error("dynamic frame kind is invalid");
  if (bytes[19] !== LAB_SOURCE_CHUNK_COUNT || bytes[20] !== LAB_SOURCE_CHUNK_BYTES || bytes[21] !== LAB_SOURCE_CHUNK_BYTES) {
    throw new Error("dynamic frame source geometry is invalid");
  }
  if (bytes[18] > 15 || bytes[22] === 0) throw new Error("dynamic frame mask metadata is invalid");
  const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(FRAME_CRC_OFFSET, false);
  if (crc32(bytes.subarray(0, FRAME_CRC_OFFSET)) !== expectedCrc) throw new Error("dynamic frame CRC32 does not match");
  const sequence = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(16, false);
  const frameKind = bytes[6] === 0 ? "systematic" : "repair";
  if (frameKind === "systematic" && (sequence >= LAB_SOURCE_CHUNK_COUNT || bytes[22] !== 1 << sequence)) {
    throw new Error("systematic frame equation is invalid");
  }
  return {
    sessionHex: toHex(bytes.subarray(8, 16)),
    sequence,
    maskId: bytes[18],
    frameKind,
    equationMask: bytes[22],
    objectLength: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(24, false),
    objectCrc: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(26, false),
    payload: bytes.slice(30, 30 + LAB_SOURCE_CHUNK_BYTES),
    bytes,
  };
}

export function encodeBytesToRadix6(bytes: Uint8Array): number[] {
  if (bytes.length % RADIX_BLOCK_BYTES !== 0) throw new Error("radix-6 input must contain complete 8-byte blocks");
  const digits: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += RADIX_BLOCK_BYTES) {
    let value = 0n;
    for (let index = 0; index < RADIX_BLOCK_BYTES; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]);
    const block = new Array<number>(RADIX_DIGITS_PER_BLOCK).fill(0);
    for (let index = RADIX_DIGITS_PER_BLOCK - 1; index >= 0; index -= 1) {
      block[index] = Number(value % 6n);
      value /= 6n;
    }
    digits.push(...block);
  }
  return digits;
}

export function decodeRadix6ToBytes(symbols: readonly (number | null)[]): Uint8Array {
  if (symbols.length % RADIX_DIGITS_PER_BLOCK !== 0) throw new Error("radix-6 symbols must contain complete blocks");
  const bytes = new Uint8Array((symbols.length / RADIX_DIGITS_PER_BLOCK) * RADIX_BLOCK_BYTES);
  const limit = 1n << 64n;
  for (let offset = 0; offset < symbols.length; offset += RADIX_DIGITS_PER_BLOCK) {
    let value = 0n;
    for (let index = 0; index < RADIX_DIGITS_PER_BLOCK; index += 1) {
      const symbol = symbols[offset + index];
      if (symbol === null) throw new Error("radix-6 block contains an erasure");
      if (!Number.isInteger(symbol) || symbol < 0 || symbol >= LAB_RADIX) throw new Error("symbol is outside the C6 palette");
      value = (value * 6n) + BigInt(symbol);
    }
    if (value >= limit) throw new Error("radix-6 block is not canonical");
    const byteOffset = (offset / RADIX_DIGITS_PER_BLOCK) * RADIX_BLOCK_BYTES;
    for (let index = RADIX_BLOCK_BYTES - 1; index >= 0; index -= 1) {
      bytes[byteOffset + index] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return bytes;
}

export function decodeDynamicGridSymbols(
  displayedSymbols: readonly (number | null)[],
  maskId: number,
): FrameGridDecode {
  if (displayedSymbols.length < LAB_SYMBOLS_PER_PACKET * LAB_PACKET_COPIES) throw new Error("not enough C6 symbols for dynamic frame copies");
  const symbols = removeSymbolMask(displayedSymbols, maskId);
  const validFrames: DynamicLabFrame[] = [];
  for (let copy = 0; copy < LAB_PACKET_COPIES; copy += 1) {
    const start = copy * LAB_SYMBOLS_PER_PACKET;
    try {
      validFrames.push(parseDynamicFrame(decodeRadix6ToBytes(symbols.slice(start, start + LAB_SYMBOLS_PER_PACKET))));
    } catch {
      // A copy with an erasure, non-canonical digit block, or CRC failure is rejected.
    }
  }
  if (validFrames.length > 0) {
    const frame = validFrames[0];
    if (validFrames.some((candidate) => candidate.sessionHex !== frame.sessionHex || candidate.sequence !== frame.sequence)) {
      throw new Error("valid frame copies disagree");
    }
    return { frame, repairMode: "direct-copy", validCopies: validFrames.length };
  }

  const consensus: Array<number | null> = [];
  for (let index = 0; index < LAB_SYMBOLS_PER_PACKET; index += 1) {
    const first = symbols[index];
    const second = symbols[index + LAB_SYMBOLS_PER_PACKET];
    consensus.push(first === second ? first : first === null ? second : second === null ? first : null);
  }
  return {
    frame: parseDynamicFrame(decodeRadix6ToBytes(consensus)),
    repairMode: "dual-copy-consensus",
    validCopies: 0,
  };
}

export function applySymbolMask(symbols: readonly number[], maskId: number): number[] {
  validateMaskId(maskId);
  const slots = dataCellSlots();
  return symbols.map((symbol, index) => modulo(symbol + maskDelta(maskId, slots[index].row, slots[index].column), LAB_RADIX));
}

export function removeSymbolMask(symbols: readonly (number | null)[], maskId: number): Array<number | null> {
  validateMaskId(maskId);
  const slots = dataCellSlots();
  return symbols.map((symbol, index) => symbol === null
    ? null
    : modulo(symbol - maskDelta(maskId, slots[index].row, slots[index].column), LAB_RADIX));
}

export function selectVisualMask(
  unmaskedSymbols: readonly number[],
  previousDisplayedSymbols: readonly number[] | null = null,
): Readonly<{ maskId: number; score: number }> {
  let best = { maskId: 0, score: Number.NEGATIVE_INFINITY };
  for (let maskId = 0; maskId < 16; maskId += 1) {
    const displayed = applySymbolMask(unmaskedSymbols, maskId);
    const score = scoreDisplayedSymbols(displayed, previousDisplayedSymbols);
    if (score > best.score) best = { maskId, score };
  }
  return best;
}

export function buildBootstrapUrl(origin: string, frame: DynamicLabFrame): string {
  const url = new URL("/optical-lab?role=reader", origin);
  url.hash = `${LAB_BOOTSTRAP_PREFIX}.${frame.sessionHex}.${frame.sequence.toString(36)}.${frame.maskId.toString(16)}`;
  return url.toString();
}

export function parseBootstrapUrl(value: string, expectedOrigin?: string): BootstrapControl {
  const url = new URL(value);
  const secureOrigin = url.protocol === "https:"
    || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  if (!secureOrigin || (expectedOrigin && url.origin !== expectedOrigin) || url.pathname !== "/optical-lab" || url.searchParams.get("role") !== "reader") {
    throw new Error("bootstrap URL is not an accepted optical-lab origin");
  }
  const match = url.hash.match(/^#PRISM-DYN2\.([0-9a-f]{16})\.([0-9a-z]+)\.([0-9a-f])$/);
  if (!match) throw new Error("bootstrap control header is invalid");
  const sequence = Number.parseInt(match[2], 36);
  const maskId = Number.parseInt(match[3], 16);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff) throw new Error("bootstrap sequence is invalid");
  return { sessionHex: match[1], sequence, maskId };
}

export class DynamicLabDecoder {
  private readonly rows = new Map<number, { mask: number; data: Uint8Array }>();
  private readonly sequences = new Set<number>();
  private sessionHex: string | null = null;
  private objectLength = 0;
  private objectCrc = 0;
  private acceptedFrames = 0;
  private duplicateFrames = 0;

  addFrame(frame: DynamicLabFrame): boolean {
    if (this.sessionHex === null) {
      this.sessionHex = frame.sessionHex;
      this.objectLength = frame.objectLength;
      this.objectCrc = frame.objectCrc;
    }
    if (frame.sessionHex !== this.sessionHex || frame.objectLength !== this.objectLength || frame.objectCrc !== this.objectCrc) {
      throw new Error("dynamic frame belongs to a different object");
    }
    if (this.sequences.has(frame.sequence)) {
      this.duplicateFrames += 1;
      return false;
    }
    this.sequences.add(frame.sequence);

    let mask = frame.equationMask;
    const data = Uint8Array.from(frame.payload);
    for (let pivot = 0; pivot < LAB_SOURCE_CHUNK_COUNT; pivot += 1) {
      if ((mask & (1 << pivot)) === 0) continue;
      const row = this.rows.get(pivot);
      if (!row) continue;
      mask ^= row.mask;
      xorInto(data, row.data);
    }
    if (mask === 0) {
      if (data.some((byte) => byte !== 0)) throw new Error("inconsistent repair equation");
      this.duplicateFrames += 1;
      return false;
    }

    const pivot = lowestSetBit(mask);
    for (const row of this.rows.values()) {
      if ((row.mask & (1 << pivot)) !== 0) {
        row.mask ^= mask;
        xorInto(row.data, data);
      }
    }
    this.rows.set(pivot, { mask, data });
    this.acceptedFrames += 1;
    return true;
  }

  progress(): DecoderProgress {
    return {
      rank: this.rows.size,
      required: LAB_SOURCE_CHUNK_COUNT,
      acceptedFrames: this.acceptedFrames,
      duplicateFrames: this.duplicateFrames,
      sessionHex: this.sessionHex,
    };
  }

  canRecoverObject(): boolean {
    return this.rows.size === LAB_SOURCE_CHUNK_COUNT;
  }

  reconstruct(): DynamicLabObject {
    if (!this.canRecoverObject()) throw new Error("not enough independent source equations");
    const bytes = new Uint8Array(this.objectLength);
    for (let chunk = 0; chunk < LAB_SOURCE_CHUNK_COUNT; chunk += 1) {
      const row = this.rows.get(chunk);
      if (!row || row.mask !== 1 << chunk) throw new Error("outer decoder did not reach reduced row-echelon form");
      bytes.set(row.data, chunk * LAB_SOURCE_CHUNK_BYTES);
    }
    if (crc32(bytes) !== this.objectCrc) throw new Error("reconstructed object CRC32 does not match");
    return parseLabObject(bytes);
  }
}

export function dataCellCoordinates(): Point[] {
  return dataCellSlots().map(({ x, y }) => ({ x, y }));
}

export function pilotCoordinates(tileColumn: number, tileRow: number): Array<Point & { symbol: number }> {
  return PILOTS.map(({ x, y, symbol }) => ({
    x: LAB_FRAME.dataX + ((tileColumn * LAB_FRAME.tileSize + x + 0.5) * LAB_FRAME.cellPitch),
    y: LAB_FRAME.dataY + ((tileRow * LAB_FRAME.tileSize + y + 0.5) * LAB_FRAME.cellPitch),
    symbol,
  }));
}

export function calibrationCoordinates(): Array<Point & { symbol: number }> {
  const coordinates: Array<Point & { symbol: number }> = [];
  for (let row = 0; row < LAB_FRAME.calibrationRows; row += 1) {
    for (let column = 0; column < LAB_FRAME.calibrationColumns; column += 1) {
      coordinates.push({
        x: LAB_FRAME.calibrationX + ((column + 0.5) * LAB_FRAME.calibrationPitch),
        y: LAB_FRAME.calibrationY + ((row + 0.5) * LAB_FRAME.calibrationPitch),
        symbol: (column + row) % LAB_RADIX,
      });
    }
  }
  return coordinates;
}

export function estimatePalette(samples: readonly (readonly Rgb[])[]): PaletteModel {
  if (samples.length !== LAB_RADIX || samples.some((group) => group.length === 0)) {
    throw new Error("all six C6 calibration states need observed samples");
  }
  const means = samples.map((group) => meanRgb(group));
  for (let first = 0; first < means.length; first += 1) {
    for (let second = first + 1; second < means.length; second += 1) {
      if (euclideanDistance(means[first], means[second]) < 24) throw new Error("observed C6 palette separation is too low");
    }
  }
  const inverseVariances = samples.map((group, symbol) => {
    const mean = means[symbol];
    return [0, 1, 2].map((channel) => {
      const variance = group.reduce((sum, rgb) => sum + ((rgb[channel] - mean[channel]) ** 2), 0)
        / Math.max(1, group.length - 1);
      return 1 / (variance + 36);
    }) as [number, number, number];
  });
  return { means, inverseVariances };
}

export function localizePalette(globalModel: PaletteModel, pilots: readonly Rgb[]): PaletteModel {
  if (pilots.length !== LAB_RADIX || globalModel.means.length !== LAB_RADIX) throw new Error("a C6 tile needs six local pilot observations");
  const shift: [number, number, number] = [0, 0, 0];
  for (let symbol = 0; symbol < LAB_RADIX; symbol += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      shift[channel] += (pilots[symbol][channel] - globalModel.means[symbol][channel]) / LAB_RADIX;
    }
  }
  const means = pilots.map((pilot, symbol) => [0, 1, 2].map((channel) => (
    (0.65 * pilot[channel]) + (0.35 * (globalModel.means[symbol][channel] + shift[channel]))
  )) as [number, number, number]);
  return { means, inverseVariances: globalModel.inverseVariances };
}

export function classifyColor(observed: Rgb, model: PaletteModel): SoftClassification {
  const ranked = model.means.map((mean, symbol) => {
    let distance = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      distance += ((observed[channel] - mean[channel]) ** 2) * model.inverseVariances[symbol][channel];
    }
    return { symbol, distance };
  }).sort((left, right) => left.distance - right.distance);
  const confidence = ranked[1].distance - ranked[0].distance;
  return {
    symbol: ranked[0].symbol,
    secondSymbol: ranked[1].symbol,
    confidence,
    erasure: confidence < LAB_ERASURE_THRESHOLD,
  };
}

export function solveHomography(source: readonly Point[], destination: readonly Point[]): readonly number[] {
  if (source.length !== 4 || destination.length !== 4) throw new Error("homography needs exactly four source and destination points");
  const matrix: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = destination[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) throw new Error("optical geometry is singular");
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let cell = column; cell < 9; cell += 1) matrix[column][cell] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let cell = column; cell < 9; cell += 1) matrix[row][cell] -= factor * matrix[column][cell];
    }
  }
  return matrix.map((row) => row[8]);
}

export function projectPoint(homography: readonly number[], point: Point): Point {
  if (homography.length !== 8) throw new Error("homography must contain eight coefficients");
  const denominator = (homography[6] * point.x) + (homography[7] * point.y) + 1;
  if (Math.abs(denominator) < 1e-10) throw new Error("projected optical point is outside the finite plane");
  return {
    x: ((homography[0] * point.x) + (homography[1] * point.y) + homography[2]) / denominator,
    y: ((homography[3] * point.x) + (homography[4] * point.y) + homography[5]) / denominator,
  };
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildUnmaskedGridSymbols(frame: DynamicLabFrame): number[] {
  const packetSymbols = encodeBytesToRadix6(frame.bytes);
  const symbols = [...packetSymbols, ...packetSymbols];
  const capacity = dataCellSlots().length;
  let state = (seedFromBytes(frame.bytes.subarray(8, 16)) ^ frame.sequence ^ 0x639ac3d1) >>> 0;
  while (symbols.length < capacity) {
    state = xorshift32(state);
    symbols.push(state % LAB_RADIX);
  }
  return symbols;
}

function repairEquationMask(sessionNonce: Uint8Array, sequence: number): number {
  const repairIndex = sequence - LAB_SOURCE_CHUNK_COUNT;
  if (repairIndex < LAB_SOURCE_CHUNK_COUNT) {
    const start = repairIndex % LAB_SOURCE_CHUNK_COUNT;
    return (1 << start) | (1 << ((start + 1) % LAB_SOURCE_CHUNK_COUNT)) | (1 << ((start + 2) % LAB_SOURCE_CHUNK_COUNT));
  }
  let state = (seedFromBytes(sessionNonce) ^ Math.imul(sequence + 1, 0x9e3779b1)) >>> 0;
  state = xorshift32(state);
  const degree = 2 + (state % 4);
  let mask = 0;
  while (popcount(mask) < degree) {
    state = xorshift32(state);
    mask |= 1 << (state % LAB_SOURCE_CHUNK_COUNT);
  }
  return mask;
}

function xorObjectChunks(object: Uint8Array, equationMask: number): Uint8Array {
  const payload = new Uint8Array(LAB_SOURCE_CHUNK_BYTES);
  for (let chunk = 0; chunk < LAB_SOURCE_CHUNK_COUNT; chunk += 1) {
    if ((equationMask & (1 << chunk)) === 0) continue;
    xorInto(payload, object.subarray(chunk * LAB_SOURCE_CHUNK_BYTES, (chunk + 1) * LAB_SOURCE_CHUNK_BYTES));
  }
  return payload;
}

function dataCellSlots(): CellSlot[] {
  const slots: CellSlot[] = [];
  const tileColumns = LAB_FRAME.dataColumns / LAB_FRAME.tileSize;
  const tileRows = LAB_FRAME.dataRows / LAB_FRAME.tileSize;
  for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tileColumns; tileColumn += 1) {
      for (let localY = 0; localY < LAB_FRAME.tileSize; localY += 1) {
        for (let localX = 0; localX < LAB_FRAME.tileSize; localX += 1) {
          if (PILOT_KEYS.has(`${localX}:${localY}`)) continue;
          const column = tileColumn * LAB_FRAME.tileSize + localX;
          const row = tileRow * LAB_FRAME.tileSize + localY;
          slots.push({
            column,
            row,
            x: LAB_FRAME.dataX + ((column + 0.5) * LAB_FRAME.cellPitch),
            y: LAB_FRAME.dataY + ((row + 0.5) * LAB_FRAME.cellPitch),
          });
        }
      }
    }
  }
  return slots;
}

function scoreDisplayedSymbols(symbols: readonly number[], previous: readonly number[] | null): number {
  const slots = dataCellSlots();
  const indexByPosition = new Map(slots.map((slot, index) => [`${slot.column}:${slot.row}`, index]));
  let score = 0;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    for (const [column, row] of [[slot.column + 1, slot.row], [slot.column, slot.row + 1]]) {
      const neighbor = indexByPosition.get(`${column}:${row}`);
      if (neighbor !== undefined) score += paletteDistance(symbols[index], symbols[neighbor]);
    }
    if (previous && index < previous.length) score += 0.38 * paletteDistance(symbols[index], previous[index]);
  }
  const counts = new Array<number>(LAB_RADIX).fill(0);
  for (const symbol of symbols) counts[symbol] += 1;
  const target = symbols.length / LAB_RADIX;
  score -= counts.reduce((penalty, count) => penalty + Math.abs(count - target), 0) * 0.8;
  return score;
}

function paletteDistance(first: number, second: number): number {
  const distance = euclideanDistance(C6_PALETTE[first], C6_PALETTE[second]);
  return first === second ? -90 : distance;
}

function maskDelta(maskId: number, row: number, column: number): number {
  switch (maskId) {
    case 0: return (row + column) % 6;
    case 1: return (2 * row + column) % 6;
    case 2: return (row + 2 * column) % 6;
    case 3: return (3 * row + column) % 6;
    case 4: return (row + 3 * column) % 6;
    case 5: return ((row * column) + row + column) % 6;
    case 6: return (Math.floor(row / 2) + column) % 6;
    case 7: return (row + Math.floor(column / 2)) % 6;
    case 8: return (Math.floor(row / 3) + 2 * column) % 6;
    case 9: return (2 * row + Math.floor(column / 3)) % 6;
    case 10: return ((row * column) + 2 * row + column) % 6;
    case 11: return ((row * column) + row + 2 * column) % 6;
    case 12: return ((row % 3) * 2 + column) % 6;
    case 13: return (row + (column % 3) * 2) % 6;
    case 14: return (row * row + column) % 6;
    case 15: return (row + column * column) % 6;
    default: throw new Error("mask id is outside the supported table");
  }
}

function assertSessionNonce(sessionNonce: Uint8Array) {
  if (sessionNonce.length !== 8) throw new Error("lab session nonce must be exactly 8 bytes");
}

function assertMagic(bytes: Uint8Array, magic: Uint8Array, label: string) {
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) throw new Error(`${label} magic does not match`);
  }
}

function validateMaskId(maskId: number) {
  if (!Number.isInteger(maskId) || maskId < 0 || maskId > 15) throw new Error("mask id must be between 0 and 15");
}

function xorInto(target: Uint8Array, source: Uint8Array) {
  if (target.length !== source.length) throw new Error("XOR vectors must have equal lengths");
  for (let index = 0; index < target.length; index += 1) target[index] ^= source[index];
}

function lowestSetBit(mask: number): number {
  for (let bit = 0; bit < LAB_SOURCE_CHUNK_COUNT; bit += 1) if ((mask & (1 << bit)) !== 0) return bit;
  throw new Error("equation has no pivot");
}

function popcount(value: number): number {
  let count = 0;
  for (let working = value; working !== 0; working >>>= 1) count += working & 1;
  return count;
}

function seedFromBytes(bytes: Uint8Array): number {
  let seed = 0x811c9dc5;
  for (const byte of bytes) seed = Math.imul(seed ^ byte, 0x01000193) >>> 0;
  return seed || 1;
}

function xorshift32(input: number): number {
  let value = input >>> 0 || 1;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function meanRgb(samples: readonly Rgb[]): Rgb {
  const totals = samples.reduce<[number, number, number]>((sum, rgb) => [
    sum[0] + rgb[0], sum[1] + rgb[1], sum[2] + rgb[2],
  ], [0, 0, 0]);
  return totals.map((total) => total / samples.length) as [number, number, number];
}

function euclideanDistance(left: Rgb, right: Rgb): number {
  return Math.sqrt(left.reduce((sum, channel, index) => sum + ((channel - right[index]) ** 2), 0));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
