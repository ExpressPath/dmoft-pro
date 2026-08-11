import { describe, expect, it } from "vitest";

import { estimateMdsSuccessProbability, optimizeCapturePolicy } from "../src/lib/optical-optimizer";

describe("joint optical capture optimizer", () => {
  it("keeps handheld geometry locked to every observed frame", () => {
    const policy = optimizeCapturePolicy({
      cellErasureRate: 0.005,
      frameDetectionRate: 0.99,
      meanConfidence: 14,
      qrDetectionMs: 80,
      chromaDecodeMs: 22,
      motionRisk: 0.002,
    });

    expect(policy.targetFps).toBe(10);
    expect(policy.geometryRelockInterval).toBe(1);
    expect(policy.erasureThreshold).toBe(1.5);
    expect(policy.estimatedInnerSuccess).toBeGreaterThan(0.999);
    expect(policy.verifiedBytesPerSecond).toBeGreaterThan(1600);
  });

  it("relocks every frame when motion makes cached geometry unsafe", () => {
    const policy = optimizeCapturePolicy({
      cellErasureRate: 0.01,
      frameDetectionRate: 0.95,
      meanConfidence: 7,
      qrDetectionMs: 4,
      chromaDecodeMs: 10,
      motionRisk: 0.9,
    });

    expect(policy.geometryRelockInterval).toBe(1);
    expect(policy.erasureThreshold).toBe(2);
  });

  it("models the MDS acceptance cliff instead of assuming raw density is useful", () => {
    const clean = estimateMdsSuccessProbability(250, 40, 0.05);
    const marginal = estimateMdsSuccessProbability(250, 40, 0.16);
    const failed = estimateMdsSuccessProbability(250, 40, 0.25);

    expect(clean).toBeGreaterThan(0.999);
    expect(marginal).toBeGreaterThan(0.5);
    expect(failed).toBeLessThan(0.01);
  });

  it("raises the erasure threshold and reports lower verified throughput on a noisy channel", () => {
    const clean = optimizeCapturePolicy({
      cellErasureRate: 0.002,
      frameDetectionRate: 0.99,
      meanConfidence: 15,
      qrDetectionMs: 12,
      chromaDecodeMs: 18,
      motionRisk: 0.01,
    });
    const noisy = optimizeCapturePolicy({
      cellErasureRate: 0.08,
      frameDetectionRate: 0.7,
      meanConfidence: 2,
      qrDetectionMs: 20,
      chromaDecodeMs: 35,
      motionRisk: 0.3,
    });

    expect(noisy.erasureThreshold).toBe(4);
    expect(noisy.verifiedBytesPerSecond).toBeLessThan(clean.verifiedBytesPerSecond);
    expect(noisy.verifiedBytesPerAreaSecond).toBeLessThan(clean.verifiedBytesPerAreaSecond);
  });
});
