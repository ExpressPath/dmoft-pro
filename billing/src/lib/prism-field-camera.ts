import { projectPoint, solveHomography } from "./optical-lab";
import type { CameraPixelImage } from "./optical-camera";
import {
  FIELD_CELL_COUNT,
  DEFAULT_FIELD_GEOMETRY_ID,
  FIELD_ERASURE_THRESHOLD,
  FIELD_GEOMETRIES,
  FIELD_PHASE_COUNT,
  FIELD_PROFILES,
  decodeNativeFieldSymbols,
  distributedPilotSign,
  fieldGeometry,
  renderedFieldColor,
  type FieldGeometryId,
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
  geometryId: FieldGeometryId;
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
export type NativeFieldFailureDiagnostics = Readonly<{
  geometryId: FieldGeometryId;
  profileId: FieldProfileId;
  confidence: number;
  erasures: number;
  observedCellPixels: number;
}>;

export class NativeFieldDecodeError extends Error {
  constructor(
    public readonly stage: NativeFieldDecodeStage,
    message: string,
    public readonly diagnostics: NativeFieldFailureDiagnostics | null = null,
  ) {
    super(message);
    this.name = "NativeFieldDecodeError";
  }
}

type OrientationCandidate = Readonly<{
  points: readonly Point[];
  geometryId: FieldGeometryId;
  phase: number;
  score: number;
  referenceProfileId: FieldProfileId;
}>;

type AffineChannelModel = Readonly<{
  matrix: readonly [Rgb, Rgb, Rgb];
  offsets: Rgb;
}>;

type ClassifiedField = Readonly<{
  states: Array<number | null>;
  reliabilities: number[];
  meanConfidence: number;
  erasures: number;
}>;

const UNIT_CORNERS: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
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
    geometryId: refined.geometryId,
    phase: refined.phase,
    mode: "distributed-pilot",
    pilotScore: refined.score,
    observedCellPixels: observedCellPixels(refined.points, refined.geometryId),
  };
}

export function trackNativeFieldPhase(
  image: CameraPixelImage,
  location: NativeFieldLocation,
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): NativeFieldAcquisition | null {
  validateImage(image);
  const points = locationPoints(location);
  let homography: readonly number[];
  try {
    homography = solveHomography(UNIT_CORNERS, points);
  } catch {
    return null;
  }
  const samples: Rgb[] = [];
  const indices: number[] = [];
  for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
    const sample = sampleRgbOrNull(image, projectPoint(homography, logicalCenter(index, geometryId)));
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
    geometryId,
    phase,
    mode: "distributed-pilot",
    pilotScore,
    observedCellPixels: observedCellPixels(points, geometryId),
  };
}

export function decodeNativeFieldImage(
  image: CameraPixelImage,
  acquisition: Pick<NativeFieldAcquisition, "location" | "phase" | "geometryId">,
  preferredProfiles: readonly FieldProfileId[] = ["C8", "C16", "C24", "C32"],
  erasureThreshold = FIELD_ERASURE_THRESHOLD,
): NativeFieldCameraDecode {
  const candidates: Array<Pick<NativeFieldAcquisition, "location" | "phase" | "geometryId">> = [acquisition];
  for (const geometryId of Object.keys(FIELD_GEOMETRIES) as FieldGeometryId[]) {
    if (geometryId === acquisition.geometryId) continue;
    const alternate = trackNativeFieldPhase(image, acquisition.location, geometryId);
    if (alternate) candidates.push(alternate);
  }
  let selectedError: NativeFieldDecodeError | null = null;
  for (const candidate of candidates) {
    try {
      return decodeNativeFieldImageCandidate(image, candidate, preferredProfiles, erasureThreshold);
    } catch (error) {
      if (!(error instanceof NativeFieldDecodeError)) throw error;
      if (
        !selectedError
        || (error.diagnostics?.erasures ?? Infinity) < (selectedError.diagnostics?.erasures ?? Infinity)
      ) selectedError = error;
    }
  }
  throw selectedError ?? new NativeFieldDecodeError("inner-fec", "no geometry candidate produced a valid field");
}

function decodeNativeFieldImageCandidate(
  image: CameraPixelImage,
  acquisition: Pick<NativeFieldAcquisition, "location" | "phase" | "geometryId">,
  preferredProfiles: readonly FieldProfileId[],
  erasureThreshold: number,
): NativeFieldCameraDecode {
  validateImage(image);
  const initialPoints = locationPoints(acquisition.location);
  const cellPixels = observedCellPixels(initialPoints, acquisition.geometryId);
  if (cellPixels < MIN_CELL_PIXELS) {
    throw new NativeFieldDecodeError(
      "geometry",
      `native field is too small (${cellPixels.toFixed(1)} px/cell; need at least ${MIN_CELL_PIXELS})`,
    );
  }
  let lastError: unknown = null;
  let bestFailure: NativeFieldFailureDiagnostics | null = null;
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
    const hypothesisCellPixels = observedCellPixels(points, acquisition.geometryId);
    const sampleRadius = hypothesisCellPixels >= 18 ? 2 : hypothesisCellPixels >= 8 ? 1 : 0;
    let homography: readonly number[];
    try {
      homography = solveHomography(UNIT_CORNERS, points);
    } catch (error) {
      lastError = error;
      continue;
    }
    let samples: Rgb[];
    try {
      samples = Array.from({ length: FIELD_CELL_COUNT }, (_, index) => sampleRgb(
        image,
        projectPoint(homography, logicalCenter(index, acquisition.geometryId)),
        sampleRadius,
      ));
    } catch (error) {
      lastError = error;
      continue;
    }
    const equalizerStrength = hypothesisCellPixels < 6 ? 0.12 : hypothesisCellPixels < 9 ? 0.06 : 0;
    if (equalizerStrength > 0) samples = equalizeTouchingCellSamples(samples, equalizerStrength, acquisition.geometryId);
    for (const profileId of uniqueProfiles(preferredProfiles)) {
      try {
        const model = estimateBlindAffineModel(samples, profileId, acquisition.phase);
        const first = classifyField(samples, profileId, acquisition.phase, model, erasureThreshold);
        const refinedModel = refineDecisionDirectedModel(samples, first, profileId, acquisition.phase, model);
        for (const candidateModel of [refinedModel, model]) {
          const classified = candidateModel === model
            ? first
            : classifyField(samples, profileId, acquisition.phase, candidateModel, erasureThreshold);
          const failure = {
            geometryId: acquisition.geometryId,
            profileId,
            confidence: classified.meanConfidence,
            erasures: classified.erasures,
            observedCellPixels: hypothesisCellPixels,
          } as const;
          if (!bestFailure || failure.erasures < bestFailure.erasures) bestFailure = failure;
          try {
            const decoded = decodeNativeFieldSymbols(
              classified.states,
              profileId,
              acquisition.phase,
              undefined,
              classified.reliabilities,
              acquisition.geometryId,
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
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new NativeFieldDecodeError(
    "inner-fec",
    lastError instanceof Error ? lastError.message : "no adaptive color profile produced a valid field",
    bestFailure,
  );
}

/** First-order inverse for nearest-neighbour optical leakage. */
export function equalizeTouchingCellSamples(
  samples: readonly Rgb[],
  strength: number,
  geometryId: FieldGeometryId = DEFAULT_FIELD_GEOMETRY_ID,
): Rgb[] {
  if (samples.length !== FIELD_CELL_COUNT) throw new Error("equalizer requires a complete field");
  if (!Number.isFinite(strength) || strength < 0 || strength > 0.35) throw new Error("equalizer strength is invalid");
  return samples.map((sample, index) => {
    const neighbours = fieldGeometry(geometryId).cells[index].neighbours.map((neighbour) => samples[neighbour]);
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
      for (const geometryId of Object.keys(FIELD_GEOMETRIES) as FieldGeometryId[]) {
        let homography: readonly number[];
        try {
          homography = solveHomography(UNIT_CORNERS, scaled);
        } catch {
          continue;
        }
        const samples: Rgb[] = [];
        const indices: number[] = [];
        for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
          const point = projectPoint(homography, logicalCenter(index, geometryId));
          const sample = sampleRgbOrNull(image, point);
          if (!sample) continue;
          samples.push(sample);
          indices.push(index);
        }
        if (samples.length < FIELD_CELL_COUNT / 5) continue;
        const residuals = payloadRemovedResiduals(samples, "C16");
        let candidate: OrientationCandidate = {
          points: scaled,
          geometryId,
          phase: 0,
          score: -Infinity,
          referenceProfileId: "C16",
        };
        for (let phase = 0; phase < FIELD_PHASE_COUNT; phase += 1) {
          const score = normalizedPilotCorrelation(residuals, indices, phase);
          if (score > candidate.score) candidate = { ...candidate, phase, score };
        }
        coarseCandidates.push(candidate);
      }
    }
  }
  let best: OrientationCandidate | null = null;
  for (const coarseCandidate of coarseCandidates.sort((left, right) => right.score - left.score).slice(0, 24)) {
    let homography: readonly number[];
    try {
      homography = solveHomography(UNIT_CORNERS, coarseCandidate.points);
    } catch {
      continue;
    }
    const samples: Rgb[] = [];
    const indices: number[] = [];
    for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
      const sample = sampleRgbOrNull(image, projectPoint(homography, logicalCenter(index, coarseCandidate.geometryId)));
      if (!sample) continue;
      samples.push(sample);
      indices.push(index);
    }
    for (const profileId of ["C8", "C16", "C24", "C32"] as const) {
      const residuals = payloadRemovedResiduals(samples, profileId);
      for (let phase = 0; phase < FIELD_PHASE_COUNT; phase += 1) {
        const score = normalizedPilotCorrelation(residuals, indices, phase);
        if (!best || score > best.score) best = {
          points: coarseCandidate.points,
          geometryId: coarseCandidate.geometryId,
          phase,
          score,
          referenceProfileId: profileId,
        };
      }
    }
  }
  return best;
}

function refineDistributedGeometry(image: CameraPixelImage, candidate: OrientationCandidate): OrientationCandidate {
  if (candidate.points.some((point) => (
    point.x < 1 || point.y < 1 || point.x > image.width - 2 || point.y > image.height - 2
  ))) return candidate;
  let best = candidate;
  const pitch = observedCellPixels(candidate.points, candidate.geometryId);
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
          homography = solveHomography(UNIT_CORNERS, points);
        } catch {
          continue;
        }
        const samples: Rgb[] = [];
        const indices: number[] = [];
        for (let index = 0; index < FIELD_CELL_COUNT; index += PILOT_SAMPLE_STRIDE) {
          const sample = sampleRgbOrNull(image, projectPoint(homography, logicalCenter(index, best.geometryId)));
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
      const predicted = predictColor(model, base);
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
  if (fieldEvidenceTouchesAllImageEdges(evidence, image, step)) return outerImageCorners(image);
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
  return scaleQuad([topLeft, topRight, bottomRight, bottomLeft], 1.02);
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

function fieldEvidenceTouchesAllImageEdges(
  evidence: readonly Point[],
  image: CameraPixelImage,
  step: number,
): boolean {
  const margin = step * 2.5;
  const minimumSupport = Math.max(5, Math.floor(Math.min(image.width, image.height) / Math.max(1, step * 90)));
  return evidence.filter((point) => point.x <= margin).length >= minimumSupport
    && evidence.filter((point) => point.x >= image.width - 1 - margin).length >= minimumSupport
    && evidence.filter((point) => point.y <= margin).length >= minimumSupport
    && evidence.filter((point) => point.y >= image.height - 1 - margin).length >= minimumSupport;
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
  return diagonalAffineModel(gains as [number, number, number], offsets as [number, number, number]);
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
  return diagonalAffineModel(gains as [number, number, number], offsets as [number, number, number]);
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
      const expected = predictColor(model, nominal);
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
  const design = accepted.map(({ index }) => {
    const state = classified.states[index] as number;
    const nominal = renderedFieldColor(profileId, state, index, phase);
    return {
      index,
      features: [nominal[0] / 255, nominal[1] / 255, nominal[2] / 255, 1] as const,
    };
  });
  const rows: Rgb[] = [];
  const offsets: number[] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    const normal = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => 0));
    const target = Array.from({ length: 4 }, () => 0);
    for (const { index, features } of design) {
      for (let row = 0; row < 4; row += 1) {
        target[row] += features[row] * samples[index][channel];
        for (let column = 0; column < 4; column += 1) normal[row][column] += features[row] * features[column];
      }
    }
    for (let diagonal = 0; diagonal < 3; diagonal += 1) normal[diagonal][diagonal] += 0.015;
    const solved = solveLinearSystem(normal, target);
    if (!solved || solved.some((value) => !Number.isFinite(value))) return fallback;
    rows.push([
      clampRange(solved[0] / 255, -0.8, 2.4),
      clampRange(solved[1] / 255, -0.8, 2.4),
      clampRange(solved[2] / 255, -0.8, 2.4),
    ]);
    offsets.push(clampRange(solved[3], -128, 192));
  }
  return { matrix: rows as [[number, number, number], [number, number, number], [number, number, number]], offsets: offsets as [number, number, number] };
}

function uniqueProfiles(input: readonly FieldProfileId[]): FieldProfileId[] {
  const profiles = [...new Set(input)];
  if (profiles.length === 0) return ["C8", "C16", "C24", "C32"];
  for (const profile of profiles) if (!FIELD_PROFILES[profile]) throw new Error("unknown field profile");
  return profiles;
}

function diagonalAffineModel(gains: Rgb, offsets: Rgb): AffineChannelModel {
  return {
    matrix: [
      [gains[0], 0, 0],
      [0, gains[1], 0],
      [0, 0, gains[2]],
    ],
    offsets,
  };
}

function predictColor(model: AffineChannelModel, nominal: Rgb): Rgb {
  return model.matrix.map((row, channel) => (
    (row[0] * nominal[0])
    + (row[1] * nominal[1])
    + (row[2] * nominal[2])
    + model.offsets[channel]
  )) as [number, number, number];
}

function solveLinearSystem(matrixInput: readonly (readonly number[])[], vectorInput: readonly number[]): number[] | null {
  const size = vectorInput.length;
  if (matrixInput.length !== size || matrixInput.some((row) => row.length !== size)) return null;
  const augmented = matrixInput.map((row, index) => [...row, vectorInput[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let selected = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[selected][pivot])) selected = row;
    }
    if (Math.abs(augmented[selected][pivot]) < 1e-9) return null;
    [augmented[pivot], augmented[selected]] = [augmented[selected], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) augmented[row][column] -= factor * augmented[pivot][column];
    }
  }
  return augmented.map((row) => row[size]);
}

function observedCellPixels(points: readonly Point[], geometryId: FieldGeometryId): number {
  let homography: readonly number[];
  try {
    homography = solveHomography(UNIT_CORNERS, points);
  } catch {
    return 0;
  }
  const geometry = fieldGeometry(geometryId);
  let minimum = Infinity;
  for (let index = 0; index < FIELD_CELL_COUNT; index += 97) {
    const cell = geometry.cells[index];
    const center = projectPoint(homography, cell.center);
    for (const neighbour of cell.neighbours.slice(0, 3)) {
      minimum = Math.min(minimum, distance(center, projectPoint(homography, geometry.cells[neighbour].center)));
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
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

function pointsToLocation(points: readonly Point[]): NativeFieldLocation {
  return {
    topLeftCorner: points[0], topRightCorner: points[1],
    bottomRightCorner: points[2], bottomLeftCorner: points[3],
  };
}

function locationPoints(location: NativeFieldLocation): readonly Point[] {
  return [location.topLeftCorner, location.topRightCorner, location.bottomRightCorner, location.bottomLeftCorner];
}

function outerImageCorners(image: CameraPixelImage): readonly Point[] {
  return [
    { x: 0, y: 0 },
    { x: image.width - 1, y: 0 },
    { x: image.width - 1, y: image.height - 1 },
    { x: 0, y: image.height - 1 },
  ];
}

function logicalCenter(index: number, geometryId: FieldGeometryId): Point {
  return fieldGeometry(geometryId).cells[index].center;
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
