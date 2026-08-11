import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

import {
  C8_QR_PALETTE,
  LAB_COLOR_CORE_RATIO,
  LAB_FRAME,
  buildLabObject,
  prepareDynamicFrame,
  type PreparedDynamicFrame,
  type Rgb,
} from "../src/lib/optical-lab";
import {
  OpticalDecodeError,
  acquireQr,
  decodeCameraImage,
  type QrLocation,
} from "../src/lib/optical-camera";

const ORIGIN = "https://example.test";
const SESSION = new Uint8Array([0x41, 0x52, 0x63, 0x74, 0x85, 0x96, 0xa7, 0xb8]);
const OBJECT = buildLabObject(SESSION);
const PREPARED = prepareDynamicFrame(SESSION, OBJECT.bytes, 5, ORIGIN);

describe("mobile optical receiver", () => {
  it("keeps the guarded color carrier decodable as an ordinary QR luminance plane", () => {
    const image = renderSyntheticCapture(PREPARED);
    const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });

    expect(qr?.data).toBe(`${ORIGIN}/o`);
  });

  it("recovers the QR control plane through the color-carrier projection when grayscale collapses", () => {
    const distortedPalette: readonly Rgb[] = [
      [0, 0, 0],
      [160, 0, 0],
      [0, 80, 0],
      [25, 25, 160],
      [255, 255, 255],
      [245, 245, 0],
      [0, 0, 245],
      [245, 0, 245],
    ];
    const image = renderSyntheticCapture(PREPARED, (color) => {
      const state = C8_QR_PALETTE.findIndex((candidate) => candidate.every((value, index) => value === color[index]));
      return state >= 0 ? distortedPalette[state] : color;
    });

    expect(jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })).toBeNull();
    const acquired = acquireQr(image);

    expect(acquired?.data).toBe(`${ORIGIN}/o`);
    expect(acquired?.mode).toMatch(/carrier$/);
  });

  it("finds a centered symbol inside a wider camera frame and maps its corners back", () => {
    const symbol = renderSyntheticCapture(PREPARED);
    const image = embedCentered(symbol, 1280, 720);
    const acquired = acquireQr(image);

    expect(acquired?.data).toBe(`${ORIGIN}/o`);
    expect(acquired?.location.topLeftCorner.x).toBeGreaterThan(300);
    expect(acquired?.location.bottomRightCorner.x).toBeLessThan(1000);
  });

  it("recovers the chroma frame after display/camera channel gain and offset", () => {
    const image = renderSyntheticCapture(PREPARED, ([red, green, blue]) => [
      clamp((red * 0.84) + 18),
      clamp((green * 0.91) + 9),
      clamp((blue * 0.78) + 22),
    ]);
    const decoded = decodeCameraImage(image, fullFrameLocation(), PREPARED.bootstrap, ORIGIN, 2);

    expect(decoded.decoded.frame.sessionHex).toBe(PREPARED.frame.sessionHex);
    expect(decoded.decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.observedModulePixels).toBeCloseTo(LAB_FRAME.modulePitch, 6);
    expect(decoded.erasures).toBeLessThanOrEqual(4);
  });

  it("reports insufficient optical resolution before attempting color FEC", () => {
    const image = renderSyntheticCapture(PREPARED);
    const tiny: QrLocation = {
      topLeftCorner: { x: 100, y: 100 },
      topRightCorner: { x: 210, y: 100 },
      bottomRightCorner: { x: 210, y: 210 },
      bottomLeftCorner: { x: 100, y: 210 },
    };

    expect(() => decodeCameraImage(image, tiny, PREPARED.bootstrap, ORIGIN)).toThrowError(
      expect.objectContaining<Partial<OpticalDecodeError>>({ stage: "geometry" }),
    );
  });
});

function renderSyntheticCapture(
  prepared: PreparedDynamicFrame,
  channel: (color: Rgb) => Rgb = (color) => color,
) {
  const data = new Uint8ClampedArray(LAB_FRAME.width * LAB_FRAME.height * 4);
  fillRect(data, LAB_FRAME.width, 0, 0, LAB_FRAME.width, LAB_FRAME.height, channel([255, 255, 255]));
  const coreSize = Math.max(1, Math.round(LAB_FRAME.modulePitch * LAB_COLOR_CORE_RATIO));
  const coreOffset = Math.floor((LAB_FRAME.modulePitch - coreSize) / 2);
  for (let row = 0; row < prepared.matrix.size; row += 1) {
    for (let column = 0; column < prepared.matrix.size; column += 1) {
      const index = (row * prepared.matrix.size) + column;
      const x = LAB_FRAME.qrX + (column * LAB_FRAME.modulePitch);
      const y = LAB_FRAME.qrY + (row * LAB_FRAME.modulePitch);
      const baseState = prepared.matrix.bits[index] === 1 ? 0 : 4;
      fillRect(data, LAB_FRAME.width, x, y, LAB_FRAME.modulePitch, LAB_FRAME.modulePitch, channel(C8_QR_PALETTE[baseState]));
      if (!prepared.matrix.reserved[index]) {
        fillRect(
          data,
          LAB_FRAME.width,
          x + coreOffset,
          y + coreOffset,
          coreSize,
          coreSize,
          channel(C8_QR_PALETTE[prepared.paletteStates[index]]),
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

function embedCentered(
  source: Readonly<{ data: Uint8ClampedArray; width: number; height: number }>,
  width: number,
  height: number,
) {
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

function fullFrameLocation(): QrLocation {
  return {
    topLeftCorner: { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY },
    topRightCorner: { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY },
    bottomRightCorner: { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
    bottomLeftCorner: { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
