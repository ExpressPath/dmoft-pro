"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

import {
  C8_QR_PALETTE,
  DynamicLabDecoder,
  LAB_FRAME,
  LAB_OBJECT_BYTES,
  LAB_PALETTE_SIZE,
  LAB_PROFILE_NAME,
  LAB_QUIET_ZONE_AREA_GAIN,
  LAB_QR_ERROR_CORRECTION,
  LAB_QR_VERSION,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_TARGET_FPS,
  buildLabObject,
  classifyColor,
  createIntegratedQrMatrix,
  decodeIntegratedPaletteSymbols,
  estimatePalette,
  isDarkPaletteState,
  localizePalette,
  moduleCenter,
  parseBootstrapUrl,
  prepareDynamicFrame,
  projectPoint,
  solveHomography,
  type BootstrapControl,
  type DecoderProgress,
  type DynamicLabFrame,
  type DynamicLabObject,
  type FrameGridDecode,
  type Point,
  type PreparedDynamicFrame,
  type Rgb,
} from "@/lib/optical-lab";

import styles from "./optical-lab.module.css";

type Role = "sender" | "reader";
type QrCorner = Readonly<{ x: number; y: number }>;
type QrLocation = Readonly<{
  topLeftCorner: QrCorner;
  topRightCorner: QrCorner;
  bottomRightCorner: QrCorner;
  bottomLeftCorner: QrCorner;
}>;

type DecodedCameraFrame = Readonly<{
  decoded: FrameGridDecode;
  confidence: number;
  erasures: number;
  payloadCellCount: number;
}>;

type SenderMetrics = Readonly<{
  sessionHex: string;
  sequence: number;
  maskId: number;
  qrMaskPattern: number;
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
  recommendation: "C8" | "C4" | "BW";
}>;

type ReaderSuccess = Readonly<{
  object: DynamicLabObject;
  metrics: ReaderMetrics;
}>;

const QR_SOURCE_CORNERS: readonly Point[] = [
  { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY },
  { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY },
  { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
  { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
];
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
  recommendation: "C8",
};

export function OpticalLab({ initialRole }: { initialRole: Role }) {
  const [role, setRole] = useState<Role>(initialRole);
  const [senderMetrics, setSenderMetrics] = useState<SenderMetrics | null>(null);
  const [senderSelfTest, setSenderSelfTest] = useState("検証中…");
  const [cameraActive, setCameraActive] = useState(false);
  const [readerStatus, setReaderStatus] = useState("カメラは停止しています。");
  const [readerMetrics, setReaderMetrics] = useState<ReaderMetrics>(EMPTY_PROGRESS);
  const [readerSuccess, setReaderSuccess] = useState<ReaderSuccess | null>(null);
  const senderCanvasRef = useRef<HTMLCanvasElement>(null);
  const senderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const samplingCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const lastScanTimeRef = useRef(0);
  const diagnosticFrameRef = useRef(0);
  const rejectedFramesRef = useRef(0);
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
          window.location.origin,
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
                ? "QR luminance + C8 chroma + CRC32 OK"
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
          qrMaskPattern: prepared.matrix.qrMaskPattern,
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
    setReaderMetrics(EMPTY_PROGRESS);
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
        },
      });
      const video = videoRef.current;
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      scanningRef.current = true;
      diagnosticFrameRef.current = 0;
      lastScanTimeRef.current = 0;
      setCameraActive(true);
      setReaderStatus("一体型Dynamic QRを探索中です。正方形全体とquiet zoneを映してください。");
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

  function scanCamera(timestamp: number) {
    if (!scanningRef.current) return;
    animationFrameRef.current = requestAnimationFrame(scanCamera);
    if (timestamp - lastScanTimeRef.current < 90) return;
    lastScanTimeRef.current = timestamp;

    const video = videoRef.current;
    const canvas = samplingCanvasRef.current;
    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (sourceWidth === 0 || sourceHeight === 0) return;
    const scale = Math.min(1, 1600 / sourceWidth);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const qr = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
    diagnosticFrameRef.current += 1;

    if (!qr) {
      if (diagnosticFrameRef.current % 12 === 0) setReaderStatus("QR finder/timing/alignmentを探索中です。距離と反射を調整してください。");
      return;
    }

    try {
      const control = parseBootstrapUrl(qr.data, window.location.origin);
      const cameraFrame = decodeCameraImage(imageData, qr.location as QrLocation, qr.data);
      assertControlMatchesFrame(control, cameraFrame.decoded.frame);

      let decoder = decoderRef.current;
      if (!decoder || (decoder.progress().sessionHex && decoder.progress().sessionHex !== cameraFrame.decoded.frame.sessionHex)) {
        decoder = new DynamicLabDecoder();
        decoderRef.current = decoder;
        rejectedFramesRef.current = 0;
      }
      decoder.addFrame(cameraFrame.decoded.frame);
      const progress = decoder.progress();
      const metrics: ReaderMetrics = {
        ...progress,
        rejectedFrames: rejectedFramesRef.current,
        lastSequence: cameraFrame.decoded.frame.sequence,
        lastFrameKind: cameraFrame.decoded.frame.frameKind,
        confidence: cameraFrame.confidence,
        erasures: cameraFrame.erasures,
        recommendation: recommendProfile(cameraFrame.confidence, cameraFrame.erasures, cameraFrame.payloadCellCount),
      };
      setReaderMetrics(metrics);
      setReaderStatus(
        `一体型フレーム ${cameraFrame.decoded.frame.sequence} を受理 · 独立シンボル ${progress.rank}/${progress.required} · ${cameraFrame.decoded.frame.frameKind}`,
      );

      if (decoder.canRecoverObject()) {
        const object = decoder.reconstruct();
        setReaderSuccess({ object, metrics });
        stopCamera("一体型Dynamic QRストリームを再構築し、オブジェクトCRC32を確認しました。");
      }
    } catch (error) {
      rejectedFramesRef.current += 1;
      if (diagnosticFrameRef.current % 5 === 0) {
        const detail = error instanceof Error ? error.message : "integrated color decode failed";
        setReaderStatus(`QR幾何を検出。低信頼chromaフレームを破棄して継続中: ${detail}`);
      }
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
        <p className={styles.eyebrow}>One QR-family symbol · Dynamic multicolor</p>
        <h1 id="lab-title">Integrated Dynamic Color QR Lab</h1>
        <p>
          QRと色パネルを並べる方式ではありません。1つの正方形QR格子のfinder・timing・alignment・quiet zoneを維持し、
          同じdata moduleへ黒・白を含む8色の動的chroma情報を重ね、{LAB_OBJECT_BYTES.toLocaleString()}-byteを複数フレームで復元します。
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
              <h2 id="sender-title">この1つの動的カラーQR全体を映す</h2>
            </div>
            <span className={styles.profileBadge}>{LAB_PROFILE_NAME}</span>
          </div>
          <ol className={styles.instructions}>
            <li>同じ正方形コードをスマホ標準カメラで読み、readerリンクを開きます。</li>
            <li>readerで「カメラを開始」を押し、Micro QR由来の2-module quiet zoneを含む正方形全体を映します。</li>
            <li>黒白のQR輝度面が幾何とbootstrapを、同じmodule内の8色chroma面が動的データを運びます。</li>
          </ol>
          <div className={styles.frameShell}>
            <canvas
              ref={senderCanvasRef}
              width={LAB_FRAME.width}
              height={LAB_FRAME.height}
              className={styles.senderCanvas}
              role="img"
              aria-label="finder、timing、alignmentと黒白を含む8色動的payloadを一体化した単一正方形QRコード"
            />
          </div>
          <div className={styles.metrics} aria-live="polite">
            <span>Frame <strong>{senderMetrics?.sequence ?? "…"}</strong></span>
            <span>Mode <strong>{senderMetrics?.frameKind ?? "…"}</strong></span>
            <span>Chroma mask <strong>{senderMetrics?.maskId ?? "…"} / 15</strong></span>
            <span>QR mask <strong>{senderMetrics?.qrMaskPattern ?? "…"} / 7</strong></span>
            <span>Rate <strong>{senderMetrics ? senderMetrics.measuredFps.toFixed(1) : "…"} FPS</strong></span>
            <span>QR base <strong>V{LAB_QR_VERSION} / {LAB_QR_ERROR_CORRECTION}</strong></span>
            <span>Palette <strong>8 states · black/white included</strong></span>
            <span>Payload <strong>2 chroma bits / module</strong></span>
            <span>Quiet zone <strong>2 modules · +{((LAB_QUIET_ZONE_AREA_GAIN - 1) * 100).toFixed(1)}% area efficiency</strong></span>
            <span>Usable modules <strong>{senderMetrics?.payloadCells ?? "…"}</strong></span>
            <span>Integrated pilots <strong>{senderMetrics?.pilotCells ?? "…"}</strong></span>
            <span>Self-test <strong>{senderSelfTest}</strong></span>
            <span>Session <strong>{senderMetrics?.sessionHex ?? "生成中…"}</strong></span>
          </div>
          <p className={styles.algorithmNote}>
            Function moduleは純粋な黒白のまま保持します。Data moduleはQR bitがdarkなら黒・赤・濃緑・青、lightなら白・黄・cyan・magentaから選択し、
            CIE Lab色差・同色隣接・時間遷移を評価して16個の可逆maskから最良を選びます。Micro QR由来の2-module marginと、
            global 8-color pilots＋tileごとのblack/white anchorsで校正面積を圧縮します。独立した校正帯や別QRはありません。
          </p>
        </section>
      ) : (
        <section className={styles.workspace} aria-labelledby="reader-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PHONE · INTEGRATED RECEIVER</p>
              <h2 id="reader-title">1つのQR格子から幾何・色・動的FECを復元</h2>
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
              aria-label="一体型Dynamic Color QR読取用ライブカメラ"
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
              <span>Erasures <strong>{readerMetrics.erasures}</strong></span>
              <span>Channel recommendation <strong>{readerMetrics.recommendation}</strong></span>
            </div>
          </div>

          {readerSuccess ? (
            <div className={styles.successPanel} role="status">
              <p className={styles.successMark}>INTEGRATED QR STREAM · OBJECT CRC32 VERIFIED</p>
              <h3>{readerSuccess.object.message}</h3>
              <dl>
                <div><dt>Session</dt><dd>{readerSuccess.object.sessionHex}</dd></div>
                <div><dt>Object</dt><dd>{readerSuccess.object.bytes.length} bytes</dd></div>
                <div><dt>Independent equations</dt><dd>{readerSuccess.metrics.rank} / {readerSuccess.metrics.required}</dd></div>
                <div><dt>Last mode</dt><dd>{readerSuccess.metrics.lastFrameKind}</dd></div>
                <div><dt>Mean confidence</dt><dd>{readerSuccess.metrics.confidence.toFixed(2)}</dd></div>
                <div><dt>Erasures</dt><dd>{readerSuccess.metrics.erasures}</dd></div>
              </dl>
            </div>
          ) : null}
          <p className={styles.privacyNote}>
            QR輝度classと矛盾する色、低信頼色、CRC不一致フレームはerasureまたはdropとして扱います。
            これは光学・FEC検証であり、暗号認証テストではありません。
          </p>
        </section>
      )}
    </main>
  );
}

function renderSenderFrame(canvas: HTMLCanvasElement, prepared: PreparedDynamicFrame) {
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = LAB_FRAME.width;
  renderCanvas.height = LAB_FRAME.height;
  const context = renderCanvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

  for (let row = 0; row < prepared.matrix.size; row += 1) {
    for (let column = 0; column < prepared.matrix.size; column += 1) {
      const state = prepared.paletteStates[(row * prepared.matrix.size) + column];
      const [red, green, blue] = C8_QR_PALETTE[state];
      context.fillStyle = `rgb(${red} ${green} ${blue})`;
      context.fillRect(
        LAB_FRAME.qrX + (column * LAB_FRAME.modulePitch),
        LAB_FRAME.qrY + (row * LAB_FRAME.modulePitch),
        LAB_FRAME.modulePitch,
        LAB_FRAME.modulePitch,
      );
    }
  }

  if (canvas.width !== LAB_FRAME.width) canvas.width = LAB_FRAME.width;
  if (canvas.height !== LAB_FRAME.height) canvas.height = LAB_FRAME.height;
  const visibleContext = canvas.getContext("2d");
  if (!visibleContext) throw new Error("visible 2D canvas is unavailable");
  visibleContext.drawImage(renderCanvas, 0, 0);
}

function decodeCameraImage(image: ImageData, location: QrLocation, bootstrap: string): DecodedCameraFrame {
  const matrix = createIntegratedQrMatrix(bootstrap);
  const destination = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
  const homography = solveHomography(QR_SOURCE_CORNERS, destination);
  const observedQrWidth = distance(location.topLeftCorner, location.topRightCorner);
  const sampleRadius = Math.max(1, Math.min(5, Math.round(
    (observedQrWidth / LAB_FRAME.qrSize) * LAB_FRAME.modulePitch * 0.2,
  )));

  const globalSamples: Rgb[][] = Array.from({ length: LAB_PALETTE_SIZE }, () => []);
  const tileSamples = new Map<string, Map<number, Rgb>>();
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
  const globalPalette = estimatePalette(globalSamples);
  const localModels = new Map<string, ReturnType<typeof localizePalette>>();
  for (const [key, samples] of tileSamples) {
    if (!samples.has(0) || !samples.has(4)) continue;
    localModels.set(key, localizePalette(
      globalPalette,
      [samples.get(0) as Rgb, samples.get(4) as Rgb],
    ));
  }

  const observedStates: Array<number | null> = [];
  const confidences: number[] = [];
  let erasures = 0;
  for (const cell of matrix.payloadCells) {
    const model = localModels.get(tileKey(cell.tileRow, cell.tileColumn)) ?? globalPalette;
    const classified = classifyColor(
      sampleRgb(image, projectPoint(homography, moduleCenter(cell)), sampleRadius),
      model,
    );
    const luminanceMismatch = isDarkPaletteState(classified.symbol) !== (matrix.bits[cell.index] === 1);
    const erasure = classified.erasure || luminanceMismatch;
    confidences.push(classified.confidence);
    if (erasure) erasures += 1;
    observedStates.push(erasure ? null : classified.symbol);
  }

  const control = parseBootstrapUrl(bootstrap, window.location.origin);
  const decoded = decodeIntegratedPaletteSymbols(observedStates, matrix, control.maskId);
  const confidence = confidences.length === 0
    ? 0
    : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  return { decoded, confidence, erasures, payloadCellCount: matrix.payloadCells.length };
}

function verifyRenderedFrame(canvas: HTMLCanvasElement): DecodedCameraFrame {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  if (!qr) throw new Error("integrated QR luminance plane did not self-decode");
  const control = parseBootstrapUrl(qr.data, window.location.origin);
  const decoded = decodeCameraImage(image, qr.location as QrLocation, qr.data);
  assertControlMatchesFrame(control, decoded.decoded.frame);
  return decoded;
}

function assertControlMatchesFrame(control: BootstrapControl, frame: DynamicLabFrame) {
  if (control.sessionHex !== frame.sessionHex || control.sequence !== frame.sequence || control.maskId !== frame.maskId) {
    throw new Error("integrated QR control and chroma payload disagree");
  }
}

function recommendProfile(confidence: number, erasures: number, payloadCells: number): "C8" | "C4" | "BW" {
  const erasureRate = erasures / Math.max(1, payloadCells);
  if (erasureRate > 0.15 || confidence < 2.5) return "BW";
  if (erasureRate > 0.08 || confidence < 5) return "C4";
  return "C8";
}

function tileKey(tileRow: number, tileColumn: number): string {
  return `${tileRow}:${tileColumn}`;
}

function sampleRgb(image: ImageData, point: Point, radius: number): Rgb {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  if (
    centerX - radius < 0
    || centerY - radius < 0
    || centerX + radius >= image.width
    || centerY + radius >= image.height
  ) throw new Error("一体型QR領域がカメラ画面から外れています");
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      const offset = ((y * image.width) + x) * 4;
      red += image.data[offset];
      green += image.data[offset + 1];
      blue += image.data[offset + 2];
      count += 1;
    }
  }
  return [red / count, green / count, blue / count];
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
