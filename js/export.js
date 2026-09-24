/*!
 * CSV export layer — one spec per platform.
 *
 *   Adobe Stock    comma-delimited, double-quoted, keywords comma-joined inside the field,
 *                  30-character filename cap with warning (excluding extension)
 *   Shutterstock   comma-delimited, double-quoted
 *   Freepik        semicolon-delimited, single-quoted
 *   iStock/Getty   comma-delimited, double-quoted + controlled-vocabulary caveat
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
  var PLATFORM_BY_ID = MSMG.PLATFORM_BY_ID;

  var NEWLINE = '\r\n'; // widest spreadsheet/tool compatibility for bulk uploads

  /**
   * Always quote, double the quote character inside, flatten newlines.
   * For Freepik the quote character is ' so internal apostrophes become ''.
   */
  function escapeField(value, quote) {
    var s = String(value == null ? '' : value)
      .replace(/\r?\n|\r/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    var q = quote || '"';
    var escaped = s.split(q).join(q + q);
    return q + escaped + q;
  }

  function row(fields, quote, delimiter) {
    return fields.map(function (f) { return escapeField(f, quote); }).join(delimiter);
  }

  /* ------------------------------------------------------------------ *
   * Per-platform row builders. `row` = validated metadata for one asset.
   * ------------------------------------------------------------------ */
  var SPECS = {
    adobe_stock: {
      label: 'Adobe Stock',
      delimiter: ',',
      quote: '"',
      headers: ['Filename', 'Title', 'Keywords', 'Category', 'Releases'],
      build: function (r) {
        return [r.filename, r.title, r.keywords.join(','), r.category || '', ''];
      },
      caveats: [
        'Filename is capped at 30 characters (excluding extension) — longer stems are ' +
        'truncated on a word/underscore boundary and reported as a warning.'
      ]
    },
    shutterstock: {
      label: 'Shutterstock',
      delimiter: ',',
      quote: '"',
      headers: ['Filename', 'Description', 'Keywords', 'Categories'],
      build: function (r) {
        return [r.filename, r.title, r.keywords.join(','), (r.categories || []).join(',')];
      },
      caveats: [
        'Shutterstock reads the Description column as the visible title (max 200 characters).',
        'Two categories maximum; the primary category is written first.'
      ]
    },
    freepik: {
      label: 'Freepik',
      delimiter: ';',
      quote: "'",
      headers: ['Filename', 'Title', 'Keywords', 'Category'],
      build: function (r) {
        return [r.filename, r.title, r.keywords.join(','), r.category || ''];
      },
      caveats: [
        'Semicolon-delimited with single-quote quoting — this file will look wrong in a ' +
        'stray comma-based reader; that is the format Freepik expects.'
      ]
    },
    istock_getty: {
      label: 'iStock / Getty Images',
      delimiter: ',',
      quote: '"',
      headers: ['Filename', 'Description', 'Keywords', 'Categories'],
      build: function (r) {
        return [r.filename, r.title, r.keywords.join(','), r.categories ? r.categories.join(',') : (r.category || '')];
      },
      caveats: [
        'CONTROLLED VOCABULARY: Getty maps submitted keywords to its own preferred terms and ' +
        'only accepts its own category list. Import this file only after confirming both the ' +
        'categories and any auto-mapped keywords in the Getty contributor portal — values here ' +
        'are a starting point, not a guarantee.',
        'Getty/iStock titles are surfaced as the description; keep them literal and free of ' +
        'marketing language.'
      ]
    }
  };

  function specFor(platformId) {
    var spec = SPECS[platformId];
    if (!spec) throw new Error('No CSV spec for platform: ' + platformId);
    return spec;
  }

  /**
   * Build one CSV file for one asset.
   * metadata = { title, keywords[], category, categories[], note }
   * returns { csv, warnings[], caveats[], filename, spec }
   */
  function buildCsv(platformId, metadata, options) {
    options = options || {};
    var spec = specFor(platformId);
    var platform = PLATFORM_BY_ID[platformId];
    var warnings = [];

    var stem = util.sanitizeFilename(options.filename || metadata.filename || 'asset');

    if (platform && platform.filenameMax) {
      if (stem.length > platform.filenameMax) {
        var original = stem;
        stem = util.sanitizeFilename(stem, platform.filenameMax);
        warnings.push('Filename "' + original + '" is ' + original.length +
          ' characters; ' + platform.label + ' caps filenames at ' + platform.filenameMax +
          '. Shortened to "' + stem + '".');
      }
      if (stem.length > platform.filenameMax) {
        stem = stem.slice(0, platform.filenameMax);
      }
    }

    var rowData = {
      filename: stem,
      title: util.tidyText(metadata.title || ''),
      keywords: (metadata.keywords || []).slice(),
      category: metadata.category || '',
      categories: metadata.categories || (metadata.category ? [metadata.category] : []),
      note: metadata.note || ''
    };

    if (!rowData.title) warnings.push('No title available for ' + spec.label + '.');
    if (!rowData.keywords.length) warnings.push('No keywords available for ' + spec.label + '.');
    if (platform && rowData.keywords.length > platform.keywordsMax) {
      warnings.push(rowData.keywords.length + ' keywords exceed ' + platform.label +
        ' max of ' + platform.keywordsMax + '; extra terms dropped.');
      rowData.keywords = rowData.keywords.slice(0, platform.keywordsMax);
    }
    if (platform && rowData.keywords.length < platform.keywordsMin) {
      warnings.push('Only ' + rowData.keywords.length + ' keywords — ' + platform.label +
        ' expects at least ' + platform.keywordsMin + '.');
    }
    if (platform && rowData.title.length > platform.titleHardMax) {
      warnings.push('Title exceeds ' + platform.label + ' maximum of ' + platform.titleHardMax +
        ' characters and would be rejected on import.');
    }

    var lines = [row(spec.headers, spec.quote, spec.delimiter)];
    lines.push(row(spec.build(rowData), spec.quote, spec.delimiter));

    return {
      csv: lines.join(NEWLINE) + NEWLINE,
      warnings: warnings,
      caveats: spec.caveats.slice(),
      filename: platformId + '_' + stem + '_metadata.csv',
      platform: platformId,
      spec: spec,
      controlledVocabulary: !!(platform && platform.controlledVocabulary)
    };
  }

  /**
   * Build a combined CSV across platforms (one block per platform, blank line separated).
   * Useful for archival; not for direct upload.
   */
  function buildCombined(metadata, options) {
    var out = [];
    Object.keys(SPECS).forEach(function (id) {
      var built = buildCsv(id, metadata, options);
      out.push('# ' + built.spec.label);
      out.push(built.csv.replace(/\s+$/, ''));
      out.push('');
    });
    return out.join(NEWLINE);
  }

  function download(platformId, metadata, options) {
    var built = buildCsv(platformId, metadata, options);
    util.downloadText(built.filename, built.csv, 'text/csv');
    return built;
  }

  function downloadCombined(metadata, options) {
    var stem = util.sanitizeFilename((options && options.filename) || 'asset');
    util.downloadText(stem + '_all_platforms.csv', buildCombined(metadata, options), 'text/csv');
  }

  return {
    exports: {
      SPECS: SPECS,
      specFor: specFor,
      escapeField: escapeField,
      buildCsv: buildCsv,
      buildCombined: buildCombined,
      download: download,
      downloadCombined: downloadCombined
    }
  };
});
