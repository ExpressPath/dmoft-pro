"use client";

import { useEffect, useRef, useState } from "react";

import {
  FIELD_CELL_COUNT,
  DEFAULT_FIELD_GEOMETRY_ID,
  FIELD_FRAME,
  FIELD_GEOMETRIES,
  FIELD_GEOMETRY_TRACK_MAX_AGE_MS,
  FIELD_GEOMETRY_TRACK_MAX_FRAMES,
  FIELD_PROFILES,
  FIELD_PROFILE_NAME,
  FIELD_SOURCE_SYMBOL_COUNT,
  FIELD_TARGET_FPS,
  buildNativeLabObject,
  createFieldRasterOwners,
  crc32,
  parseNativeLabObject,
  prepareNativeFieldFrame,
  type FieldGeometryId,
  type FieldProfileId,
  type NativeLabObject,
  type PreparedNativeFieldFrame,
} from "@/lib/prism-field";
import {
  NativeFieldDecodeError,
  decodeNativeFieldImage,
  locateNativeField,
  trackNativeFieldPhase,
  type NativeFieldAcquisition,
  type NativeFieldDecodeStage,
  type NativeFieldLocation,
} from "@/lib/prism-field-camera";
import {
  RaptorQObjectDecoder,
  createRaptorQPackets,
  ensureRaptorQInitialized,
} from "@/lib/raptorq-browser";

import styles from "./optical-lab.module.css";

type Role = "sender" | "reader";
type ProfileChoice = "AUTO" | FieldProfileId;
type GeometryChoice = "AUTO" | FieldGeometryId;

type SenderMetrics = Readonly<{
  sessionHex: string;
  sequence: number;
  maskId: number;
  phase: number;
  profileId: FieldProfileId;
  geometryId: FieldGeometryId;
  measuredFps: number;
  raptorPackets: number;
}>;

type ReaderMetrics = Readonly<{
  acceptedPackets: number;
  requiredPackets: number;
  duplicatePackets: number;
  rejectedFrames: number;
  scannedFrames: number;
  acquiredFrames: number;
  lastSequence: number | null;
  sessionHex: string | null;
  profileId: FieldProfileId | null;
  geometryId: FieldGeometryId | null;
  confidence: number;
  erasures: number;
  correctedByteErasures: number;
  reliabilityErasedBytes: number;
  observedCellPixels: number;
  pilotScore: number;
  acquisitionMode: "detected" | "tracked" | null;
  verifiedBytesPerSecond: number;
}>;

type ReceiverDiagnostics = Readonly<{
  lastStage: "idle" | "distributed-pilot" | NativeFieldDecodeStage | "accepted";
  lastReason: string;
}>;

type ReaderSuccess = Readonly<{
  object: NativeLabObject;
  elapsedMs: number;
}>;

const EMPTY_READER_METRICS: ReaderMetrics = {
  acceptedPackets: 0,
  requiredPackets: FIELD_SOURCE_SYMBOL_COUNT,
  duplicatePackets: 0,
  rejectedFrames: 0,
  scannedFrames: 0,
  acquiredFrames: 0,
  lastSequence: null,
  sessionHex: null,
  profileId: null,
  geometryId: null,
  confidence: 0,
  erasures: 0,
  correctedByteErasures: 0,
  reliabilityErasedBytes: 0,
  observedCellPixels: 0,
  pilotScore: 0,
  acquisitionMode: null,
  verifiedBytesPerSecond: 0,
};

const INITIAL_DIAGNOSTICS: ReceiverDiagnostics = {
  lastStage: "idle",
  lastReason: "Camera is idle",
};

export function OpticalLab({ initialRole }: { initialRole: Role }) {
  const [role, setRole] = useState<Role>(initialRole);
  const [profileChoice, setProfileChoice] = useState<ProfileChoice>("AUTO");
  const [geometryChoice, setGeometryChoice] = useState<GeometryChoice>("AUTO");
  const [senderMetrics, setSenderMetrics] = useState<SenderMetrics | null>(null);
  const [senderSelfTest, setSenderSelfTest] = useState("Initializing RFC 6330 codec…");
  const [cameraActive, setCameraActive] = useState(false);
  const [readerStatus, setReaderStatus] = useState("Camera is stopped.");
  const [readerMetrics, setReaderMetrics] = useState<ReaderMetrics>(EMPTY_READER_METRICS);
  const [diagnostics, setDiagnostics] = useState<ReceiverDiagnostics>(INITIAL_DIAGNOSTICS);
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
  const readerMetricsRef = useRef<ReaderMetrics>(EMPTY_READER_METRICS);
  const geometryTrackRef = useRef<{
    location: NativeFieldLocation;
    geometryId: FieldGeometryId;
    framesSinceLock: number;
    lockedAt: number;
  } | null>(null);
  const decoderRef = useRef<RaptorQObjectDecoder | null>(null);
  const decoderSessionRef = useRef<string | null>(null);
  const receiverStartedAtRef = useRef(0);

  useEffect(() => {
    if (role !== "sender") return;
    const canvas = senderCanvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let sequence = 0;
    let previousStates: number[] | null = null;
    let previousRenderTime = performance.now();
    const profileId: FieldProfileId = profileChoice === "AUTO" ? "C16" : profileChoice;
    const geometryId: FieldGeometryId = geometryChoice === "AUTO" ? DEFAULT_FIELD_GEOMETRY_ID : geometryChoice;
    const profile = FIELD_PROFILES[profileId];
    const sessionNonce = crypto.getRandomValues(new Uint8Array(8));
    const object = buildNativeLabObject(sessionNonce, profileId);

    const start = async () => {
      try {
        await ensureRaptorQInitialized();
        if (cancelled) return;
        const packets = createRaptorQPackets(object.bytes, profile.raptorPacketBytes, 96);
        const renderNext = () => {
          const started = performance.now();
          try {
            const prepared = prepareNativeFieldFrame(
              sessionNonce,
              object.bytes,
              sequence & 0xffff,
              packets[sequence % packets.length],
              profileId,
              previousStates,
              geometryId,
            );
            renderSenderFrame(canvas, prepared);
            if (cancelled) return;
            if (sequence === 0) {
              try {
                const verified = verifyRenderedFrame(canvas, profileId);
                setSenderSelfTest(
                  verified.decoded.frame.sessionHex === prepared.frame.sessionHex
                    ? "Distributed pilot + blind color + MDS + CRC32 OK"
                    : "Self-test mismatch",
                );
              } catch (error) {
                setSenderSelfTest(error instanceof Error ? `Self-test failed: ${error.message}` : "Self-test failed");
              }
            }
            const now = performance.now();
            setSenderMetrics({
              sessionHex: prepared.frame.sessionHex,
              sequence: prepared.frame.sequence,
              maskId: prepared.frame.maskId,
              phase: prepared.frame.phase,
              profileId,
              geometryId,
              measuredFps: 1000 / Math.max(1, now - previousRenderTime),
              raptorPackets: packets.length,
            });
            previousRenderTime = now;
            previousStates = Array.from(prepared.states);
            sequence += 1;
            senderTimerRef.current = setTimeout(
              renderNext,
              Math.max(0, (1000 / FIELD_TARGET_FPS) - (performance.now() - started)),
            );
          } catch (error) {
            if (!cancelled) setSenderSelfTest(error instanceof Error ? error.message : "Sender failed");
          }
        };
        renderNext();
      } catch (error) {
        if (!cancelled) setSenderSelfTest(error instanceof Error ? error.message : "RaptorQ initialization failed");
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (senderTimerRef.current) clearTimeout(senderTimerRef.current);
      senderTimerRef.current = null;
    };
  }, [geometryChoice, profileChoice, role]);

  useEffect(() => () => {
    scanningRef.current = false;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (senderTimerRef.current) clearTimeout(senderTimerRef.current);
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    decoderRef.current?.free();
  }, []);

  function updateReaderMetrics(next: ReaderMetrics) {
    readerMetricsRef.current = next;
    setReaderMetrics(next);
  }

  function stopCamera(nextStatus = "Camera stopped.") {
    scanningRef.current = false;
    scanBusyRef.current = false;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setReaderStatus(nextStatus);
  }

  function resetReader() {
    decoderRef.current?.free();
    decoderRef.current = null;
    decoderSessionRef.current = null;
    geometryTrackRef.current = null;
    receiverStartedAtRef.current = performance.now();
    updateReaderMetrics(EMPTY_READER_METRICS);
    setDiagnostics(INITIAL_DIAGNOSTICS);
    setReaderSuccess(null);
  }

  async function startCamera() {
    resetReader();
    if (!navigator.mediaDevices?.getUserMedia) {
      setReaderStatus("This browser does not expose the camera API. Use current Safari or Chrome over HTTPS.");
      return;
    }
    setReaderStatus("Loading the RFC 6330 decoder…");
    try {
      await ensureRaptorQInitialized();
      setReaderStatus("Requesting camera permission…");
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
      scanBusyRef.current = false;
      lastScanTimeRef.current = 0;
      setCameraActive(true);
      setReaderStatus("Searching for the borderless distributed-pilot field. Fill the landscape guide.");
      animationFrameRef.current = requestAnimationFrame(scanCamera);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setReaderStatus(name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in site settings and retry."
        : error instanceof Error ? `Camera start failed: ${error.message}` : "Camera start failed.");
    }
  }

  async function scanCamera(timestamp: number) {
    if (!scanningRef.current) return;
    animationFrameRef.current = requestAnimationFrame(scanCamera);
    if (scanBusyRef.current || timestamp - lastScanTimeRef.current < 1000 / FIELD_TARGET_FPS) return;
    lastScanTimeRef.current = timestamp;
    const video = videoRef.current;
    const canvas = samplingCanvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    scanBusyRef.current = true;
    const before = readerMetricsRef.current;
    updateReaderMetrics({ ...before, scannedFrames: before.scannedFrames + 1 });

    try {
      const track = geometryTrackRef.current;
      const trackFresh = track
        && track.framesSinceLock < FIELD_GEOMETRY_TRACK_MAX_FRAMES
        && timestamp - track.lockedAt <= FIELD_GEOMETRY_TRACK_MAX_AGE_MS;
      let acquisition: NativeFieldAcquisition | null = trackFresh
        ? trackNativeFieldPhase(image, track.location, track.geometryId)
        : null;
      const acquisitionMode: ReaderMetrics["acquisitionMode"] = acquisition ? "tracked" : "detected";
      if (!acquisition) acquisition = locateNativeField(image);
      if (!acquisition) {
        geometryTrackRef.current = null;
        setDiagnostics({
          lastStage: "distributed-pilot",
          lastReason: "No valid full-field geometry/phase correlation in the current camera frame",
        });
        setReaderStatus("Field not locked. Keep the complete moving rectangle inside the landscape guide.");
        return;
      }
      geometryTrackRef.current = {
        location: acquisition.location,
        geometryId: acquisition.geometryId,
        framesSinceLock: acquisitionMode === "tracked" && track ? track.framesSinceLock + 1 : 0,
        lockedAt: acquisitionMode === "tracked" && track ? track.lockedAt : timestamp,
      };
      const cameraFrame = decodeNativeFieldImage(image, acquisition);
      const frame = cameraFrame.decoded.frame;
      const profile = FIELD_PROFILES[frame.profileId];
      let decoder = decoderRef.current;
      if (!decoder || decoderSessionRef.current !== frame.sessionHex) {
        decoder?.free();
        decoder = new RaptorQObjectDecoder(frame.objectLength, profile.raptorPacketBytes);
        decoderRef.current = decoder;
        decoderSessionRef.current = frame.sessionHex;
      }
      const acceptedBefore = decoder.acceptedPacketCount;
      const reconstructed = decoder.add(frame.raptorPacket);
      const duplicate = decoder.acceptedPacketCount === acceptedBefore;
      const elapsedSeconds = Math.max(0.001, (monotonicNow() - receiverStartedAtRef.current) / 1000);
      const previous = readerMetricsRef.current;
      const metrics: ReaderMetrics = {
        ...previous,
        acceptedPackets: decoder.acceptedPacketCount,
        requiredPackets: Math.ceil(frame.objectLength / profile.sourceSymbolBytes),
        duplicatePackets: previous.duplicatePackets + (duplicate ? 1 : 0),
        acquiredFrames: previous.acquiredFrames + 1,
        lastSequence: frame.sequence,
        sessionHex: frame.sessionHex,
        profileId: frame.profileId,
        geometryId: frame.geometryId,
        confidence: cameraFrame.confidence,
        erasures: cameraFrame.erasures,
        correctedByteErasures: cameraFrame.decoded.correctedByteErasures,
        reliabilityErasedBytes: cameraFrame.decoded.reliabilityErasedBytes,
        observedCellPixels: cameraFrame.observedCellPixels,
        pilotScore: acquisition.pilotScore,
        acquisitionMode,
        verifiedBytesPerSecond: (decoder.acceptedPacketCount * profile.sourceSymbolBytes) / elapsedSeconds,
      };
      updateReaderMetrics(metrics);
      setDiagnostics({ lastStage: "accepted", lastReason: `Frame ${frame.sequence} passed distributed control, MDS, and CRC32` });
      setReaderStatus(`Accepted frame ${frame.sequence} · RFC 6330 symbols ${decoder.acceptedPacketCount}/${metrics.requiredPackets}`);

      if (reconstructed) {
        if (crc32(reconstructed) !== frame.objectCrc) throw new Error("reconstructed object CRC32 does not match the distributed control word");
        const object = parseNativeLabObject(reconstructed);
        if (object.sessionHex !== frame.sessionHex || object.profileId !== frame.profileId) {
          throw new Error("reconstructed object does not belong to this optical session");
        }
        const elapsedMs = monotonicNow() - receiverStartedAtRef.current;
        setReaderSuccess({ object, elapsedMs });
        stopCamera("Native full-field object reconstructed and verified.");
      }
    } catch (error) {
      const previous = readerMetricsRef.current;
      updateReaderMetrics({ ...previous, rejectedFrames: previous.rejectedFrames + 1 });
      const stage = error instanceof NativeFieldDecodeError ? error.stage : "inner-fec";
      const reason = error instanceof Error ? error.message : "native field decode failed";
      setDiagnostics({ lastStage: stage, lastReason: reason });
      setReaderStatus(`Frame rejected at ${stage}: ${reason}`);
      if (stage === "geometry" || stage === "sampling") geometryTrackRef.current = null;
    } finally {
      scanBusyRef.current = false;
    }
  }

  const activeProfile = FIELD_PROFILES[senderMetrics?.profileId ?? (profileChoice === "AUTO" ? "C16" : profileChoice)];
  const activeGeometry = FIELD_GEOMETRIES[
    senderMetrics?.geometryId ?? (geometryChoice === "AUTO" ? DEFAULT_FIELD_GEOMETRY_ID : geometryChoice)
  ];
  const progress = Math.min(100, (readerMetrics.acceptedPackets / Math.max(1, readerMetrics.requiredPackets)) * 100);

  return (
    <main className={`shell ${styles.labMain}`}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>PRISM FIELD · NATIVE OPTICAL PHY</p>
        <h1>Dynamic multicolor field test</h1>
        <p>
          This test no longer emits a QR-shaped control skeleton. Every one of the {FIELD_CELL_COUNT.toLocaleString()} touching cells carries
          protected stream data; geometry, phase, and color references are weak sequences superimposed over the complete field.
        </p>
      </section>

      <nav className={styles.roleSwitch} aria-label="Optical test role">
        <button type="button" className={role === "sender" ? styles.activeRole : undefined} onClick={() => setRole("sender")}>PC sender</button>
        <button type="button" className={role === "reader" ? styles.activeRole : undefined} onClick={() => setRole("reader")}>Phone reader</button>
      </nav>

      {role === "sender" ? (
        <section className={styles.workspace} aria-labelledby="sender-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PC · DYNAMIC SENDER</p>
              <h2 id="sender-title">Show this complete moving field to the phone</h2>
            </div>
            <span className={styles.profileBadge}>{FIELD_PROFILE_NAME}</span>
          </div>
          <ol className={styles.instructions}>
            <li>Open the phone reader from the same public URL and allow camera access.</li>
            <li>Use landscape orientation and fit this entire rectangle inside the camera guide.</li>
            <li>Hold steady while RaptorQ accepts enough out-of-order symbols.</li>
          </ol>
          <label className={styles.profileControl}>
            Color constellation
            <select value={profileChoice} onChange={(event) => setProfileChoice(event.target.value as ProfileChoice)}>
              <option value="AUTO">AUTO · robust C16 bootstrap</option>
              <option value="C8">C8 · 3 bits/cell</option>
              <option value="C16">C16 · 4 bits/cell</option>
              <option value="C24">C24 · grouped radix-24</option>
              <option value="C32">C32 · 5 bits/cell</option>
            </select>
          </label>
          <label className={styles.profileControl}>
            Cell geometry
            <select value={geometryChoice} onChange={(event) => setGeometryChoice(event.target.value as GeometryChoice)}>
              <option value="AUTO">AUTO · affine-triangular bootstrap</option>
              <option value="TRI57">TRI57 · hexagonal Voronoi cells</option>
              <option value="SQ60">SQ60 · square raster fallback</option>
            </select>
          </label>
          <div className={styles.frameShell}>
            <canvas ref={senderCanvasRef} className={styles.senderCanvas} aria-label="Borderless distributed-pilot dynamic multicolor field" />
          </div>
          <div className={styles.metrics} aria-live="polite">
            <span>Frame <strong>{senderMetrics?.sequence ?? "…"}</strong></span>
            <span>Phase <strong>{senderMetrics?.phase ?? "…"} / 15</strong></span>
            <span>Mask <strong>{senderMetrics?.maskId ?? "…"} / 15</strong></span>
            <span>Rate <strong>{senderMetrics ? senderMetrics.measuredFps.toFixed(1) : "…"} FPS</strong></span>
            <span>Geometry <strong>{activeGeometry.id} · {activeGeometry.nominalColumns}×{activeGeometry.nominalRows}</strong></span>
            <span>Cell region <strong>{activeGeometry.lattice === "affine-triangular" ? "hexagonal Voronoi" : "square Voronoi"}</strong></span>
            <span>Min. separation <strong>{activeGeometry.minimumCenterDistanceAtReference.toFixed(2)} px</strong></span>
            <span>Palette <strong>{activeProfile.palette.length} states · black/white included</strong></span>
            <span>Information <strong>{activeProfile.bitsPerCell.toFixed(3)} bits/cell</strong></span>
            <span>Reserved cells <strong>0</strong></span>
            <span>Physical gaps <strong>0</strong></span>
            <span>Inner FEC <strong>{activeProfile.stripeCount}×[{activeProfile.innerCodewordBytes},{activeProfile.innerDataBytes}] Cauchy-MDS</strong></span>
            <span>RaptorQ envelope <strong>{activeProfile.raptorPacketBytes} bytes</strong></span>
            <span>Stream packets <strong>{senderMetrics?.raptorPackets ?? "…"}</strong></span>
            <span>Self-test <strong>{senderSelfTest}</strong></span>
            <span>Session <strong>{senderMetrics?.sessionHex ?? "…"}</strong></span>
          </div>
          <p className={styles.algorithmNote}>
            Control bytes are protected inside the same interleaved MDS codeword as payload bytes. The receiver estimates border geometry and
            phase by whole-field PRBS correlation, removes payload color by blind clustering, refines an affine camera model from confident decisions,
            and marks ambiguous cells as erasures. C24 uses local 16-cell radix groups so one erasure cannot create object-wide carry propagation.
          </p>
        </section>
      ) : (
        <section className={styles.workspace} aria-labelledby="reader-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PHONE · NATIVE RECEIVER</p>
              <h2 id="reader-title">Read the full-field stream with the live camera</h2>
            </div>
            <span className={styles.localBadge}>LOCAL CAMERA</span>
          </div>
          <div className={styles.cameraShell}>
            <video ref={videoRef} className={styles.cameraVideo} autoPlay muted playsInline aria-label="Native optical field live camera" />
            <div className={styles.cameraGuide} aria-hidden="true" />
            {!cameraActive ? <p className={styles.cameraPlaceholder}>Camera stopped</p> : null}
          </div>
          <canvas ref={samplingCanvasRef} className={styles.samplingCanvas} aria-hidden="true" />
          <div className={styles.cameraActions}>
            <button type="button" onClick={() => void startCamera()} disabled={cameraActive}>Start camera</button>
            <button type="button" onClick={() => stopCamera()} disabled={!cameraActive}>Stop</button>
          </div>
          <p className={styles.readerStatus} role="status" aria-live="polite">{readerStatus}</p>
          <div className={styles.progressPanel}>
            <div className={styles.progressTrack}><span style={{ width: `${progress}%` }} /></div>
            <div className={styles.metrics}>
              <span>RFC 6330 packets <strong>{readerMetrics.acceptedPackets} / {readerMetrics.requiredPackets}</strong></span>
              <span>Duplicates <strong>{readerMetrics.duplicatePackets}</strong></span>
              <span>Rejected <strong>{readerMetrics.rejectedFrames}</strong></span>
              <span>Acquired <strong>{readerMetrics.acquiredFrames} / {readerMetrics.scannedFrames}</strong></span>
              <span>Last frame <strong>{readerMetrics.lastSequence ?? "—"}</strong></span>
              <span>Profile <strong>{readerMetrics.profileId ?? "—"}</strong></span>
              <span>Cell geometry <strong>{readerMetrics.geometryId ?? "—"}</strong></span>
              <span>Pilot correlation <strong>{readerMetrics.pilotScore.toFixed(3)}</strong></span>
              <span>Blind-color confidence <strong>{readerMetrics.confidence.toFixed(3)}</strong></span>
              <span>Cell erasures <strong>{readerMetrics.erasures}</strong></span>
              <span>MDS recovered bytes <strong>{readerMetrics.correctedByteErasures}</strong></span>
              <span>Soft-chase bytes <strong>{readerMetrics.reliabilityErasedBytes}</strong></span>
              <span>Resolution <strong>{readerMetrics.observedCellPixels.toFixed(1)} px/cell</strong></span>
              <span>Geometry <strong>{readerMetrics.acquisitionMode ?? "—"}</strong></span>
              <span>Accepted rate <strong>{readerMetrics.verifiedBytesPerSecond.toFixed(0)} B/s</strong></span>
              <span>Stage <strong>{diagnostics.lastStage}</strong></span>
            </div>
            <p className={styles.diagnosticReason}>{diagnostics.lastReason}</p>
          </div>
          {readerSuccess ? (
            <div className={styles.successPanel} role="status">
              <p className={styles.successMark}>NATIVE FIELD · RAPTORQ OBJECT CRC32 VERIFIED</p>
              <h3>{readerSuccess.object.message}</h3>
              <dl>
                <div><dt>Session</dt><dd>{readerSuccess.object.sessionHex}</dd></div>
                <div><dt>Profile</dt><dd>{readerSuccess.object.profileId}</dd></div>
                <div><dt>Object</dt><dd>{readerSuccess.object.bytes.length} bytes</dd></div>
                <div><dt>Capture</dt><dd>{(readerSuccess.elapsedMs / 1000).toFixed(2)} s</dd></div>
              </dl>
            </div>
          ) : null}
          <p className={styles.privacyNote}>
            Camera frames stay in this browser tab. This lab verifies optical reconstruction and CRC32; production file output still requires the
            receiver-bound encrypted container and chunk AEAD authentication before any final save.
          </p>
        </section>
      )}
    </main>
  );
}

function renderSenderFrame(canvas: HTMLCanvasElement, prepared: PreparedNativeFieldFrame) {
  if (canvas.width !== FIELD_FRAME.width) canvas.width = FIELD_FRAME.width;
  if (canvas.height !== FIELD_FRAME.height) canvas.height = FIELD_FRAME.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.imageSmoothingEnabled = false;
  const owners = fieldRasterOwners(prepared.frame.geometryId);
  const image = context.createImageData(FIELD_FRAME.width, FIELD_FRAME.height);
  for (let pixel = 0; pixel < owners.length; pixel += 1) {
    const [red, green, blue] = prepared.renderedColors[owners[pixel]];
    const offset = pixel * 4;
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = blue;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

const RASTER_OWNER_CACHE = new Map<FieldGeometryId, Uint16Array>();

function fieldRasterOwners(geometryId: FieldGeometryId): Uint16Array {
  const cached = RASTER_OWNER_CACHE.get(geometryId);
  if (cached) return cached;
  const owners = createFieldRasterOwners(geometryId);
  RASTER_OWNER_CACHE.set(geometryId, owners);
  return owners;
}

function verifyRenderedFrame(canvas: HTMLCanvasElement, profileId: FieldProfileId) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const acquisition = locateNativeField(image);
  if (!acquisition) throw new Error("distributed pilot did not self-acquire");
  return decodeNativeFieldImage(image, acquisition, [profileId]);
}

async function stabilizeCameraTrack(track: MediaStreamTrack | undefined) {
  if (!track?.getCapabilities) return;
  type Capabilities = MediaTrackCapabilities & {
    focusMode?: readonly string[];
    exposureMode?: readonly string[];
    whiteBalanceMode?: readonly string[];
  };
  type Constraints = MediaTrackConstraintSet & {
    focusMode?: string;
    exposureMode?: string;
    whiteBalanceMode?: string;
  };
  const capabilities = track.getCapabilities() as Capabilities;
  const advanced: Constraints = {};
  if (capabilities.focusMode?.includes("continuous")) advanced.focusMode = "continuous";
  if (capabilities.exposureMode?.includes("continuous")) advanced.exposureMode = "continuous";
  if (capabilities.whiteBalanceMode?.includes("continuous")) advanced.whiteBalanceMode = "continuous";
  if (Object.keys(advanced).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [advanced] });
  } catch {
    // Device-specific controls are optional; blind calibration remains active.
  }
}

function monotonicNow(): number {
  return performance.now();
}
