/*!
 * Writes the two fixture images to tests/fixtures/ so they can be dragged into the
 * app (or attached to a provider request) without regenerating artwork by hand.
 *
 *   node tests/make-fixtures.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var fixtures = require('./png.js');

var outDir = path.join(__dirname, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

var written = [];

function write(name, buffer) {
  var file = path.join(outDir, name);
  fs.writeFileSync(file, buffer);
  written.push({ file: file, bytes: buffer.length });
}

write('single-background-512x384.png', fixtures.singleBackgroundPng(512, 384));
write('template-pack-512x384.png', fixtures.templatePackPng(512, 384));

written.forEach(function (w) {
  console.log('wrote ' + path.relative(process.cwd(), w.file) + '  (' + Math.round(w.bytes / 1024) + ' KB)');
});
