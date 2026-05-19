/**
 * pdfViewer.js — PDF Viewer Module (Phase 1: View Only)
 *
 * Renders engineering drawings using pdf.js (canvas-based).
 * Completely independent of CSV/table logic.
 * If no PDF is loaded, the app behaves identically to before.
 */

window.PSB = window.PSB || {};

// ── Internal State ───────────────────────────────────────
var pdfDoc = null;
var pdfCurrentPage = 1;
var pdfTotalPages = 0;
var pdfZoom = 1.0;
var pdfFileName = null;
var pdfArrayBuffer = null;
var pdfFileHandle = null;
var pdfRenderTask = null;

var PDF_MIN_ZOOM = 0.25;
var PDF_MAX_ZOOM = 4.0;
var PDF_ZOOM_STEP = 0.25;

// ── DOM References (set in initPdfViewer) ────────────────
var elViewer, elToolbar, elCanvasWrap, elCanvas, elCtx;
var elPageInfo, elFilename, elResizer, elLeftPanel;
var btnPrev, btnNext, btnZoomIn, btnZoomOut, btnZoomFit, btnClose;

// ── IndexedDB (File Handle Persistence) ──────────────────
var IDB_NAME = 'psb_pdf_store';
var IDB_STORE = 'handles';
var IDB_KEY = 'currentPdfHandle';

function openIDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror = function() { reject(req.error); };
  });
}

function savePdfHandleToIDB(handle) {
  return openIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }).catch(function(err) {
    console.warn('[PSB-PDF] IDB save handle failed:', err);
  });
}

function getPdfHandleFromIDB() {
  return openIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readonly');
      var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror = function() { reject(req.error); };
    });
  }).catch(function(err) {
    console.warn('[PSB-PDF] IDB get handle failed:', err);
    return null;
  });
}

function clearPdfHandleFromIDB() {
  return openIDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }).catch(function(err) {
    console.warn('[PSB-PDF] IDB clear handle failed:', err);
  });
}

// ── Initialization ───────────────────────────────────────
function initPdfViewer() {
  elViewer = document.getElementById('pdf-viewer');
  elCanvasWrap = document.getElementById('pdf-canvas-wrap');
  elCanvas = document.getElementById('pdf-canvas');
  elCtx = elCanvas.getContext('2d');
  elPageInfo = document.getElementById('pdf-page-info');
  elFilename = document.getElementById('pdf-filename');
  elResizer = document.getElementById('pdf-resizer');
  elLeftPanel = document.getElementById('left-panel');

  btnPrev = document.getElementById('pdf-prev');
  btnNext = document.getElementById('pdf-next');
  btnZoomIn = document.getElementById('pdf-zoom-in');
  btnZoomOut = document.getElementById('pdf-zoom-out');
  btnZoomFit = document.getElementById('pdf-zoom-fit');
  btnClose = document.getElementById('pdf-close');

  // Upload button — use File System Access API to get a persistent handle
  var btnUpload = document.getElementById('btn-upload-pdf');
  var fileInput = document.getElementById('file-import-pdf');
  if (btnUpload) {
    btnUpload.addEventListener('click', function() {
      if (window.showOpenFilePicker) {
        window.showOpenFilePicker({
          types: [{ description: 'PDF Document', accept: { 'application/pdf': ['.pdf'] } }],
          multiple: false,
        }).then(function(handles) {
          var handle = handles[0];
          pdfFileHandle = handle;
          savePdfHandleToIDB(handle);
          return handle.getFile();
        }).then(function(file) {
          loadPdfFromFile(file);
        }).catch(function(err) {
          if (err.name !== 'AbortError') console.warn('[PSB-PDF] Open failed:', err);
        });
      } else if (fileInput) {
        fileInput.click();
      }
    });
    if (fileInput) {
      fileInput.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (file) loadPdfFromFile(file);
        e.target.value = '';
      });
    }
  }

  // Toolbar buttons
  btnPrev.addEventListener('click', function() { goToPage(pdfCurrentPage - 1); });
  btnNext.addEventListener('click', function() { goToPage(pdfCurrentPage + 1); });
  btnZoomIn.addEventListener('click', function() { setZoom(pdfZoom + PDF_ZOOM_STEP); });
  btnZoomOut.addEventListener('click', function() { setZoom(pdfZoom - PDF_ZOOM_STEP); });
  btnZoomFit.addEventListener('click', function() { zoomFit(); });
  btnClose.addEventListener('click', function() { closePdf(); });

  // Pan (click-drag scrolling)
  setupPan();

  // Ctrl+Wheel zoom
  elCanvasWrap.addEventListener('wheel', function(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) setZoom(pdfZoom + PDF_ZOOM_STEP);
      else setZoom(pdfZoom - PDF_ZOOM_STEP);
    }
  }, { passive: false });

  // Keyboard navigation
  elCanvasWrap.addEventListener('keydown', function(e) {
    if (!pdfDoc) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      goToPage(pdfCurrentPage - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      goToPage(pdfCurrentPage + 1);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(pdfZoom + PDF_ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(pdfZoom - PDF_ZOOM_STEP);
    }
  });

  // Horizontal resizer
  setupPdfResizer();

  // Re-fit on window resize
  var resizeTimer;
  window.addEventListener('resize', function() {
    if (!pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function() { zoomFit(); }, 150);
  });

  console.log('[PSB-PDF] PDF viewer initialized');
}

// ── Load PDF from File ───────────────────────────────────
function loadPdfFromFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;

  var reader = new FileReader();
  reader.onload = function(e) {
    pdfArrayBuffer = e.target.result;
    pdfFileName = file.name;

    loadPdfFromArrayBuffer(pdfArrayBuffer).then(function() {
      if (PSB.setPdfFileName) PSB.setPdfFileName(pdfFileName);
      elFilename.textContent = pdfFileName;
      PSB.showToast('PDF loaded: ' + pdfFileName, 'success');
    });
  };
  reader.readAsArrayBuffer(file);
}

function waitForPdfjsLib() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise(function(resolve) {
    window.addEventListener('pdfjsReady', resolve, { once: true });
  });
}

function loadPdfFromArrayBuffer(buffer) {
  return waitForPdfjsLib().then(function() {
    var data = new Uint8Array(buffer);
    var loadingTask = window.pdfjsLib.getDocument({ data: data });
    return loadingTask.promise;
  }).then(function(doc) {
    pdfDoc = doc;
    pdfTotalPages = doc.numPages;
    pdfCurrentPage = 1;
    showPdfViewer();
    return zoomFit();
  }).catch(function(err) {
    console.error('[PSB-PDF] Failed to load PDF:', err);
    PSB.showToast('Failed to load PDF: ' + err.message, 'error');
  });
}

// ── Page Navigation ──────────────────────────────────────
function goToPage(num) {
  if (!pdfDoc) return;
  if (num < 1 || num > pdfTotalPages) return;
  pdfCurrentPage = num;
  renderPage();
}

function updatePageInfo() {
  if (elPageInfo) {
    elPageInfo.textContent = pdfCurrentPage + ' / ' + pdfTotalPages;
  }
  if (btnPrev) btnPrev.disabled = pdfCurrentPage <= 1;
  if (btnNext) btnNext.disabled = pdfCurrentPage >= pdfTotalPages;
}

// ── Render ───────────────────────────────────────────────
function renderPage() {
  if (!pdfDoc) return Promise.resolve();

  // Cancel any in-progress render
  if (pdfRenderTask) {
    pdfRenderTask.cancel();
    pdfRenderTask = null;
  }

  updatePageInfo();

  return pdfDoc.getPage(pdfCurrentPage).then(function(page) {
    var viewport = page.getViewport({ scale: pdfZoom });
    var dpr = window.devicePixelRatio || 1;

    elCanvas.width = viewport.width * dpr;
    elCanvas.height = viewport.height * dpr;
    elCanvas.style.width = viewport.width + 'px';
    elCanvas.style.height = viewport.height + 'px';

    elCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var renderContext = {
      canvasContext: elCtx,
      viewport: viewport,
    };

    pdfRenderTask = page.render(renderContext);
    return pdfRenderTask.promise.then(function() {
      pdfRenderTask = null;
    }).catch(function(err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.warn('[PSB-PDF] Render error:', err);
    });
  });
}

// ── Zoom ─────────────────────────────────────────────────
function setZoom(newZoom) {
  newZoom = Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, newZoom));
  newZoom = Math.round(newZoom * 100) / 100;
  if (newZoom === pdfZoom) return;
  pdfZoom = newZoom;
  renderPage();
}

function zoomFit() {
  if (!pdfDoc) return Promise.resolve();

  return pdfDoc.getPage(pdfCurrentPage).then(function(page) {
    var viewport = page.getViewport({ scale: 1.0 });
    var wrapRect = elCanvasWrap.getBoundingClientRect();
    var padFraction = 0.95;
    var scaleW = (wrapRect.width * padFraction) / viewport.width;
    var scaleH = (wrapRect.height * padFraction) / viewport.height;
    pdfZoom = Math.min(scaleW, scaleH);
    pdfZoom = Math.max(PDF_MIN_ZOOM, Math.min(PDF_MAX_ZOOM, pdfZoom));
    pdfZoom = Math.round(pdfZoom * 100) / 100;
    return renderPage();
  });
}

// ── Show / Hide ──────────────────────────────────────────
function showPdfViewer() {
  elViewer.classList.remove('hidden');
  elResizer.classList.remove('hidden');
  elLeftPanel.classList.add('has-pdf');
  // Remove any fixed height on viewer so flex works
  elViewer.style.height = '';
}

function hidePdfViewer() {
  elViewer.classList.add('hidden');
  elResizer.classList.add('hidden');
  elLeftPanel.classList.remove('has-pdf');
  elViewer.style.height = '';
}

// ── Close PDF ────────────────────────────────────────────
function closePdf() {
  pdfDoc = null;
  pdfCurrentPage = 1;
  pdfTotalPages = 0;
  pdfZoom = 1.0;
  pdfFileName = null;
  pdfArrayBuffer = null;
  pdfFileHandle = null;
  pdfRenderTask = null;

  hidePdfViewer();
  clearPdfHandleFromIDB();

  if (PSB.setPdfFileName) PSB.setPdfFileName(null);

  // Clear canvas
  if (elCanvas) {
    elCtx.clearRect(0, 0, elCanvas.width, elCanvas.height);
    elCanvas.width = 0;
    elCanvas.height = 0;
  }
  if (elPageInfo) elPageInfo.textContent = '— / —';
  if (elFilename) elFilename.textContent = '';
}

// ── Pan (click-drag scroll) ──────────────────────────────
function setupPan() {
  var isPanning = false;
  var startX, startY, scrollLeft, scrollTop;

  elCanvasWrap.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    isPanning = true;
    startX = e.clientX;
    startY = e.clientY;
    scrollLeft = elCanvasWrap.scrollLeft;
    scrollTop = elCanvasWrap.scrollTop;
    elCanvasWrap.classList.add('panning');
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!isPanning) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    elCanvasWrap.scrollLeft = scrollLeft - dx;
    elCanvasWrap.scrollTop = scrollTop - dy;
  });

  document.addEventListener('mouseup', function() {
    if (isPanning) {
      isPanning = false;
      elCanvasWrap.classList.remove('panning');
    }
  });
}

// ── Horizontal Resizer (PDF/Table split) ─────────────────
function setupPdfResizer() {
  var isResizing = false;

  elResizer.addEventListener('mousedown', function(e) {
    isResizing = true;
    elResizer.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!isResizing) return;
    var panelRect = elLeftPanel.getBoundingClientRect();
    var mouseY = e.clientY - panelRect.top;
    var panelH = panelRect.height;

    var pdfH = Math.max(200, Math.min(mouseY, panelH - 120));
    elViewer.style.height = pdfH + 'px';
    elViewer.style.flex = 'none';
  });

  document.addEventListener('mouseup', function() {
    if (isResizing) {
      isResizing = false;
      elResizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (pdfDoc) zoomFit();
    }
  });
}

// ── Restore PDF from IndexedDB ───────────────────────────
function tryRestorePdf(expectedFileName) {
  return getPdfHandleFromIDB().then(function(handle) {
    if (!handle) return false;

    // Check permission (Chromium only)
    return handle.queryPermission({ mode: 'read' }).then(function(perm) {
      if (perm !== 'granted') {
        return handle.requestPermission({ mode: 'read' });
      }
      return perm;
    }).then(function(perm) {
      if (perm !== 'granted') return false;
      return handle.getFile();
    }).then(function(file) {
      if (!file) return false;
      pdfFileHandle = handle;
      return new Promise(function(resolve) {
        var reader = new FileReader();
        reader.onload = function(e) {
          pdfArrayBuffer = e.target.result;
          pdfFileName = file.name;
          loadPdfFromArrayBuffer(pdfArrayBuffer).then(function() {
            elFilename.textContent = pdfFileName;
            resolve(true);
          }).catch(function() { resolve(false); });
        };
        reader.onerror = function() { resolve(false); };
        reader.readAsArrayBuffer(file);
      });
    });
  }).catch(function(err) {
    console.warn('[PSB-PDF] Restore failed:', err);
    return false;
  });
}

// ── Prompt User to Locate PDF ────────────────────────────
function promptForPdf(suggestedName) {
  if (!window.showOpenFilePicker) return Promise.resolve(false);

  var opts = {
    types: [{ description: 'PDF Document', accept: { 'application/pdf': ['.pdf'] } }],
    multiple: false,
  };
  // Start in the project file's directory if available
  if (PSB.hasFileHandle && PSB.hasFileHandle()) {
    var projHandle = PSB.getProjectFileHandle && PSB.getProjectFileHandle();
    if (projHandle) opts.startIn = projHandle;
  }

  return window.showOpenFilePicker(opts).then(function(handles) {
    var handle = handles[0];
    pdfFileHandle = handle;
    savePdfHandleToIDB(handle);
    return handle.getFile();
  }).then(function(file) {
    return new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onload = function(e) {
        pdfArrayBuffer = e.target.result;
        pdfFileName = file.name;
        loadPdfFromArrayBuffer(pdfArrayBuffer).then(function() {
          if (PSB.setPdfFileName) PSB.setPdfFileName(pdfFileName);
          elFilename.textContent = pdfFileName;
          resolve(true);
        }).catch(function() { resolve(false); });
      };
      reader.onerror = function() { resolve(false); };
      reader.readAsArrayBuffer(file);
    });
  }).catch(function(err) {
    if (err.name === 'AbortError') return false;
    console.warn('[PSB-PDF] Locate PDF failed:', err);
    return false;
  });
}

/**
 * Try IDB restore first; if that fails and promptIfMissing is true,
 * open a file picker so the user can locate the PDF.
 */
function restoreOrPromptPdf(expectedFileName, promptIfMissing) {
  return tryRestorePdf(expectedFileName).then(function(ok) {
    if (ok) return true;
    if (promptIfMissing) {
      PSB.showToast('Please locate ' + expectedFileName, 'info');
      return promptForPdf(expectedFileName);
    }
    return false;
  });
}

// ── Load PDF from Directory Handle ───────────────────────
function loadPdfFromDirHandle(dirHandle, targetName) {
  if (!dirHandle || !targetName) return Promise.resolve(false);

  return dirHandle.getFileHandle(targetName).then(function(handle) {
    pdfFileHandle = handle;
    savePdfHandleToIDB(handle);
    return handle.getFile();
  }).then(function(file) {
    return new Promise(function(resolve) {
      var reader = new FileReader();
      reader.onload = function(e) {
        pdfArrayBuffer = e.target.result;
        pdfFileName = file.name;
        loadPdfFromArrayBuffer(pdfArrayBuffer).then(function() {
          if (PSB.setPdfFileName) PSB.setPdfFileName(pdfFileName);
          elFilename.textContent = pdfFileName;
          resolve(true);
        }).catch(function() { resolve(false); });
      };
      reader.onerror = function() { resolve(false); };
      reader.readAsArrayBuffer(file);
    });
  }).catch(function(err) {
    console.warn('[PSB-PDF] PDF not found in directory:', err);
    return false;
  });
}

// ── Public API ───────────────────────────────────────────
function hasPdf() { return pdfDoc !== null; }
function getPdfFileName() { return pdfFileName; }

// ── Export to namespace ──────────────────────────────────
PSB.initPdfViewer = initPdfViewer;
PSB.loadPdfFromFile = loadPdfFromFile;
PSB.closePdf = closePdf;
PSB.tryRestorePdf = tryRestorePdf;
PSB.restoreOrPromptPdf = restoreOrPromptPdf;
PSB.promptForPdf = promptForPdf;
PSB.loadPdfFromDirHandle = loadPdfFromDirHandle;
PSB.hasPdf = hasPdf;
PSB.getPdfFileName = getPdfFileName;
