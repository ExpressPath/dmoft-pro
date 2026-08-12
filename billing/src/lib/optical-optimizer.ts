import {
  LAB_INNER_PARITY_BYTES,
  LAB_INNER_STRIPE_CODEWORD_BYTES,
  LAB_INNER_STRIPE_COUNT,
  LAB_ACTIVE_QUIET_MODULES,
  LAB_SYMBOL_MODULES,
  LAB_SOURCE_CHUNK_BYTES,
} from "./optical-lab";

const CANDIDATE_FPS = [4, 6, 8, 10] as const;
// Reusing a frozen homography is unsafe on a handheld receiver without optical flow.
const CANDIDATE_RELOCK_INTERVALS = [1] as const;

export type ChannelEstimate = Readonly<{
  cellErasureRate: number;
  frameDetectionRate: number;
  meanConfidence: number;
  geometryDetectionMs: number;
  chromaDecodeMs: number;
  motionRisk: number;
}>;

export type CapturePolicy = Readonly<{
  targetFps: typeof CANDIDATE_FPS[number];
  geometryRelockInterval: typeof CANDIDATE_RELOCK_INTERVALS[number];
  erasureThreshold: number;
  estimatedInnerSuccess: number;
  estimatedFrameAcceptance: number;
  verifiedBytesPerSecond: number;
  verifiedBytesPerAreaSecond: number;
}>;

/**
 * Maximizes expected verified payload density rather than raw modulation.
 *
 * eta(theta) = sourceBytes * effectiveFPS * P(accepted | theta) / symbolArea
 */
export function optimizeCapturePolicy(observationInput: ChannelEstimate): CapturePolicy {
  const observation = validateObservation(observationInput);
  const byteErasureRate = 1 - ((1 - observation.cellErasureRate) ** 2);
  const stripeSuccess = estimateMdsSuccessProbability(
    LAB_INNER_STRIPE_CODEWORD_BYTES,
    LAB_INNER_PARITY_BYTES,
    byteErasureRate,
  );
  const innerSuccess = stripeSuccess ** LAB_INNER_STRIPE_COUNT;
  const symbolSide = LAB_SYMBOL_MODULES + (2 * LAB_ACTIVE_QUIET_MODULES);
  const symbolArea = symbolSide ** 2;
  let selected: CapturePolicy | null = null;

  for (const targetFps of CANDIDATE_FPS) {
    for (const geometryRelockInterval of CANDIDATE_RELOCK_INTERVALS) {
      const meanProcessingMs = observation.chromaDecodeMs
        + (observation.geometryDetectionMs / geometryRelockInterval);
      const processingLimitedFps = 1000 / Math.max(1, meanProcessingMs);
      const effectiveFps = Math.min(targetFps, processingLimitedFps);
      const trackedFrameSurvival = geometryRelockInterval === 1
        ? 1
        : Math.exp(-observation.motionRisk * (geometryRelockInterval - 1));
      const geometryAcceptance = observation.frameDetectionRate * (
        (1 + ((geometryRelockInterval - 1) * trackedFrameSurvival))
        / geometryRelockInterval
      );
      const frameAcceptance = clamp01(geometryAcceptance * innerSuccess);
      const verifiedBytesPerSecond = LAB_SOURCE_CHUNK_BYTES * effectiveFps * frameAcceptance;
      const candidate: CapturePolicy = {
        targetFps,
        geometryRelockInterval,
        erasureThreshold: confidenceErasureThreshold(observation.meanConfidence),
        estimatedInnerSuccess: innerSuccess,
        estimatedFrameAcceptance: frameAcceptance,
        verifiedBytesPerSecond,
        verifiedBytesPerAreaSecond: verifiedBytesPerSecond / symbolArea,
      };
      if (
        !selected
        || candidate.verifiedBytesPerAreaSecond > selected.verifiedBytesPerAreaSecond
        || (
          candidate.verifiedBytesPerAreaSecond === selected.verifiedBytesPerAreaSecond
          && candidate.geometryRelockInterval < selected.geometryRelockInterval
        )
      ) selected = candidate;
    }
  }
  if (!selected) throw new Error("capture optimizer has no candidate policy");
  return selected;
}

/** Conservative probability that no more than parityBytes codeword octets are erased. */
export function estimateMdsSuccessProbability(
  codewordBytes: number,
  parityBytes: number,
  byteErasureRate: number,
): number {
  if (!Number.isInteger(codewordBytes) || codewordBytes <= 0) throw new Error("codeword length must be positive");
  if (!Number.isInteger(parityBytes) || parityBytes < 0 || parityBytes >= codewordBytes) {
    throw new Error("parity length must be inside the codeword");
  }
  if (!Number.isFinite(byteErasureRate) || byteErasureRate < 0 || byteErasureRate > 1) {
    throw new Error("byte erasure rate must be a probability");
  }
  if (byteErasureRate === 0) return 1;
  if (byteErasureRate === 1) return 0;
  const successProbability = 1 - byteErasureRate;
  let term = successProbability ** codewordBytes;
  let cumulative = term;
  for (let erasures = 0; erasures < parityBytes; erasures += 1) {
    term *= ((codewordBytes - erasures) / (erasures + 1))
      * (byteErasureRate / successProbability);
    cumulative += term;
  }
  return clamp01(cumulative);
}

function confidenceErasureThreshold(meanConfidence: number): number {
  if (meanConfidence >= 10) return 1.5;
  if (meanConfidence >= 5) return 2;
  if (meanConfidence >= 2.5) return 3;
  return 4;
}

function validateObservation(input: ChannelEstimate): ChannelEstimate {
  for (const [label, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  }
  if (input.cellErasureRate > 1 || input.frameDetectionRate > 1 || input.motionRisk > 1) {
    throw new Error("channel rates must be probabilities");
  }
  return input;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
