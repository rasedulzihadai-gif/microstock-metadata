/*!
 * Microstock Metadata Generator — core namespace, constants, storage, utilities.
 * Classic script (works from file://) + CommonJS (works in Node tests).
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

  var VERSION = '2.0.0';
  var STORAGE_PREFIX = 'msmg.v2.';

  /* ------------------------------------------------------------------ *
   * Platform metadata contracts.
   * titleMax      = real, enforced ceiling used by the title rules (G/H)
   * titleHardMax  = absolute platform maximum (never exceed, but soft trim first)
   * keywordsMax   = hard cap; keywordsMin = hard floor; keywordsTarget = ideal band
   * csv           = delimiter + quote char for that platform's bulk-upload file
   * ------------------------------------------------------------------ */
  var PLATFORMS = [
    {
      id: 'adobe_stock',
      label: 'Adobe Stock',
      short: 'Adobe',
      titleMax: 70,
      titleHardMax: 200,
      keywordsMax: 49,
      keywordsMin: 5,
      keywordsTarget: [35, 49],
      csv: { delimiter: ',', quote: '"' },
      filenameMax: 30,
      filenameNote: 'Adobe filename limit: 30 characters (excluding extension).',
      categoryField: 'Category',
      notes: 'Keywords are comma-separated inside a single quoted field. Vector/AI assets belong in Graphic Resources.'
    },
    {
      id: 'shutterstock',
      label: 'Shutterstock',
      short: 'Shutterstock',
      titleMax: 100,
      titleHardMax: 200,
      keywordsMax: 50,
      keywordsMin: 7,
      keywordsTarget: [30, 50],
      csv: { delimiter: ',', quote: '"' },
      filenameMax: 0, // no platform-specific cap
      categoryField: 'Categories',
      notes: 'Description is the visible title. Two categories allowed; keep the primary first.'
    },
    {
      id: 'freepik',
      label: 'Freepik',
      short: 'Freepik',
      titleMax: 70,
      titleHardMax: 70,
      keywordsMax: 50,
      keywordsMin: 10,
      keywordsTarget: [25, 50],
      csv: { delimiter: ';', quote: "'" },
      filenameMax: 0,
      categoryField: 'Category',
      notes: 'Semicolon-delimited, single-quoted CSV.'
    },
    {
      id: 'istock_getty',
      label: 'iStock / Getty Images',
      short: 'iStock/Getty',
      titleMax: 120,
      titleHardMax: 200,
      keywordsMax: 50,
      keywordsMin: 5,
      keywordsTarget: [25, 50],
      csv: { delimiter: ',', quote: '"' },
      filenameMax: 0,
      categoryField: 'Categories',
      controlledVocabulary: true,
      notes: 'Getty enforces a controlled vocabulary: chosen categories must come from Getty\'s own list and some submitted keywords are silently mapped to a preferred term. Treat exported values as a starting point and verify in the Getty contributor portal.'
    }
  ];

  var PLATFORM_BY_ID = PLATFORMS.reduce(function (acc, p) { acc[p.id] = p; return acc; }, {});

  /* ------------------------------------------------------------------ *
   * Content types.
   * ------------------------------------------------------------------ */
  var CONTENT_TYPES = {
    single_asset: {
      id: 'single_asset',
      label: 'Single background',
      shortLabel: 'Single',
      description: 'One background / texture / photo / illustration meant to be used as-is.',
      ruleSet: 'A-G'
    },
    template_pack: {
      id: 'template_pack',
      label: 'Template / design pack',
      shortLabel: 'Template pack',
      description: 'A composed layout, poster mockup or multi-element design pack sold as one asset.',
      ruleSet: 'A-F + H-K'
    }
  };

  /* Generic praise words that never help a stock search. Rule C. */
  var BANNED_FILLER = [
    'beautiful', 'amazing', 'awesome', 'cool', 'nice', 'good', 'best', 'great',
    'perfect', 'beauty', 'stunning', 'gorgeous', 'wonderful', 'lovely', 'pretty',
    'high quality', 'highquality', 'hd', '4k', '8k', 'ultra hd', 'quality',
    'professional', 'creative', 'unique', 'exclusive', 'super', 'fantastic',
    'excellent', 'attractive', 'stylish', 'elegant background', 'awesome background',
    'image', 'picture', 'photo of', 'royalty free', 'stock photo', 'wallpaper hd'
  ];

  /* Words that signal a collection/pack title (used by the template-pack linter). */
  var PACK_CUE_WORDS = [
    'set', 'sets', 'collection', 'pack', 'bundle', 'template', 'templates',
    'layout', 'layouts', 'mockup', 'mockups', 'kit', 'designs'
  ];

  /* Rule I pool: what the pack is FOR / made of. */
  var DESIGN_PURPOSE_POOL = [
    'template', 'poster', 'layout', 'cover', 'flier', 'flyer', 'booklet', 'banner',
    'collection', 'set', 'presentation', 'mockup', 'print', 'editable design',
    'vector template', 'business card', 'brochure'
  ];

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms || 150);
    };
  }

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /** Truncate to maxLen on a word boundary (never mid-word, never mid-punctuation). */
  function truncateAtWord(str, maxLen) {
    var s = String(str == null ? '' : str).trim();
    if (s.length <= maxLen) return s;
    var slice = s.slice(0, maxLen + 1);
    var cut = slice.lastIndexOf(' ');
    if (cut < Math.floor(maxLen * 0.5)) {
      // No usable space; fall back to any separator, then hard cut.
      cut = Math.max(slice.lastIndexOf(','), slice.lastIndexOf(';'), slice.lastIndexOf('-'));
    }
    if (cut < Math.floor(maxLen * 0.5)) return s.slice(0, maxLen).trim();
    return s.slice(0, cut).replace(/[\s,;:.|-]+$/, '').trim();
  }

  /** Collapse whitespace, drop trailing sentence punctuation noise. */
  function tidyText(str) {
    return String(str == null ? '' : str)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeKeyword(kw) {
    return tidyText(kw)
      .toLowerCase()
      .replace(/^["'\-\s]+|["'\s]+$/g, '')
      .replace(/[.,;:!?]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /** Sanitize a filename stem for a platform upload file. */
  function sanitizeFilename(name, maxLen) {
    var stem = String(name || '').replace(/\.[A-Za-z0-9]{2,5}$/, '');
    stem = stem.replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
    if (!stem) stem = 'asset';
    if (maxLen && stem.length > maxLen) stem = stem.slice(0, maxLen).replace(/_+$/, '');
    return stem;
  }

  /** Rough token estimate (good enough for cost display, not billing). */
  function estimateTokens(text) {
    if (!text) return 0;
    return Math.max(1, Math.round(String(text).length / 4));
  }

  function formatCost(usd) {
    if (!isFinite(usd)) return 'n/a';
    if (usd < 0.01) return '$' + usd.toFixed(5);
    return '$' + usd.toFixed(3);
  }

  /** Promise pool with a concurrency cap — used for batch image processing. */
  function createPool(limit) {
    var active = 0, queue = [];
    function next() {
      if (active >= limit || !queue.length) return;
      active++;
      var job = queue.shift();
      Promise.resolve()
        .then(job.fn)
        .then(function (v) { job.resolve(v); }, function (e) { job.reject(e); })
        .then(function () { active--; next(); });
    }
    return function (fn) {
      return new Promise(function (resolve, reject) {
        queue.push({ fn: fn, resolve: resolve, reject: reject });
        next();
      });
    };
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        resolve();
      } catch (e) { reject(e); }
    });
  }

  /* ------------------------------------------------------------------ *
   * Storage (localStorage; degrades to in-memory when unavailable).
   * ------------------------------------------------------------------ */
  var memStore = {};
  var hasLS = (function () {
    try {
      var k = STORAGE_PREFIX + '__t';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  var store = {
    available: hasLS,
    get: function (key, fallback) {
      try {
        var raw = hasLS ? localStorage.getItem(STORAGE_PREFIX + key) : memStore[key];
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      var raw = JSON.stringify(value);
      try {
        if (hasLS) localStorage.setItem(STORAGE_PREFIX + key, raw);
        else memStore[key] = raw;
      } catch (e) { memStore[key] = raw; }
    },
    remove: function (key) {
      try { if (hasLS) localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) { /* noop */ }
      delete memStore[key];
    }
  };

  var devMode = (function () {
    try {
      return typeof location !== 'undefined' &&
        /(?:\?|&)dev=1(?:&|$)/.test(location.search);
    } catch (e) { return false; }
  })();

  return {
    VERSION: VERSION,
    STORAGE_PREFIX: STORAGE_PREFIX,
    PLATFORMS: PLATFORMS,
    PLATFORM_BY_ID: PLATFORM_BY_ID,
    CONTENT_TYPES: CONTENT_TYPES,
    BANNED_FILLER: BANNED_FILLER,
    PACK_CUE_WORDS: PACK_CUE_WORDS,
    DESIGN_PURPOSE_POOL: DESIGN_PURPOSE_POOL,
    devMode: devMode,
    store: store,
    util: {
      clamp: clamp,
      uid: uid,
      escapeHtml: escapeHtml,
      debounce: debounce,
      sleep: sleep,
      truncateAtWord: truncateAtWord,
      tidyText: tidyText,
      normalizeKeyword: normalizeKeyword,
      sanitizeFilename: sanitizeFilename,
      estimateTokens: estimateTokens,
      formatCost: formatCost,
      createPool: createPool,
      downloadText: downloadText,
      copyText: copyText
    }
  };
});
