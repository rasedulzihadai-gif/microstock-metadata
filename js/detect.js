/*!
 * Content-type heuristic pre-classifier.
 *
 * Answers one question: does this preview look like a single usable surface
 * (single_asset) or a composed multi-element layout (template_pack)?
 *
 *   computeSignalsFromGray(gray, w, h, colorCount)  — pure, Node-testable
 *   classifySignals(signals)                        — pure, Node-testable
 *   analyzeCanvas / analyzeDataUrl / analyzeFile    — browser wrappers
 *
 * The result is advisory: it is fed to the vision model as a weak prior and shown
 * to the contributor as a suggestion. It is never the final classification — the
 * model's visual read wins (and is validated against the contributor's toggle).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.MSMG = root.MSMG || {};
    Object.assign(root.MSMG, factory(root.MSMG));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MSMG) {
  'use strict';

  var util = MSMG.util;

  var EDGE_THRESHOLD = 34;   // Sobel L1 magnitude that counts as an edge
  var MAX_ANALYSIS_DIM = 192;

  /* ------------------------------------------------------------------ *
   * Pure signal extraction
   * ------------------------------------------------------------------ */
  function computeSignalsFromGray(gray, w, h, colorCount) {
    var mag = new Float32Array(w * h);
    var edgeCount = 0;
    var interior = 0;

    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1];
        var ml = gray[i - 1], mr = gray[i + 1];
        var bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1];
        var gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        var gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        var m = Math.abs(gx) + Math.abs(gy);
        mag[i] = m;
        interior++;
        if (m > EDGE_THRESHOLD) edgeCount++;
      }
    }
    var edgeDensity = interior ? edgeCount / interior : 0;

    // Column / row edge profiles.
    var colEdges = new Float32Array(w);
    var rowEdges = new Float32Array(h);
    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) {
        if (mag[yy * w + xx] > EDGE_THRESHOLD) { colEdges[xx]++; rowEdges[yy]++; }
      }
    }

    // Text-like bands: rows with many SHORT edge runs (glyph strokes / headline bars).
    var textRows = new Uint8Array(h);
    var minShortRuns = Math.max(4, Math.round(w * 0.06));
    for (var ry = 1; ry < h - 1; ry++) {
      var runs = 0, runLen = 0;
      for (var rx = 1; rx < w - 1; rx++) {
        if (mag[ry * w + rx] > EDGE_THRESHOLD) {
          runLen++;
        } else if (runLen > 0) {
          if (runLen <= 4) runs++;
          runLen = 0;
        }
      }
      if (runLen > 0 && runLen <= 4) runs++;
      textRows[ry] = runs >= minShortRuns ? 1 : 0;
    }
    var textBandCount = 0;
    var previousRowWasText = 0;
    for (var ty = 1; ty < h - 1; ty++) {
      if (textRows[ty] && !previousRowWasText) textBandCount++;
      previousRowWasText = textRows[ty];
    }

    // Grid regularity via normalised autocorrelation of the column profile.
    function autocorrPeak(profile, maxLag) {
      var n = profile.length;
      if (n < 8) return 0;
      var mean = 0, i;
      for (i = 0; i < n; i++) mean += profile[i];
      mean /= n;
      var centered = new Float32Array(n);
      var denom = 0;
      for (i = 0; i < n; i++) { centered[i] = profile[i] - mean; denom += centered[i] * centered[i]; }
      if (denom <= 0) return 0;
      var best = 0;
      var limit = Math.min(maxLag, Math.floor(n / 2));
      for (var lag = 3; lag <= limit; lag++) {
        var num = 0;
        for (var k = 0; k < n - lag; k++) num += centered[k] * centered[k + lag];
        var r = num / denom;
        if (r > best) best = r;
      }
      return util.clamp(best, 0, 1);
    }
    var regularity = Math.max(autocorrPeak(colEdges, Math.round(w / 2)),
      autocorrPeak(rowEdges, Math.round(h / 2)));

    // Gutters -> content regions (panels).
    function maxOf(arr) {
      var m = 0;
      for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
      return m;
    }
    var maxCol = maxOf(colEdges), maxRow = maxOf(rowEdges);
    var structured = edgeDensity >= 0.012 && maxCol >= 3 && maxRow >= 3;

    function segments(profile, max, length) {
      if (!structured) return { count: 1, gutterRatio: 0, segments: null };
      var gutterThreshold = Math.max(1, max * 0.05);
      var minRun = Math.max(2, Math.round(length * 0.02));
      var segs = [];
      var current = null;
      var gutterRunStart = -1;

      for (var k = 0; k < length; k++) {
        if (profile[k] <= gutterThreshold) {
          if (gutterRunStart === -1) gutterRunStart = k;
          continue;
        }
        if (gutterRunStart !== -1) {
          // Only a gutter run at least minRun wide splits the layout.
          if (k - gutterRunStart >= minRun && current) {
            current.end = gutterRunStart - 1;
            segs.push(current);
            current = null;
          }
          gutterRunStart = -1;
        }
        if (!current) current = { start: k, end: k };
        else current.end = k;
      }
      if (current) { current.end = length - 1; segs.push(current); }

      var kept = segs.filter(function (s) {
        var width = s.end - s.start + 1;
        if (width < Math.max(3, Math.round(length * 0.05))) return false;
        var peak = 0;
        for (var i2 = s.start; i2 <= s.end; i2++) if (profile[i2] > peak) peak = profile[i2];
        return peak > max * 0.2;
      });

      var contentLength = kept.reduce(function (a, s) { return a + (s.end - s.start + 1); }, 0);

      // How uniform are the kept segments? A seamless texture splits into many
      // near-identical tiles; a real layout has a few differently sized regions.
      var sizeConsistency = 0;
      var medianWidthRatio = 1;
      if (kept.length >= 1) {
        var widths = kept.map(function (s) { return s.end - s.start + 1; });
        var sortedWidths = widths.slice().sort(function (a, b) { return a - b; });
        var median = sortedWidths[Math.floor(sortedWidths.length / 2)];
        medianWidthRatio = length ? median / length : 1;
        if (kept.length >= 2) {
          var mean = widths.reduce(function (a, b) { return a + b; }, 0) / widths.length;
          var variance = widths.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / widths.length;
          sizeConsistency = mean > 0 ? util.clamp(1 - Math.sqrt(variance) / mean, 0, 1) : 0;
        }
      }

      return {
        count: Math.max(1, kept.length),
        gutterRatio: length ? (length - contentLength) / length : 0,
        sizeConsistency: sizeConsistency,
        medianWidthRatio: medianWidthRatio,
        segments: kept
      };
    }

    var colSeg = segments(colEdges, maxCol, w);
    var rowSeg = segments(rowEdges, maxRow, h);

    // Distinct colour schemes per segment -> a layout of different designs rather than
    // one repeating surface. Computed before the tiling decision because it is one of
    // the discriminating signals.
    var panelColorSpread = 0;
    if (colSeg.segments && rowSeg.segments && colSeg.segments.length > 0 && rowSeg.segments.length > 0) {
      var means = [];
      colSeg.segments.forEach(function (cs) {
        rowSeg.segments.forEach(function (rs) {
          var sum = 0, n = 0;
          for (var py = rs.start; py <= rs.end; py += 2) {
            for (var px = cs.start; px <= cs.end; px += 2) {
              sum += gray[py * w + px];
              n++;
            }
          }
          if (n > 0) means.push(sum / n);
        });
      });
      if (means.length >= 2) {
        var avg = means.reduce(function (a, b) { return a + b; }, 0) / means.length;
        var varSum = means.reduce(function (a, b) { return a + (b - avg) * (b - avg); }, 0) / means.length;
        panelColorSpread = util.clamp(Math.sqrt(varSum) / 64, 0, 1);
      }
    }

    // A seamless texture (dots, stripes, tiles) splits into MANY small, near-identical
    // segments with a strong periodic signature. That is a surface, not a multi-panel
    // layout, so it must not be counted as panels. Three things separate a texture from
    // a layout: the tiles are small, uniform in size, AND look alike (a real layout's
    // panels carry different designs, so their colour spread is far higher).
    var fineXMetric = colSeg.count >= 3 && colSeg.medianWidthRatio < 0.16;
    var fineYMetric = rowSeg.count >= 3 && rowSeg.medianWidthRatio < 0.16;
    var tiled = structured && regularity > 0.5 && (fineXMetric || fineYMetric) &&
      Math.max(colSeg.sizeConsistency, rowSeg.sizeConsistency) > 0.55 &&
      panelColorSpread < 0.12;

    var panelCount = tiled ? 1 : Math.min(16, colSeg.count * rowSeg.count);

    // High contrast between the strongest structural line and the average -> layout rules.
    var colMean = 0;
    for (var cm = 0; cm < w; cm++) colMean += colEdges[cm];
    colMean /= Math.max(1, w);
    var peakRatio = colMean > 0 ? maxCol / colMean : 0;

    return {
      width: w,
      height: h,
      aspectRatio: w / Math.max(1, h),
      edgeDensity: edgeDensity,
      colorCount: colorCount || 0,
      panelCount: panelCount,
      periodicTiles: tiled,
      tileGrid: { x: colSeg.count, y: rowSeg.count },
      gutterRatio: Math.max(colSeg.gutterRatio, rowSeg.gutterRatio),
      textBandCount: textBandCount,
      regularity: regularity,
      peakRatio: peakRatio,
      panelColorSpread: panelColorSpread
    };
  }

  /* ------------------------------------------------------------------ *
   * Pure classification
   * ------------------------------------------------------------------ */
  function classifySignals(signals) {
    var score = 0.35; // slight prior toward single_asset unless evidence accumulates
    var evidence = [];

    function add(points, why) { score += points; evidence.push(why); }
    var pct = (signals.edgeDensity * 100).toFixed(2) + '%';

    if (signals.edgeDensity < 0.015) {
      add(-0.45, 'near-zero edge energy (' + pct + ') — smooth gradient/flat surface');
    } else if (signals.edgeDensity < 0.03) {
      add(-0.2, 'very low edge energy (' + pct + ')');
    }

    if (signals.panelCount >= 2) {
      add(0.3 + Math.min(0.15, 0.05 * (signals.panelCount - 2)),
        'composite layout: ' + signals.panelCount + ' content region(s) separated by uniform gutters');
    }

    // A seamless repeating surface (dots, stripes, tiles) produces many short high-contrast
    // runs and strong periodicity without being a layout. Discount both signals when the
    // frame is a single region and the structure is globally periodic.
    var periodicPattern = signals.periodicTiles ||
      (signals.panelCount < 2 && signals.regularity >= 0.5);
    var structureWeight = periodicPattern ? 0.25 : 1;
    if (periodicPattern) {
      evidence.push(signals.periodicTiles
        ? 'regular tiled texture (' + (signals.tileGrid ? signals.tileGrid.x + '×' + signals.tileGrid.y : 'grid') +
          ') — treated as a single surface, text-band and grid signals discounted'
        : 'globally periodic surface — text-band and grid signals discounted');
    }

    if (signals.textBandCount >= 2) {
      add(0.18 * structureWeight, signals.textBandCount + ' text-like band(s) (headline/paragraph blocks)');
    } else if (signals.textBandCount === 1) {
      add(0.06 * structureWeight, 'one text-like band');
    }

    if (signals.regularity > 0.45) {
      add(0.16 * structureWeight, 'strong repeating grid regularity (' + signals.regularity.toFixed(2) + ')');
    } else if (signals.regularity > 0.25) {
      add(0.07 * structureWeight, 'some repeating structure (' + signals.regularity.toFixed(2) + ')');
    }

    if (signals.panelColorSpread > 0.18) {
      add(0.12, 'regions use distinctly different colour schemes (multiple designs)');
    }

    if (signals.panelCount < 2 && signals.textBandCount === 0 && signals.colorCount > 0 &&
      signals.colorCount <= 96 && signals.edgeDensity < 0.05) {
      add(-0.1, 'few quantised colours and no layout structure — single surface');
    }

    if (signals.panelCount < 2 && signals.peakRatio > 8 && signals.textBandCount === 0) {
      add(-0.08, 'one dominant structural line, no panels or text bands');
    }

    score = util.clamp(score, 0, 1);
    var isPack = score >= 0.55;
    return {
      contentType: isPack ? 'template_pack' : 'single_asset',
      confidence: Math.round((isPack ? score : 1 - score) * 100) / 100,
      score: Math.round(score * 100) / 100,
      evidence: evidence,
      signals: signals
    };
  }

  /* ------------------------------------------------------------------ *
   * RGBA -> grayscale + quantised colour count (pure)
   * ------------------------------------------------------------------ */
  function signalsFromRgba(rgba, w, h) {
    var gray = new Float32Array(w * h);
    var colors = new Set();
    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      var r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
    return computeSignalsFromGray(gray, w, h, colors.size);
  }

  /* ------------------------------------------------------------------ *
   * Browser wrappers
   * ------------------------------------------------------------------ */
  function analyzeCanvas(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var w = canvas.width, h = canvas.height;
    var data = ctx.getImageData(0, 0, w, h).data;
    return classifySignals(signalsFromRgba(data, w, h));
  }

  function drawToCanvas(image, maxDim) {
    maxDim = maxDim || MAX_ANALYSIS_DIM;
    var iw = image.naturalWidth || image.width;
    var ih = image.naturalHeight || image.height;
    var scale = Math.min(1, maxDim / Math.max(iw, ih));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(8, Math.round(iw * scale));
    canvas.height = Math.max(8, Math.round(ih * scale));
    var ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function analyzeDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try { resolve(analyzeCanvas(drawToCanvas(img))); }
        catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('Could not load image for pre-check.')); };
      img.src = dataUrl;
    });
  }

  function analyzeFile(file) {
    return readAsDataUrl(file).then(analyzeDataUrl);
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Could not read ' + (file && file.name))); };
      reader.readAsDataURL(file);
    });
  }

  return {
    detect: {
      EDGE_THRESHOLD: EDGE_THRESHOLD,
      MAX_ANALYSIS_DIM: MAX_ANALYSIS_DIM,
      computeSignalsFromGray: computeSignalsFromGray,
      signalsFromRgba: signalsFromRgba,
      classifySignals: classifySignals,
      analyzeCanvas: analyzeCanvas,
      analyzeDataUrl: analyzeDataUrl,
      analyzeFile: analyzeFile,
      drawToCanvas: drawToCanvas,
      readAsDataUrl: readAsDataUrl
    }
  };
});
