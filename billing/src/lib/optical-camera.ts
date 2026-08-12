import {
  LAB_ERASURE_THRESHOLD,
  LAB_PALETTE_SIZE,
  LAB_SYMBOL_MODULES,
  PRISM_FINDER_CENTERS,
  classifyColor,
  createPrismMatrix,
  decodePrismPaletteSymbols,
  estimatePalette,
  localizePalette,
  logicalModuleCenter,
  projectPoint,
  solveHomography,
  type FrameGridDecode,
  type Point,
  type Rgb,
} from "./optical-lab";

export type CameraPixelImage = Readonly<{
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}>;

// The four points are finder centers in logical TL, TR, BR, BL order. They are
// deliberately not outer QR corners because this profile is not a QR Code.
export type QrLocation = Readonly<{
  topLeftCorner: Point;
  topRightCorner: Point;
  bottomRightCorner: Point;
  bottomLeftCorner: Point;
}>;

export type PrismAcquisition = Readonly<{
  location: QrLocation;
  mode: "custom-four-finder";
  finderScore: number;
  orientationScore: number;
}>;

export type OpticalDecodeStage = "geometry" | "calibration" | "sampling" | "inner-fec";

export class OpticalDecodeError extends Error {
  constructor(
    public readonly stage: OpticalDecodeStage,
    message: string,
  ) {
    super(message);
    this.name = "OpticalDecodeError";
  }
}

export type DecodedCameraFrame = Readonly<{
  decoded: FrameGridDecode;
  confidence: number;
  erasures: number;
  payloadCellCount: number;
  observedModulePixels: number;
  sampleRadius: number;
}>;

type FinderCandidate = {
  x: number;
  y: number;
  moduleSize: number;
  votes: number;
};

type PatternCrossCheck = Readonly<{
  center: number;
  moduleSize: number;
  total: number;
}>;

const FINDER_DISTANCE_MODULES = LAB_SYMBOL_MODULES - 7;

export function locatePrismSymbol(image: CameraPixelImage): PrismAcquisition | null {
  validateImage(image);
  const grayscale = toGrayscale(image);
  const threshold = otsuThreshold(grayscale);
  const binary = Uint8Array.from(grayscale, (value) => value <= threshold ? 1 : 0);
  const candidates = scanFinderCandidates(binary, image.width, image.height);
  const selected = selectFinderQuad(candidates);
  if (!selected) return null;
  const oriented = orientFinderQuad(grayscale, image.width, image.height, threshold, selected.points);
  if (!oriented || oriented.orientationScore < 0.72) return null;
  return {
    location: pointsToLocation(oriented.points),
    mode: "custom-four-finder",
    finderScore: selected.score,
    orientationScore: oriented.orientationScore,
  };
}

export function decodeCameraImage(
  image: CameraPixelImage,
  location: QrLocation,
  erasureThreshold = LAB_ERASURE_THRESHOLD,
): DecodedCameraFrame {
  validateImage(image);
  const destination = locationPoints(location);
  const sideLengths = destination.map((corner, index) => distance(corner, destination[(index + 1) % 4]));
  const minimumSide = Math.min(...sideLengths);
  const maximumSide = Math.max(...sideLengths);
  const observedModulePixels = minimumSide / FINDER_DISTANCE_MODULES;
  if (observedModulePixels < 3.5) {
    throw new OpticalDecodeError(
      "geometry",
      `custom symbol is too small (${observedModulePixels.toFixed(1)} px/module; need at least 3.5)`,
    );
  }
  if (maximumSide / Math.max(1, minimumSide) > 2.4) {
    throw new OpticalDecodeError("geometry", "viewing angle is too steep for reliable custom-grid sampling");
  }

  let homography: readonly number[];
  try {
    homography = solveHomography(PRISM_FINDER_CENTERS, destination);
  } catch (error) {
    throw staged("geometry", error);
  }
  const matrix = createPrismMatrix();
  const sampleRadius = Math.max(1, Math.min(5, Math.floor(observedModulePixels * 0.14)));
  const globalSamples: Rgb[][] = Array.from({ length: LAB_PALETTE_SIZE }, () => []);
  const tileSamples = new Map<string, Map<number, Rgb>>();
  try {
    for (const pilot of matrix.pilots) {
      const observed = sampleRgb(image, projectPoint(homography, logicalModuleCenter(pilot)), sampleRadius);
      if (pilot.scope === "global") {
        globalSamples[pilot.paletteState].push(observed);
      } else {
        const key = tileKey(pilot.tileRow, pilot.tileColumn);
        const group = tileSamples.get(key) ?? new Map<number, Rgb>();
        group.set(pilot.paletteState, observed);
        tileSamples.set(key, group);
      }
    }
  } catch (error) {
    throw staged("sampling", error);
  }

  let globalPalette;
  try {
    globalPalette = estimatePalette(globalSamples);
  } catch (error) {
    throw staged("calibration", error);
  }
  const localModels = new Map<string, ReturnType<typeof localizePalette>>();
  for (const [key, samples] of tileSamples) {
    if (!samples.has(0) || !samples.has(LAB_PALETTE_SIZE - 1)) continue;
    try {
      localModels.set(key, localizePalette(globalPalette, [
        samples.get(0) as Rgb,
        samples.get(LAB_PALETTE_SIZE - 1) as Rgb,
      ]));
    } catch {
      // A damaged local anchor falls back to the global 16-color model.
    }
  }

  const observedStates: Array<number | null> = [];
  const confidences: number[] = [];
  const reliabilities: number[] = [];
  let erasures = 0;
  try {
    for (const cell of matrix.payloadCells) {
      const model = localModels.get(tileKey(cell.tileRow, cell.tileColumn)) ?? globalPalette;
      const classified = classifyColor(
        sampleRgb(image, projectPoint(homography, logicalModuleCenter(cell)), sampleRadius),
        model,
        erasureThreshold,
      );
      confidences.push(classified.confidence);
      reliabilities.push(classified.confidence / (1 + classified.bestDistance));
      if (classified.erasure) erasures += 1;
      observedStates.push(classified.erasure ? null : classified.symbol);
    }
  } catch (error) {
    throw staged("sampling", error);
  }

  try {
    const decoded = decodePrismPaletteSymbols(observedStates, matrix, undefined, reliabilities);
    const confidence = confidences.length === 0
      ? 0
      : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    return {
      decoded,
      confidence,
      erasures,
      payloadCellCount: matrix.payloadCells.length,
      observedModulePixels,
      sampleRadius,
    };
  } catch (error) {
    throw staged("inner-fec", error);
  }
}

function scanFinderCandidates(binary: Uint8Array, width: number, height: number): FinderCandidate[] {
  const candidates: FinderCandidate[] = [];
  const rowStep = height > 900 ? 2 : 1;
  for (let y = 0; y < height; y += rowStep) {
    const runs: Array<{ dark: boolean; start: number; length: number }> = [];
    let start = 0;
    let dark = binary[y * width] === 1;
    for (let x = 1; x <= width; x += 1) {
      const nextDark = x < width ? binary[(y * width) + x] === 1 : !dark;
      if (x < width && nextDark === dark) continue;
      runs.push({ dark, start, length: x - start });
      start = x;
      dark = nextDark;
    }
    for (let run = 0; run + 4 < runs.length; run += 1) {
      const group = runs.slice(run, run + 5);
      if (!group[0].dark || group[1].dark || !group[2].dark || group[3].dark || !group[4].dark) continue;
      const counts = group.map((entry) => entry.length);
      if (!finderRatio(counts)) continue;
      const centerX = group[2].start + (group[2].length / 2);
      const vertical = crossCheck(binary, width, height, Math.round(centerX), y, 0, 1);
      if (!vertical) continue;
      const horizontal = crossCheck(binary, width, height, Math.round(centerX), Math.round(vertical.center), 1, 0);
      if (!horizontal) continue;
      const moduleSize = (counts.reduce((sum, value) => sum + value, 0) / 7
        + vertical.moduleSize + horizontal.moduleSize) / 3;
      mergeCandidate(candidates, horizontal.center, vertical.center, moduleSize);
    }
  }
  return candidates.filter((candidate) => candidate.votes >= 2 && candidate.moduleSize >= 1.4)
    .sort((left, right) => right.votes - left.votes || right.moduleSize - left.moduleSize)
    .slice(0, 16);
}

function crossCheck(
  binary: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  dx: number,
  dy: number,
): PatternCrossCheck | null {
  if (!inside(startX, startY, width, height) || binary[(startY * width) + startX] !== 1) return null;
  const negative: number[] = [];
  const positive: number[] = [];
  for (const direction of [-1, 1]) {
    let x = startX + (direction < 0 ? 0 : dx);
    let y = startY + (direction < 0 ? 0 : dy);
    const counts = direction < 0 ? negative : positive;
    for (const expectedDark of [true, false, true]) {
      let count = 0;
      while (inside(x, y, width, height) && (binary[(y * width) + x] === 1) === expectedDark) {
        count += 1;
        x += dx * direction;
        y += dy * direction;
      }
      if (count === 0) return null;
      counts.push(count);
    }
  }
  const centerCount = negative[0] + positive[0];
  const counts = [negative[2], negative[1], centerCount, positive[1], positive[2]];
  if (!finderRatio(counts)) return null;
  const centerStart = (dx === 1 ? startX : startY) - negative[0] + 1;
  return {
    center: centerStart + (centerCount / 2),
    moduleSize: counts.reduce((sum, value) => sum + value, 0) / 7,
    total: counts.reduce((sum, value) => sum + value, 0),
  };
}

function finderRatio(counts: readonly number[]): boolean {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total < 7) return false;
  const moduleWidth = total / 7;
  const outerTolerance = Math.max(1.5, moduleWidth * 0.9);
  const centerTolerance = Math.max(2.5, moduleWidth * 1.45);
  return Math.abs(counts[0] - moduleWidth) <= outerTolerance
    && Math.abs(counts[1] - moduleWidth) <= outerTolerance
    && Math.abs(counts[2] - (3 * moduleWidth)) <= centerTolerance
    && Math.abs(counts[3] - moduleWidth) <= outerTolerance
    && Math.abs(counts[4] - moduleWidth) <= outerTolerance;
}

function mergeCandidate(candidates: FinderCandidate[], x: number, y: number, moduleSize: number) {
  const existing = candidates.find((candidate) => (
    distance(candidate, { x, y }) <= Math.max(3, moduleSize * 2)
    && Math.max(candidate.moduleSize, moduleSize) / Math.max(0.1, Math.min(candidate.moduleSize, moduleSize)) < 1.8
  ));
  if (!existing) {
    candidates.push({ x, y, moduleSize, votes: 1 });
    return;
  }
  const nextVotes = existing.votes + 1;
  existing.x = ((existing.x * existing.votes) + x) / nextVotes;
  existing.y = ((existing.y * existing.votes) + y) / nextVotes;
  existing.moduleSize = ((existing.moduleSize * existing.votes) + moduleSize) / nextVotes;
  existing.votes = nextVotes;
}

function selectFinderQuad(candidates: readonly FinderCandidate[]): Readonly<{ points: readonly Point[]; score: number }> | null {
  if (candidates.length < 4) return null;
  let best: { points: readonly Point[]; score: number } | null = null;
  for (let a = 0; a < candidates.length - 3; a += 1) {
    for (let b = a + 1; b < candidates.length - 2; b += 1) {
      for (let c = b + 1; c < candidates.length - 1; c += 1) {
        for (let d = c + 1; d < candidates.length; d += 1) {
          const group = [candidates[a], candidates[b], candidates[c], candidates[d]];
          const points = orderImageQuad(group);
          if (!points) continue;
          const sides = points.map((point, index) => distance(point, points[(index + 1) % 4]));
          const meanModule = group.reduce((sum, candidate) => sum + candidate.moduleSize, 0) / group.length;
          const normalizedSides = sides.map((side) => side / meanModule);
          if (Math.min(...normalizedSides) < 20 || Math.max(...normalizedSides) > 55) continue;
          if (Math.max(...sides) / Math.max(1, Math.min(...sides)) > 2.6) continue;
          const area = polygonArea(points);
          if (area < (meanModule * FINDER_DISTANCE_MODULES) ** 2 * 0.2) continue;
          const diagonals = [distance(points[0], points[2]), distance(points[1], points[3])];
          if (Math.max(...diagonals) / Math.max(1, Math.min(...diagonals)) > 1.8) continue;
          const moduleSpread = Math.max(...group.map((candidate) => candidate.moduleSize))
            / Math.max(0.1, Math.min(...group.map((candidate) => candidate.moduleSize)));
          if (moduleSpread > 2.8) continue;
          const votes = group.reduce((sum, candidate) => sum + candidate.votes, 0);
          const sideError = normalizedSides.reduce((sum, side) => sum + Math.abs(side - FINDER_DISTANCE_MODULES), 0);
          const score = (votes * 12) - sideError - (Math.abs(diagonals[0] - diagonals[1]) / meanModule);
          if (!best || score > best.score) best = { points, score };
        }
      }
    }
  }
  return best;
}

function orientFinderQuad(
  grayscale: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  imageQuad: readonly Point[],
): Readonly<{ points: readonly Point[]; orientationScore: number }> | null {
  const matrix = createPrismMatrix();
  const permutations: Point[][] = [];
  for (let rotation = 0; rotation < 4; rotation += 1) {
    permutations.push(Array.from({ length: 4 }, (_, index) => imageQuad[(rotation + index) % 4]));
    permutations.push(Array.from({ length: 4 }, (_, index) => imageQuad[modulo(rotation - index, 4)]));
  }
  let best: { points: readonly Point[]; orientationScore: number } | null = null;
  for (const points of permutations) {
    let homography: readonly number[];
    try {
      homography = solveHomography(PRISM_FINDER_CENTERS, points);
    } catch {
      continue;
    }
    let matches = 0;
    let samples = 0;
    for (let row = 0; row < matrix.size; row += 1) {
      for (let column = 0; column < matrix.size; column += 1) {
        const index = row * matrix.size + column;
        if (!matrix.reserved[index]) continue;
        const point = projectPoint(homography, { x: column + 0.5, y: row + 0.5 });
        const x = Math.round(point.x);
        const y = Math.round(point.y);
        if (!inside(x, y, width, height)) continue;
        const expectedDark = matrix.functionStates[index] === 0;
        const observedDark = grayscale[(y * width) + x] <= threshold;
        if (expectedDark === observedDark) matches += 1;
        samples += 1;
      }
    }
    if (samples === 0) continue;
    const orientationScore = matches / samples;
    if (!best || orientationScore > best.orientationScore) best = { points, orientationScore };
  }
  return best;
}

function orderImageQuad(points: readonly Point[]): readonly Point[] | null {
  const bySum = [...points].sort((left, right) => (left.x + left.y) - (right.x + right.y));
  const byDifference = [...points].sort((left, right) => (left.x - left.y) - (right.x - right.y));
  const ordered = [bySum[0], byDifference[byDifference.length - 1], bySum[bySum.length - 1], byDifference[0]];
  if (new Set(ordered).size !== 4 || polygonArea(ordered) <= 0) return null;
  return ordered;
}

function pointsToLocation(points: readonly Point[]): QrLocation {
  return {
    topLeftCorner: points[0],
    topRightCorner: points[1],
    bottomRightCorner: points[2],
    bottomLeftCorner: points[3],
  };
}

function locationPoints(location: QrLocation): readonly Point[] {
  return [location.topLeftCorner, location.topRightCorner, location.bottomRightCorner, location.bottomLeftCorner];
}

function toGrayscale(image: CameraPixelImage): Uint8Array {
  const grayscale = new Uint8Array(image.width * image.height);
  for (let pixel = 0, offset = 0; pixel < grayscale.length; pixel += 1, offset += 4) {
    grayscale[pixel] = Math.round(
      (0.299 * image.data[offset]) + (0.587 * image.data[offset + 1]) + (0.114 * image.data[offset + 2]),
    );
  }
  return grayscale;
}

function otsuThreshold(grayscale: Uint8Array): number {
  const histogram = new Uint32Array(256);
  let weightedTotal = 0;
  for (const value of grayscale) {
    histogram[value] += 1;
    weightedTotal += value;
  }
  let backgroundWeight = 0;
  let backgroundWeighted = 0;
  let bestVariance = -1;
  let bestThreshold = 127;
  for (let threshold = 0; threshold < 255; threshold += 1) {
    backgroundWeight += histogram[threshold];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = grayscale.length - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundWeighted += threshold * histogram[threshold];
    const backgroundMean = backgroundWeighted / backgroundWeight;
    const foregroundMean = (weightedTotal - backgroundWeighted) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * ((backgroundMean - foregroundMean) ** 2);
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return Math.max(72, Math.min(190, bestThreshold));
}

function sampleRgb(image: CameraPixelImage, point: Point, radius: number): Rgb {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  if (
    centerX - radius < 0
    || centerY - radius < 0
    || centerX + radius >= image.width
    || centerY + radius >= image.height
  ) throw new Error("the full custom symbol must remain inside the camera frame");
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const offset = ((y * image.width) + x) * 4;
      red.push(image.data[offset]);
      green.push(image.data[offset + 1]);
      blue.push(image.data[offset + 2]);
    }
  }
  return [median(red), median(green), median(blue)];
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

function validateImage(image: CameraPixelImage) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new OpticalDecodeError("sampling", "camera image dimensions are invalid");
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new OpticalDecodeError("sampling", "camera image RGBA buffer length is invalid");
  }
}

function staged(stage: OpticalDecodeStage, error: unknown): OpticalDecodeError {
  if (error instanceof OpticalDecodeError) return error;
  return new OpticalDecodeError(stage, error instanceof Error ? error.message : String(error));
}

function tileKey(tileRow: number, tileColumn: number): string {
  return `${tileRow}:${tileColumn}`;
}

function polygonArea(points: readonly Point[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    twiceArea += (points[index].x * next.y) - (next.x * points[index].y);
  }
  return Math.abs(twiceArea) / 2;
}

function inside(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
