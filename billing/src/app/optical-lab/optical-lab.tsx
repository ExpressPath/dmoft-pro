"use client";

import jsQR from "jsqr";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import {
  C6_PALETTE,
  DynamicLabDecoder,
  LAB_FRAME,
  LAB_PROFILE_NAME,
  LAB_RADIX,
  LAB_SOURCE_CHUNK_COUNT,
  LAB_TARGET_FPS,
  buildBootstrapUrl,
  buildLabObject,
  calibrationCoordinates,
  classifyColor,
  decodeDynamicGridSymbols,
  estimatePalette,
  localizePalette,
  parseBootstrapUrl,
  pilotCoordinates,
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
}>;

type SenderMetrics = Readonly<{
  sessionHex: string;
  sequence: number;
  maskId: number;
  frameKind: DynamicLabFrame["frameKind"];
  measuredFps: number;
}>;

type ReaderMetrics = Readonly<DecoderProgress & {
  rejectedFrames: number;
  lastSequence: number | null;
  lastFrameKind: DynamicLabFrame["frameKind"] | null;
  confidence: number;
  erasures: number;
  recommendation: "C6" | "C4" | "BW";
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
const PILOT_KEYS = new Set(["0:0", "7:0", "0:7", "7:7", "3:0", "4:7"]);
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
  recommendation: "C6",
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
    let previousSymbols: readonly number[] | null = null;
    let previousRenderTime = performance.now();
    const sessionNonce = new Uint8Array(8);
    crypto.getRandomValues(sessionNonce);
    const object = buildLabObject(sessionNonce);

    const renderNext = async () => {
      const started = performance.now();
      const prepared = prepareDynamicFrame(sessionNonce, object.bytes, sequence, previousSymbols);
      const bootstrap = buildBootstrapUrl(window.location.origin, prepared.frame);
      await renderSenderFrame(canvas, prepared, bootstrap);
      if (cancelled) return;

      if (sequence === 0) {
        try {
          const verified = verifyRenderedFrame(canvas);
          setSenderSelfTest(
            verified.decoded.frame.sessionHex === prepared.frame.sessionHex
              && verified.decoded.frame.sequence === prepared.frame.sequence
              ? "QR + C6 + CRC32 OK"
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
        frameKind: prepared.frame.frameKind,
        measuredFps,
      });
      previousSymbols = prepared.displayedSymbols;
      sequence = (sequence + 1) & 0xffff;
      const wait = Math.max(0, (1000 / LAB_TARGET_FPS) - (performance.now() - started));
      senderTimerRef.current = setTimeout(() => void renderNext(), wait);
    };

    void renderNext().catch(() => {
      if (!cancelled) setSenderSelfTest("FAILED");
    });
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
          width: { ideal: 1280 },
          height: { ideal: 720 },
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
      setReaderStatus("動的C6フレームを探索中です。白いフレーム全体を映してください。");
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
    const scale = Math.min(1, 1280 / sourceWidth);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const qr = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });
    diagnosticFrameRef.current += 1;

    if (!qr) {
      if (diagnosticFrameRef.current % 12 === 0) setReaderStatus("モノクロ制御QRを探索中です。距離と反射を調整してください。");
      return;
    }

    try {
      const control = parseBootstrapUrl(qr.data, window.location.origin);
      const cameraFrame = decodeCameraImage(imageData, qr.location as QrLocation, control.maskId);
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
        recommendation: recommendProfile(cameraFrame.confidence, cameraFrame.erasures),
      };
      setReaderMetrics(metrics);
      setReaderStatus(
        `フレーム ${cameraFrame.decoded.frame.sequence} を受理 · 独立シンボル ${progress.rank}/${progress.required} · ${cameraFrame.decoded.frame.frameKind}`,
      );

      if (decoder.canRecoverObject()) {
        const object = decoder.reconstruct();
        setReaderSuccess({ object, metrics });
        stopCamera("動的ストリームを再構築し、オブジェクトCRC32を確認しました。");
      }
    } catch (error) {
      rejectedFramesRef.current += 1;
      if (diagnosticFrameRef.current % 5 === 0) {
        const detail = error instanceof Error ? error.message : "dynamic color decode failed";
        setReaderStatus(`制御面を検出。低信頼フレームを破棄して継続中: ${detail}`);
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
        <p className={styles.eyebrow}>Public optical test · Dynamic stream</p>
        <h1 id="lab-title">PrismGlyph Dynamic Camera Lab</h1>
        <p>
          モノクロ制御面と6色データ面を毎秒更新し、複数フレームから192-byteのテストオブジェクトを復元します。
          映像・画像・復元データはブラウザの外へ送信されません。
        </p>
      </section>

      <nav className={styles.roleSwitch} aria-label="テスト端末の役割">
        <button
          className={role === "sender" ? styles.activeRole : ""}
          type="button"
          onClick={() => selectRole("sender")}
          aria-pressed={role === "sender"}
        >
          PCで動的ストリーム表示
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
              <p className={styles.step}>PC · DYNAMIC SENDER</p>
              <h2 id="sender-title">変化するフレーム全体をスマホへ向ける</h2>
            </div>
            <span className={styles.profileBadge}>{LAB_PROFILE_NAME}</span>
          </div>
          <ol className={styles.instructions}>
            <li>スマホの標準カメラで左側のモノクロQRを読み、表示されたリンクを開きます。</li>
            <li>スマホ側で「カメラを開始」を押し、QR・色セル・校正帯を同時に映します。</li>
            <li>途中のrepairフレームから開始しても、独立した式が8本集まれば復元できます。</li>
          </ol>
          <div className={styles.frameShell}>
            <canvas
              ref={senderCanvasRef}
              width={LAB_FRAME.width}
              height={LAB_FRAME.height}
              className={styles.senderCanvas}
              role="img"
              aria-label="動的モノクロ制御QR、6色データセル、局所校正パイロットを含むPrismGlyphテストストリーム"
            />
          </div>
          <div className={styles.metrics} aria-live="polite">
            <span>Frame <strong>{senderMetrics?.sequence ?? "…"}</strong></span>
            <span>Mode <strong>{senderMetrics?.frameKind ?? "…"}</strong></span>
            <span>Mask <strong>{senderMetrics?.maskId ?? "…"} / 15</strong></span>
            <span>Rate <strong>{senderMetrics ? senderMetrics.measuredFps.toFixed(1) : "…"} FPS</strong></span>
            <span>Palette <strong>6 colors · base-6</strong></span>
            <span>Tile pilots <strong>6 / 8×8</strong></span>
            <span>Core ratio <strong>0.75</strong></span>
            <span>Self-test <strong>{senderSelfTest}</strong></span>
            <span>Session <strong>{senderMetrics?.sessionHex ?? "生成中…"}</strong></span>
          </div>
          <p className={styles.algorithmNote}>
            実装中の外部FECはRaptorQではなく、系統シンボル＋GF(2) XOR repairの検証用ストリームです。
            各フレームはsession・sequence・mask・equation・object CRCを自己記述します。
          </p>
        </section>
      ) : (
        <section className={styles.workspace} aria-labelledby="reader-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PHONE · STARTLESS RECEIVER</p>
              <h2 id="reader-title">ライブカメラで複数フレーム復元</h2>
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
              aria-label="PrismGlyph動的フレーム読取用ライブカメラ"
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
              <p className={styles.successMark}>STARTLESS STREAM · OBJECT CRC32 VERIFIED</p>
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
            低信頼セルはerasureとして扱い、CRC不一致フレームは蓄積しません。カメラはボタン操作後だけ開始し、
            停止・成功・ページ離脱時に解放します。これは光学・FEC検証であり、暗号認証テストではありません。
          </p>
        </section>
      )}
    </main>
  );
}

async function renderSenderFrame(
  canvas: HTMLCanvasElement,
  prepared: PreparedDynamicFrame,
  bootstrap: string,
) {
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = LAB_FRAME.width;
  renderCanvas.height = LAB_FRAME.height;
  const context = renderCanvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
  context.strokeStyle = "#000000";
  context.lineWidth = 8;
  context.strokeRect(12, 12, renderCanvas.width - 24, renderCanvas.height - 24);

  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, bootstrap, {
    width: LAB_FRAME.qrSize,
    margin: 0,
    errorCorrectionLevel: "H",
    color: { dark: "#000000", light: "#ffffff" },
  });
  context.drawImage(qrCanvas, LAB_FRAME.qrX, LAB_FRAME.qrY, LAB_FRAME.qrSize, LAB_FRAME.qrSize);

  let dataIndex = 0;
  const tileColumns = LAB_FRAME.dataColumns / LAB_FRAME.tileSize;
  const tileRows = LAB_FRAME.dataRows / LAB_FRAME.tileSize;
  for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tileColumns; tileColumn += 1) {
      const pilots = new Map(pilotCoordinates(tileColumn, tileRow).map((pilot) => [
        `${Math.floor((pilot.x - LAB_FRAME.dataX) / LAB_FRAME.cellPitch)}:${Math.floor((pilot.y - LAB_FRAME.dataY) / LAB_FRAME.cellPitch)}`,
        pilot.symbol,
      ]));
      for (let localY = 0; localY < LAB_FRAME.tileSize; localY += 1) {
        for (let localX = 0; localX < LAB_FRAME.tileSize; localX += 1) {
          const column = tileColumn * LAB_FRAME.tileSize + localX;
          const row = tileRow * LAB_FRAME.tileSize + localY;
          const pilotSymbol = pilots.get(`${column}:${row}`);
          const symbol = pilotSymbol ?? prepared.displayedSymbols[dataIndex++];
          paintColorCell(
            context,
            LAB_FRAME.dataX + column * LAB_FRAME.cellPitch,
            LAB_FRAME.dataY + row * LAB_FRAME.cellPitch,
            LAB_FRAME.cellPitch,
            symbol,
          );
        }
      }
    }
  }

  for (const calibration of calibrationCoordinates()) {
    paintColorCell(
      context,
      calibration.x - LAB_FRAME.calibrationPitch / 2,
      calibration.y - LAB_FRAME.calibrationPitch / 2,
      LAB_FRAME.calibrationPitch,
      calibration.symbol,
    );
  }

  if (canvas.width !== LAB_FRAME.width) canvas.width = LAB_FRAME.width;
  if (canvas.height !== LAB_FRAME.height) canvas.height = LAB_FRAME.height;
  const visibleContext = canvas.getContext("2d");
  if (!visibleContext) throw new Error("visible 2D canvas is unavailable");
  visibleContext.drawImage(renderCanvas, 0, 0);
}

function paintColorCell(context: CanvasRenderingContext2D, x: number, y: number, pitch: number, symbol: number) {
  context.fillStyle = "#ffffff";
  context.fillRect(x, y, pitch, pitch);
  const core = pitch * LAB_FRAME.coloredCoreRatio;
  const inset = (pitch - core) / 2;
  const [red, green, blue] = C6_PALETTE[symbol];
  context.fillStyle = `rgb(${red} ${green} ${blue})`;
  context.fillRect(x + inset, y + inset, core, core);
}

function decodeCameraImage(image: ImageData, location: QrLocation, maskId: number): DecodedCameraFrame {
  const destination = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner,
  ];
  const homography = solveHomography(QR_SOURCE_CORNERS, destination);
  const observedQrWidth = distance(location.topLeftCorner, location.topRightCorner);
  const sampleRadius = Math.max(1, Math.min(5, Math.round(
    (observedQrWidth / LAB_FRAME.qrSize) * LAB_FRAME.cellPitch * 0.12,
  )));

  const calibrationSamples: Rgb[][] = Array.from({ length: LAB_RADIX }, () => []);
  for (const calibration of calibrationCoordinates()) {
    calibrationSamples[calibration.symbol].push(sampleRgb(image, projectPoint(homography, calibration), sampleRadius));
  }
  const globalPalette = estimatePalette(calibrationSamples);
  const symbols: Array<number | null> = [];
  const confidences: number[] = [];
  let erasures = 0;
  const tileColumns = LAB_FRAME.dataColumns / LAB_FRAME.tileSize;
  const tileRows = LAB_FRAME.dataRows / LAB_FRAME.tileSize;

  for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tileColumns; tileColumn += 1) {
      const pilots = pilotCoordinates(tileColumn, tileRow).map((pilot) => (
        sampleRgb(image, projectPoint(homography, pilot), sampleRadius)
      ));
      const localPalette = localizePalette(globalPalette, pilots);
      for (let localY = 0; localY < LAB_FRAME.tileSize; localY += 1) {
        for (let localX = 0; localX < LAB_FRAME.tileSize; localX += 1) {
          if (PILOT_KEYS.has(`${localX}:${localY}`)) continue;
          const logical = {
            x: LAB_FRAME.dataX + ((tileColumn * LAB_FRAME.tileSize + localX + 0.5) * LAB_FRAME.cellPitch),
            y: LAB_FRAME.dataY + ((tileRow * LAB_FRAME.tileSize + localY + 0.5) * LAB_FRAME.cellPitch),
          };
          const classified = classifyColor(sampleRgb(image, projectPoint(homography, logical), sampleRadius), localPalette);
          confidences.push(classified.confidence);
          if (classified.erasure) erasures += 1;
          symbols.push(classified.erasure ? null : classified.symbol);
        }
      }
    }
  }

  const decoded = decodeDynamicGridSymbols(symbols, maskId);
  const confidence = confidences.length === 0
    ? 0
    : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  return { decoded, confidence, erasures };
}

function verifyRenderedFrame(canvas: HTMLCanvasElement): DecodedCameraFrame {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  if (!qr) throw new Error("rendered bootstrap QR did not self-decode");
  const control = parseBootstrapUrl(qr.data, window.location.origin);
  const decoded = decodeCameraImage(image, qr.location as QrLocation, control.maskId);
  assertControlMatchesFrame(control, decoded.decoded.frame);
  return decoded;
}

function assertControlMatchesFrame(control: BootstrapControl, frame: DynamicLabFrame) {
  if (control.sessionHex !== frame.sessionHex || control.sequence !== frame.sequence || control.maskId !== frame.maskId) {
    throw new Error("monochrome control header and C6 payload disagree");
  }
}

function recommendProfile(confidence: number, erasures: number): "C6" | "C4" | "BW" {
  const erasureRate = erasures / 522;
  if (erasureRate > 0.15 || confidence < 2.5) return "BW";
  if (erasureRate > 0.08 || confidence < 5) return "C4";
  return "C6";
}

function sampleRgb(image: ImageData, point: Point, radius: number): Rgb {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  if (
    centerX - radius < 0
    || centerY - radius < 0
    || centerX + radius >= image.width
    || centerY + radius >= image.height
  ) throw new Error("カラー領域がカメラ画面から外れています");
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
