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

export const LAB_PROFILE_NAME = "DMOFT-C4-WEB-LAB1";
export const LAB_BOOTSTRAP_HASH = "#DMOFT-LAB1";
export const LAB_PACKET_BYTES = 32;
export const LAB_PACKET_COPIES = 3;
export const LAB_SYMBOLS_PER_PACKET = LAB_PACKET_BYTES * 4;
export const LAB_ERASURE_THRESHOLD = 2;

export const C4_PALETTE = [
  [220, 35, 45],
  [25, 165, 75],
  [35, 85, 215],
  [235, 195, 30],
] as const;

const PACKET_MAGIC = new Uint8Array([0x44, 0x4d, 0x4f, 0x46]);
const LAB_FRAME_TYPE = 0xf0;
const C4_PROFILE_CODE = 1;
const FIXED_MESSAGE = new TextEncoder().encode("LIVE-OK!");
const PILOTS = [
  { x: 0, y: 0, symbol: 0 },
  { x: 7, y: 0, symbol: 1 },
  { x: 0, y: 7, symbol: 2 },
  { x: 7, y: 7, symbol: 3 },
] as const;
const PILOT_KEYS = new Set(PILOTS.map(({ x, y }) => `${x}:${y}`));

export type Point = Readonly<{ x: number; y: number }>;
export type Rgb = Readonly<[number, number, number]>;

export type LabPacket = Readonly<{
  sessionHex: string;
  timestampSeconds: number;
  message: string;
  bytes: Uint8Array;
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

export type LabDecode = Readonly<{
  packet: LabPacket;
  repairMode: "direct-copy" | "majority-repair";
  validCopies: number;
}>;

export function buildLabPacket(
  sessionNonce: Uint8Array,
  timestampSeconds: number,
): LabPacket {
  if (sessionNonce.length !== 8) {
    throw new Error("lab session nonce must be exactly 8 bytes");
  }
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0 || timestampSeconds > 0xffffffff) {
    throw new Error("lab timestamp must fit in an unsigned 32-bit integer");
  }

  const bytes = new Uint8Array(LAB_PACKET_BYTES);
  bytes.set(PACKET_MAGIC, 0);
  bytes[4] = 0;
  bytes[5] = 1;
  bytes[6] = LAB_FRAME_TYPE;
  bytes[7] = C4_PROFILE_CODE;
  bytes.set(sessionNonce, 8);
  new DataView(bytes.buffer).setUint32(16, timestampSeconds, false);
  bytes.set(FIXED_MESSAGE, 20);
  new DataView(bytes.buffer).setUint32(28, crc32(bytes.subarray(0, 28)), false);
  return parseLabPacket(bytes);
}

export function parseLabPacket(input: Uint8Array): LabPacket {
  const bytes = Uint8Array.from(input);
  if (bytes.length !== LAB_PACKET_BYTES) {
    throw new Error(`lab packet must be exactly ${LAB_PACKET_BYTES} bytes`);
  }
  for (let index = 0; index < PACKET_MAGIC.length; index += 1) {
    if (bytes[index] !== PACKET_MAGIC[index]) {
      throw new Error("lab packet magic does not match");
    }
  }
  if (bytes[4] !== 0 || bytes[5] !== 1 || bytes[6] !== LAB_FRAME_TYPE || bytes[7] !== C4_PROFILE_CODE) {
    throw new Error("lab packet profile is not supported");
  }
  const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(28, false);
  const observedCrc = crc32(bytes.subarray(0, 28));
  if (observedCrc !== expectedCrc) {
    throw new Error("lab packet CRC32 does not match");
  }
  const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 28));
  if (message !== "LIVE-OK!") {
    throw new Error("lab packet message does not match");
  }
  return {
    sessionHex: toHex(bytes.subarray(8, 16)),
    timestampSeconds: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, false),
    message,
    bytes,
  };
}

export function encodeLabGridSymbols(packet: LabPacket): number[] {
  const packetSymbols = packBytesToC4Symbols(packet.bytes);
  const symbols: number[] = [];
  for (let copy = 0; copy < LAB_PACKET_COPIES; copy += 1) {
    symbols.push(...packetSymbols);
  }
  const capacity = dataCellCoordinates().length;
  for (let index = symbols.length; index < capacity; index += 1) {
    const nonceByte = packet.bytes[8 + (index % 8)] ?? 0;
    symbols.push((nonceByte + (index * 3) + (index >>> 2)) & 0b11);
  }
  return symbols;
}

export function decodeLabGridSymbols(symbols: readonly (number | null)[]): LabDecode {
  if (symbols.length < LAB_SYMBOLS_PER_PACKET * LAB_PACKET_COPIES) {
    throw new Error("not enough optical symbols for the lab packet copies");
  }

  const validPackets: LabPacket[] = [];
  for (let copy = 0; copy < LAB_PACKET_COPIES; copy += 1) {
    const start = copy * LAB_SYMBOLS_PER_PACKET;
    const copySymbols = symbols.slice(start, start + LAB_SYMBOLS_PER_PACKET);
    if (copySymbols.some((symbol) => symbol === null)) {
      continue;
    }
    try {
      validPackets.push(parseLabPacket(unpackC4Symbols(copySymbols as number[])));
    } catch {
      // A damaged copy is ignored; the other copies and majority repair remain available.
    }
  }

  if (validPackets.length > 0) {
    const first = validPackets[0];
    if (validPackets.some((packet) => packet.sessionHex !== first.sessionHex)) {
      throw new Error("authenticated lab copies disagree on the session");
    }
    return { packet: first, repairMode: "direct-copy", validCopies: validPackets.length };
  }

  const repaired: Array<number | null> = [];
  for (let index = 0; index < LAB_SYMBOLS_PER_PACKET; index += 1) {
    const votes = new Map<number, number>();
    for (let copy = 0; copy < LAB_PACKET_COPIES; copy += 1) {
      const symbol = symbols[index + (copy * LAB_SYMBOLS_PER_PACKET)];
      if (symbol !== null) {
        votes.set(symbol, (votes.get(symbol) ?? 0) + 1);
      }
    }
    let winner: number | null = null;
    let winnerVotes = 0;
    for (const [symbol, count] of votes) {
      if (count > winnerVotes) {
        winner = symbol;
        winnerVotes = count;
      }
    }
    repaired.push(winnerVotes >= 2 ? winner : null);
  }
  if (repaired.some((symbol) => symbol === null)) {
    throw new Error("lab packet has too many erasures for majority repair");
  }
  return {
    packet: parseLabPacket(unpackC4Symbols(repaired as number[])),
    repairMode: "majority-repair",
    validCopies: 0,
  };
}

export function packBytesToC4Symbols(bytes: Uint8Array): number[] {
  const symbols: number[] = [];
  for (const byte of bytes) {
    symbols.push((byte >>> 6) & 3, (byte >>> 4) & 3, (byte >>> 2) & 3, byte & 3);
  }
  return symbols;
}

export function unpackC4Symbols(symbols: readonly number[]): Uint8Array {
  if (symbols.length % 4 !== 0) {
    throw new Error("C4 symbol count must be divisible by four");
  }
  const bytes = new Uint8Array(symbols.length / 4);
  for (let offset = 0; offset < symbols.length; offset += 4) {
    const group = symbols.slice(offset, offset + 4);
    if (group.some((symbol) => !Number.isInteger(symbol) || symbol < 0 || symbol > 3)) {
      throw new Error("C4 symbol is outside the active palette");
    }
    bytes[offset / 4] = (group[0] << 6) | (group[1] << 4) | (group[2] << 2) | group[3];
  }
  return bytes;
}

export function dataCellCoordinates(): Point[] {
  const coordinates: Point[] = [];
  const tileColumns = LAB_FRAME.dataColumns / LAB_FRAME.tileSize;
  const tileRows = LAB_FRAME.dataRows / LAB_FRAME.tileSize;
  for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tileColumns; tileColumn += 1) {
      for (let localY = 0; localY < LAB_FRAME.tileSize; localY += 1) {
        for (let localX = 0; localX < LAB_FRAME.tileSize; localX += 1) {
          if (!PILOT_KEYS.has(`${localX}:${localY}`)) {
            coordinates.push({
              x: LAB_FRAME.dataX + ((tileColumn * LAB_FRAME.tileSize + localX + 0.5) * LAB_FRAME.cellPitch),
              y: LAB_FRAME.dataY + ((tileRow * LAB_FRAME.tileSize + localY + 0.5) * LAB_FRAME.cellPitch),
            });
          }
        }
      }
    }
  }
  return coordinates;
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
        symbol: (column + row) % 4,
      });
    }
  }
  return coordinates;
}

export function estimatePalette(samples: readonly (readonly Rgb[])[]): PaletteModel {
  if (samples.length !== 4 || samples.some((group) => group.length === 0)) {
    throw new Error("all four C4 calibration states need observed samples");
  }
  const means = samples.map((group) => meanRgb(group));
  for (let first = 0; first < means.length; first += 1) {
    for (let second = first + 1; second < means.length; second += 1) {
      if (euclideanDistance(means[first], means[second]) < 24) {
        throw new Error("observed C4 palette separation is too low");
      }
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
  if (pilots.length !== 4) {
    throw new Error("a C4 tile needs four local pilot observations");
  }
  const shift: [number, number, number] = [0, 0, 0];
  for (let symbol = 0; symbol < 4; symbol += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      shift[channel] += (pilots[symbol][channel] - globalModel.means[symbol][channel]) / 4;
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
  if (source.length !== 4 || destination.length !== 4) {
    throw new Error("homography needs exactly four source and destination points");
  }
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
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) {
      throw new Error("optical geometry is singular");
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let cell = column; cell < 9; cell += 1) {
      matrix[column][cell] /= divisor;
    }
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let cell = column; cell < 9; cell += 1) {
        matrix[row][cell] -= factor * matrix[column][cell];
      }
    }
  }
  return matrix.map((row) => row[8]);
}

export function projectPoint(homography: readonly number[], point: Point): Point {
  if (homography.length !== 8) {
    throw new Error("homography must contain eight coefficients");
  }
  const denominator = (homography[6] * point.x) + (homography[7] * point.y) + 1;
  if (Math.abs(denominator) < 1e-10) {
    throw new Error("projected optical point is outside the finite plane");
  }
  return {
    x: ((homography[0] * point.x) + (homography[1] * point.y) + homography[2]) / denominator,
    y: ((homography[3] * point.x) + (homography[4] * point.y) + homography[5]) / denominator,
  };
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function meanRgb(samples: readonly Rgb[]): Rgb {
  const totals = samples.reduce<[number, number, number]>((sum, rgb) => [
    sum[0] + rgb[0],
    sum[1] + rgb[1],
    sum[2] + rgb[2],
  ], [0, 0, 0]);
  return totals.map((total) => total / samples.length) as [number, number, number];
}

function euclideanDistance(left: Rgb, right: Rgb): number {
  return Math.sqrt(left.reduce((sum, channel, index) => sum + ((channel - right[index]) ** 2), 0));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
