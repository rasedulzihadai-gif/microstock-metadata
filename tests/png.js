/*!
 * Test fixtures: a dependency-free PNG encoder plus grayscale conversion.
 *
 * The artwork itself lives in js/scenes.js (shared with the browser test page) so the
 * exact same pixels drive both the Node suite and the in-browser checks.
 */
'use strict';

var zlib = require('node:zlib');
var scenes = require('../js/scenes.js').scenes;

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** pixelFn(x, y) -> [r, g, b] (0-255) */
function encodePng(width, height, pixelFn) {
  var stride = width * 3 + 1;
  var raw = Buffer.alloc(stride * height);
  for (var y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (var x = 0; x < width; x++) {
      var rgb = pixelFn(x, y);
      var off = y * stride + 1 + x * 3;
      raw[off] = rgb[0] & 0xff;
      raw[off + 1] = rgb[1] & 0xff;
      raw[off + 2] = rgb[2] & 0xff;
    }
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function toDataUrl(pngBuffer) {
  return 'data:image/png;base64,' + pngBuffer.toString('base64');
}

/** Scene -> grayscale buffer + quantised colour count, for the detection tests. */
function grayFromScene(sceneFn, w, h) {
  var gray = new Float32Array(w * h);
  var colors = new Set();
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var rgb = sceneFn(x, y);
      gray[y * w + x] = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      colors.add(((rgb[0] >> 4) << 8) | ((rgb[1] >> 4) << 4) | (rgb[2] >> 4));
    }
  }
  return { gray: gray, colorCount: colors.size };
}

function pngFor(kind, w, h) {
  w = w || 512;
  h = h || 384;
  return encodePng(w, h, scenes.scenePixelFn(kind, w, h));
}

module.exports = {
  encodePng: encodePng,
  toDataUrl: toDataUrl,
  grayFromScene: grayFromScene,
  singleBackgroundScene: function (w, h) { return scenes.scenePixelFn('single_asset', w, h); },
  templatePackScene: function (w, h) { return scenes.scenePixelFn('template_pack', w, h); },
  dotPatternScene: function (w, h) { return scenes.scenePixelFn('seamless_pattern', w, h); },
  singleBackgroundPng: function (w, h) { return pngFor('single_asset', w, h); },
  templatePackPng: function (w, h) { return pngFor('template_pack', w, h); },
  dotPatternPng: function (w, h) { return pngFor('seamless_pattern', w, h); }
};
