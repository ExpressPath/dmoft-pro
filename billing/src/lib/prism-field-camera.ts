import { projectPoint, solveHomography } from "./optical-lab";
import type { CameraPixelImage } from "./optical-camera";
import {
  FIELD_CELL_COUNT,
  FIELD_COLUMNS,
  FIELD_ERASURE_THRESHOLD,
  FIELD_PHASE_COUNT,
  FIELD_PROFILES,
  FIELD_ROWS,
  decodeNativeFieldSymbols,
  distributedPilotSign,
  renderedFieldColor,
  type FieldProfileId,
  type NativeFieldDecode,
  type Point,
  type Rgb,
} from "./prism-field";

export type NativeFieldLocation = Readonly<{
  topLeftCorner: Point;
  topRightCorner: Point;
  bottomRightCorner: Point;
  bottomLeftCorner: Point;
}>;

export type NativeFieldAcquisition = Readonly<{
  location: NativeFieldLocation;
  phase: number;
  mode: "distributed-pilot";
  pilotScore: number;
  observedCellPixels: number;
}>;

export type NativeFieldCameraDecode = Readonly<{
  decoded: NativeFieldDecode;
  confidence: number;
  erasures: number;
  observedCellPixels: number;
  profileId: FieldProfileId;
  equalizerStrength: number;
}>;

export type NativeFieldDecodeStage = "geometry" | "phase" | "calibration" | "sampling" | "inner-fec";

export class NativeFieldDecodeError extends Error {
  constructor(
    public readonly stage: NativeFieldDecodeStage,
    message: string,
  ) {
    super(message);
    this.name = "NativeFieldDecodeError";
  }
}

type OrientationCandidate = Readonly<{
  points: readonly Point[];
  phase: number;
  score: number;
  referenceProfileId: FieldProfileId;
}>;

type AffineChannelModel = Readonly<{
  gains: Rgb;
  offsets: Rgb;
}>;

type ClassifiedField = Readonly<{
  states: Array<number | null>;
  reliabilities: number[];
  meanConfidence: number;
  erasures: number;
}>;

const LOGICAL_CORNERS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: FIELD_COLUMNS, y: 0 },
  { x: FIELD_COLUMNS, y: FIELD_ROWS },
  { x: 0, y: FIELD_ROWS },
];
const MIN_CELL_PIXELS = 3.2;
const MIN_PILOT_SCORE = 0.028;
const PILOT_SAMPLE_STRIDE = 3;

/**
 * Acquires the borderless field from its distributed geometry/phase sequence.
 * The image-edge segmentation only provides a coarse quadrilateral; the final
 * orientation and frame phase come from correlation over the whole field.
 */
export function locateNativeField(image: CameraPixelImage): NativeFieldAcquisition | null {
  validateImage(image);
  const coarse = coarseFieldQuad(image);
  if (!coarse) return null;
  const oriented = orientByDistributedPilot(image, coarse);
  if (!oriented || oriented.score < MIN_PILOT_SCORE) return null;
  const refined = refineDistributedGeometry(image, oriented);
  const location = pointsToLocation(refined.points);
  return {
    location,
    phase: refined.phase,
    mode: "distributed-pilot",
    pilotScore: refined.score,
    observedCellPixels: observedCellPixels(refined.points),
  };
}

export function trackNativeFieldPhase(
  image: CameraPixelImage,
  location: NativeFieldLocation,
): NativeFieldAcquisition | null {
  validateImage(image);
  const points = locationPoints(location);
  let homography: readonly number[];
  try {
    homography = solveHomography(LOGICAL_CORNERS, points);
  } catch {
    return null;
  }
  const samples: Rgb[] = [];
  const indices: number[] = [];
  for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
    const sample = sampleRgbOrNull(image, projectPoint(homography, logicalCenter(index)));
    if (!sample) continue;
    samples.push(sample);
    indices.push(index);
  }
  if (samples.length < FIELD_CELL_COUNT / 5) return null;
  let phase = 0;
  let pilotScore = -Infinity;
  for (const residuals of payloadRemovedResidualSets(samples)) {
    for (let candidate = 0; candidate < FIELD_PHASE_COUNT; candidate += 1) {
      const score = normalizedPilotCorrelation(residuals, indices, candidate);
      if (score > pilotScore) {
        phase = candidate;
        pilotScore = score;
      }
    }
  }
  if (pilotScore < MIN_PILOT_SCORE) return null;
  return {
    location,
    phase,
    mode: "distributed-pilot",
    pilotScore,
    observedCellPixels: observedCellPixels(points),
  };
}

export function decodeNativeFieldImage(
  image: CameraPixelImage,
  acquisition: Pick<NativeFieldAcquisition, "location" | "phase">,
  preferredProfiles: readonly FieldProfileId[] = ["C16", "C8", "C24", "C32"],
  erasureThreshold = FIELD_ERASURE_THRESHOLD,
): NativeFieldCameraDecode {
  validateImage(image);
  const initialPoints = locationPoints(acquisition.location);
  const cellPixels = observedCellPixels(initialPoints);
  if (cellPixels < MIN_CELL_PIXELS) {
    throw new NativeFieldDecodeError(
      "geometry",
      `native field is too small (${cellPixels.toFixed(1)} px/cell; need at least ${MIN_CELL_PIXELS})`,
    );
  }
  let lastError: unknown = null;
  // Borderless segmentation can land a fraction of a cell inside the true
  // outer edge. Try small, bounded sampling lattices and let MDS+CRC select the
  // unique valid geometry instead of trusting a single hard boundary estimate.
  const geometryHypotheses: Point[][] = [1, 1.008, 1.016, 1.024, 0.992]
    .map((scale) => scale === 1 ? [...initialPoints] : scaleQuad(initialPoints, scale));
  const cornerDelta = Math.max(2, Math.min(14, cellPixels * 0.75));
  for (let corner = 0; corner < 4; corner += 1) {
    geometryHypotheses.push(offsetCorner(initialPoints, corner, cornerDelta));
    geometryHypotheses.push(offsetCorner(initialPoints, corner, -cornerDelta));
  }
  for (const points of geometryHypotheses) {
    let homography: readonly number[];
    try {
      homography = solveHomography(LOGICAL_CORNERS, points);
    } catch (error) {
      lastError = error;
      continue;
    }
    let samples: Rgb[];
    try {
      samples = Array.from({ length: FIELD_CELL_COUNT }, (_, index) => sampleRgb(
        image,
        projectPoint(homography, logicalCenter(index)),
        0,
      ));
    } catch (error) {
      lastError = error;
      continue;
    }
    const hypothesisCellPixels = observedCellPixels(points);
    const equalizerStrength = hypothesisCellPixels < 6 ? 0.12 : hypothesisCellPixels < 9 ? 0.06 : 0;
    if (equalizerStrength > 0) samples = equalizeTouchingCellSamples(samples, equalizerStrength);
    for (const profileId of uniqueProfiles(preferredProfiles)) {
      try {
        const model = estimateBlindAffineModel(samples, profileId, acquisition.phase);
        const first = classifyField(samples, profileId, acquisition.phase, model, erasureThreshold);
        const refinedModel = refineDecisionDirectedModel(samples, first, profileId, acquisition.phase, model);
        const classified = classifyField(samples, profileId, acquisition.phase, refinedModel, erasureThreshold);
        const decoded = decodeNativeFieldSymbols(
          classified.states,
          profileId,
          acquisition.phase,
          undefined,
          classified.reliabilities,
        );
        return {
          decoded,
          confidence: classified.meanConfidence,
          erasures: classified.erasures,
          observedCellPixels: hypothesisCellPixels,
          profileId,
          equalizerStrength,
        };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new NativeFieldDecodeError(
    "inner-fec",
    lastError instanceof Error ? lastError.message : "no adaptive color profile produced a valid field",
  );
}

/** First-order inverse for nearest-neighbour optical leakage. */
export function equalizeTouchingCellSamples(samples: readonly Rgb[], strength: number): Rgb[] {
  if (samples.length !== FIELD_CELL_COUNT) throw new Error("equalizer requires a complete field");
  if (!Number.isFinite(strength) || strength < 0 || strength > 0.35) throw new Error("equalizer strength is invalid");
  return samples.map((sample, index) => {
    const row = Math.floor(index / FIELD_COLUMNS);
    const column = index % FIELD_COLUMNS;
    const neighbours: Rgb[] = [];
    if (row > 0) neighbours.push(samples[index - FIELD_COLUMNS]);
    if (row + 1 < FIELD_ROWS) neighbours.push(samples[index + FIELD_COLUMNS]);
    if (column > 0) neighbours.push(samples[index - 1]);
    if (column + 1 < FIELD_COLUMNS) neighbours.push(samples[index + 1]);
    const mean = neighbours.reduce<[number, number, number]>((sum, value) => [
      sum[0] + value[0], sum[1] + value[1], sum[2] + value[2],
    ], [0, 0, 0]).map((value) => value / neighbours.length) as [number, number, number];
    return sample.map((value, channel) => clamp(value + (strength * (value - mean[channel])))) as [number, number, number];
  });
}

function orientByDistributedPilot(image: CameraPixelImage, coarse: readonly Point[]): OrientationCandidate | null {
  const permutations = dihedralPermutations(coarse);
  const coarseCandidates: OrientationCandidate[] = [];
  for (const points of permutations) {
    const touchesEdge = points.some((point) => (
      point.x < 2 || point.y < 2 || point.x > image.width - 3 || point.y > image.height - 3
    ));
    const scaledVariants = (touchesEdge ? [1] : [0.97, 1, 1.03, 1.06]).map((scale) => scaleQuad(points, scale));
    for (const scaled of scaledVariants) {
      let homography: readonly number[];
      try {
        homography = solveHomography(LOGICAL_CORNERS, scaled);
      } catch {
        continue;
      }
      const samples: Rgb[] = [];
      const indices: number[] = [];
      for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
        const point = projectPoint(homography, logicalCenter(index));
        const sample = sampleRgbOrNull(image, point);
        if (!sample) continue;
        samples.push(sample);
        indices.push(index);
      }
      if (samples.length < FIELD_CELL_COUNT / 5) continue;
      const residuals = payloadRemovedResiduals(samples, "C16");
      let candidate: OrientationCandidate = { points: scaled, phase: 0, score: -Infinity, referenceProfileId: "C16" };
      for (let phase = 0; phase < FIELD_PHASE_COUNT; phase += 1) {
        const score = normalizedPilotCorrelation(residuals, indices, phase);
        if (score > candidate.score) candidate = { points: scaled, phase, score, referenceProfileId: "C16" };
      }
      coarseCandidates.push(candidate);
    }
  }
  let best: OrientationCandidate | null = null;
  for (const coarseCandidate of coarseCandidates.sort((left, right) => right.score - left.score).slice(0, 8)) {
    let homography: readonly number[];
    try {
      homography = solveHomography(LOGICAL_CORNERS, coarseCandidate.points);
    } catch {
      continue;
    }
    const samples: Rgb[] = [];
    const indices: number[] = [];
    for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
      const sample = sampleRgbOrNull(image, projectPoint(homography, logicalCenter(index)));
      if (!sample) continue;
      samples.push(sample);
      indices.push(index);
    }
    for (const profileId of ["C8", "C16", "C24", "C32"] as const) {
      const residuals = payloadRemovedResiduals(samples, profileId);
      for (let phase = 0; phase < FIELD_PHASE_COUNT; phase += 1) {
        const score = normalizedPilotCorrelation(residuals, indices, phase);
        if (!best || score > best.score) best = { points: coarseCandidate.points, phase, score, referenceProfileId: profileId };
      }
    }
  }
  return best;
}

function refineDistributedGeometry(image: CameraPixelImage, candidate: OrientationCandidate): OrientationCandidate {
  let best = candidate;
  const pitch = observedCellPixels(candidate.points);
  const deltas = [0.72, 0.36, 0.16].map((ratio) => Math.max(0.6, Math.min(11, pitch * ratio)));
  for (const delta of deltas) {
    for (let corner = 0; corner < 4; corner += 1) {
      for (const [dx, dy] of [[-delta, 0], [delta, 0], [0, -delta], [0, delta]] as const) {
        const points = best.points.map((point, index) => index === corner ? {
          x: clampRange(point.x + dx, 0, image.width - 1),
          y: clampRange(point.y + dy, 0, image.height - 1),
        } : point);
        let homography: readonly number[];
        try {
          homography = solveHomography(LOGICAL_CORNERS, points);
        } catch {
          continue;
        }
        const samples: Rgb[] = [];
        const indices: number[] = [];
        for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
          const sample = sampleRgbOrNull(image, projectPoint(homography, logicalCenter(index)));
          if (!sample) continue;
          samples.push(sample);
          indices.push(index);
        }
        const score = normalizedPilotCorrelation(
          payloadRemovedResiduals(samples, best.referenceProfileId),
          indices,
          best.phase,
        );
        if (score > best.score) best = { ...best, points, score };
      }
    }
  }
  return best;
}

function payloadRemovedResidualSets(samples: readonly Rgb[]): number[][] {
  return (["C8", "C16", "C24", "C32"] as const).map((profileId) => payloadRemovedResiduals(samples, profileId));
}

function payloadRemovedResiduals(samples: readonly Rgb[], profileId: FieldProfileId): number[] {
  const model = estimateBasePaletteAffine(samples, profileId);
  return samples.map((sample) => {
    let nearest: Rgb | null = null;
    let nearestDistance = Infinity;
    for (const base of FIELD_PROFILES[profileId].palette) {
      const predicted = base.map((value, channel) => (value * model.gains[channel]) + model.offsets[channel]) as [number, number, number];
      const candidateDistance = colorDistance(sample, predicted);
      if (candidateDistance < nearestDistance) {
        nearest = predicted;
        nearestDistance = candidateDistance;
      }
    }
    if (!nearest) return 0;
    return (0.299 * (sample[0] - nearest[0]))
      + (0.587 * (sample[1] - nearest[1]))
      + (0.114 * (sample[2] - nearest[2]));
  });
}

function normalizedPilotCorrelation(residuals: readonly number[], indices: readonly number[], phase: number): number {
  const mean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  let covariance = 0;
  let variance = 0;
  for (let sample = 0; sample < residuals.length; sample += 1) {
    const centered = residuals[sample] - mean;
    covariance += centered * distributedPilotSign(indices[sample], phase, 0);
    variance += centered * centered;
  }
  return covariance / Math.max(1, Math.sqrt(variance * residuals.length));
}

function coarseFieldQuad(image: CameraPixelImage): readonly Point[] | null {
  const imageAspect = image.width / image.height;
  const fieldAspect = FIELD_COLUMNS / FIELD_ROWS;
  if (Math.abs(Math.log(imageAspect / fieldAspect)) < 0.07 && textureCoverage(image) > 0.38) {
    return outerImageCorners(image);
  }
  const step = Math.max(2, Math.floor(Math.min(image.width, image.height) / 420));
  const evidence: Point[] = [];
  for (let y = step; y < image.height - step; y += step) {
    for (let x = step; x < image.width - step; x += step) {
      const pixel = rgbAt(image, x, y);
      const right = rgbAt(image, Math.min(image.width - 1, x + step), y);
      const down = rgbAt(image, x, Math.min(image.height - 1, y + step));
      const chroma = Math.max(...pixel) - Math.min(...pixel);
      if (chroma > 34 || colorDistance(pixel, right) > 42 || colorDistance(pixel, down) > 42) evidence.push({ x, y });
    }
  }
  if (evidence.length < 120) return null;
  // Keep the true outer cell rows. A one-percent trim is already close to a
  // complete cell at this grid size and biases a borderless estimate inward.
  const minimumX = percentile(evidence.map((point) => point.x), 0.001);
  const maximumX = percentile(evidence.map((point) => point.x), 0.999);
  const minimumY = percentile(evidence.map((point) => point.y), 0.001);
  const maximumY = percentile(evidence.map((point) => point.y), 0.999);
  const bounded = evidence.filter((point) => point.x >= minimumX && point.x <= maximumX && point.y >= minimumY && point.y <= maximumY);
  const fitted = fitEvidenceQuad(bounded, minimumX, maximumX, minimumY, maximumY);
  if (fitted) return fitted;
  const topLeft = minimumBy(bounded, (point) => normalizedCornerCost(point, minimumX, maximumX, minimumY, maximumY, 0));
  const topRight = minimumBy(bounded, (point) => normalizedCornerCost(point, minimumX, maximumX, minimumY, maximumY, 1));
  const bottomRight = minimumBy(bounded, (point) => normalizedCornerCost(point, minimumX, maximumX, minimumY, maximumY, 2));
  const bottomLeft = minimumBy(bounded, (point) => normalizedCornerCost(point, minimumX, maximumX, minimumY, maximumY, 3));
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;
  return scaleQuad([topLeft, topRight, bottomRight, bottomLeft], 1 + (0.7 / Math.max(1, Math.min(FIELD_COLUMNS, FIELD_ROWS))));
}

function fitEvidenceQuad(
  evidence: readonly Point[],
  minimumX: number,
  maximumX: number,
  minimumY: number,
  maximumY: number,
): readonly Point[] | null {
  const xBins = boundaryBins(evidence, minimumX, maximumX, 44, "x");
  const yBins = boundaryBins(evidence, minimumY, maximumY, 28, "y");
  const top = robustLine(xBins.map((bin) => ({ x: bin.center, y: Math.min(...bin.points.map((point) => point.y)) })));
  const bottom = robustLine(xBins.map((bin) => ({ x: bin.center, y: Math.max(...bin.points.map((point) => point.y)) })));
  const leftRaw = robustLine(yBins.map((bin) => ({ x: bin.center, y: Math.min(...bin.points.map((point) => point.x)) })));
  const rightRaw = robustLine(yBins.map((bin) => ({ x: bin.center, y: Math.max(...bin.points.map((point) => point.x)) })));
  if (!top || !bottom || !leftRaw || !rightRaw) return null;
  // top/bottom are y=a*x+b. left/right were fitted as x=a*y+b.
  const topLeft = intersectYX(top, leftRaw);
  const topRight = intersectYX(top, rightRaw);
  const bottomRight = intersectYX(bottom, rightRaw);
  const bottomLeft = intersectYX(bottom, leftRaw);
  const points = [topLeft, topRight, bottomRight, bottomLeft];
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  if (distance(topLeft, topRight) < 0.35 * (maximumX - minimumX)) return null;
  if (distance(topLeft, bottomLeft) < 0.35 * (maximumY - minimumY)) return null;
  return points;
}

function boundaryBins(
  evidence: readonly Point[],
  minimum: number,
  maximum: number,
  count: number,
  axis: "x" | "y",
): Array<{ center: number; points: Point[] }> {
  const width = Math.max(1, (maximum - minimum) / count);
  const bins = Array.from({ length: count }, (_, index) => ({
    center: minimum + ((index + 0.5) * width),
    points: [] as Point[],
  }));
  for (const point of evidence) {
    const value = axis === "x" ? point.x : point.y;
    const index = Math.max(0, Math.min(count - 1, Math.floor((value - minimum) / width)));
    bins[index].points.push(point);
  }
  return bins.filter((bin, index) => index >= 2 && index < count - 2 && bin.points.length >= 2);
}

function robustLine(points: readonly Point[]): Readonly<{ slope: number; offset: number }> | null {
  if (points.length < 8) return null;
  let retained = [...points];
  let model: { slope: number; offset: number } | null = null;
  for (let pass = 0; pass < 3; pass += 1) {
    const count = retained.length;
    const sumX = retained.reduce((sum, point) => sum + point.x, 0);
    const sumY = retained.reduce((sum, point) => sum + point.y, 0);
    const sumXX = retained.reduce((sum, point) => sum + (point.x * point.x), 0);
    const sumXY = retained.reduce((sum, point) => sum + (point.x * point.y), 0);
    const denominator = (count * sumXX) - (sumX * sumX);
    if (Math.abs(denominator) < 1e-6) return null;
    const slope = ((count * sumXY) - (sumX * sumY)) / denominator;
    model = { slope, offset: (sumY - (slope * sumX)) / count };
    const residuals = retained.map((point) => Math.abs(point.y - ((slope * point.x) + model!.offset)));
    const cutoff = Math.max(2, percentile(residuals, 0.72));
    retained = retained.filter((point) => Math.abs(point.y - ((slope * point.x) + model!.offset)) <= cutoff);
    if (retained.length < 8) break;
  }
  return model;
}

function intersectYX(
  horizontal: Readonly<{ slope: number; offset: number }>,
  vertical: Readonly<{ slope: number; offset: number }>,
): Point {
  // y = h.slope*x + h.offset; x = v.slope*y + v.offset
  const denominator = 1 - (horizontal.slope * vertical.slope);
  const x = ((vertical.slope * horizontal.offset) + vertical.offset) / denominator;
  return { x, y: (horizontal.slope * x) + horizontal.offset };
}

function textureCoverage(image: CameraPixelImage): number {
  const step = Math.max(3, Math.floor(Math.min(image.width, image.height) / 180));
  let textured = 0;
  let samples = 0;
  for (let y = step; y < image.height - step; y += step) {
    for (let x = step; x < image.width - step; x += step) {
      const pixel = rgbAt(image, x, y);
      const neighbour = rgbAt(image, x + step, y);
      if ((Math.max(...pixel) - Math.min(...pixel)) > 25 || colorDistance(pixel, neighbour) > 28) textured += 1;
      samples += 1;
    }
  }
  return textured / Math.max(1, samples);
}

function estimateBlindAffineModel(samples: readonly Rgb[], profileId: FieldProfileId, phase: number): AffineChannelModel {
  const palette = FIELD_PROFILES[profileId].palette;
  const gains: number[] = [];
  const offsets: number[] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const observed = samples.map((sample) => sample[channel]);
    const nominal = palette.flatMap((_, state) => (
      Array.from({ length: 32 }, (__, index) => renderedFieldColor(profileId, state, index * 61 % FIELD_CELL_COUNT, phase)[channel])
    ));
    const observedLow = percentile(observed, 0.015);
    const observedHigh = percentile(observed, 0.985);
    const nominalLow = percentile(nominal, 0.015);
    const nominalHigh = percentile(nominal, 0.985);
    const gain = (observedHigh - observedLow) / Math.max(16, nominalHigh - nominalLow);
    gains.push(clampRange(gain, 0.35, 2.4));
    offsets.push(observedLow - (gains[channel] * nominalLow));
  }
  return { gains: gains as [number, number, number], offsets: offsets as [number, number, number] };
}

function estimateBasePaletteAffine(samples: readonly Rgb[], profileId: FieldProfileId): AffineChannelModel {
  const palette = FIELD_PROFILES[profileId].palette;
  const gains: number[] = [];
  const offsets: number[] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const observedLow = percentile(samples.map((sample) => sample[channel]), 0.02);
    const observedHigh = percentile(samples.map((sample) => sample[channel]), 0.98);
    const nominalLow = percentile(palette.map((color) => color[channel]), 0.02);
    const nominalHigh = percentile(palette.map((color) => color[channel]), 0.98);
    const gain = clampRange((observedHigh - observedLow) / Math.max(16, nominalHigh - nominalLow), 0.35, 2.4);
    gains.push(gain);
    offsets.push(observedLow - (gain * nominalLow));
  }
  return { gains: gains as [number, number, number], offsets: offsets as [number, number, number] };
}

function classifyField(
  samples: readonly Rgb[],
  profileId: FieldProfileId,
  phase: number,
  model: AffineChannelModel,
  erasureThreshold: number,
): ClassifiedField {
  const profile = FIELD_PROFILES[profileId];
  const states: Array<number | null> = [];
  const reliabilities: number[] = [];
  let totalConfidence = 0;
  let erasures = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const distances = profile.palette.map((_, state) => {
      const nominal = renderedFieldColor(profileId, state, index, phase);
      const expected = nominal.map((value, channel) => (value * model.gains[channel]) + model.offsets[channel]) as [number, number, number];
      return colorDistance(samples[index], expected);
    });
    const order = distances.map((distance, state) => ({ distance, state }))
      .sort((left, right) => left.distance - right.distance || left.state - right.state);
    const best = order[0];
    const second = order[1];
    const confidence = (second.distance - best.distance) / Math.max(6, second.distance);
    const reliability = Math.max(0, confidence) / (1 + (best.distance / 48));
    const erasure = confidence * 10 < erasureThreshold || best.distance > 82;
    states.push(erasure ? null : best.state);
    reliabilities.push(reliability);
    totalConfidence += confidence;
    if (erasure) erasures += 1;
  }
  return { states, reliabilities, meanConfidence: totalConfidence / samples.length, erasures };
}

function refineDecisionDirectedModel(
  samples: readonly Rgb[],
  classified: ClassifiedField,
  profileId: FieldProfileId,
  phase: number,
  fallback: AffineChannelModel,
): AffineChannelModel {
  const accepted = classified.reliabilities.map((reliability, index) => ({ reliability, index }))
    .filter(({ index }) => classified.states[index] !== null)
    .sort((left, right) => right.reliability - left.reliability)
    .slice(0, Math.max(180, Math.floor(FIELD_CELL_COUNT * 0.55)));
  if (accepted.length < 64) return fallback;
  const gains: number[] = [];
  const offsets: number[] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    for (const { index } of accepted) {
      const state = classified.states[index] as number;
      const x = renderedFieldColor(profileId, state, index, phase)[channel];
      const y = samples[index][channel];
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }
    const count = accepted.length;
    const denominator = (count * sumXX) - (sumX * sumX);
    if (Math.abs(denominator) < 1) {
      gains.push(fallback.gains[channel]);
      offsets.push(fallback.offsets[channel]);
      continue;
    }
    const gain = clampRange(((count * sumXY) - (sumX * sumY)) / denominator, 0.35, 2.4);
    gains.push(gain);
    offsets.push((sumY - (gain * sumX)) / count);
  }
  return { gains: gains as [number, number, number], offsets: offsets as [number, number, number] };
}

function uniqueProfiles(input: readonly FieldProfileId[]): FieldProfileId[] {
  const profiles = [...new Set(input)];
  if (profiles.length === 0) return ["C16", "C8", "C24", "C32"];
  for (const profile of profiles) if (!FIELD_PROFILES[profile]) throw new Error("unknown field profile");
  return profiles;
}

function observedCellPixels(points: readonly Point[]): number {
  const horizontal = (distance(points[0], points[1]) + distance(points[3], points[2])) / (2 * FIELD_COLUMNS);
  const vertical = (distance(points[0], points[3]) + distance(points[1], points[2])) / (2 * FIELD_ROWS);
  return Math.min(horizontal, vertical);
}

function dihedralPermutations(points: readonly Point[]): Point[][] {
  const result: Point[][] = [];
  for (let rotation = 0; rotation < 4; rotation += 1) {
    result.push(Array.from({ length: 4 }, (_, index) => points[(rotation + index) % 4]));
    result.push(Array.from({ length: 4 }, (_, index) => points[modulo(rotation - index, 4)]));
  }
  return result;
}

function scaleQuad(points: readonly Point[], scale: number): Point[] {
  const center = points.reduce<Point>((sum, point) => ({ x: sum.x + (point.x / 4), y: sum.y + (point.y / 4) }), { x: 0, y: 0 });
  return points.map((point) => ({ x: center.x + ((point.x - center.x) * scale), y: center.y + ((point.y - center.y) * scale) }));
}

function offsetCorner(points: readonly Point[], corner: number, delta: number): Point[] {
  const center = points.reduce<Point>((sum, point) => ({ x: sum.x + (point.x / 4), y: sum.y + (point.y / 4) }), { x: 0, y: 0 });
  return points.map((point, index) => index !== corner ? point : ({
    x: point.x + (point.x < center.x ? -delta : delta),
    y: point.y + (point.y < center.y ? -delta : delta),
  }));
}

function outerImageCorners(image: CameraPixelImage): readonly Point[] {
  return [
    { x: 0, y: 0 },
    { x: image.width - 1, y: 0 },
    { x: image.width - 1, y: image.height - 1 },
    { x: 0, y: image.height - 1 },
  ];
}

function pointsToLocation(points: readonly Point[]): NativeFieldLocation {
  return {
    topLeftCorner: points[0], topRightCorner: points[1],
    bottomRightCorner: points[2], bottomLeftCorner: points[3],
  };
}

function locationPoints(location: NativeFieldLocation): readonly Point[] {
  return [location.topLeftCorner, location.topRightCorner, location.bottomRightCorner, location.bottomLeftCorner];
}

function logicalCenter(index: number): Point {
  return { x: (index % FIELD_COLUMNS) + 0.5, y: Math.floor(index / FIELD_COLUMNS) + 0.5 };
}

function normalizedCornerCost(
  point: Point,
  minimumX: number,
  maximumX: number,
  minimumY: number,
  maximumY: number,
  corner: number,
): number {
  const x = (point.x - minimumX) / Math.max(1, maximumX - minimumX);
  const y = (point.y - minimumY) / Math.max(1, maximumY - minimumY);
  if (corner === 0) return x + y;
  if (corner === 1) return (1 - x) + y;
  if (corner === 2) return (1 - x) + (1 - y);
  return x + (1 - y);
}

function minimumBy<T>(values: readonly T[], score: (value: T) => number): T | null {
  let selected: T | null = null;
  let selectedScore = Infinity;
  for (const value of values) {
    const current = score(value);
    if (current < selectedScore) {
      selected = value;
      selectedScore = current;
    }
  }
  return selected;
}

function sampleRgb(image: CameraPixelImage, point: Point, radius: number): Rgb {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  const totals = [0, 0, 0];
  let count = 0;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const offset = ((y * image.width) + x) * 4;
      totals[0] += image.data[offset];
      totals[1] += image.data[offset + 1];
      totals[2] += image.data[offset + 2];
      count += 1;
    }
  }
  if (count === 0) throw new Error("distributed field sample is outside the camera image");
  return totals.map((value) => value / count) as [number, number, number];
}

function sampleRgbOrNull(image: CameraPixelImage, point: Point): Rgb | null {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  return x < 0 || y < 0 || x >= image.width || y >= image.height ? null : rgbAt(image, x, y);
}

function rgbAt(image: CameraPixelImage, x: number, y: number): Rgb {
  const offset = ((y * image.width) + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) throw new Error("cannot estimate percentile of an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)))];
}

function colorDistance(first: Rgb, second: Rgb): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampRange(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function validateImage(image: CameraPixelImage) {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error("camera image dimensions are invalid");
  }
  if (image.data.length !== image.width * image.height * 4) throw new Error("camera image must contain RGBA pixels");
}
