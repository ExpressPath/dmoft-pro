import jsQR from "jsqr";

import {
  LAB_CHROMA_RADIX,
  LAB_ERASURE_THRESHOLD,
  LAB_FRAME,
  LAB_PALETTE_SIZE,
  LAB_QR_MODULES,
  classifyColor,
  createIntegratedQrMatrix,
  decodeIntegratedPaletteSymbols,
  estimatePalette,
  localizePalette,
  moduleCenter,
  parseBootstrapUrl,
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

export type QrLocation = Readonly<{
  topLeftCorner: Point;
  topRightCorner: Point;
  bottomRightCorner: Point;
  bottomLeftCorner: Point;
}>;

export type QrAcquisitionMode = "center-raw" | "center-carrier" | "full-raw" | "full-carrier";

export type QrAcquisition = Readonly<{
  data: string;
  location: QrLocation;
  mode: QrAcquisitionMode;
}>;

export type OpticalDecodeStage = "geometry" | "bootstrap" | "calibration" | "sampling" | "inner-fec";

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

const QR_SOURCE_CORNERS: readonly Point[] = [
  { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY },
  { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY },
  { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
  { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
];

const CENTER_SEARCH_RATIO = 0.96;

/**
 * Locates and decodes the monochrome QR control plane without assuming that
 * camera RGB values preserve the display's grayscale luminance. The centered
 * attempts match the on-screen camera guide and reduce both search noise and
 * latency. The max-channel carrier projection is a fallback for saturated
 * chroma states whose ordinary grayscale values cross a QR threshold.
 */
export function acquireQr(image: CameraPixelImage): QrAcquisition | null {
  validateImage(image);
  const center = centeredSquare(image, CENTER_SEARCH_RATIO);
  const attempts: ReadonlyArray<Readonly<{
    source: CameraPixelImage;
    carrier: boolean;
    offsetX: number;
    offsetY: number;
    mode: QrAcquisitionMode;
  }>> = [
    {
      source: center.image,
      carrier: false,
      offsetX: center.offsetX,
      offsetY: center.offsetY,
      mode: "center-raw",
    },
    {
      source: center.image,
      carrier: true,
      offsetX: center.offsetX,
      offsetY: center.offsetY,
      mode: "center-carrier",
    },
    { source: image, carrier: false, offsetX: 0, offsetY: 0, mode: "full-raw" },
    { source: image, carrier: true, offsetX: 0, offsetY: 0, mode: "full-carrier" },
  ];

  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = `${attempt.source.width}:${attempt.source.height}:${attempt.carrier ? "carrier" : "raw"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const attemptImage = attempt.carrier ? projectColorCarrier(attempt.source) : attempt.source;
    const pixels = attemptImage.data instanceof Uint8ClampedArray
      ? attemptImage.data
      : Uint8ClampedArray.from(attemptImage.data);
    const qr = jsQR(pixels, attemptImage.width, attemptImage.height, {
      inversionAttempts: "dontInvert",
    });
    if (!qr) continue;
    return {
      data: qr.data,
      location: offsetLocation(qr.location as QrLocation, attempt.offsetX, attempt.offsetY),
      mode: attempt.mode,
    };
  }
  return null;
}

export function decodeCameraImage(
  image: CameraPixelImage,
  location: QrLocation,
  bootstrap: string,
  expectedOrigin: string,
  erasureThreshold = LAB_ERASURE_THRESHOLD,
): DecodedCameraFrame {
  validateImage(image);
  let matrix;
  try {
    parseBootstrapUrl(bootstrap, expectedOrigin);
    matrix = createIntegratedQrMatrix(bootstrap);
  } catch (error) {
    throw staged("bootstrap", error);
  }

  const destination = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
  const sideLengths = destination.map((corner, index) => distance(corner, destination[(index + 1) % 4]));
  const minimumSide = Math.min(...sideLengths);
  const maximumSide = Math.max(...sideLengths);
  const observedModulePixels = minimumSide / LAB_QR_MODULES;
  if (observedModulePixels < 3.5) {
    throw new OpticalDecodeError(
      "geometry",
      `code is too small (${observedModulePixels.toFixed(1)} px/module; need at least 3.5)`,
    );
  }
  if (maximumSide / Math.max(1, minimumSide) > 2.2) {
    throw new OpticalDecodeError("geometry", "viewing angle is too steep for reliable module sampling");
  }

  let homography: readonly number[];
  try {
    homography = solveHomography(QR_SOURCE_CORNERS, destination);
  } catch (error) {
    throw staged("geometry", error);
  }
  const sampleRadius = Math.max(1, Math.min(5, Math.floor(observedModulePixels * 0.16)));

  const globalSamples: Rgb[][] = Array.from({ length: LAB_PALETTE_SIZE }, () => []);
  const tileSamples = new Map<string, Map<number, Rgb>>();
  try {
    for (const pilot of matrix.pilots) {
      const observed = sampleRgb(image, projectPoint(homography, moduleCenter(pilot)), sampleRadius);
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
    if (!samples.has(0) || !samples.has(LAB_CHROMA_RADIX)) continue;
    try {
      localModels.set(key, localizePalette(
        globalPalette,
        [samples.get(0) as Rgb, samples.get(LAB_CHROMA_RADIX) as Rgb],
      ));
    } catch {
      // A damaged local anchor falls back to the spatially distributed global model.
    }
  }

  const observedStates: Array<number | null> = [];
  const confidences: number[] = [];
  const reliabilities: number[] = [];
  let erasures = 0;
  try {
    for (const cell of matrix.payloadCells) {
      const model = localModels.get(tileKey(cell.tileRow, cell.tileColumn)) ?? globalPalette;
      const expectedDark = matrix.bits[cell.index] === 1;
      const classified = classifyColor(
        sampleRgb(image, projectPoint(homography, moduleCenter(cell)), sampleRadius),
        model,
        erasureThreshold,
        expectedDark,
      );
      const erasure = classified.erasure;
      confidences.push(classified.confidence);
      reliabilities.push(classified.confidence / (1 + classified.bestDistance));
      if (erasure) erasures += 1;
      observedStates.push(erasure ? null : classified.symbol);
    }
  } catch (error) {
    throw staged("sampling", error);
  }

  try {
    const decoded = decodeIntegratedPaletteSymbols(observedStates, matrix, undefined, reliabilities);
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

function sampleRgb(image: CameraPixelImage, point: Point, radius: number): Rgb {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  if (
    centerX - radius < 0
    || centerY - radius < 0
    || centerX + radius >= image.width
    || centerY + radius >= image.height
  ) throw new Error("the full QR symbol must remain inside the camera frame");
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

function centeredSquare(image: CameraPixelImage, ratio: number): Readonly<{
  image: CameraPixelImage;
  offsetX: number;
  offsetY: number;
}> {
  const size = Math.max(1, Math.floor(Math.min(image.width, image.height) * ratio));
  if (size === image.width && size === image.height) return { image, offsetX: 0, offsetY: 0 };
  const offsetX = Math.floor((image.width - size) / 2);
  const offsetY = Math.floor((image.height - size) / 2);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const sourceStart = (((offsetY + y) * image.width) + offsetX) * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + (size * 4)), y * size * 4);
  }
  return { image: { data, width: size, height: size }, offsetX, offsetY };
}

function projectColorCarrier(image: CameraPixelImage): CameraPixelImage {
  const data = new Uint8ClampedArray(image.data.length);
  const channelCeilings = estimateChannelCeilings(image);
  const carrierValues = new Uint8Array(image.width * image.height);
  const histogram = new Uint32Array(256);
  let pixel = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const carrier = Math.max(
      image.data[offset] / channelCeilings[0],
      image.data[offset + 1] / channelCeilings[1],
      image.data[offset + 2] / channelCeilings[2],
    );
    const value = Math.max(0, Math.min(255, Math.round(carrier * 255)));
    carrierValues[pixel] = value;
    histogram[value] += 1;
    pixel += 1;
  }
  // The profile constrains dark chroma peaks to <= 0.76 and light chroma
  // peaks to >= 0.88 after per-channel normalization. Clamp Otsu inside that
  // intentional guard band so black finder mass cannot pull the split to zero.
  const threshold = Math.max(196, Math.min(220, otsuThreshold(histogram, carrierValues.length)));
  for (let index = 0; index < carrierValues.length; index += 1) {
    const offset = index * 4;
    const value = carrierValues[index] <= threshold ? 0 : 255;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { data, width: image.width, height: image.height };
}

function otsuThreshold(histogram: Uint32Array, total: number): number {
  let weightedTotal = 0;
  for (let value = 0; value < histogram.length; value += 1) weightedTotal += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundWeighted = 0;
  let bestVariance = -1;
  let bestThreshold = 127;
  for (let threshold = 0; threshold < histogram.length - 1; threshold += 1) {
    backgroundWeight += histogram[threshold];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
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
  return bestThreshold;
}

function estimateChannelCeilings(image: CameraPixelImage): Rgb {
  const histograms = Array.from({ length: 3 }, () => new Uint32Array(256));
  for (let offset = 0; offset < image.data.length; offset += 4) {
    histograms[0][image.data[offset]] += 1;
    histograms[1][image.data[offset + 1]] += 1;
    histograms[2][image.data[offset + 2]] += 1;
  }
  const target = Math.max(1, Math.ceil(image.width * image.height * 0.98));
  return histograms.map((histogram) => {
    let cumulative = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) return Math.max(32, value);
    }
    return 255;
  }) as [number, number, number];
}

function offsetLocation(location: QrLocation, offsetX: number, offsetY: number): QrLocation {
  const offset = (point: Point): Point => ({ x: point.x + offsetX, y: point.y + offsetY });
  return {
    topLeftCorner: offset(location.topLeftCorner),
    topRightCorner: offset(location.topRightCorner),
    bottomRightCorner: offset(location.bottomRightCorner),
    bottomLeftCorner: offset(location.bottomLeftCorner),
  };
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

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
