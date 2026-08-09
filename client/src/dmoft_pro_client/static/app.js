"use strict";

const ui = {
  video: document.getElementById("preview"),
  canvas: document.getElementById("capture"),
  placeholder: document.getElementById("placeholder"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  download: document.getElementById("download"),
  state: document.getElementById("state"),
  progress: document.getElementById("progress"),
  frames: document.getElementById("frames"),
  message: document.getElementById("message"),
};

let csrfToken = "";
let stream = null;
let running = false;
let limits = { maximum_fps: 10, maximum_width: 1280, maximum_height: 720 };

function apiHeaders(contentType) {
  const headers = { "X-DMOFT-CSRF": csrfToken };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

function renderStatus(status) {
  ui.state.textContent = status.state || status.license_status || "ready";
  ui.progress.textContent = `${Math.round((status.independent_progress || 0) * 100)}%`;
  ui.frames.textContent = `${status.accepted_frames || 0} accepted / ${status.rejected_frames || 0} rejected`;
  ui.message.textContent = status.license_warning || status.message || "";
  if (status.completed) {
    running = false;
    releaseCamera();
    ui.download.disabled = false;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const document = await response.json();
  if (!response.ok) throw new Error(document.error || `Local API error ${response.status}`);
  return document;
}

async function bootstrap() {
  const response = await fetch("/api/v1/bootstrap", { cache: "no-store" });
  const document = await response.json();
  if (!response.ok) throw new Error(document.error || "License validation failed");
  csrfToken = document.csrf_token;
  limits = document;
  renderStatus(document);
  ui.start.disabled = false;
}

function releaseCamera() {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  ui.video.srcObject = null;
  ui.placeholder.hidden = false;
  ui.start.disabled = false;
  ui.stop.disabled = true;
}

async function startCamera() {
  ui.start.disabled = true;
  ui.message.textContent = "Requesting camera permission…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: Math.min(1280, limits.maximum_width), max: limits.maximum_width },
        height: { ideal: Math.min(720, limits.maximum_height), max: limits.maximum_height },
        frameRate: { ideal: 10, max: limits.maximum_fps },
      },
    });
    ui.video.srcObject = stream;
    await ui.video.play();
    const status = await request("/api/v1/session/start", {
      method: "POST",
      headers: apiHeaders("application/json"),
      body: "{}",
    });
    running = true;
    ui.placeholder.hidden = true;
    ui.stop.disabled = false;
    renderStatus(status);
    captureLoop();
  } catch (error) {
    releaseCamera();
    ui.message.textContent = error instanceof Error ? error.message : "Camera start failed";
  }
}

async function stopCamera() {
  running = false;
  releaseCamera();
  try {
    const status = await request("/api/v1/session/stop", {
      method: "POST",
      headers: apiHeaders("application/json"),
      body: "{}",
    });
    renderStatus(status);
  } catch (error) {
    ui.message.textContent = error instanceof Error ? error.message : "Camera stop failed";
  }
}

function boundedCanvasSize(width, height) {
  const scale = Math.min(1, limits.maximum_width / width, limits.maximum_height / height);
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

function jpegBlob() {
  return new Promise((resolve, reject) => {
    const [width, height] = boundedCanvasSize(ui.video.videoWidth, ui.video.videoHeight);
    ui.canvas.width = width;
    ui.canvas.height = height;
    const context = ui.canvas.getContext("2d", { alpha: false });
    context.drawImage(ui.video, 0, 0, width, height);
    ui.canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("JPEG capture failed")), "image/jpeg", 0.85);
  });
}

async function captureLoop() {
  if (!running) return;
  const started = performance.now();
  try {
    const blob = await jpegBlob();
    const status = await request("/api/v1/frame", {
      method: "POST",
      headers: apiHeaders("image/jpeg"),
      body: blob,
    });
    renderStatus(status);
  } catch (error) {
    if (error instanceof Error && !error.message.includes("frame rate")) {
      ui.message.textContent = error.message;
      if (error.message.includes("capture session")) {
        running = false;
        releaseCamera();
      }
    }
  }
  if (running) {
    const interval = 1000 / Math.min(10, limits.maximum_fps);
    window.setTimeout(captureLoop, Math.max(0, interval - (performance.now() - started)));
  }
}

async function downloadResult() {
  try {
    const response = await fetch("/api/v1/result", { headers: apiHeaders() });
    if (!response.ok) {
      const document = await response.json();
      throw new Error(document.error || "Result is unavailable");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "transfer.dmoft";
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    ui.message.textContent = error instanceof Error ? error.message : "Download failed";
  }
}

ui.start.disabled = true;
ui.start.addEventListener("click", startCamera);
ui.stop.addEventListener("click", stopCamera);
ui.download.addEventListener("click", downloadResult);
window.addEventListener("beforeunload", releaseCamera);
bootstrap().catch((error) => {
  ui.state.textContent = "blocked";
  ui.message.textContent = error instanceof Error ? error.message : "Initialization failed";
});
