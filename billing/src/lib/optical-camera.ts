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
