import QRCode from "qrcode";

export const LAB_QR_VERSION = 10;
export const LAB_QR_MODULES = 17 + (4 * LAB_QR_VERSION);
export const LAB_QR_ERROR_CORRECTION = "H" as const;
export const LAB_FRAME = {
  width: 780,
  height: 780,
  qrX: 48,
  qrY: 48,
  qrSize: 684,
  modulePitch: 12,
  moduleCount: LAB_QR_MODULES,
  quietModules: 4,
  tileSize: 8,
} as const;

export const LAB_PROFILE_NAME = "PRISM-C8-QR-INTEGRATED1";
export const LAB_BOOTSTRAP_PREFIX = "PRISM-IQR1";
export const LAB_TARGET_FPS = 8;
export const LAB_PALETTE_SIZE = 8;
export const LAB_CHROMA_RADIX = 4;
export const LAB_PACKET_BYTES = 256;
export const LAB_PACKET_COPIES = 2;
export const LAB_SOURCE_CHUNK_BYTES = 192;
export const LAB_SOURCE_CHUNK_COUNT = 8;
export const LAB_OBJECT_BYTES = LAB_SOURCE_CHUNK_BYTES * LAB_SOURCE_CHUNK_COUNT;
export const LAB_SYMBOLS_PER_PACKET = LAB_PACKET_BYTES * 4;
export const LAB_ERASURE_THRESHOLD = 2;

// States 0-3 must remain below the QR luminance threshold; states 4-7 must remain above it.
export const C8_QR_PALETTE = [
  [0, 0, 0],
  [195, 20, 25],
  [0, 115, 45],
  [25, 55, 190],
  [255, 255, 255],
  [250, 225, 20],
  [35, 215, 225],
  [245, 135, 225],
] as const;

const PACKET_MAGIC = new Uint8Array([0x44, 0x4d, 0x4f, 0x46]);
const OBJECT_MAGIC = new Uint8Array([0x50, 0x47, 0x44, 0x4f]);
const FRAME_VERSION = 3;
const C8_INTEGRATED_PROFILE_CODE = 8;
const OUTER_XOR_CODE = 1;
const FRAME_PAYLOAD_OFFSET = 32;
const FRAME_CRC_OFFSET = LAB_PACKET_BYTES - 4;
const OBJECT_CRC_OFFSET = LAB_OBJECT_BYTES - 4;
const OBJECT_MESSAGE = new TextEncoder().encode("INTEGRATED-DYNAMIC-QR-OK");
const PILOTS_PER_LUMINANCE_CLASS = 4;

export type Point = Readonly<{ x: number; y: number }>;
export type Rgb = Readonly<[number, number, number]>;

export type IntegratedCell = Readonly<{
  index: number;
  row: number;
  column: number;
  tileRow: number;
  tileColumn: number;
}>;

export type IntegratedPilot = Readonly<IntegratedCell & { paletteState: number }>;

export type IntegratedQrMatrix = Readonly<{
  size: number;
  bits: Uint8Array;
  reserved: Uint8Array;
  qrMaskPattern: number;
  pilots: readonly IntegratedPilot[];
  payloadCells: readonly IntegratedCell[];
}>;

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
  bootstrap: string;
  matrix: IntegratedQrMatrix;
  paletteStates: Uint8Array;
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
  bytes[6] = C8_INTEGRATED_PROFILE_CODE;
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
  if (
    bytes[4] !== 0
    || bytes[5] !== FRAME_VERSION
    || bytes[6] !== C8_INTEGRATED_PROFILE_CODE
    || bytes[7] !== OUTER_XOR_CODE
  ) throw new Error("lab object profile is not supported");
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
  origin: string,
  previousPaletteStates: readonly number[] | null = null,
): PreparedDynamicFrame {
  let selected: PreparedDynamicFrame | null = null;
  for (let maskId = 0; maskId < 16; maskId += 1) {
    const frame = buildDynamicFrame(sessionNonce, object, sequence, maskId);
    const bootstrap = buildBootstrapUrl(origin, frame);
    const matrix = createIntegratedQrMatrix(bootstrap);
    const unmaskedSymbols = buildUnmaskedPayloadSymbols(frame, matrix.payloadCells.length);
    const maskedSymbols = applyChromaMask(unmaskedSymbols, maskId, matrix.payloadCells);
    const paletteStates = composeIntegratedPalette(matrix, maskedSymbols);
    const maskScore = scorePaletteStates(matrix, paletteStates, previousPaletteStates);
    if (!selected || maskScore > selected.maskScore) {
      selected = { frame, bootstrap, matrix, paletteStates, maskScore };
    }
  }
  if (!selected) throw new Error("no integrated chroma mask could be selected");
  return selected;
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
  validateMaskId(maskId);
  const object = parseLabObject(objectInput);
  if (object.sessionHex !== toHex(sessionNonce)) throw new Error("object and frame sessions do not match");

  const frameKind = sequence < LAB_SOURCE_CHUNK_COUNT ? "systematic" : "repair";
  const equationMask = frameKind === "systematic" ? 1 << sequence : repairEquationMask(sessionNonce, sequence);
  const payload = xorObjectChunks(object.bytes, equationMask);
  const bytes = new Uint8Array(LAB_PACKET_BYTES);
  bytes.set(PACKET_MAGIC, 0);
  bytes[4] = 0;
  bytes[5] = FRAME_VERSION;
  bytes[6] = frameKind === "systematic" ? 0 : 1;
  bytes[7] = C8_INTEGRATED_PROFILE_CODE;
  bytes.set(sessionNonce, 8);
  new DataView(bytes.buffer).setUint16(16, sequence, false);
  bytes[18] = maskId;
  bytes[19] = LAB_SOURCE_CHUNK_COUNT;
  bytes[20] = LAB_SOURCE_CHUNK_BYTES;
  bytes[21] = LAB_PACKET_COPIES;
  bytes[22] = equationMask;
  bytes[23] = OUTER_XOR_CODE;
  new DataView(bytes.buffer).setUint16(24, object.bytes.length, false);
  new DataView(bytes.buffer).setUint32(26, crc32(object.bytes), false);
  new DataView(bytes.buffer).setUint16(30, payload.length, false);
  bytes.set(payload, FRAME_PAYLOAD_OFFSET);
  new DataView(bytes.buffer).setUint32(FRAME_CRC_OFFSET, crc32(bytes.subarray(0, FRAME_CRC_OFFSET)), false);
  return parseDynamicFrame(bytes);
}

export function parseDynamicFrame(input: Uint8Array): DynamicLabFrame {
  const bytes = Uint8Array.from(input);
  if (bytes.length !== LAB_PACKET_BYTES) throw new Error(`dynamic frame must be ${LAB_PACKET_BYTES} bytes`);
  assertMagic(bytes, PACKET_MAGIC, "dynamic frame");
  if (
    bytes[4] !== 0
    || bytes[5] !== FRAME_VERSION
    || bytes[7] !== C8_INTEGRATED_PROFILE_CODE
    || bytes[23] !== OUTER_XOR_CODE
  ) throw new Error("dynamic frame profile is not supported");
  if (bytes[6] !== 0 && bytes[6] !== 1) throw new Error("dynamic frame kind is invalid");
  if (
    bytes[19] !== LAB_SOURCE_CHUNK_COUNT
    || bytes[20] !== LAB_SOURCE_CHUNK_BYTES
    || bytes[21] !== LAB_PACKET_COPIES
    || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(30, false) !== LAB_SOURCE_CHUNK_BYTES
  ) throw new Error("dynamic frame source geometry is invalid");
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
    payload: bytes.slice(FRAME_PAYLOAD_OFFSET, FRAME_PAYLOAD_OFFSET + LAB_SOURCE_CHUNK_BYTES),
    bytes,
  };
}

export function createIntegratedQrMatrix(bootstrap: string): IntegratedQrMatrix {
  const qr = QRCode.create(bootstrap, {
    version: LAB_QR_VERSION,
    errorCorrectionLevel: LAB_QR_ERROR_CORRECTION,
  });
  if (qr.modules.size !== LAB_QR_MODULES) throw new Error("integrated QR module count is not stable");
  const bits = Uint8Array.from(qr.modules.data, (value) => value ? 1 : 0);
  const reserved = Uint8Array.from(qr.modules.reservedBit, (value) => value ? 1 : 0);
  const pilots = selectIntegratedPilots(bits, reserved, qr.modules.size);
  const pilotIndexes = new Set(pilots.map((pilot) => pilot.index));
  const payloadCells: IntegratedCell[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      const index = row * qr.modules.size + column;
      if (!reserved[index] && !pilotIndexes.has(index)) payloadCells.push(createCell(row, column, qr.modules.size));
    }
  }
  payloadCells.sort((left, right) => cellInterleaveKey(left) - cellInterleaveKey(right) || left.index - right.index);
  if (payloadCells.length < LAB_SYMBOLS_PER_PACKET * LAB_PACKET_COPIES) {
    throw new Error("integrated QR does not have enough chroma payload modules");
  }
  return {
    size: qr.modules.size,
    bits,
    reserved,
    qrMaskPattern: qr.maskPattern ?? 0,
    pilots,
    payloadCells,
  };
}

export function encodeBytesToQuaternary(bytes: Uint8Array): number[] {
  const symbols: number[] = [];
  for (const byte of bytes) symbols.push((byte >>> 6) & 3, (byte >>> 4) & 3, (byte >>> 2) & 3, byte & 3);
  return symbols;
}

export function decodeQuaternaryToBytes(symbols: readonly (number | null)[]): Uint8Array {
  if (symbols.length % 4 !== 0) throw new Error("quaternary symbol count must be divisible by four");
  const bytes = new Uint8Array(symbols.length / 4);
  for (let offset = 0; offset < symbols.length; offset += 4) {
    const group = symbols.slice(offset, offset + 4);
    if (group.some((symbol) => symbol === null)) throw new Error("quaternary block contains an erasure");
    if (group.some((symbol) => !Number.isInteger(symbol) || (symbol ?? -1) < 0 || (symbol ?? 4) >= LAB_CHROMA_RADIX)) {
      throw new Error("symbol is outside the active luminance quartet");
    }
    const values = group as number[];
    bytes[offset / 4] = (values[0] << 6) | (values[1] << 4) | (values[2] << 2) | values[3];
  }
  return bytes;
}

export function applyChromaMask(
  symbols: readonly number[],
  maskId: number,
  cells: readonly IntegratedCell[],
): number[] {
  validateMaskId(maskId);
  if (symbols.length > cells.length) throw new Error("chroma symbols exceed integrated payload cells");
  return symbols.map((symbol, index) => modulo(
    symbol + chromaMaskDelta(maskId, cells[index].row, cells[index].column),
    LAB_CHROMA_RADIX,
  ));
}

export function removeChromaMask(
  symbols: readonly (number | null)[],
  maskId: number,
  cells: readonly IntegratedCell[],
): Array<number | null> {
  validateMaskId(maskId);
  if (symbols.length > cells.length) throw new Error("chroma symbols exceed integrated payload cells");
  return symbols.map((symbol, index) => symbol === null ? null : modulo(
    symbol - chromaMaskDelta(maskId, cells[index].row, cells[index].column),
    LAB_CHROMA_RADIX,
  ));
}

export function decodeIntegratedPaletteSymbols(
  observedPaletteStates: readonly (number | null)[],
  matrix: IntegratedQrMatrix,
  maskId: number,
): FrameGridDecode {
  if (observedPaletteStates.length < LAB_SYMBOLS_PER_PACKET * LAB_PACKET_COPIES) {
    throw new Error("not enough integrated chroma symbols for frame copies");
  }
  const constrainedSymbols = observedPaletteStates.map((state, index) => {
    if (state === null) return null;
    if (!Number.isInteger(state) || state < 0 || state >= LAB_PALETTE_SIZE) return null;
    const expectedDark = matrix.bits[matrix.payloadCells[index].index] === 1;
    if (expectedDark !== isDarkPaletteState(state)) return null;
    return state % LAB_CHROMA_RADIX;
  });
  const symbols = removeChromaMask(constrainedSymbols, maskId, matrix.payloadCells);
  const validFrames: DynamicLabFrame[] = [];
  for (let copy = 0; copy < LAB_PACKET_COPIES; copy += 1) {
    const start = copy * LAB_SYMBOLS_PER_PACKET;
    try {
      validFrames.push(parseDynamicFrame(decodeQuaternaryToBytes(symbols.slice(start, start + LAB_SYMBOLS_PER_PACKET))));
    } catch {
      // Erased, malformed, or CRC-invalid copies are rejected before outer decoding.
    }
  }
  if (validFrames.length > 0) {
    const frame = validFrames[0];
    if (validFrames.some((candidate) => candidate.sessionHex !== frame.sessionHex || candidate.sequence !== frame.sequence)) {
      throw new Error("valid integrated frame copies disagree");
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
    frame: parseDynamicFrame(decodeQuaternaryToBytes(consensus)),
    repairMode: "dual-copy-consensus",
    validCopies: 0,
  };
}

export function moduleCenter(cell: Pick<IntegratedCell, "row" | "column">): Point {
  return {
    x: LAB_FRAME.qrX + ((cell.column + 0.5) * LAB_FRAME.modulePitch),
    y: LAB_FRAME.qrY + ((cell.row + 0.5) * LAB_FRAME.modulePitch),
  };
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
  const match = url.hash.match(/^#PRISM-IQR1\.([0-9a-f]{16})\.([0-9a-z]+)\.([0-9a-f])$/);
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

export function isDarkPaletteState(state: number): boolean {
  return state >= 0 && state < LAB_CHROMA_RADIX;
}

export function relativeLuminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

export function estimatePalette(samples: readonly (readonly Rgb[])[]): PaletteModel {
  if (samples.length !== LAB_PALETTE_SIZE || samples.some((group) => group.length === 0)) {
    throw new Error("all eight integrated palette states need observed samples");
  }
  const means = samples.map((group) => meanRgb(group));
  for (let first = 0; first < means.length; first += 1) {
    for (let second = first + 1; second < means.length; second += 1) {
      if (deltaE(means[first], means[second]) < 18) throw new Error("observed integrated palette separation is too low");
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
  if (pilots.length !== LAB_PALETTE_SIZE || globalModel.means.length !== LAB_PALETTE_SIZE) {
    throw new Error("an integrated tile needs eight local pilot observations");
  }
  const shift: [number, number, number] = [0, 0, 0];
  for (let symbol = 0; symbol < LAB_PALETTE_SIZE; symbol += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      shift[channel] += (pilots[symbol][channel] - globalModel.means[symbol][channel]) / LAB_PALETTE_SIZE;
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

function selectIntegratedPilots(bits: Uint8Array, reserved: Uint8Array, size: number): IntegratedPilot[] {
  const pilots: IntegratedPilot[] = [];
  const tileCount = Math.ceil(size / LAB_FRAME.tileSize);
  for (let tileRow = 0; tileRow < tileCount; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tileCount; tileColumn += 1) {
      const dark: IntegratedCell[] = [];
      const light: IntegratedCell[] = [];
      const rowStart = tileRow * LAB_FRAME.tileSize;
      const columnStart = tileColumn * LAB_FRAME.tileSize;
      for (let row = rowStart; row < Math.min(size, rowStart + LAB_FRAME.tileSize); row += 1) {
        for (let column = columnStart; column < Math.min(size, columnStart + LAB_FRAME.tileSize); column += 1) {
          const cell = createCell(row, column, size);
          if (reserved[cell.index]) continue;
          (bits[cell.index] ? dark : light).push(cell);
        }
      }
      if (dark.length < PILOTS_PER_LUMINANCE_CLASS || light.length < PILOTS_PER_LUMINANCE_CLASS) continue;
      dark.sort((left, right) => pilotSelectionKey(left) - pilotSelectionKey(right) || left.index - right.index);
      light.sort((left, right) => pilotSelectionKey(left) - pilotSelectionKey(right) || left.index - right.index);
      for (let state = 0; state < PILOTS_PER_LUMINANCE_CLASS; state += 1) {
        pilots.push({ ...dark[state], paletteState: state });
        pilots.push({ ...light[state], paletteState: state + LAB_CHROMA_RADIX });
      }
    }
  }
  if (new Set(pilots.map((pilot) => pilot.paletteState)).size !== LAB_PALETTE_SIZE) {
    throw new Error("integrated QR cannot place a complete camera-space palette");
  }
  return pilots;
}

function composeIntegratedPalette(matrix: IntegratedQrMatrix, maskedSymbols: readonly number[]): Uint8Array {
  const states = Uint8Array.from(matrix.bits, (bit) => bit ? 0 : LAB_CHROMA_RADIX);
  for (const pilot of matrix.pilots) states[pilot.index] = pilot.paletteState;
  matrix.payloadCells.forEach((cell, index) => {
    const chroma = maskedSymbols[index];
    states[cell.index] = matrix.bits[cell.index] ? chroma : chroma + LAB_CHROMA_RADIX;
  });
  return states;
}

function buildUnmaskedPayloadSymbols(frame: DynamicLabFrame, capacity: number): number[] {
  const packetSymbols = encodeBytesToQuaternary(frame.bytes);
  const symbols = [...packetSymbols, ...packetSymbols];
  let state = (seedFromBytes(frame.bytes.subarray(8, 16)) ^ frame.sequence ^ 0x639ac3d1) >>> 0;
  while (symbols.length < capacity) {
    state = xorshift32(state);
    symbols.push(state % LAB_CHROMA_RADIX);
  }
  return symbols;
}

function scorePaletteStates(
  matrix: IntegratedQrMatrix,
  states: Uint8Array,
  previous: readonly number[] | null,
): number {
  let score = 0;
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      const index = row * matrix.size + column;
      if (column + 1 < matrix.size) score += paletteDistance(states[index], states[index + 1]);
      if (row + 1 < matrix.size) score += paletteDistance(states[index], states[index + matrix.size]);
      if (previous && index < previous.length) score += 0.32 * paletteDistance(states[index], previous[index]);
    }
  }
  const counts = new Array<number>(LAB_PALETTE_SIZE).fill(0);
  for (const cell of matrix.payloadCells) counts[states[cell.index]] += 1;
  const darkTotal = counts.slice(0, 4).reduce((sum, value) => sum + value, 0);
  const lightTotal = counts.slice(4).reduce((sum, value) => sum + value, 0);
  for (let state = 0; state < LAB_PALETTE_SIZE; state += 1) {
    const target = (state < 4 ? darkTotal : lightTotal) / 4;
    score -= Math.abs(counts[state] - target) * 1.2;
  }
  return score;
}

function paletteDistance(first: number, second: number): number {
  if (first === second) return -120;
  return deltaE(C8_QR_PALETTE[first], C8_QR_PALETTE[second]);
}

function deltaE(first: Rgb, second: Rgb): number {
  const left = rgbToLab(first);
  const right = rgbToLab(second);
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function rgbToLab(rgb: Rgb): [number, number, number] {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const x = ((0.4124564 * linear[0]) + (0.3575761 * linear[1]) + (0.1804375 * linear[2])) / 0.95047;
  const y = (0.2126729 * linear[0]) + (0.7151522 * linear[1]) + (0.072175 * linear[2]);
  const z = ((0.0193339 * linear[0]) + (0.119192 * linear[1]) + (0.9503041 * linear[2])) / 1.08883;
  const convert = (value: number) => value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116);
  const fx = convert(x);
  const fy = convert(y);
  const fz = convert(z);
  return [(116 * fy) - 16, 500 * (fx - fy), 200 * (fy - fz)];
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

function createCell(row: number, column: number, size: number): IntegratedCell {
  return {
    index: row * size + column,
    row,
    column,
    tileRow: Math.floor(row / LAB_FRAME.tileSize),
    tileColumn: Math.floor(column / LAB_FRAME.tileSize),
  };
}

function pilotSelectionKey(cell: IntegratedCell): number {
  return hash32(Math.imul(cell.row + 1, 0x45d9f3b) ^ Math.imul(cell.column + 1, 0x119de1f3));
}

function cellInterleaveKey(cell: IntegratedCell): number {
  return hash32(Math.imul(cell.index + 1, 0x9e3779b1));
}

function chromaMaskDelta(maskId: number, row: number, column: number): number {
  switch (maskId) {
    case 0: return (row + column) % 4;
    case 1: return (2 * row + column) % 4;
    case 2: return (row + 2 * column) % 4;
    case 3: return (3 * row + column) % 4;
    case 4: return (row + 3 * column) % 4;
    case 5: return ((row * column) + row + column) % 4;
    case 6: return (Math.floor(row / 2) + column) % 4;
    case 7: return (row + Math.floor(column / 2)) % 4;
    case 8: return (Math.floor(row / 3) + 2 * column) % 4;
    case 9: return (2 * row + Math.floor(column / 3)) % 4;
    case 10: return ((row * column) + 2 * row + column) % 4;
    case 11: return ((row * column) + row + 2 * column) % 4;
    case 12: return ((row % 3) * 2 + column) % 4;
    case 13: return (row + (column % 3) * 2) % 4;
    case 14: return (row * row + column) % 4;
    case 15: return (row + column * column) % 4;
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

function hash32(input: number): number {
  let value = input >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
