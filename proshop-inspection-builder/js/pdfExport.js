/**
 * pdfExport.js — export the loaded PDF with red balloon annotations baked in,
 * using pdf-lib. Runs entirely in-browser: the PDF bytes already in memory
 * (pdfViewer.js' pdfArrayBuffer) are passed to pdf-lib, balloons are drawn as
 * vector shapes, and the resulting bytes are emitted via a transient blob URL.
 *
 * SECURITY BOUNDARY: no network calls, no external services, no project data
 * crosses the page origin. pdf-lib is loaded from lib/ as a vendored script;
 * nothing in this module touches fetch/XHR.
 *
 * COORDINATE CONVENTION: balloonManager.js stores anchorBox via
 * viewport.convertToPdfPoint(), which returns PDF *user space* coordinates
 * (Y-up, origin bottom-left). pdf-lib uses the same convention, so no Y-flip
 * is needed. toPdfLibCoords() is kept as a named function (per CLAUDE.md) so
 * the contract is documented and a future change in the pipeline doesn't
 * silently break placement.
 */

(function() {
  'use strict';
  window.PSB = window.PSB || {};

  // Identity transform — see "COORDINATE CONVENTION" in the file header.
  // pageHeight is accepted but unused; kept for signature stability.
  function toPdfLibCoords(pdfX, pdfY, pageHeight) {
    return { x: pdfX, y: pdfY };
  }

  // Shortest distance from a point to a rectangle (0 if inside).
  function pointToRectDistance(px, py, r) {
    var dx = Math.max(r.x - px, 0, px - (r.x + r.w));
    var dy = Math.max(r.y - py, 0, py - (r.y + r.h));
    return Math.sqrt(dx * dx + dy * dy);
  }

  function deriveExportFilename(orig) {
    if (!orig) return 'drawing-ballooned.pdf';
    var dot = orig.lastIndexOf('.');
    var base = dot > 0 ? orig.substring(0, dot) : orig;
    return base + '-ballooned.pdf';
  }

  // Iterate state.rows once; bucket every row that has a balloon by page
  // number. dimTag prefers the live user.balloon.dimTag (mutable for balloon
  // rows) and falls back to raw.dimTag (CSV-imported rows that have been
  // ballooned).
  function groupBalloonsByPage(rows) {
    var byPage = {};
    rows.forEach(function(row) {
      var b = row.user && row.user.balloon;
      if (!b || !b.anchorBox) return;
      var dimTag = (b.dimTag != null) ? String(b.dimTag)
                                      : ((row.raw && row.raw.dimTag) || '');
      (byPage[b.page] = byPage[b.page] || []).push({
        rowId: row.id,
        dimTag: dimTag,
        anchorBox: b.anchorBox,
        balloonOffset: b.balloonOffset || { dx: 0, dy: 0 },
        leaderConnectionPoint: b.leaderConnectionPoint || { side: 'left', t: 0.5 },
      });
    });
    return byPage;
  }

  // Compute the leader-line endpoint on the anchor-box perimeter in PDF user
  // space. Mirrors the on-screen rendering convention in balloonManager so
  // exported leader lines start at the same point the user sees.
  function getConnectionPointPdf(balloon) {
    var lcp = balloon.leaderConnectionPoint;
    var b = balloon.anchorBox;
    // PDF user space is Y-up: 'top' is the higher-Y edge of the box.
    switch (lcp.side) {
      case 'left':   return { x: b.x,             y: b.y + lcp.t * b.h };
      case 'right':  return { x: b.x + b.w,       y: b.y + lcp.t * b.h };
      case 'top':    return { x: b.x + lcp.t * b.w, y: b.y + b.h };
      case 'bottom': return { x: b.x + lcp.t * b.w, y: b.y };
      default:       return { x: b.x,             y: b.y + b.h / 2 };
    }
  }

  /**
   * @param {Object} state — full app state ({ rows, globals, ... })
   * @param {ArrayBuffer} pdfArrayBuffer — the bytes already loaded by pdfViewer.js
   * @param {string} originalFileName — globals.pdfFileName, used to derive the download name
   * @returns {Promise<{ filename, byteCount, balloonCount, pageCount }>}
   */
  function exportBalloonedPdf(state, pdfArrayBuffer, originalFileName) {
    if (!window.PDFLib) {
      return Promise.reject(new Error('pdf-lib not loaded (lib/pdf-lib.min.js missing?)'));
    }
    if (!pdfArrayBuffer) return Promise.reject(new Error('No PDF loaded'));
    if (!state || !state.rows) return Promise.reject(new Error('No app state'));

    var balloonsByPage = groupBalloonsByPage(state.rows);
    var totalBalloons = state.rows.filter(function(r) {
      return r.user && r.user.balloon;
    }).length;
    if (totalBalloons === 0) {
      return Promise.reject(new Error('No balloons to export'));
    }

    var PDFLib = window.PDFLib;
    var PDFDocument = PDFLib.PDFDocument;
    var StandardFonts = PDFLib.StandardFonts;
    var rgb = PDFLib.rgb;

    // Clone the ArrayBuffer — pdf-lib mutates its input in some code paths and
    // pdfViewer.js still owns the original for re-renders / restoration.
    var copy = pdfArrayBuffer.slice(0);

    return PDFDocument.load(copy).then(function(pdfDoc) {
      return pdfDoc.embedFont(StandardFonts.HelveticaBold).then(function(font) {
        var pages = pdfDoc.getPages();
        var drawn = 0;

        Object.keys(balloonsByPage).forEach(function(pn) {
          var pageIdx = parseInt(pn, 10) - 1;
          if (pageIdx < 0 || pageIdx >= pages.length) {
            console.warn('[pdfExport] balloons on page', pn,
                         '— PDF only has', pages.length, 'pages; skipping');
            return;
          }
          var page = pages[pageIdx];
          var size = page.getSize();
          var pageWidth = size.width;
          var pageHeight = size.height;
          // Balloon size is the global balloonRadius (PDF points), matching the
          // on-screen base radius so export visually matches the editor.
          var radius = (state.globals && state.globals.balloonRadius > 0)
                       ? state.globals.balloonRadius : 6;

          balloonsByPage[pn].forEach(function(bal) {
            var anchorCenter = {
              x: bal.anchorBox.x + bal.anchorBox.w / 2,
              y: bal.anchorBox.y + bal.anchorBox.h / 2,
            };
            var balloonCenter = {
              x: anchorCenter.x + bal.balloonOffset.dx,
              y: anchorCenter.y + bal.balloonOffset.dy,
            };
            var connPdf = getConnectionPointPdf(bal);

            var bp = toPdfLibCoords(balloonCenter.x, balloonCenter.y, pageHeight);
            var cp = toPdfLibCoords(connPdf.x, connPdf.y, pageHeight);

            // Out-of-bounds warning (still draw — easier to find and fix
            // visually than silent omission).
            if (bp.x < 0 || bp.x > pageWidth || bp.y < 0 || bp.y > pageHeight) {
              console.warn('[pdfExport] balloon #' + bal.dimTag +
                           ' outside page bounds: (' +
                           bp.x.toFixed(1) + ',' + bp.y.toFixed(1) + ')');
            }

            // Leader line only when the balloon circle is clear of the anchor
            // box — same rule as the on-screen overlay. Computed in PDF user
            // space (balloonCenter and anchorBox share that space).
            var gap = pointToRectDistance(balloonCenter.x, balloonCenter.y, bal.anchorBox);
            if (gap > radius + 2) {
              page.drawLine({
                start: { x: cp.x, y: cp.y },
                end:   { x: bp.x, y: bp.y },
                thickness: 0.5,
                color: rgb(1, 0, 0),
              });
            }

            page.drawEllipse({
              x: bp.x, y: bp.y,
              xScale: radius, yScale: radius,
              color: rgb(1, 0, 0),
              borderColor: rgb(0.5, 0, 0),
              borderWidth: 0.5,
            });

            var label = String(bal.dimTag);
            var fontSize = radius * 1.1;
            var textWidth = font.widthOfTextAtSize(label, fontSize);
            page.drawText(label, {
              x: bp.x - textWidth / 2,
              y: bp.y - fontSize / 3,
              size: fontSize,
              font: font,
              color: rgb(1, 1, 1),
            });
            drawn++;
          });
        });

        return pdfDoc.save().then(function(pdfBytes) {
          var filename = deriveExportFilename(originalFileName);
          var blob = new Blob([pdfBytes], { type: 'application/pdf' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function() { URL.revokeObjectURL(url); }, 5000);

          return {
            filename: filename,
            byteCount: pdfBytes.byteLength,
            balloonCount: drawn,
            pageCount: pages.length,
          };
        });
      });
    });
  }

  PSB.exportBalloonedPdf = exportBalloonedPdf;
  PSB.derivePdfExportFilename = deriveExportFilename;
})();
