"use client";

import { useEffect, useRef, useState } from "react";

import {
  C16_PRISM_PALETTE,
  DynamicLabDecoder,
  LAB_ACTIVE_QUIET_MODULES,
  LAB_COLOR_CORE_RATIO,
  LAB_FRAME,
  LAB_GEOMETRY_TRACK_MAX_AGE_MS,
  LAB_GEOMETRY_TRACK_MAX_FRAMES,
  LAB_INNER_CODE_RATE,
  LAB_INNER_PARITY_BYTES,
  LAB_INNER_STRIPE_COUNT,
  LAB_OBJECT_BYTES,
  LAB_PROFILE_AREA_GAIN,
  LAB_PROFILE_NAME,
  LAB_RX5_PAYLOAD_GAIN,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_SOURCE_CHUNK_BYTES,
  LAB_SYMBOL_MODULES,
  LAB_TARGET_FPS,
  LAB_VERIFIED_PAYLOAD_DENSITY_GAIN,
  buildLabObject,
  prepareDynamicFrame,
  type DecoderProgress,
  type DynamicLabFrame,
  type DynamicLabObject,
  type PreparedDynamicFrame,
} from "@/lib/optical-lab";
import {
  OpticalDecodeError,
  decodeCameraImage,
  locatePrismSymbol,
  type DecodedCameraFrame,
  type OpticalDecodeStage,
  type QrLocation,
} from "@/lib/optical-camera";
import type { Point } from "@/lib/optical-lab";
import { optimizeCapturePolicy, type CapturePolicy } from "@/lib/optical-optimizer";

import styles from "./optical-lab.module.css";

type Role = "sender" | "reader";
type SenderMetrics = Readonly<{
  sessionHex: string;
  sequence: number;
  maskId: number;
  payloadCells: number;
  pilotCells: number;
  frameKind: DynamicLabFrame["frameKind"];
  measuredFps: number;
}>;

type ReaderMetrics = Readonly<DecoderProgress & {
  rejectedFrames: number;
  lastSequence: number | null;
  lastFrameKind: DynamicLabFrame["frameKind"] | null;
  confidence: number;
  erasures: number;
  correctedByteErasures: number;
  reliabilityErasedBytes: number;
  observedModulePixels: number;
  geometryMode: "detected" | "tracked" | null;
  acquisitionMode: "custom-four-finder" | "tracked" | null;
  targetFps: number;
  geometryRelockInterval: number;
  estimatedFrameAcceptance: number;
  verifiedBytesPerSecond: number;
}>;

type ReceiverDiagnostics = Readonly<{
  scannedFrames: number;
  finderDetections: number;
  lastStage: "idle" | "finder" | OpticalDecodeStage | "accepted";
  lastReason: string;
  stageRejects: Readonly<Record<OpticalDecodeStage, number>>;
}>;

type ReaderSuccess = Readonly<{
  object: DynamicLabObject;
  metrics: ReaderMetrics;
}>;

const DEFAULT_CAPTURE_POLICY: CapturePolicy = optimizeCapturePolicy({
  cellErasureRate: 0.01,
  frameDetectionRate: 0.95,
  meanConfidence: 8,
  geometryDetectionMs: 40,
  chromaDecodeMs: 24,
  motionRisk: 0.02,
});
const EMPTY_PROGRESS: ReaderMetrics = {
  rank: 0,
  required: LAB_SOURCE_CHUNK_COUNT,
  acceptedFrames: 0,
  duplicateFrames: 0,
  sessionHex: null,
  rejectedFrames: 0,
  lastSequence: null,
  lastFrameKind: null,
  confidence: 0,
  erasures: 0,
  correctedByteErasures: 0,
  reliabilityErasedBytes: 0,
  observedModulePixels: 0,
  geometryMode: null,
  acquisitionMode: null,
  targetFps: DEFAULT_CAPTURE_POLICY.targetFps,
  geometryRelockInterval: DEFAULT_CAPTURE_POLICY.geometryRelockInterval,
  estimatedFrameAcceptance: 0,
  verifiedBytesPerSecond: 0,
};
const EMPTY_DIAGNOSTICS: ReceiverDiagnostics = {
  scannedFrames: 0,
  finderDetections: 0,
  lastStage: "idle",
  lastReason: "Waiting for camera",
  stageRejects: {
    geometry: 0,
    calibration: 0,
    sampling: 0,
    "inner-fec": 0,
  },
};

export function OpticalLab({ initialRole }: { initialRole: Role }) {
  const [role, setRole] = useState<Role>(initialRole);
  const [senderMetrics, setSenderMetrics] = useState<SenderMetrics | null>(null);
  const [senderSelfTest, setSenderSelfTest] = useState("検証中…");
  const [cameraActive, setCameraActive] = useState(false);
  const [readerStatus, setReaderStatus] = useState("カメラは停止しています。");
  const [readerMetrics, setReaderMetrics] = useState<ReaderMetrics>(EMPTY_PROGRESS);
  const [receiverDiagnostics, setReceiverDiagnostics] = useState<ReceiverDiagnostics>(EMPTY_DIAGNOSTICS);
  const [readerSuccess, setReaderSuccess] = useState<ReaderSuccess | null>(null);
  const senderCanvasRef = useRef<HTMLCanvasElement>(null);
  const senderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const samplingCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const scanBusyRef = useRef(false);
  const lastScanTimeRef = useRef(0);
  const scanIntervalRef = useRef(1000 / DEFAULT_CAPTURE_POLICY.targetFps);
  const diagnosticFrameRef = useRef(0);
  const rejectedFramesRef = useRef(0);
  const geometryAttemptsRef = useRef(0);
  const geometryDetectedRef = useRef(0);
  const geometryDetectionMsRef = useRef(40);
  const chromaDecodeMsRef = useRef(24);
  const motionRiskRef = useRef(0.02);
  const receiverDiagnosticsRef = useRef<ReceiverDiagnostics>(EMPTY_DIAGNOSTICS);
  const capturePolicyRef = useRef<CapturePolicy>(DEFAULT_CAPTURE_POLICY);
  const geometryTrackRef = useRef<{
    location: QrLocation;
    framesSinceLock: number;
    lockedAt: number;
  } | null>(null);
  const decoderRef = useRef<DynamicLabDecoder | null>(null);

  useEffect(() => {
    if (role !== "sender") return;
    const canvas = senderCanvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let sequence = 0;
    let previousPaletteStates: number[] | null = null;
    let previousRenderTime = performance.now();
    const sessionNonce = new Uint8Array(8);
    crypto.getRandomValues(sessionNonce);
    const object = buildLabObject(sessionNonce);

    const renderNext = () => {
      try {
        const started = performance.now();
        const prepared = prepareDynamicFrame(
          sessionNonce,
          object.bytes,
          sequence,
          previousPaletteStates,
        );
        renderSenderFrame(canvas, prepared);
        if (cancelled) return;

        if (sequence === 0) {
          try {
            const verified = verifyRenderedFrame(canvas);
            setSenderSelfTest(
              verified.decoded.frame.sessionHex === prepared.frame.sessionHex
                && verified.decoded.frame.sequence === prepared.frame.sequence
                ? "4-finder + C16 + triple MDS33 + CRC32 OK"
                : "FAILED",
            );
          } catch {
            setSenderSelfTest("FAILED");
          }
        }

        const now = performance.now();
        const measuredFps = 1000 / Math.max(1, now - previousRenderTime);
        previousRenderTime = now;
        setSenderMetrics({
          sessionHex: prepared.frame.sessionHex,
          sequence: prepared.frame.sequence,
          maskId: prepared.frame.maskId,
          payloadCells: prepared.matrix.payloadCells.length,
          pilotCells: prepared.matrix.pilots.length,
          frameKind: prepared.frame.frameKind,
          measuredFps,
        });
        previousPaletteStates = Array.from(prepared.paletteStates);
        sequence = (sequence + 1) & 0xffff;
        const wait = Math.max(0, (1000 / LAB_TARGET_FPS) - (performance.now() - started));
        senderTimerRef.current = setTimeout(renderNext, wait);
      } catch {
        if (!cancelled) setSenderSelfTest("FAILED");
      }
    };

    senderTimerRef.current = setTimeout(renderNext, 0);
    return () => {
      cancelled = true;
      if (senderTimerRef.current) clearTimeout(senderTimerRef.current);
      senderTimerRef.current = null;
    };
  }, [role]);

  useEffect(() => () => {
    scanningRef.current = false;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (senderTimerRef.current) clearTimeout(senderTimerRef.current);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
  }, []);

  function stopCamera(nextStatus = "カメラを停止しました。") {
    scanningRef.current = false;
    scanBusyRef.current = false;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setReaderStatus(nextStatus);
  }

  function resetReader() {
    decoderRef.current = null;
    rejectedFramesRef.current = 0;
    geometryAttemptsRef.current = 0;
    geometryDetectedRef.current = 0;
    geometryDetectionMsRef.current = 40;
    chromaDecodeMsRef.current = 24;
    motionRiskRef.current = 0.02;
    capturePolicyRef.current = DEFAULT_CAPTURE_POLICY;
    scanIntervalRef.current = 1000 / DEFAULT_CAPTURE_POLICY.targetFps;
    scanBusyRef.current = false;
    geometryTrackRef.current = null;
    receiverDiagnosticsRef.current = EMPTY_DIAGNOSTICS;
    setReaderMetrics(EMPTY_PROGRESS);
    setReceiverDiagnostics(EMPTY_DIAGNOSTICS);
    setReaderSuccess(null);
  }

  async function startCamera() {
    resetReader();
    if (!navigator.mediaDevices?.getUserMedia) {
      setReaderStatus("このブラウザはカメラAPIに対応していません。SafariまたはChromeの最新版を使用してください。");
      return;
    }
    setReaderStatus("カメラ許可を要求しています…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 60 },
        },
      });
      const video = videoRef.current;
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      await stabilizeCameraTrack(stream.getVideoTracks()[0]);
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      scanningRef.current = true;
      diagnosticFrameRef.current = 0;
      lastScanTimeRef.current = 0;
      setCameraActive(true);
      setReaderStatus("4-finder C16カスタムコードを探索中です。正方形全体とquiet zoneを映してください。");
      animationFrameRef.current = requestAnimationFrame(scanCamera);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError") {
        setReaderStatus("カメラが許可されませんでした。ブラウザのサイト設定からカメラを許可してください。");
      } else if (name === "NotFoundError") {
        setReaderStatus("利用可能なカメラが見つかりませんでした。");
      } else {
        setReaderStatus("カメラを開始できませんでした。ページを再読み込みしてもう一度試してください。");
      }
    }
  }

  async function scanCamera(timestamp: number) {
    if (!scanningRef.current) return;
    animationFrameRef.current = requestAnimationFrame(scanCamera);
    if (scanBusyRef.current) return;
    if (timestamp - lastScanTimeRef.current < scanIntervalRef.current) return;
    lastScanTimeRef.current = timestamp;

    const video = videoRef.current;
    const canvas = samplingCanvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (sourceWidth === 0 || sourceHeight === 0) return;
    const scale = Math.min(1, 1080 / Math.max(sourceWidth, sourceHeight));
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    scanBusyRef.current = true;
    diagnosticFrameRef.current += 1;
    receiverDiagnosticsRef.current = {
      ...receiverDiagnosticsRef.current,
      scannedFrames: receiverDiagnosticsRef.current.scannedFrames + 1,
    };

    try {
      const previousTrack = geometryTrackRef.current;
      const policy = capturePolicyRef.current;
      const needsRelock = !previousTrack
        || previousTrack.framesSinceLock >= policy.geometryRelockInterval - 1;
      let location: QrLocation;
      let geometryMode: ReaderMetrics["geometryMode"];
      let acquisitionMode: ReaderMetrics["acquisitionMode"];
      if (needsRelock) {
        geometryAttemptsRef.current += 1;
        const detectionStarted = monotonicNow();
        const detectedSymbol = locatePrismSymbol(imageData);
        geometryDetectionMsRef.current = updateEwma(geometryDetectionMsRef.current, monotonicNow() - detectionStarted, 0.2);
        const trackIsFresh = previousTrack
          && previousTrack.framesSinceLock < LAB_GEOMETRY_TRACK_MAX_FRAMES
          && timestamp - previousTrack.lockedAt <= LAB_GEOMETRY_TRACK_MAX_AGE_MS;
        if (!detectedSymbol && trackIsFresh) {
          location = previousTrack.location;
          acquisitionMode = "tracked";
          geometryMode = "tracked";
          geometryTrackRef.current = {
            ...previousTrack,
            framesSinceLock: previousTrack.framesSinceLock + 1,
          };
        } else if (!detectedSymbol) {
          geometryTrackRef.current = null;
          receiverDiagnosticsRef.current = {
            ...receiverDiagnosticsRef.current,
            lastStage: "finder",
            lastReason: "Four valid 1:1:3:1:1 finder patterns and orientation rails were not recovered",
          };
          if (diagnosticFrameRef.current % 6 === 0) {
            setReceiverDiagnostics(receiverDiagnosticsRef.current);
            setReaderStatus("4つのfinderを探索中です。2-module quiet zoneを含む正方形全体をガイド内へ入れてください。");
          }
          return;
        } else {
          geometryDetectedRef.current += 1;
          receiverDiagnosticsRef.current = {
            ...receiverDiagnosticsRef.current,
            finderDetections: receiverDiagnosticsRef.current.finderDetections + 1,
          };
          location = detectedSymbol.location;
          acquisitionMode = detectedSymbol.mode;
          if (previousTrack) {
            motionRiskRef.current = updateEwma(
              motionRiskRef.current,
              cornerMotionRisk(previousTrack.location, location, imageData.width, imageData.height),
              0.25,
            );
          }
          geometryTrackRef.current = {
            location,
            framesSinceLock: 0,
            lockedAt: timestamp,
          };
          geometryMode = "detected";
        }
      } else {
        location = previousTrack.location;
        geometryTrackRef.current = {
          ...previousTrack,
          framesSinceLock: previousTrack.framesSinceLock + 1,
        };
        geometryMode = "tracked";
        acquisitionMode = "tracked";
      }

      const decodeStarted = monotonicNow();
      const cameraFrame = decodeCameraImage(
        imageData,
        location,
        policy.erasureThreshold,
      );
      chromaDecodeMsRef.current = updateEwma(chromaDecodeMsRef.current, monotonicNow() - decodeStarted, 0.2);

      let decoder = decoderRef.current;
      if (!decoder || (decoder.progress().sessionHex && decoder.progress().sessionHex !== cameraFrame.decoded.frame.sessionHex)) {
        decoder = new DynamicLabDecoder();
        decoderRef.current = decoder;
        rejectedFramesRef.current = 0;
      }
      decoder.addFrame(cameraFrame.decoded.frame);
      const progress = decoder.progress();
      const optimizedPolicy = optimizeCapturePolicy({
        cellErasureRate: cameraFrame.erasures / Math.max(1, cameraFrame.payloadCellCount),
        frameDetectionRate: (geometryDetectedRef.current + 1) / (geometryAttemptsRef.current + 1),
        meanConfidence: cameraFrame.confidence,
        geometryDetectionMs: geometryDetectionMsRef.current,
        chromaDecodeMs: chromaDecodeMsRef.current,
        motionRisk: motionRiskRef.current,
      });
      capturePolicyRef.current = optimizedPolicy;
      scanIntervalRef.current = 1000 / optimizedPolicy.targetFps;
      const metrics: ReaderMetrics = {
        ...progress,
        rejectedFrames: rejectedFramesRef.current,
        lastSequence: cameraFrame.decoded.frame.sequence,
        lastFrameKind: cameraFrame.decoded.frame.frameKind,
        confidence: cameraFrame.confidence,
        erasures: cameraFrame.erasures,
        correctedByteErasures: cameraFrame.decoded.correctedByteErasures,
        reliabilityErasedBytes: cameraFrame.decoded.reliabilityErasedBytes,
        observedModulePixels: cameraFrame.observedModulePixels,
        geometryMode,
        acquisitionMode,
        targetFps: optimizedPolicy.targetFps,
        geometryRelockInterval: optimizedPolicy.geometryRelockInterval,
        estimatedFrameAcceptance: optimizedPolicy.estimatedFrameAcceptance,
        verifiedBytesPerSecond: optimizedPolicy.verifiedBytesPerSecond,
      };
      setReaderMetrics(metrics);
      receiverDiagnosticsRef.current = {
        ...receiverDiagnosticsRef.current,
        lastStage: "accepted",
        lastReason: `Frame ${cameraFrame.decoded.frame.sequence} accepted`,
      };
      setReceiverDiagnostics(receiverDiagnosticsRef.current);
      setReaderStatus(
        `一体型フレーム ${cameraFrame.decoded.frame.sequence} を受理 · 独立シンボル ${progress.rank}/${progress.required} · ${cameraFrame.decoded.frame.frameKind}`,
      );

      if (decoder.canRecoverObject()) {
        const object = decoder.reconstruct();
        setReaderSuccess({ object, metrics });
        stopCamera("C16カスタム光学ストリームを再構築し、オブジェクトCRC32を確認しました。");
      }
    } catch (error) {
      rejectedFramesRef.current += 1;
      const stage = error instanceof OpticalDecodeError ? error.stage : "inner-fec";
      const detail = error instanceof Error ? error.message : "integrated color decode failed";
      const currentTrack = geometryTrackRef.current;
      const canRetainGeometry = currentTrack
        && stage !== "geometry"
        && stage !== "sampling"
        && currentTrack.framesSinceLock < LAB_GEOMETRY_TRACK_MAX_FRAMES
        && timestamp - currentTrack.lockedAt <= LAB_GEOMETRY_TRACK_MAX_AGE_MS;
      geometryTrackRef.current = canRetainGeometry
        ? { ...currentTrack, framesSinceLock: currentTrack.framesSinceLock + 1 }
        : null;
      receiverDiagnosticsRef.current = {
        ...receiverDiagnosticsRef.current,
        lastStage: stage,
        lastReason: detail,
        stageRejects: {
          ...receiverDiagnosticsRef.current.stageRejects,
          [stage]: receiverDiagnosticsRef.current.stageRejects[stage] + 1,
        },
      };
      if (diagnosticFrameRef.current % 3 === 0) {
        setReceiverDiagnostics(receiverDiagnosticsRef.current);
        setReaderMetrics((current) => ({ ...current, rejectedFrames: rejectedFramesRef.current }));
        setReaderStatus(`カスタム幾何を検出。低信頼C16フレームを破棄して継続中: ${detail}`);
      }
    } finally {
      scanBusyRef.current = false;
    }
  }

  function selectRole(nextRole: Role) {
    if (nextRole === role) return;
    stopCamera("カメラは停止しています。");
    resetReader();
    setRole(nextRole);
    window.history.replaceState(null, "", `/optical-lab?role=${nextRole}`);
  }

  return (
    <main className={styles.labMain}>
      <section className={styles.hero} aria-labelledby="lab-title">
        <p className={styles.eyebrow}>Custom optical PHY · 16-color dynamic symbol</p>
        <h1 id="lab-title">Prism C16 Dynamic Optical Lab</h1>
        <p>
          通常QR互換を外し、黒・白を含む16色を4 bit/moduleとして直接利用します。4つのmonochrome finder、
          16色camera calibration、triple GF(256) Cauchy-MDS、startless outer repairで
          {LAB_OBJECT_BYTES.toLocaleString()}-byte test objectを復元します。
        </p>
      </section>

      <nav className={styles.roleSwitch} aria-label="テスト端末の役割">
        <button
          className={role === "sender" ? styles.activeRole : ""}
          type="button"
          onClick={() => selectRole("sender")}
          aria-pressed={role === "sender"}
        >
          PCで一体型コード表示
        </button>
        <button
          className={role === "reader" ? styles.activeRole : ""}
          type="button"
          onClick={() => selectRole("reader")}
          aria-pressed={role === "reader"}
        >
          スマホでカメラ読取
        </button>
      </nav>

      {role === "sender" ? (
        <section className={styles.workspace} aria-labelledby="sender-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PC · INTEGRATED SENDER</p>
              <h2 id="sender-title">この1つのC16カスタム光学コード全体を映す</h2>
            </div>
            <span className={styles.profileBadge}>{LAB_PROFILE_NAME}</span>
          </div>
          <ol className={styles.instructions}>
            <li>スマホでは先にreaderリンクを開きます。標準QR readerでこのコードを読む必要はありません。</li>
            <li>readerで「カメラを開始」を押し、2-module quiet zoneを含む正方形全体を映します。</li>
            <li>4 finderとtiming railが幾何を固定し、残りのmoduleが16色の動的データを直接運びます。</li>
          </ol>
          <div className={styles.frameShell}>
            <canvas
              ref={senderCanvasRef}
              width={LAB_FRAME.width}
              height={LAB_FRAME.height}
              className={styles.senderCanvas}
              role="img"
              aria-label="4 finder、timing rail、黒白を含む16色payloadを統合したカスタム動的光学コード"
            />
          </div>
          <div className={styles.metrics} aria-live="polite">
            <span>Frame <strong>{senderMetrics?.sequence ?? "…"}</strong></span>
            <span>Mode <strong>{senderMetrics?.frameKind ?? "…"}</strong></span>
            <span>Palette mask <strong>{senderMetrics?.maskId ?? "…"} / 15</strong></span>
            <span>Rate <strong>{senderMetrics ? senderMetrics.measuredFps.toFixed(1) : "…"} FPS</strong></span>
            <span>Geometry <strong>{LAB_SYMBOL_MODULES}×{LAB_SYMBOL_MODULES} · four 7×7 finders</strong></span>
            <span>Palette <strong>16 states · black/white included</strong></span>
            <span>Payload <strong>4 bits / module</strong></span>
            <span>Quiet zone <strong>{LAB_ACTIVE_QUIET_MODULES} modules · custom detector</strong></span>
            <span>Color core <strong>{Math.round(LAB_COLOR_CORE_RATIO * 100)}% · neutral guard</strong></span>
            <span>Footprint vs MICROTECH2 <strong>{LAB_PROFILE_AREA_GAIN.toFixed(2)}× area efficiency</strong></span>
            <span>Useful density vs MICROTECH2 <strong>{LAB_VERIFIED_PAYLOAD_DENSITY_GAIN.toFixed(2)}×</strong></span>
            <span>Payload vs RX5 <strong>{LAB_RX5_PAYLOAD_GAIN.toFixed(2)}×</strong></span>
            <span>Inner FEC <strong>{LAB_INNER_STRIPE_COUNT}× Cauchy-MDS [205,172] · R={LAB_INNER_CODE_RATE.toFixed(2)}</strong></span>
            <span>Source/frame <strong>{LAB_SOURCE_CHUNK_BYTES} bytes</strong></span>
            <span>Usable modules <strong>{senderMetrics?.payloadCells ?? "…"}</strong></span>
            <span>Integrated pilots <strong>{senderMetrics?.pilotCells ?? "…"}</strong></span>
            <span>Self-test <strong>{senderSelfTest}</strong></span>
            <span>Session <strong>{senderMetrics?.sessionHex ?? "生成中…"}</strong></span>
          </div>
          <p className={styles.algorithmNote}>
            Finderとtiming railだけを純粋な黒白に固定し、data moduleはneutral guardの中央{Math.round(LAB_COLOR_CORE_RATIO * 100)}%へ
            16色を直接配置します。各moduleは4 bitを運び、CIE Lab色差・同色隣接・時間遷移を評価して16個の可逆maskから最良を選びます。
            3本の独立MDS stripeが各{LAB_INNER_PARITY_BYTES} byteのerasureを回復し、handheld modeでは毎フレーム4 finderを再検出します。
          </p>
        </section>
      ) : (
        <section className={styles.workspace} aria-labelledby="reader-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PHONE · INTEGRATED RECEIVER</p>
              <h2 id="reader-title">4 finderから幾何・16色・動的FECを復元</h2>
            </div>
            <span className={styles.localBadge}>LOCAL ONLY</span>
          </div>

          <div className={styles.cameraShell}>
            <video
              ref={videoRef}
              className={styles.cameraVideo}
              autoPlay
              muted
              playsInline
              aria-label="C16カスタム動的光学コード読取用ライブカメラ"
            />
            <div className={styles.cameraGuide} aria-hidden="true" />
            {!cameraActive ? <p className={styles.cameraPlaceholder}>カメラ停止中</p> : null}
          </div>
          <canvas ref={samplingCanvasRef} className={styles.samplingCanvas} aria-hidden="true" />

          <div className={styles.cameraActions}>
            <button type="button" onClick={() => void startCamera()} disabled={cameraActive}>カメラを開始</button>
            <button type="button" onClick={() => stopCamera()} disabled={!cameraActive}>停止</button>
          </div>
          <p className={styles.readerStatus} role="status" aria-live="polite">{readerStatus}</p>

          <div className={styles.progressPanel} aria-label="動的復元進捗">
            <div className={styles.progressTrack}>
              <span style={{ width: `${(readerMetrics.rank / readerMetrics.required) * 100}%` }} />
            </div>
            <div className={styles.metrics}>
              <span>Independent equations <strong>{readerMetrics.rank} / {readerMetrics.required}</strong></span>
              <span>Accepted <strong>{readerMetrics.acceptedFrames}</strong></span>
              <span>Duplicates <strong>{readerMetrics.duplicateFrames}</strong></span>
              <span>Rejected <strong>{readerMetrics.rejectedFrames}</strong></span>
              <span>Last frame <strong>{readerMetrics.lastSequence ?? "—"} · {readerMetrics.lastFrameKind ?? "—"}</strong></span>
              <span>Confidence <strong>{readerMetrics.confidence.toFixed(2)}</strong></span>
              <span>Cell erasures <strong>{readerMetrics.erasures}</strong></span>
              <span>MDS recovered bytes <strong>{readerMetrics.correctedByteErasures}</strong></span>
              <span>Soft-chase erasures <strong>{readerMetrics.reliabilityErasedBytes}</strong></span>
              <span>Observed resolution <strong>{readerMetrics.observedModulePixels.toFixed(1)} px/module</strong></span>
              <span>Geometry <strong>{readerMetrics.geometryMode ?? "—"} · relock/{readerMetrics.geometryRelockInterval}</strong></span>
              <span>Acquisition <strong>{readerMetrics.acquisitionMode ?? "—"}</strong></span>
              <span>Adaptive rate <strong>{readerMetrics.targetFps} FPS</strong></span>
              <span>Estimated acceptance <strong>{(readerMetrics.estimatedFrameAcceptance * 100).toFixed(1)}%</strong></span>
              <span>Estimated verified rate <strong>{readerMetrics.verifiedBytesPerSecond.toFixed(0)} B/s</strong></span>
              <span>Decoder stage <strong>{receiverDiagnostics.lastStage}</strong></span>
              <span>Finder detection <strong>{receiverDiagnostics.finderDetections} / {receiverDiagnostics.scannedFrames}</strong></span>
            </div>
            <p className={styles.diagnosticReason}>{receiverDiagnostics.lastReason}</p>
          </div>

          {readerSuccess ? (
            <div className={styles.successPanel} role="status">
              <p className={styles.successMark}>PRISM C16 STREAM · OBJECT CRC32 VERIFIED</p>
              <h3>{readerSuccess.object.message}</h3>
              <dl>
                <div><dt>Session</dt><dd>{readerSuccess.object.sessionHex}</dd></div>
                <div><dt>Object</dt><dd>{readerSuccess.object.bytes.length} bytes</dd></div>
                <div><dt>Independent equations</dt><dd>{readerSuccess.metrics.rank} / {readerSuccess.metrics.required}</dd></div>
                <div><dt>Last mode</dt><dd>{readerSuccess.metrics.lastFrameKind}</dd></div>
                <div><dt>Mean confidence</dt><dd>{readerSuccess.metrics.confidence.toFixed(2)}</dd></div>
                <div><dt>Erasures</dt><dd>{readerSuccess.metrics.erasures}</dd></div>
                <div><dt>MDS recovered bytes</dt><dd>{readerSuccess.metrics.correctedByteErasures}</dd></div>
              </dl>
            </div>
          ) : null}
          <p className={styles.privacyNote}>
            16色camera modelで低信頼となる色、MDS不一致、CRC不一致フレームはerasureまたはdropとして扱います。
            これは光学・FEC検証であり、暗号認証テストではありません。
          </p>
        </section>
      )}
    </main>
  );
}

function renderSenderFrame(
  canvas: HTMLCanvasElement,
  prepared: PreparedDynamicFrame,
) {
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = LAB_FRAME.width;
  renderCanvas.height = LAB_FRAME.height;
  const context = renderCanvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
  const colorCoreSize = Math.max(1, Math.round(LAB_FRAME.modulePitch * LAB_COLOR_CORE_RATIO));
  const colorCoreOffset = Math.floor((LAB_FRAME.modulePitch - colorCoreSize) / 2);

  for (let row = 0; row < prepared.matrix.size; row += 1) {
    for (let column = 0; column < prepared.matrix.size; column += 1) {
      const index = (row * prepared.matrix.size) + column;
      const moduleX = LAB_FRAME.symbolX + (column * LAB_FRAME.modulePitch);
      const moduleY = LAB_FRAME.symbolY + (row * LAB_FRAME.modulePitch);
      const state = prepared.paletteStates[index];
      const [red, green, blue] = C16_PRISM_PALETTE[state];
      context.fillStyle = prepared.matrix.reserved[index]
        ? `rgb(${red} ${green} ${blue})`
        : "rgb(205 205 205)";
      context.fillRect(moduleX, moduleY, LAB_FRAME.modulePitch, LAB_FRAME.modulePitch);
      if (prepared.matrix.reserved[index]) continue;
      context.fillStyle = `rgb(${red} ${green} ${blue})`;
      context.fillRect(
        moduleX + colorCoreOffset,
        moduleY + colorCoreOffset,
        colorCoreSize,
        colorCoreSize,
      );
    }
  }

  if (canvas.width !== LAB_FRAME.width) canvas.width = LAB_FRAME.width;
  if (canvas.height !== LAB_FRAME.height) canvas.height = LAB_FRAME.height;
  const visibleContext = canvas.getContext("2d");
  if (!visibleContext) throw new Error("visible 2D canvas is unavailable");
  visibleContext.drawImage(renderCanvas, 0, 0);
}

function verifyRenderedFrame(canvas: HTMLCanvasElement): DecodedCameraFrame {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const acquisition = locatePrismSymbol(image);
  if (!acquisition) throw new Error("custom four-finder geometry did not self-decode");
  return decodeCameraImage(image, acquisition.location);
}

function cornerMotionRisk(previous: QrLocation, current: QrLocation, width: number, height: number): number {
  const previousCorners = [previous.topLeftCorner, previous.topRightCorner, previous.bottomRightCorner, previous.bottomLeftCorner];
  const currentCorners = [current.topLeftCorner, current.topRightCorner, current.bottomRightCorner, current.bottomLeftCorner];
  const diagonal = Math.max(1, Math.hypot(width, height));
  const normalizedMotion = previousCorners.reduce((sum, corner, index) => (
    sum + distance(corner, currentCorners[index])
  ), 0) / (previousCorners.length * diagonal);
  return Math.max(0, Math.min(1, normalizedMotion * 12));
}

function updateEwma(previous: number, observed: number, alpha: number): number {
  return (alpha * observed) + ((1 - alpha) * previous);
}

function monotonicNow(): number {
  return performance.now();
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

async function stabilizeCameraTrack(track: MediaStreamTrack | undefined) {
  if (!track?.getCapabilities) return;
  type CameraCapabilities = MediaTrackCapabilities & {
    focusMode?: readonly string[];
    exposureMode?: readonly string[];
    whiteBalanceMode?: readonly string[];
  };
  type CameraConstraintSet = MediaTrackConstraintSet & {
    focusMode?: string;
    exposureMode?: string;
    whiteBalanceMode?: string;
  };
  const capabilities = track.getCapabilities() as CameraCapabilities;
  const advanced: CameraConstraintSet = {};
  if (capabilities.focusMode?.includes("continuous")) advanced.focusMode = "continuous";
  if (capabilities.exposureMode?.includes("continuous")) advanced.exposureMode = "continuous";
  if (capabilities.whiteBalanceMode?.includes("continuous")) advanced.whiteBalanceMode = "continuous";
  if (Object.keys(advanced).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [advanced] });
  } catch {
    // Camera-specific controls are optional; the calibrated decoder remains usable.
  }
}
