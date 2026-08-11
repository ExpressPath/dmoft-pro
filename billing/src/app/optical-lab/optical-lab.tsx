"use client";

import jsQR from "jsqr";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import {
  C4_PALETTE,
  LAB_BOOTSTRAP_HASH,
  LAB_FRAME,
  LAB_PROFILE_NAME,
  buildLabPacket,
  calibrationCoordinates,
  classifyColor,
  decodeLabGridSymbols,
  encodeLabGridSymbols,
  estimatePalette,
  localizePalette,
  pilotCoordinates,
  projectPoint,
  solveHomography,
  type LabDecode,
  type LabPacket,
  type Point,
  type Rgb,
} from "@/lib/optical-lab";

import styles from "./optical-lab.module.css";

type Role = "sender" | "reader";

type ReaderSuccess = Readonly<{
  decoded: LabDecode;
  confidence: number;
  erasures: number;
}>;

type QrCorner = Readonly<{ x: number; y: number }>;

type QrLocation = Readonly<{
  topLeftCorner: QrCorner;
  topRightCorner: QrCorner;
  bottomRightCorner: QrCorner;
  bottomLeftCorner: QrCorner;
}>;

const QR_SOURCE_CORNERS: readonly Point[] = [
  { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY },
  { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY },
  { x: LAB_FRAME.qrX + LAB_FRAME.qrSize, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
  { x: LAB_FRAME.qrX, y: LAB_FRAME.qrY + LAB_FRAME.qrSize },
];

export function OpticalLab({ initialRole }: { initialRole: Role }) {
  const [role, setRole] = useState<Role>(initialRole);
  const [senderPacket, setSenderPacket] = useState<LabPacket | null>(null);
  const [senderSelfTest, setSenderSelfTest] = useState("検証中…");
  const [cameraActive, setCameraActive] = useState(false);
  const [readerStatus, setReaderStatus] = useState("カメラは停止しています。");
  const [readerSuccess, setReaderSuccess] = useState<ReaderSuccess | null>(null);
  const senderCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const samplingCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const lastScanTimeRef = useRef(0);
  const diagnosticFrameRef = useRef(0);

  useEffect(() => {
    if (role !== "sender") return;
    const canvas = senderCanvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const sessionNonce = new Uint8Array(8);
    crypto.getRandomValues(sessionNonce);
    const packet = buildLabPacket(sessionNonce, Math.floor(Date.now() / 1000));
    const bootstrap = `${window.location.origin}/optical-lab?role=reader${LAB_BOOTSTRAP_HASH}`;

    void renderSenderFrame(canvas, packet, bootstrap).then(() => {
      const selfTest = verifyRenderedFrame(canvas, bootstrap);
      if (!cancelled) {
        setSenderPacket(packet);
        setSenderSelfTest(selfTest.packet.sessionHex === packet.sessionHex ? "CRC32 OK" : "FAILED");
      }
    }).catch(() => {
      if (!cancelled) {
        setSenderPacket(null);
        setSenderSelfTest("FAILED");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [role]);

  useEffect(() => () => {
    scanningRef.current = false;
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
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

  async function startCamera() {
    setReaderSuccess(null);
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
      setCameraActive(true);
      setReaderStatus("DMOFTフレームを探しています。PC画面の白いフレーム全体を映してください。");
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
    if (timestamp - lastScanTimeRef.current < 140) return;
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
    const qr = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });
    diagnosticFrameRef.current += 1;

    if (!qr || !isExpectedBootstrap(qr.data)) {
      if (diagnosticFrameRef.current % 12 === 0) {
        setReaderStatus("QRブートストラップを探索中です。画面全体を映し、反射を避けてください。");
      }
      return;
    }

    try {
      const decoded = decodeCameraImage(imageData, qr.location as QrLocation);
      setReaderSuccess(decoded);
      stopCamera("C4テストペイロードを復元し、CRC32整合性を確認しました。");
    } catch (error) {
      if (diagnosticFrameRef.current % 6 === 0) {
        const detail = error instanceof Error ? error.message : "color decode failed";
        setReaderStatus(`ブートストラップ検出済み。カラー領域を調整中: ${detail}`);
      }
    }
  }

  function selectRole(nextRole: Role) {
    if (nextRole === role) return;
    stopCamera("カメラは停止しています。");
    setReaderSuccess(null);
    setRole(nextRole);
    window.history.replaceState(null, "", `/optical-lab?role=${nextRole}`);
  }

  return (
    <main className={styles.labMain}>
      <section className={styles.hero} aria-labelledby="lab-title">
        <p className={styles.eyebrow}>Public optical test · Phase 1</p>
        <h1 id="lab-title">DMOFT Live Camera Lab</h1>
        <p>
          PC画面のC4テストフレームをスマホのカメラで読み取ります。映像・画像・復元データは
          ブラウザの外へ送信されません。
        </p>
      </section>

      <nav className={styles.roleSwitch} aria-label="テスト端末の役割">
        <button
          className={role === "sender" ? styles.activeRole : ""}
          type="button"
          onClick={() => selectRole("sender")}
          aria-pressed={role === "sender"}
        >
          PCでフレーム表示
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
              <p className={styles.step}>PC · SENDER</p>
              <h2 id="sender-title">このフレームをスマホへ向ける</h2>
            </div>
            <span className={styles.profileBadge}>{LAB_PROFILE_NAME}</span>
          </div>
          <ol className={styles.instructions}>
            <li>最初にスマホの標準カメラで左側のQRを読み、表示されたリンクを開きます。</li>
            <li>スマホ側で「カメラを開始」を押し、この白いフレーム全体を映します。</li>
            <li>CRC32整合性検証に成功するとセッションIDと信頼度が表示されます。</li>
          </ol>
          <div className={styles.frameShell}>
            <canvas
              ref={senderCanvasRef}
              width={LAB_FRAME.width}
              height={LAB_FRAME.height}
              className={styles.senderCanvas}
              role="img"
              aria-label="スマホ読取ページへのQRブートストラップとC4カラーセルを含むDMOFTテストフレーム"
            />
          </div>
          <div className={styles.metrics}>
            <span>Core ratio <strong>0.75</strong></span>
            <span>Palette <strong>4 colors</strong></span>
            <span>Tile pilots <strong>4 / 8×8</strong></span>
            <span>Browser self-test <strong>{senderSelfTest}</strong></span>
            <span>Session <strong>{senderPacket?.sessionHex ?? "生成中…"}</strong></span>
          </div>
        </section>
      ) : (
        <section className={styles.workspace} aria-labelledby="reader-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.step}>PHONE · RECEIVER</p>
              <h2 id="reader-title">ライブカメラでローカル復元</h2>
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
              aria-label="DMOFTフレーム読取用ライブカメラ"
            />
            <div className={styles.cameraGuide} aria-hidden="true" />
            {!cameraActive ? <p className={styles.cameraPlaceholder}>カメラ停止中</p> : null}
          </div>
          <canvas ref={samplingCanvasRef} className={styles.samplingCanvas} aria-hidden="true" />

          <div className={styles.cameraActions}>
            <button type="button" onClick={() => void startCamera()} disabled={cameraActive}>
              カメラを開始
            </button>
            <button type="button" onClick={() => stopCamera()} disabled={!cameraActive}>
              停止
            </button>
          </div>
          <p className={styles.readerStatus} role="status" aria-live="polite">{readerStatus}</p>

          {readerSuccess ? (
            <div className={styles.successPanel} role="status">
              <p className={styles.successMark}>INTEGRITY-VERIFIED LAB PAYLOAD</p>
              <h3>{readerSuccess.decoded.packet.message}</h3>
              <dl>
                <div><dt>Session</dt><dd>{readerSuccess.decoded.packet.sessionHex}</dd></div>
                <div><dt>Repair</dt><dd>{readerSuccess.decoded.repairMode}</dd></div>
                <div><dt>Valid copies</dt><dd>{readerSuccess.decoded.validCopies} / 3</dd></div>
                <div><dt>Mean confidence</dt><dd>{readerSuccess.confidence.toFixed(2)}</dd></div>
                <div><dt>Erasures</dt><dd>{readerSuccess.erasures}</dd></div>
              </dl>
            </div>
          ) : null}
          <p className={styles.privacyNote}>
            カメラはボタン操作後だけ開始し、停止・成功・ページ離脱時にトラックを解放します。
            フレーム解析はCanvas上で完結し、アップロードAPIは使用しません。
          </p>
        </section>
      )}
    </main>
  );
}

async function renderSenderFrame(canvas: HTMLCanvasElement, packet: LabPacket, bootstrap: string) {
  canvas.width = LAB_FRAME.width;
  canvas.height = LAB_FRAME.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#000000";
  context.lineWidth = 8;
  context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);

  const qrCanvas = document.createElement("canvas");
  await QRCode.toCanvas(qrCanvas, bootstrap, {
    width: LAB_FRAME.qrSize,
    margin: 0,
    errorCorrectionLevel: "H",
    color: { dark: "#000000", light: "#ffffff" },
  });
  context.drawImage(qrCanvas, LAB_FRAME.qrX, LAB_FRAME.qrY, LAB_FRAME.qrSize, LAB_FRAME.qrSize);

  const symbols = encodeLabGridSymbols(packet);
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
          const column = (tileColumn * LAB_FRAME.tileSize) + localX;
          const row = (tileRow * LAB_FRAME.tileSize) + localY;
          const pilotSymbol = pilots.get(`${column}:${row}`);
          const symbol = pilotSymbol ?? symbols[dataIndex++];
          paintColorCell(context, LAB_FRAME.dataX + (column * LAB_FRAME.cellPitch), LAB_FRAME.dataY + (row * LAB_FRAME.cellPitch), LAB_FRAME.cellPitch, symbol);
        }
      }
    }
  }

  for (const calibration of calibrationCoordinates()) {
    paintColorCell(
      context,
      calibration.x - (LAB_FRAME.calibrationPitch / 2),
      calibration.y - (LAB_FRAME.calibrationPitch / 2),
      LAB_FRAME.calibrationPitch,
      calibration.symbol,
    );
  }
}

function paintColorCell(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  pitch: number,
  symbol: number,
) {
  context.fillStyle = "#ffffff";
  context.fillRect(x, y, pitch, pitch);
  const core = pitch * LAB_FRAME.coloredCoreRatio;
  const inset = (pitch - core) / 2;
  const [red, green, blue] = C4_PALETTE[symbol];
  context.fillStyle = `rgb(${red} ${green} ${blue})`;
  context.fillRect(x + inset, y + inset, core, core);
}

function decodeCameraImage(image: ImageData, location: QrLocation): ReaderSuccess {
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

  const calibrationSamples: Rgb[][] = [[], [], [], []];
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
      const pilotKeys = new Set(["0:0", "7:0", "0:7", "7:7"]);
      for (let localY = 0; localY < LAB_FRAME.tileSize; localY += 1) {
        for (let localX = 0; localX < LAB_FRAME.tileSize; localX += 1) {
          if (pilotKeys.has(`${localX}:${localY}`)) continue;
          const logical = {
            x: LAB_FRAME.dataX + ((tileColumn * LAB_FRAME.tileSize + localX + 0.5) * LAB_FRAME.cellPitch),
            y: LAB_FRAME.dataY + ((tileRow * LAB_FRAME.tileSize + localY + 0.5) * LAB_FRAME.cellPitch),
          };
          const observed = sampleRgb(image, projectPoint(homography, logical), sampleRadius);
          const classified = classifyColor(observed, localPalette);
          confidences.push(classified.confidence);
          if (classified.erasure) erasures += 1;
          symbols.push(classified.erasure ? null : classified.symbol);
        }
      }
    }
  }

  const decoded = decodeLabGridSymbols(symbols);
  const confidence = confidences.length === 0
    ? 0
    : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  return { decoded, confidence, erasures };
}

function verifyRenderedFrame(canvas: HTMLCanvasElement, bootstrap: string): LabDecode {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("2D canvas is unavailable");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  if (!qr || qr.data !== bootstrap) throw new Error("rendered bootstrap QR did not self-decode");
  return decodeCameraImage(image, qr.location as QrLocation).decoded;
}

function sampleRgb(image: ImageData, point: Point, radius: number): Rgb {
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  if (
    centerX - radius < 0
    || centerY - radius < 0
    || centerX + radius >= image.width
    || centerY + radius >= image.height
  ) {
    throw new Error("カラー領域がカメラ画面から外れています");
  }
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

function isExpectedBootstrap(value: string): boolean {
  try {
    const url = new URL(value);
    const secureOrigin = url.protocol === "https:"
      || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
    return secureOrigin
      && url.origin === window.location.origin
      && url.pathname === "/optical-lab"
      && url.hash === LAB_BOOTSTRAP_HASH;
  } catch {
    return false;
  }
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
