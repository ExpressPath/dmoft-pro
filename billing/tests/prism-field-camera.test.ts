import { describe, expect, it } from "vitest";

import {
  FIELD_CELL_COUNT,
  FIELD_FRAME,
  FIELD_PROFILES,
  buildNativeLabObject,
  prepareNativeFieldFrame,
  type PreparedNativeFieldFrame,
  type Rgb,
  type FieldProfileId,
  type Point,
} from "../src/lib/prism-field";
import {
  decodeNativeFieldImage,
  locateNativeField,
} from "../src/lib/prism-field-camera";
import type { CameraPixelImage } from "../src/lib/optical-camera";
import { projectPoint, solveHomography } from "../src/lib/optical-lab";

const SESSION = new Uint8Array([0x11, 0x24, 0x37, 0x4a, 0x5d, 0x60, 0x73, 0x86]);
const OBJECT = buildNativeLabObject(SESSION, "C16");
const PACKET = Uint8Array.from({ length: FIELD_PROFILES.C16.raptorPacketBytes }, (_, index) => (index * 97 + 31) & 0xff);
const PREPARED = prepareNativeFieldFrame(SESSION, OBJECT.bytes, 21, PACKET, "C16");

describe("distributed-pilot native camera receiver", () => {
  it("acquires phase without any finder, timing, or calibration cells", () => {
    const image = renderNativeField(PREPARED);
    const acquisition = locateNativeField(image);

    expect(acquisition?.mode).toBe("distributed-pilot");
    expect(acquisition?.phase).toBe(PREPARED.frame.phase);
    expect(acquisition?.pilotScore).toBeGreaterThan(0.04);
  });

  it("blind-calibrates and decodes all 2,040 touching cells", () => {
    const image = renderNativeField(PREPARED);
    const acquisition = locateNativeField(image)!;
    const decoded = decodeNativeFieldImage(image, acquisition);

    expect(decoded.decoded.frame.sessionHex).toBe(PREPARED.frame.sessionHex);
    expect(decoded.decoded.frame.sequence).toBe(PREPARED.frame.sequence);
    expect(decoded.decoded.frame.raptorPacket).toEqual(PACKET);
    expect(decoded.erasures).toBeLessThan(FIELD_CELL_COUNT * 0.02);
  });

  it("recovers after display/camera channel gain and offset", () => {
    const image = renderNativeField(PREPARED, ([red, green, blue]) => [
      clamp((red * 0.76) + 27),
      clamp((green * 0.88) + 13),
      clamp((blue * 0.69) + 35),
    ]);
    const acquisition = locateNativeField(image)!;
    const decoded = decodeNativeFieldImage(image, acquisition);

    expect(decoded.decoded.frame.sequence).toBe(21);
    expect(decoded.profileId).toBe("C16");
  });

  it("locates the field inside a wider camera image", () => {
    const embedded = embedCentered(renderNativeField(PREPARED), 1_280, 800);
    const acquisition = locateNativeField(embedded);

    expect(acquisition).not.toBeNull();
    expect(acquisition!.location.topLeftCorner.x).toBeGreaterThan(100);
    expect(decodeNativeFieldImage(embedded, acquisition!).decoded.frame.sequence).toBe(21);
  });

  it.each(["C8", "C16", "C24", "C32"] as const)("blind-decodes the %s constellation", (profileId) => {
    const prepared = preparedForProfile(profileId, 12);
    const image = renderNativeField(prepared);
    const acquisition = locateNativeField(image);
    expect(acquisition?.phase).toBe(prepared.frame.phase);
    expect(decodeNativeFieldImage(image, acquisition!, [profileId]).decoded.frame.sequence).toBe(12);
  });

  it("tracks orientation after a ninety-degree camera rotation", () => {
    const image = rotateClockwise(renderNativeField(PREPARED));
    const acquisition = locateNativeField(image);
    expect(acquisition).not.toBeNull();
    expect(decodeNativeFieldImage(image, acquisition!, ["C16"]).decoded.frame.sequence).toBe(21);
  });

  it("recovers under mild blur", () => {
    const image = boxBlur(renderNativeField(PREPARED), 1);
    const acquisition = locateNativeField(image);
    expect(acquisition).not.toBeNull();
    expect(decodeNativeFieldImage(image, acquisition!, ["C16"]).decoded.frame.sequence).toBe(21);
  });

  it("recovers a projected field at a handheld viewing angle", () => {
    const corners = [
      { x: 128, y: 102 },
      { x: 1_006, y: 148 },
      { x: 954, y: 658 },
      { x: 176, y: 625 },
    ];
    const image = warpPerspective(
      renderNativeField(PREPARED),
      corners,
      1_140,
      760,
    );
    const acquisition = locateNativeField(image);
    expect(acquisition).not.toBeNull();
    expect(decodeNativeFieldImage(image, acquisition!, ["C16"]).decoded.frame.sequence).toBe(21);
  });
});

function preparedForProfile(profileId: FieldProfileId, sequence: number): PreparedNativeFieldFrame {
  const object = buildNativeLabObject(SESSION, profileId);
  const profile = FIELD_PROFILES[profileId];
  const packet = Uint8Array.from({ length: profile.raptorPacketBytes }, (_, index) => (index * 89 + profile.code) & 0xff);
  return prepareNativeFieldFrame(SESSION, object.bytes, sequence, packet, profileId);
}

function renderNativeField(
  prepared: PreparedNativeFieldFrame,
  channel: (color: Rgb) => Rgb = (color) => color,
): CameraPixelImage {
  const data = new Uint8ClampedArray(FIELD_FRAME.width * FIELD_FRAME.height * 4);
  expect(prepared.renderedColors).toHaveLength(FIELD_CELL_COUNT);
  for (let row = 0; row < FIELD_FRAME.rows; row += 1) {
    for (let column = 0; column < FIELD_FRAME.columns; column += 1) {
      const index = row * FIELD_FRAME.columns + column;
      fillRect(
        data,
        FIELD_FRAME.width,
        column * FIELD_FRAME.cellPitch,
        row * FIELD_FRAME.cellPitch,
        FIELD_FRAME.cellPitch,
        FIELD_FRAME.cellPitch,
        channel(prepared.renderedColors[index]),
      );
    }
  }
  return { data, width: FIELD_FRAME.width, height: FIELD_FRAME.height };
}

function embedCentered(source: CameraPixelImage, width: number, height: number): CameraPixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 0, 0, width, height, [31, 35, 41]);
  const offsetX = Math.floor((width - source.width) / 2);
  const offsetY = Math.floor((height - source.height) / 2);
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = y * source.width * 4;
    const destinationStart = (((offsetY + y) * width) + offsetX) * 4;
    data.set(source.data.subarray(sourceStart, sourceStart + source.width * 4), destinationStart);
  }
  return { data, width, height };
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

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
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

function boxBlur(source: CameraPixelImage, radius: number): CameraPixelImage {
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const totals = [0, 0, 0];
      let count = 0;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = Math.max(0, Math.min(source.width - 1, x + offsetX));
          const sampleY = Math.max(0, Math.min(source.height - 1, y + offsetY));
          const offset = ((sampleY * source.width) + sampleX) * 4;
          totals[0] += source.data[offset];
          totals[1] += source.data[offset + 1];
          totals[2] += source.data[offset + 2];
          count += 1;
        }
      }
      const destination = ((y * source.width) + x) * 4;
      data[destination] = Math.round(totals[0] / count);
      data[destination + 1] = Math.round(totals[1] / count);
      data[destination + 2] = Math.round(totals[2] / count);
      data[destination + 3] = 255;
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
  fillRect(data, width, 0, 0, width, height, [27, 31, 38]);
  const minimumX = Math.max(0, Math.floor(Math.min(...destinationCorners.map((point) => point.x))));
  const maximumX = Math.min(width - 1, Math.ceil(Math.max(...destinationCorners.map((point) => point.x))));
  const minimumY = Math.max(0, Math.floor(Math.min(...destinationCorners.map((point) => point.y))));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(...destinationCorners.map((point) => point.y))));
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      if (!insideQuad({ x, y }, destinationCorners)) continue;
      const sourcePoint = projectPoint(destinationToSource, { x, y });
      const sourceX = Math.max(0, Math.min(source.width - 1, Math.round(sourcePoint.x)));
      const sourceY = Math.max(0, Math.min(source.height - 1, Math.round(sourcePoint.y)));
      const sourceOffset = ((sourceY * source.width) + sourceX) * 4;
      const destinationOffset = ((y * width) + x) * 4;
      data.set(source.data.subarray(sourceOffset, sourceOffset + 4), destinationOffset);
    }
  }
  return { data, width, height };
}

function insideQuad(point: Point, corners: readonly Point[]): boolean {
  let sign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const first = corners[index];
    const second = corners[(index + 1) % corners.length];
    const cross = ((second.x - first.x) * (point.y - first.y)) - ((second.y - first.y) * (point.x - first.x));
    if (Math.abs(cross) < 0.001) continue;
    const current = Math.sign(cross);
    if (sign !== 0 && sign !== current) return false;
    sign = current;
  }
  return true;
}
