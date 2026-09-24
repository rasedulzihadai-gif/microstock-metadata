/*!
 * Test scenes — the two genuine fixture artworks, defined once as pixel functions
 * so the identical artwork drives:
 *   - the browser test page (drawn onto a canvas, analysed by js/detect.js)
 *   - the Node test suite and live API test (encoded to PNG by tests/png.js)
 *
 *   "single_background" — one smooth blue-violet gradient with a soft light sweep.
 *   "template_pack"     — four poster-style panels on a gradient page, each with a
 *                          headline block, body lines, accent circle and accent bar,
 *                          aligned on a grid with uniform gutters.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MSMG = root.MSMG || {};
    Object.assign(root.MSMG, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function singleBackgroundScene(w, h) {
    return function (x, y) {
      var u = x / (w - 1), v = y / (h - 1);
      var sweep = Math.max(0, 1 - Math.abs((u * 0.75 + v * 0.6) - 0.55) * 2.2);
      return [
        Math.round(38 + 60 * v + 34 * sweep),
        Math.round(52 + 70 * v + 40 * sweep),
        Math.round(150 + 90 * (1 - v) + 40 * sweep)
      ];
    };
  }

  function templatePackScene(w, h) {
    var margin = Math.round(w * 0.05);
    var gapX = Math.round(w * 0.06);
    var gapY = Math.round(h * 0.08);
    var cols = 2, rows = 2;
    var panelW = Math.floor((w - 2 * margin - gapX) / cols);
    var panelH = Math.floor((h - 2 * margin - gapY) / rows);

    var palettes = [
      { bg: [22, 34, 84], ink: [230, 240, 255], accent: [88, 190, 255] },
      { bg: [206, 226, 255], ink: [26, 40, 90], accent: [255, 110, 160] },
      { bg: [16, 18, 30], ink: [240, 246, 255], accent: [150, 255, 214] },
      { bg: [66, 24, 96], ink: [255, 244, 250], accent: [255, 196, 92] }
    ];

    return function (x, y) {
      var u = x / (w - 1), v = y / (h - 1);

      for (var i = 0; i < 4; i++) {
        var cx = i % cols, cy = Math.floor(i / cols);
        var ox = margin + cx * (panelW + gapX);
        var oy = margin + cy * (panelH + gapY);
        var lx = x - ox, ly = y - oy;
        if (lx < 0 || ly < 0 || lx >= panelW || ly >= panelH) continue;

        var pal = palettes[i];
        var t = ly / panelH;
        var col = [
          pal.bg[0] + (pal.accent[0] - pal.bg[0]) * 0.12 * t,
          pal.bg[1] + (pal.accent[1] - pal.bg[1]) * 0.12 * t,
          pal.bg[2] + (pal.accent[2] - pal.bg[2]) * 0.12 * t
        ];

        // Two headline lines rendered as glyph blocks.
        var lineYs = [Math.round(panelH * 0.18), Math.round(panelH * 0.28)];
        for (var li = 0; li < lineYs.length; li++) {
          var by = lineYs[li];
          var barH = Math.max(4, Math.round(panelH * 0.06));
          if (ly >= by && ly < by + barH) {
            var glyphW = Math.max(3, Math.round(panelW * 0.045));
            var glyphGap = Math.max(2, Math.round(panelW * 0.03));
            var lineW = Math.round(panelW * (li === 0 ? 0.72 : 0.5));
            for (var gx = Math.round(panelW * 0.12);
              gx < Math.round(panelW * 0.12) + lineW;
              gx += glyphW + glyphGap) {
              if (lx >= gx && lx < gx + glyphW) col = pal.ink;
            }
          }
        }

        // Three thin body-text lines.
        for (var b = 0; b < 3; b++) {
          var ty = Math.round(panelH * (0.5 + b * 0.09));
          var th = Math.max(3, Math.round(panelH * 0.035));
          if (ly >= ty && ly < ty + th &&
            lx >= Math.round(panelW * 0.12) &&
            lx < Math.round(panelW * (0.72 - b * 0.06))) {
            col = [pal.ink[0] * 0.85, pal.ink[1] * 0.85, pal.ink[2] * 0.85];
          }
        }

        // Accent circle bottom-right, accent bar bottom-left.
        var circX = Math.round(panelW * 0.72), circY = Math.round(panelH * 0.68);
        var dx = lx - circX, dy = ly - circY;
        if (dx * dx + dy * dy <= Math.pow(panelW * 0.16, 2)) col = pal.accent;
        if (ly >= Math.round(panelH * 0.86) && ly < Math.round(panelH * 0.92) &&
          lx >= Math.round(panelW * 0.12) && lx < Math.round(panelW * 0.4)) col = pal.accent;

        return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2])];
      }

      // Gradient page background (shared palette with the single background scene).
      return [
        Math.round(52 + 40 * v + 10 * u),
        Math.round(66 + 46 * v + 12 * u),
        Math.round(140 + 70 * (1 - v))
      ];
    };
  }

  function scenePixelFn(kind, w, h) {
    return kind === 'template_pack' ? templatePackScene(w, h) : singleBackgroundScene(w, h);
  }

  /** Browser helper: paint a scene onto a canvas. Returns the canvas. */
  function paintScene(canvas, kind, w, h) {
    w = w || canvas.width;
    h = h || canvas.height;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var imageData = ctx.createImageData(w, h);
    var fn = scenePixelFn(kind, w, h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var rgb = fn(x, y);
        var off = (y * w + x) * 4;
        imageData.data[off] = rgb[0];
        imageData.data[off + 1] = rgb[1];
        imageData.data[off + 2] = rgb[2];
        imageData.data[off + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  return {
    scenes: {
      singleBackgroundScene: singleBackgroundScene,
      templatePackScene: templatePackScene,
      scenePixelFn: scenePixelFn,
      paintScene: paintScene
    }
  };
});
