/**
 * ocrEngine.js — Text extraction for balloon anchor boxes.
 *
 * Pipeline (stop at first usable result):
 *   1. PDF.js text layer    — fully local, fastest, best for digital PDFs
 *   2. Tesseract.js + WASM  — local OCR on a rendered crop, no network
 *   3. Claude vision API    — last resort, only the crop image is sent
 *
 * Coordinates are in PDF user space (the same space pdf.js gives us in
 * page.getTextContent() transforms). Callers pass anchor boxes already in
 * PDF coords.
 */

window.PSB = window.PSB || {};

var OCR_FALLBACK_MODEL = 'claude-sonnet-4-6';

// Tesseract worker — created once, reused for every crop.
var _tesseractWorker = null;
var _tesseractWorkerPromise = null;

function getApiKey() {
  return (window.PSB_CONFIG && window.PSB_CONFIG.anthropicApiKey) || null;
}

// ── Step 1: PDF.js text layer ────────────────────────────
/**
 * Extract text from a PDF page within the given anchor box (PDF coords).
 * Returns the joined string in approximate reading order, or '' if no
 * intersecting text items.
 */
function extractTextFromPdfLayer(page, anchorBox, viewport) {
  // anchorBox is in PDF user space (Y grows UP). Text items are also in PDF
  // user space, so both can be compared without flipping.
  var margin = 5;
  return page.getTextContent().then(function(content) {
    var hits = [];
    for (var i = 0; i < content.items.length; i++) {
      var item = content.items[i];
      if (!item.transform || !item.str) continue;
      var x = item.transform[4];
      var yBottom = item.transform[5];
      var size = Math.sqrt(item.transform[0] * item.transform[0] +
                           item.transform[1] * item.transform[1]) || 10;
      var w = item.width || (item.str.length * size * 0.5);
      var h = size;
      var rect = { x: x, y: yBottom, w: w, h: h };

      if (rectsIntersect(rect, expandRect(anchorBox, margin))) {
        hits.push({ str: item.str, x: x, y: yBottom, h: h });
      }
    }

    if (hits.length === 0) return '';
    // Reading order in PDF user space (Y up): top-to-bottom = y DESC,
    // then left-to-right = x ASC.
    hits.sort(function(a, b) {
      if (Math.abs(a.y - b.y) > a.h * 0.6) return b.y - a.y;
      return a.x - b.x;
    });
    return hits.map(function(h) { return h.str; }).join(' ').replace(/\s+/g, ' ').trim();
  });
}

function expandRect(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

function rectsIntersect(a, b) {
  return !(a.x + a.w < b.x ||
           b.x + b.w < a.x ||
           a.y + a.h < b.y ||
           b.y + b.h < a.y);
}

// ── Step 2: Tesseract.js ─────────────────────────────────
/**
 * Initialize the Tesseract worker pointed at our vendored core + traineddata.
 * Runs once; subsequent calls return the same promise.
 */
function getTesseractWorker() {
  if (_tesseractWorker) return Promise.resolve(_tesseractWorker);
  if (_tesseractWorkerPromise) return _tesseractWorkerPromise;

  if (typeof Tesseract === 'undefined') {
    return Promise.reject(new Error('Tesseract library not loaded'));
  }

  // Resolve lib paths relative to index.html.
  var base = 'lib/tesseract/';
  _tesseractWorkerPromise = Tesseract.createWorker('eng', 1, {
    workerPath: base + 'worker.min.js',
    corePath:   base + 'tesseract-core-simd.wasm.js',
    langPath:   base,                // expects eng.traineddata or .traineddata.gz here
    gzip:       true,
  }).then(function(worker) {
    _tesseractWorker = worker;
    _tesseractWorkerPromise = null;
    return worker;
  }).catch(function(err) {
    _tesseractWorkerPromise = null;
    throw err;
  });
  return _tesseractWorkerPromise;
}

/**
 * Render the anchor box region from a PDF page to an offscreen canvas at 2x scale.
 * Returns { canvas, dataUrl }. Caller is responsible for the canvas lifecycle.
 */
function renderAnchorCrop(page, anchorBox, baseScale) {
  var scale = (baseScale || 2.0);
  var viewport = page.getViewport({ scale: scale });
  var pageHeight = viewport.height;
  var pageWidth = viewport.width;

  // anchorBox is in PDF user space (Y up). Canvas uses Y down from top-left,
  // so flip: canvas_y = pageHeight - (anchorBox_y + anchorBox_h) * scale.
  var px = anchorBox.x * scale;
  var py = pageHeight - (anchorBox.y + anchorBox.h) * scale;
  var pw = anchorBox.w * scale;
  var ph = anchorBox.h * scale;
  // Clamp to page bounds.
  px = Math.max(0, Math.min(pageWidth - 1, px));
  py = Math.max(0, Math.min(pageHeight - 1, py));
  pw = Math.max(1, Math.min(pageWidth - px, pw));
  ph = Math.max(1, Math.min(pageHeight - py, ph));

  // Render whole page to an offscreen canvas (only the cropped region is used).
  var fullCanvas = document.createElement('canvas');
  fullCanvas.width = pageWidth;
  fullCanvas.height = pageHeight;
  var fullCtx = fullCanvas.getContext('2d');

  return page.render({ canvasContext: fullCtx, viewport: viewport }).promise.then(function() {
    var cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.ceil(pw);
    cropCanvas.height = Math.ceil(ph);
    var cropCtx = cropCanvas.getContext('2d');

    // Light contrast bump before OCR.
    cropCtx.filter = 'contrast(1.25) saturate(0)';
    cropCtx.drawImage(fullCanvas, px, py, pw, ph, 0, 0, cropCanvas.width, cropCanvas.height);
    cropCtx.filter = 'none';

    return cropCanvas;
  });
}

function canvasToBase64Png(canvas) {
  var dataUrl = canvas.toDataURL('image/png');
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}

function runTesseract(cropCanvas) {
  return getTesseractWorker().then(function(worker) {
    return worker.recognize(cropCanvas);
  }).then(function(result) {
    var d = (result && result.data) || {};
    return {
      text: (d.text || '').trim(),
      confidence: typeof d.confidence === 'number' ? (d.confidence / 100) : 0,
    };
  });
}

// ── Step 3: Claude vision fallback ───────────────────────
function callClaudeOcr(base64ImagePng) {
  var apiKey = getApiKey();
  if (!apiKey) return Promise.resolve(null);

  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: OCR_FALLBACK_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64ImagePng } },
          { type: 'text', text: 'This is a crop from an engineering drawing. Extract all dimension text exactly as written. Include the nominal value, tolerance (if shown), and any modifiers like Thru, REF, °, ±, GD&T symbols. Return only the raw extracted text, nothing else.' },
        ],
      }],
    }),
  }).then(function(resp) {
    if (!resp.ok) return null;
    return resp.json();
  }).then(function(data) {
    if (!data || !data.content || !data.content[0]) return null;
    var text = data.content[0].text;
    return (text || '').trim() || null;
  }).catch(function(err) {
    console.warn('[OCR] Claude call failed:', err);
    return null;
  });
}

// ── Parsing the raw OCR text ─────────────────────────────
var GDT_CHARS = /[⏤⏥○⌭⌒⌓⊚↗⌖⊕⊘◎ⒶⒻⓂⓁⓅⓈⓉⓊ]/;
var DIGIT_RE = /\d/;

/**
 * Split a raw OCR string into structured dimension fields the same way
 * parser.parseDimension does, but starting from one combined text blob.
 *
 * Returns:
 *   {
 *     drawingSpec, nominal, tolerance,
 *     specUnit1, specUnit2, specUnit3,
 *     isGDT, isNote, confidence: 'high' | 'medium' | 'low'
 *   }
 */
function parseOcrText(rawText) {
  var text = (rawText || '').trim();
  var out = {
    drawingSpec: '', nominal: '', tolerance: '',
    specUnit1: '', specUnit2: '', specUnit3: '',
    isGDT: false, isNote: false, confidence: 'low',
  };
  if (!text) return out;

  // GD&T short-circuit: keep raw text in drawingSpec, mark as note.
  if (GDT_CHARS.test(text)) {
    out.drawingSpec = text;
    out.isGDT = true;
    out.isNote = true;
    out.confidence = 'low';
    return out;
  }

  // Separate the spec body from any tolerance portion. We treat anything
  // including ±, +/-, +.../-..., +X/-Y as tolerance and the rest as spec.
  var tolMatch = text.match(/(±\s*\.?[0-9.]+|\+\s*\/\s*-\s*\.?[0-9.]+|\+\s*\.?[0-9.]+\s*\/\s*-\s*\.?[0-9.]+|\+\s*\.?[0-9.]+\s*[-–]\s*\.?[0-9.]+)/);
  var specBody = text;
  var tolText = '';
  if (tolMatch) {
    tolText = tolMatch[0];
    specBody = (text.slice(0, tolMatch.index) + text.slice(tolMatch.index + tolMatch[0].length)).trim();
    // Normalize "+X/-Y" → "+X -Y" so PSB.parseTolerance recognises the asymmetric form.
    tolText = tolText.replace(/\+\s*(\.?[0-9.]+)\s*\/\s*-\s*(\.?[0-9.]+)/, '+$1 -$2');
  }

  var su = PSB.parseSpecUnits(specBody);
  out.specUnit1 = su.su1 || '';
  out.specUnit2 = su.su2 || '';
  out.specUnit3 = su.su3 || '';

  var cleaned = su.cleaned;
  // The drawing spec we want to store: numeric value (with leading dot/zero etc.)
  // Pull the first numeric run out of `cleaned`.
  var numMatch = cleaned.match(/-?\.?\d+(?:\.\d+)?/);
  if (numMatch) {
    out.drawingSpec = numMatch[0];
    out.nominal = numMatch[0];
  } else {
    out.drawingSpec = cleaned;
  }

  // Tolerance normalization: parseTolerance returns numeric plus/minus.
  if (tolText) {
    var parsedTol = PSB.parseTolerance(tolText);
    if (parsedTol.isSymmetric && parsedTol.tolPlus > 0) {
      out.tolerance = String(parsedTol.tolPlus);
    } else if (parsedTol.tolPlus || parsedTol.tolMinus) {
      out.tolerance = '+' + parsedTol.tolPlus + '-' + parsedTol.tolMinus;
    }
  }

  // Confidence scoring.
  if (out.drawingSpec && DIGIT_RE.test(out.drawingSpec) && out.tolerance) {
    out.confidence = 'high';
  } else if (out.drawingSpec && DIGIT_RE.test(out.drawingSpec)) {
    out.confidence = 'medium';
  } else if (!DIGIT_RE.test(text)) {
    out.confidence = 'low';
    out.isNote = true;
    out.drawingSpec = text;
  }
  return out;
}

// ── Orchestrator ─────────────────────────────────────────
/**
 * Run the full OCR pipeline for an anchor box on a given pdf.js page.
 *
 * @param {Object} page       — pdf.js page proxy
 * @param {Object} anchorBox  — { x, y, w, h } in PDF user space
 * @param {Object} viewport   — current pdf.js viewport (for coord conversion)
 * @param {Object} [opts]
 * @param {Function} [opts.onProgress] — receives 'pdfjs' | 'tesseract' | 'claude' | 'done'
 * @returns {Promise<{ parsed, engine, rawText, ocrConfidence }>}
 */
function extractDimension(page, anchorBox, viewport, opts) {
  opts = opts || {};
  var notify = opts.onProgress || function() {};

  // ── Step 1 ────────────────────────────────────────────
  notify('pdfjs');
  return extractTextFromPdfLayer(page, anchorBox, viewport).then(function(layerText) {
    if (layerText && DIGIT_RE.test(layerText)) {
      var parsed = parseOcrText(layerText);
      return { parsed: parsed, engine: 'pdfjs', rawText: layerText, ocrConfidence: 0.95 };
    }
    // ── Step 2 ───────────────────────────────────────
    notify('tesseract');
    return renderAnchorCrop(page, anchorBox, 3.0).then(function(crop) {
      return runTesseract(crop).then(function(tres) {
        if (tres.text && DIGIT_RE.test(tres.text) && tres.confidence > 0.55) {
          var parsed = parseOcrText(tres.text);
          return { parsed: parsed, engine: 'tesseract', rawText: tres.text, ocrConfidence: tres.confidence };
        }
        // ── Step 3 ───────────────────────────────
        if (!getApiKey()) {
          // No key → return whatever we have, even if blank.
          var fallback = parseOcrText(tres.text || layerText || '');
          return { parsed: fallback, engine: tres.text ? 'tesseract' : null, rawText: tres.text || '', ocrConfidence: tres.confidence };
        }
        notify('claude');
        var b64 = canvasToBase64Png(crop);
        return callClaudeOcr(b64).then(function(claudeText) {
          if (!claudeText) {
            var fallback = parseOcrText(tres.text || layerText || '');
            return { parsed: fallback, engine: null, rawText: tres.text || '', ocrConfidence: 0 };
          }
          var parsed = parseOcrText(claudeText);
          return { parsed: parsed, engine: 'claude', rawText: claudeText, ocrConfidence: 0.7 };
        });
      });
    }).catch(function(err) {
      console.warn('[OCR] Tesseract/Claude path failed:', err);
      var parsed = parseOcrText(layerText || '');
      return { parsed: parsed, engine: layerText ? 'pdfjs' : null, rawText: layerText || '', ocrConfidence: 0 };
    });
  }).then(function(result) {
    notify('done');
    return result;
  });
}

// ── Cleanup ──────────────────────────────────────────────
window.addEventListener('beforeunload', function() {
  if (_tesseractWorker && _tesseractWorker.terminate) {
    try { _tesseractWorker.terminate(); } catch (e) { /* noop */ }
  }
});

// ── Exports ──────────────────────────────────────────────
PSB.ocrEngine = {
  extractDimension: extractDimension,
  extractTextFromPdfLayer: extractTextFromPdfLayer,
  renderAnchorCrop: renderAnchorCrop,
  runTesseract: runTesseract,
  callClaudeOcr: callClaudeOcr,
  parseOcrText: parseOcrText,
  getApiKey: getApiKey,
};
