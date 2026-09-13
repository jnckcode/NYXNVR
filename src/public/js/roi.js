/**
 * @file roi.js
 * @description Interactive HTML5 Canvas ROI Zone Editor for drawing and editing multi-polygon motion detection masks.
 * @functions initRoiEditor, renderRoiCanvas, clearRoiPolygons, getRoiConfig, loadRoiConfig
 * @dependencies none
 */

let activeRoiCameraId = null;
let roiPolygons = []; // Array of arrays: [ [ {x, y}, ... ] ]
let currentDrawingPolygon = [];
let roiCanvas = null;
let roiCtx = null;

function initRoiEditor(canvasId) {
  roiCanvas = document.getElementById(canvasId);
  if (!roiCanvas) return;
  roiCtx = roiCanvas.getContext('2d');

  roiCanvas.addEventListener('click', (e) => {
    const rect = roiCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // If clicking close to starting point and length >= 3, close polygon
    if (currentDrawingPolygon.length >= 3) {
      const first = currentDrawingPolygon[0];
      const dist = Math.hypot((first.x - x) * rect.width, (first.y - y) * rect.height);
      if (dist < 20) {
        roiPolygons.push([...currentDrawingPolygon]);
        currentDrawingPolygon = [];
        renderRoiCanvas();
        return;
      }
    }

    currentDrawingPolygon.push({ x, y });
    renderRoiCanvas();
  });
}

function renderRoiCanvas() {
  if (!roiCanvas || !roiCtx) return;
  const w = roiCanvas.width;
  const h = roiCanvas.height;

  roiCtx.clearRect(0, 0, w, h);

  // Background guide grid
  roiCtx.fillStyle = '#0f172a';
  roiCtx.fillRect(0, 0, w, h);

  roiCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  roiCtx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) {
    roiCtx.beginPath();
    roiCtx.moveTo(x, 0);
    roiCtx.lineTo(x, h);
    roiCtx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    roiCtx.beginPath();
    roiCtx.moveTo(0, y);
    roiCtx.lineTo(w, y);
    roiCtx.stroke();
  }

  // Draw completed polygons
  for (const poly of roiPolygons) {
    if (poly.length < 3) continue;
    roiCtx.beginPath();
    roiCtx.moveTo(poly[0].x * w, poly[0].y * h);
    for (let i = 1; i < poly.length; i++) {
      roiCtx.lineTo(poly[i].x * w, poly[i].y * h);
    }
    roiCtx.closePath();
    roiCtx.fillStyle = 'rgba(59, 130, 246, 0.25)';
    roiCtx.fill();
    roiCtx.strokeStyle = '#3b82f6';
    roiCtx.lineWidth = 2;
    roiCtx.stroke();

    // Draw vertex dots
    for (const pt of poly) {
      roiCtx.beginPath();
      roiCtx.arc(pt.x * w, pt.y * h, 4, 0, Math.PI * 2);
      roiCtx.fillStyle = '#60a5fa';
      roiCtx.fill();
    }
  }

  // Draw currently drawing polygon
  if (currentDrawingPolygon.length > 0) {
    roiCtx.beginPath();
    roiCtx.moveTo(currentDrawingPolygon[0].x * w, currentDrawingPolygon[0].y * h);
    for (let i = 1; i < currentDrawingPolygon.length; i++) {
      roiCtx.lineTo(currentDrawingPolygon[i].x * w, currentDrawingPolygon[i].y * h);
    }
    roiCtx.strokeStyle = '#f59e0b';
    roiCtx.lineWidth = 2;
    roiCtx.setLineDash([4, 4]);
    roiCtx.stroke();
    roiCtx.setLineDash([]);

    // Draw vertex dots
    for (let i = 0; i < currentDrawingPolygon.length; i++) {
      const pt = currentDrawingPolygon[i];
      roiCtx.beginPath();
      roiCtx.arc(pt.x * w, pt.y * h, i === 0 ? 6 : 4, 0, Math.PI * 2);
      roiCtx.fillStyle = i === 0 ? '#10b981' : '#fbbf24';
      roiCtx.fill();
    }
  }
}

function clearRoiPolygons() {
  roiPolygons = [];
  currentDrawingPolygon = [];
  renderRoiCanvas();
}

function loadRoiConfig(cameraId, cameraName, roiConfig) {
  activeRoiCameraId = cameraId;
  document.getElementById('roi-modal-cam-name').textContent = cameraName;

  roiPolygons = [];
  currentDrawingPolygon = [];

  if (roiConfig && roiConfig.polygons) {
    roiPolygons = JSON.parse(JSON.stringify(roiConfig.polygons));
  }

  renderRoiCanvas();
}

function getRoiConfig() {
  return {
    enabled: roiPolygons.length > 0,
    polygons: roiPolygons
  };
}
