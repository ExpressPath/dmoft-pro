import { describe, expect, it } from "vitest";

import {
  C16_PRISM_PALETTE,
  LAB_COLOR_CORE_RATIO,
  LAB_FRAME,
  PRISM_FINDER_CENTERS,
  buildLabObject,
  prepareDynamicFrame,
  projectPoint,
  solveHomography,
  type Point,
  type PreparedDynamicFrame,
  type Rgb,
} from "../src/lib/optical-lab";
import {
  OpticalDecodeError,
  decodeCameraImage,
  locatePrismSymbol,
  type CameraPixelImage,
  type QrLocation,
} from "../src/lib/optical-camera";

const SESSION = new Uint8Array([0x41, 0x52, 0x63, 0x74, 0x85, 0x96, 0xa7, 0xb8]);
const OBJECT = buildLabObject(SESSION);
const PREPARED = prepareDynamicFrame(SESSION, OBJECT.bytes, 5);

describe("custom mobile optical receiver", () => {
  it("locates all four monochrome finders and decodes the sixteen-color frame", () => {
    const image = renderSyntheticCapture(PREPARED);
    const acquired = locatePrismSymbol(image);

    expect(acquired?.mode).toBe("custom-four-finder");
    expect(acquired?.orientationScore).toBeGreaterThan(0.9);
    const decoded = decodeCameraImage(image, acquired!.location);
    expect(decoded.decoded.frame.sessionHex).toBe(PREPARED.frame.sessionHex);
    expect(decoded.decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.erasures).toBe(0);
  });

  it("finds a centered symbol inside a wider camera frame", () => {
    const symbol = renderSyntheticCapture(PREPARED);
    const image = embedCentered(symbol, 1_280, 800);
    const acquired = locatePrismSymbol(image);

    expect(acquired).not.toBeNull();
    expect(acquired!.location.topLeftCorner.x).toBeGreaterThan(300);
    expect(acquired!.location.bottomRightCorner.x).toBeLessThan(1_000);
    expect(decodeCameraImage(image, acquired!.location).decoded.frame.sequence).toBe(5);
  });

  it("orients and decodes the same custom symbol after a ninety-degree camera rotation", () => {
    const rotated = rotateClockwise(renderSyntheticCapture(PREPARED));
    const acquired = locatePrismSymbol(rotated);

    expect(acquired).not.toBeNull();
    expect(decodeCameraImage(rotated, acquired!.location).decoded.frame.sequence).toBe(5);
  });

  it("orients a mirrored capture without relying on a standard QR decoder", () => {
    const mirrored = mirrorHorizontal(renderSyntheticCapture(PREPARED));
    const acquired = locatePrismSymbol(mirrored);

    expect(acquired).not.toBeNull();
    expect(decodeCameraImage(mirrored, acquired!.location).decoded.frame.sequence).toBe(5);
  });

  it("recovers four-finder geometry through a perspective camera warp", () => {
    const warped = warpPerspective(
      renderSyntheticCapture(PREPARED),
      [
        { x: 105, y: 70 },
        { x: 785, y: 125 },
        { x: 735, y: 710 },
        { x: 145, y: 665 },
      ],
      900,
      780,
    );
    const acquired = locatePrismSymbol(warped);

    expect(acquired).not.toBeNull();
    expect(acquired!.orientationScore).toBeGreaterThan(0.8);
    expect(decodeCameraImage(warped, acquired!.location).decoded.frame.sequence).toBe(5);
  });

  it("recovers after per-channel display/camera gain and offset", () => {
    const image = renderSyntheticCapture(PREPARED, ([red, green, blue]) => [
      clamp((red * 0.84) + 18),
      clamp((green * 0.91) + 9),
      clamp((blue * 0.78) + 22),
    ]);
    const decoded = decodeCameraImage(image, fullFrameLocation());

    expect(decoded.decoded.frame.sessionHex).toBe(PREPARED.frame.sessionHex);
    expect(decoded.decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.observedModulePixels).toBeCloseTo(LAB_FRAME.modulePitch, 6);
    expect(decoded.erasures).toBeLessThanOrEqual(4);
  });

  it("keeps acquisition and color decoding stable under mild optical blur", () => {
    const blurred = boxBlur(renderSyntheticCapture(PREPARED), 1);
    const acquired = locatePrismSymbol(blurred);

    expect(acquired).not.toBeNull();
    expect(decodeCameraImage(blurred, acquired!.location).decoded.frame.sequence).toBe(5);
  });

  it("reports insufficient optical resolution before attempting color FEC", () => {
    const image = renderSyntheticCapture(PREPARED);
    const tiny: QrLocation = {
      topLeftCorner: { x: 100, y: 100 },
      topRightCorner: { x: 210, y: 100 },
      bottomRightCorner: { x: 210, y: 210 },
      bottomLeftCorner: { x: 100, y: 210 },
    };

    expect(() => decodeCameraImage(image, tiny)).toThrowError(
      expect.objectContaining<Partial<OpticalDecodeError>>({ stage: "geometry" }),
    );
  });
});

function renderSyntheticCapture(
  prepared: PreparedDynamicFrame,
  channel: (color: Rgb) => Rgb = (color) => color,
): CameraPixelImage {
  const data = new Uint8ClampedArray(LAB_FRAME.width * LAB_FRAME.height * 4);
  fillRect(data, LAB_FRAME.width, 0, 0, LAB_FRAME.width, LAB_FRAME.height, channel([255, 255, 255]));
  const coreSize = Math.max(1, Math.round(LAB_FRAME.modulePitch * LAB_COLOR_CORE_RATIO));
  const coreOffset = Math.floor((LAB_FRAME.modulePitch - coreSize) / 2);
  for (let row = 0; row < prepared.matrix.size; row += 1) {
    for (let column = 0; column < prepared.matrix.size; column += 1) {
      const index = (row * prepared.matrix.size) + column;
      const x = LAB_FRAME.symbolX + (column * LAB_FRAME.modulePitch);
      const y = LAB_FRAME.symbolY + (row * LAB_FRAME.modulePitch);
      const state = prepared.paletteStates[index];
      const base = prepared.matrix.reserved[index] ? C16_PRISM_PALETTE[state] : [205, 205, 205] as Rgb;
      fillRect(data, LAB_FRAME.width, x, y, LAB_FRAME.modulePitch, LAB_FRAME.modulePitch, channel(base));
      if (!prepared.matrix.reserved[index]) {
        fillRect(
          data,
          LAB_FRAME.width,
          x + coreOffset,
          y + coreOffset,
          coreSize,
          coreSize,
          channel(C16_PRISM_PALETTE[state]),
        );
      }
    }
  }
  return { data, width: LAB_FRAME.width, height: LAB_FRAME.height };
}

function fillRect(
  data: Uint8ClampedArray,
  imageWidth: number,
  left: number,
  top: number,
  width: number,
  height: number,
  color: Rgb,
) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const offset = ((y * imageWidth) + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
}

function embedCentered(source: CameraPixelImage, width: number, height: number): CameraPixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 0, 0, width, height, [36, 42, 48]);
  const offsetX = Math.floor((width - source.width) / 2);
  const offsetY = Math.floor((height - source.height) / 2);
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const destinationStart = (((offsetY + y) * width) + offsetX) * 4;
    data.set(source.data.subarray(sourceStart, sourceStart + (source.width * 4)), destinationStart);
  }
  return { data, width, height };
}

function rotateClockwise(source: CameraPixelImage): CameraPixelImage {
  const width = source.height;
  const height = source.width;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = ((y * source.width) + x) * 4;
      const destinationX = source.height - 1 - y;
      const destinationY = x;
      data.set(source.data.subarray(sourceOffset, sourceOffset + 4), ((destinationY * width) + destinationX) * 4);
    }
  }
  return { data, width, height };
}

function mirrorHorizontal(source: CameraPixelImage): CameraPixelImage {
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = ((y * source.width) + x) * 4;
      const destinationOffset = ((y * source.width) + (source.width - 1 - x)) * 4;
      data.set(source.data.subarray(sourceOffset, sourceOffset + 4), destinationOffset);
    }
  }
  return { data, width: source.width, height: source.height };
}

function boxBlur(source: CameraPixelImage, radius: number): CameraPixelImage {
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const totals = [0, 0, 0];
      let samples = 0;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
          const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
          const sourceOffset = ((sampleY * source.width) + sampleX) * 4;
          totals[0] += source.data[sourceOffset];
          totals[1] += source.data[sourceOffset + 1];
          totals[2] += source.data[sourceOffset + 2];
          samples += 1;
        }
      }
      const destinationOffset = ((y * source.width) + x) * 4;
      data[destinationOffset] = Math.round(totals[0] / samples);
      data[destinationOffset + 1] = Math.round(totals[1] / samples);
      data[destinationOffset + 2] = Math.round(totals[2] / samples);
      data[destinationOffset + 3] = 255;
    }
  }
  return { data, width: source.width, height: source.height };
}

function warpPerspective(
  source: CameraPixelImage,
  destinationCorners: readonly Point[],
  width: number,
  height: number,
): CameraPixelImage {
  const sourceCorners = [
    { x: 0, y: 0 },
    { x: source.width - 1, y: 0 },
    { x: source.width - 1, y: source.height - 1 },
    { x: 0, y: source.height - 1 },
  ];
  const destinationToSource = solveHomography(destinationCorners, sourceCorners);
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 0, 0, width, height, [32, 37, 43]);
  const minimumX = Math.max(0, Math.floor(Math.min(...destinationCorners.map((point) => point.x))));
  const maximumX = Math.min(width - 1, Math.ceil(Math.max(...destinationCorners.map((point) => point.x))));
  const minimumY = Math.max(0, Math.floor(Math.min(...destinationCorners.map((point) => point.y))));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(...destinationCorners.map((point) => point.y))));
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const sourcePoint = projectPoint(destinationToSource, { x, y });
      const sourceX = Math.round(sourcePoint.x);
      const sourceY = Math.round(sourcePoint.y);
      if (sourceX < 0 || sourceY < 0 || sourceX >= source.width || sourceY >= source.height) continue;
      const sourceOffset = ((sourceY * source.width) + sourceX) * 4;
      data.set(source.data.subarray(sourceOffset, sourceOffset + 4), ((y * width) + x) * 4);
    }
  }
  return { data, width, height };
}

function fullFrameLocation(): QrLocation {
  const finderCenter = (coordinate: number) => LAB_FRAME.symbolX + (coordinate * LAB_FRAME.modulePitch);
  return {
    topLeftCorner: { x: finderCenter(PRISM_FINDER_CENTERS[0].x), y: finderCenter(PRISM_FINDER_CENTERS[0].y) },
    topRightCorner: { x: finderCenter(PRISM_FINDER_CENTERS[1].x), y: finderCenter(PRISM_FINDER_CENTERS[1].y) },
    bottomRightCorner: { x: finderCenter(PRISM_FINDER_CENTERS[2].x), y: finderCenter(PRISM_FINDER_CENTERS[2].y) },
    bottomLeftCorner: { x: finderCenter(PRISM_FINDER_CENTERS[3].x), y: finderCenter(PRISM_FINDER_CENTERS[3].y) },
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
