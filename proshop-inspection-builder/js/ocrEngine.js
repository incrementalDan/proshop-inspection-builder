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
  //
  // A text item is captured only when its bounding box lies MOSTLY inside the
  // anchor box (>= 50% of the item's own area). This rejects two failure modes:
  // a neighbour clipping an edge contributes little of its area, and a line
  // above/below the box has no vertical overlap. A looser center-point test was
  // tried but grabbed stray layer items near the box on drawings whose text
  // layer doesn't match the visible ink; that wrong hit then short-circuited the
  // OCR fallback (see extractDimension). When a real dimension isn't in the text
  // layer, this rule correctly returns nothing so pixel OCR runs instead.
  var MIN_INSIDE = 0.5;
  return page.getTextContent().then(function(content) {
    var hits = [];
    for (var i = 0; i < content.items.length; i++) {
      var item = content.items[i];
      if (!item.transform || !item.str || !item.str.trim()) continue;
      var x = item.transform[4];
      var yBottom = item.transform[5];   // text baseline in PDF user space (Y up)
      var size = Math.sqrt(item.transform[0] * item.transform[0] +
                           item.transform[1] * item.transform[1]) || 10;
      var w = item.width || (item.str.length * size * 0.5);
      var h = item.height || size;
      var textRect = { x: x, y: yBottom, w: w, h: h };

      if (areaInsideFraction(textRect, anchorBox) >= MIN_INSIDE) {
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

// Fraction of rect A's area that lies within rect B (0..1).
function areaInsideFraction(a, b) {
  var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  return (ox * oy) / Math.max(a.w * a.h, 1e-6);
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

// ── GD&T: Claude vision with structured-JSON prompt ──────
//
// Feature control frames are visually complex and Tesseract can't read them.
// This skips the text-layer/Tesseract steps and goes straight to Claude with
// a prompt that demands a JSON-only response. The result is parsed and
// validated by gdtParser.parseGdtResponse — caller gets the populated
// user.gdt shape or an { _error } sentinel.
var GDT_OCR_MODEL = 'claude-sonnet-4-6';
var GDT_OCR_SYSTEM_PROMPT =
  'You are an engineering drawing OCR assistant specializing in GD&T ' +
  '(Geometric Dimensioning and Tolerancing). Extract the feature control frame ' +
  'from this image. Respond ONLY with a JSON object — no commentary, no markdown, ' +
  'no code fences, no explanation. JSON shape: { ' +
  '"characteristic": string (one of: position, flatness, straightness, circularity, ' +
  'cylindricity, profileLine, profileSurface, angularity, perpendicularity, parallelism, ' +
  'concentricity, symmetry, circularRunout, totalRunout), ' +
  '"hasDiameter": boolean, ' +
  '"tolerance": string (numeric, unrounded, e.g. "0.014"), ' +
  '"materialCondition": string or null (one of "mmc", "lmc", "rfs", or null), ' +
  '"datums": array of { "letter": string, "materialCondition": string or null }, ' +
  '"isComposite": boolean, ' +
  '"compositeUpper": null, ' +
  '"compositeLower": null }';

function stripJsonFences(text) {
  // Some responses wrap the JSON in ```json … ``` despite the prompt. Strip them.
  var s = String(text || '').trim();
  if (s.indexOf('```') !== 0) return s;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return s.trim();
}

function extractGdtFromCrop(base64ImagePng) {
  var apiKey = getApiKey();
  if (!apiKey) {
    return Promise.resolve({ _error: 'no_api_key', rawText: null });
  }
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: GDT_OCR_MODEL,
      max_tokens: 600,
      system: GDT_OCR_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64ImagePng } },
          { type: 'text', text: 'Extract this feature control frame as JSON.' },
        ],
      }],
    }),
  }).then(function(resp) {
    if (!resp.ok) return { _error: 'http_' + resp.status, rawText: null };
    return resp.json();
  }).then(function(data) {
    if (data && data._error) return data;
    if (!data || !data.content || !data.content[0]) {
      return { _error: 'no_content', rawText: null };
    }
    var rawText = (data.content[0].text || '').trim();
    var jsonText = stripJsonFences(rawText);
    var parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (err) {
      return { _error: 'parse_failed', rawText: rawText };
    }
    parsed._raw = rawText;
    var gdt = PSB.parseGdtResponse(parsed);
    if (gdt && gdt._error) {
      gdt.rawText = rawText;
      return gdt;
    }
    return gdt;
  }).catch(function(err) {
    console.warn('[GD&T OCR] Claude call failed:', err);
    return { _error: 'network', rawText: String(err && err.message || err) };
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
    drawingSpec: '', nominal: '', tolerance: '', tolMode: 'sym',
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

  // Thread / general-note short-circuit. A thread callout ("M4X0.7 - 6H THRU")
  // or a shop note contains digits but is NOT a dimension: it must keep its
  // full text and be flagged as a note so the math pipeline skips it, rather
  // than being decomposed into a bogus nominal/tolerance. detectFeatureType
  // owns the thread/note patterns — reuse it instead of duplicating them here.
  var featureType = (PSB.detectFeatureType ? PSB.detectFeatureType(text) : 'dimension');
  if (featureType === 'thread' || featureType === 'note') {
    out.drawingSpec = text;
    out.isNote = true;
    out.confidence = DIGIT_RE.test(text) ? 'medium' : 'low';
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
  // tolMode is the popover's starting mode: ± yields 'sym', +X/-Y yields 'asym'.
  // ('minmax' is never inferred from OCR — drawings don't use that notation.)
  if (tolText) {
    var parsedTol = PSB.parseTolerance(tolText);
    if (parsedTol.isSymmetric && parsedTol.tolPlus > 0) {
      out.tolerance = String(parsedTol.tolPlus);
      out.tolMode = 'sym';
    } else if (parsedTol.tolPlus || parsedTol.tolMinus) {
      out.tolerance = '+' + parsedTol.tolPlus + '-' + parsedTol.tolMinus;
      out.tolMode = 'asym';
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

// Padding (PDF points) added around the user's drawn box before OCR. The PDF
// text layer proved unreliable — misaligned on digital prints and, on scanned
// "searchable" PDFs, a hidden OCR layer offset from the ink — so extraction now
// reads the rendered PIXELS inside the box. A little padding means a slightly
// loose box still captures the whole glyph run. Only the OCR crop is padded;
// the caller's anchorBox (balloon anchor + leader target) is left untouched.
var OCR_CROP_PAD_PT = 5;
function padBoxForOcr(box) {
  var m = OCR_CROP_PAD_PT;
  return { x: box.x - m, y: box.y - m, w: box.w + 2 * m, h: box.h + 2 * m };
}

/**
 * Run the pixel-based OCR pipeline for an anchor box on a given pdf.js page.
 *
 * Modes (opts.ocrMode):
 *   'tesseract' (default) — local Tesseract first; Claude vision only as a
 *                           fallback when Tesseract is weak/empty.
 *   'claude'              — always Claude vision (skips Tesseract). Falls back
 *                           to Tesseract if no API key is configured.
 *
 * @param {Object} page       — pdf.js page proxy
 * @param {Object} anchorBox  — { x, y, w, h } in PDF user space
 * @param {Object} viewport   — current pdf.js viewport (unused now; kept for API stability)
 * @param {Object} [opts]
 * @param {Function} [opts.onProgress] — receives 'tesseract' | 'claude' | 'claude-gdt' | 'done'
 * @param {string} [opts.ocrMode]      — 'tesseract' | 'claude'
 * @returns {Promise<{ parsed, engine, rawText, ocrConfidence }>}
 */
function extractDimension(page, anchorBox, viewport, opts) {
  opts = opts || {};
  var notify = opts.onProgress || function() {};
  var mode = (opts.ocrMode === 'claude') ? 'claude' : 'tesseract';
  var ocrBox = padBoxForOcr(anchorBox);

  function done(result) { notify('done'); return result; }

  // GD&T branch: structured JSON via Claude, wrapped in the standard envelope.
  function runGdt(reason) {
    notify('claude-gdt');
    return renderAnchorCrop(page, ocrBox, 3.0).then(function(crop) {
      var b64 = canvasToBase64Png(crop);
      return extractGdtFromCrop(b64).then(function(gdt) {
        if (!gdt || gdt._error) {
          return {
            parsed: parseOcrText(''), engine: 'claude-gdt',
            rawText: (gdt && gdt.rawText) || '', ocrConfidence: 0,
            gdtError: gdt ? gdt._error : 'unknown', gdt: null,
          };
        }
        return {
          parsed: {
            drawingSpec: gdt.tolerance, nominal: gdt.tolerance, tolerance: '',
            specUnit1: gdt.su1, specUnit2: gdt.su2, specUnit3: '',
            isGDT: true, isNote: true, confidence: 'high',
          },
          engine: 'claude-gdt', rawText: gdt.rawOcrText || '',
          ocrConfidence: 0.9, gdt: gdt, gdtSignalSource: reason,
        };
      });
    });
  }

  // Turn a finished OCR string into the standard envelope. parseOcrText handles
  // thread/note classification (so "M4X0.7 - 6H THRU" becomes a note, not a
  // bogus dimension); GD&T frames route to the structured extractor.
  function fromText(text, engine, conf) {
    if (text && PSB.isGdtLikely(text)) return runGdt(engine);
    return { parsed: parseOcrText(text || ''), engine: text ? engine : null, rawText: text || '', ocrConfidence: conf };
  }

  function viaClaude(crop) {
    notify('claude');
    return callClaudeOcr(canvasToBase64Png(crop)).then(function(claudeText) {
      if (!claudeText) return { parsed: parseOcrText(''), engine: null, rawText: '', ocrConfidence: 0 };
      return fromText(claudeText, 'claude', 0.85);
    });
  }

  return renderAnchorCrop(page, ocrBox, 3.0).then(function(crop) {
    // Always-Claude mode (global setting). Degrades to Tesseract only when no
    // API key is present, so ballooning still works before the key is added.
    if (mode === 'claude' && getApiKey()) return viaClaude(crop);

    // Default: Tesseract first (local, cheap), Claude as the accuracy backstop.
    notify('tesseract');
    return runTesseract(crop).then(function(tres) {
      if (tres.text && PSB.isGdtLikely(tres.text)) return runGdt('tesseract');
      if (tres.text && DIGIT_RE.test(tres.text) && tres.confidence > 0.55) {
        return { parsed: parseOcrText(tres.text), engine: 'tesseract', rawText: tres.text, ocrConfidence: tres.confidence };
      }
      // Tesseract weak/empty → Claude vision fallback when a key is available.
      if (!getApiKey()) {
        return { parsed: parseOcrText(tres.text || ''), engine: tres.text ? 'tesseract' : null, rawText: tres.text || '', ocrConfidence: tres.confidence };
      }
      notify('claude');
      return callClaudeOcr(canvasToBase64Png(crop)).then(function(claudeText) {
        if (!claudeText) {
          return { parsed: parseOcrText(tres.text || ''), engine: tres.text ? 'tesseract' : null, rawText: tres.text || '', ocrConfidence: tres.confidence };
        }
        return fromText(claudeText, 'claude', 0.7);
      });
    });
  }).catch(function(err) {
    console.warn('[OCR] extraction failed:', err);
    return { parsed: parseOcrText(''), engine: null, rawText: '', ocrConfidence: 0 };
  }).then(done);
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
  extractGdtFromCrop: extractGdtFromCrop,
  parseOcrText: parseOcrText,
  getApiKey: getApiKey,
};
