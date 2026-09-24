/*!
 * Strict output-field validation + auto-fix layer.
 *
 * Never trusts the model. Parses defensively, enforces every field contract, then
 * applies the fixes rules A-K imply (filler removal, "editable text" -> "replaceable
 * text", category correctness, character ceilings, keyword caps/dedupe) and reports
 * everything it changed or could not fix.
 *
 * Issue levels:
 *   "error" — the field was unusable and had to be reconstructed/rejected
 *   "fixed" — auto-corrected, output is now compliant
 *   "warn"  — suspicious but left as-is for the contributor to judge
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
  var PLATFORMS = MSMG.PLATFORMS;
  var BANNED_FILLER = MSMG.BANNED_FILLER;
  var PACK_CUE_WORDS = MSMG.PACK_CUE_WORDS;
  var DESIGN_PURPOSE_POOL = MSMG.DESIGN_PURPOSE_POOL;

  var COLOUR_WORDS = [
    'blue', 'navy', 'azure', 'cyan', 'teal', 'turquoise', 'aqua', 'purple', 'violet',
    'lavender', 'magenta', 'pink', 'fuchsia', 'red', 'crimson', 'scarlet', 'maroon',
    'orange', 'amber', 'yellow', 'gold', 'golden', 'lime', 'green', 'emerald', 'mint',
    'olive', 'brown', 'beige', 'tan', 'cream', 'grey', 'gray', 'charcoal', 'silver',
    'black', 'white', 'pastel', 'neon', 'monochrome', 'multicoloured', 'multicolored',
    'colourful', 'colorful', 'vibrant', 'saturated', 'muted', 'dark', 'light', 'deep',
    'soft', 'glowing', 'iridescent', 'holographic', 'gradient'
  ];

  var TEXT_CUES = ['text', 'typography', 'headline', 'lettering', 'font', 'title block'];
  var VECTOR_CUES = ['vector', 'eps', 'ai file', 'illustrator', 'outlined', 'scalable', 'svg', 'infographic'];

  var CONTENT_TYPE_ALIASES = {
    'single_asset': 'single_asset',
    'single asset': 'single_asset',
    'single': 'single_asset',
    'background': 'single_asset',
    'single background': 'single_asset',
    'single_background': 'single_asset',
    'photo': 'single_asset',
    'template_pack': 'template_pack',
    'template pack': 'template_pack',
    'template': 'template_pack',
    'graphic resources': 'template_pack',
    'graphic_resources': 'template_pack',
    'pack': 'template_pack',
    'collection': 'template_pack'
  };

  function issue(level, code, field, message, extra) {
    return Object.assign({ level: level, code: code, field: field, message: message }, extra || {});
  }

  /* ------------------------------------------------------------------ *
   * Defensive JSON extraction
   * ------------------------------------------------------------------ */
  function extractJson(rawText) {
    var text = String(rawText == null ? '' : rawText).trim();
    var strippedProse = false;

    // Strip markdown fences (and count that as a repair, so it is reported).
    var fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fence && fence[1]) {
      var inner = fence[1].trim();
      if (inner !== text) strippedProse = true;
      text = inner;
    }

    // Fast path.
    try { return { data: JSON.parse(text), repaired: strippedProse }; } catch (e) { /* continue */ }

    // Brace matching that respects strings/escapes.
    var start = text.indexOf('{');
    if (start === -1) return { data: null, error: 'No JSON object found in the model response.' };
    var depth = 0, inString = false, escaped = false, end = -1;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return { data: null, error: 'Unbalanced braces in the model response.' };

    var candidate = text.slice(start, end + 1);
    try {
      return { data: JSON.parse(candidate), repaired: true };
    } catch (e2) {
      // Last resort: trailing commas.
      try {
        return { data: JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')), repaired: true };
      } catch (e3) {
        return { data: null, error: 'Model response is not valid JSON: ' + e3.message };
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function normalizeContentType(value, hint) {
    if (typeof value === 'string') {
      var key = value.trim().toLowerCase().replace(/\s+/g, ' ');
      if (CONTENT_TYPE_ALIASES[key]) return CONTENT_TYPE_ALIASES[key];
    }
    if (hint && MSMG.CONTENT_TYPES[hint]) return hint;
    return null;
  }

  function containsBanned(text) {
    var low = ' ' + String(text || '').toLowerCase() + ' ';
    for (var i = 0; i < BANNED_FILLER.length; i++) {
      var term = BANNED_FILLER[i];
      var pattern = term.indexOf(' ') >= 0
        ? low.indexOf(' ' + term + ' ') >= 0
        : new RegExp('(^|[^a-z])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(low);
      if (pattern) return term;
    }
    return null;
  }

  function stripLeadingNoise(title) {
    return util.tidyText(title)
      .replace(/^(image|picture|photo)\s+of\s+/i, '')
      .replace(/^a\s+(photo|picture|image)\s+showing\s+/i, '')
      .replace(/\s*\.{2,}\s*/g, ' ')
      .replace(/[!]{1,}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function swapEditableText(str) {
    return String(str || '')
      .replace(/\beditable\s+text\b/gi, 'replaceable text')
      .replace(/\beditable\s+texts\b/gi, 'replaceable text');
  }

  function hasTextCues(haystack) {
    var low = String(haystack || '').toLowerCase();
    return TEXT_CUES.some(function (cue) { return low.indexOf(cue) >= 0; });
  }

  function hasVectorCues(haystack) {
    var low = String(haystack || '').toLowerCase();
    return VECTOR_CUES.some(function (cue) { return low.indexOf(cue) >= 0; });
  }

  function hasColourKeyword(keywords) {
    var low = keywords.join(' ').toLowerCase();
    return COLOUR_WORDS.some(function (c) { return low.indexOf(c) >= 0; });
  }

  function countDesignPurposeTerms(keywords) {
    var low = keywords.join(' | ').toLowerCase();
    var hits = [];
    DESIGN_PURPOSE_POOL.forEach(function (term) {
      if (low.indexOf(term) >= 0 && hits.indexOf(term) === -1) hits.push(term);
    });
    return hits;
  }

  /* ------------------------------------------------------------------ *
   * Main entry point
   * ------------------------------------------------------------------ */
  function validateAndFix(rawText, options) {
    options = options || {};
    var issues = [];
    var hint = options.contentTypeHint && MSMG.CONTENT_TYPES[options.contentTypeHint]
      ? options.contentTypeHint : null;
    var platforms = options.platforms || PLATFORMS;

    var parsed = extractJson(rawText);
    if (!parsed.data || typeof parsed.data !== 'object') {
      return {
        ok: false,
        data: null,
        issues: [issue('error', 'json_parse_failed', '*', parsed.error || 'Unparseable model output.')],
        stats: { errors: 1, fixed: 0, warnings: 0 }
      };
    }
    if (parsed.repaired) {
      issues.push(issue('fixed', 'json_extracted_from_prose', '*',
        'Extracted the JSON object from surrounding model prose/fences.'));
    }

    var data = parsed.data;

    /* ---- content_type ---- */
    var rawType = data.content_type;
    var contentType = normalizeContentType(rawType, null);
    if (!contentType) {
      contentType = hint || 'single_asset';
      issues.push(issue('error', 'content_type_missing', 'content_type',
        'Model did not return a usable content_type ("' + String(rawType) +
        '"); defaulted to "' + contentType + '".'));
    } else if (typeof rawType === 'string' && rawType !== contentType) {
      issues.push(issue('fixed', 'content_type_normalized', 'content_type',
        'Normalised content_type "' + rawType + '" to "' + contentType + '".'));
    }
    if (hint && contentType !== hint) {
      issues.push(issue('warn', 'content_type_hint_conflict', 'content_type',
        'Interface hint was "' + hint + '" but the model classified the image as "' +
        contentType + '".'));
    }
    data.content_type = contentType;
    var isPack = contentType === 'template_pack';

    /* ---- description ---- */
    if (typeof data.description !== 'string' || !data.description.trim()) {
      data.description = '';
      issues.push(issue('warn', 'description_missing', 'description',
        'No description returned; the export uses platform titles instead.'));
    } else {
      var tidyDesc = util.tidyText(data.description);
      if (isPack) {
        var swappedDesc = swapEditableText(tidyDesc);
        if (swappedDesc !== tidyDesc) {
          issues.push(issue('fixed', 'editable_text_swapped', 'description',
            'Rule J: replaced "editable text" with "replaceable text" in the description.'));
          tidyDesc = swappedDesc;
        }
      }
      data.description = tidyDesc;
    }

    /* ---- platforms ---- */
    if (!data.platforms || typeof data.platforms !== 'object') {
      data.platforms = {};
      issues.push(issue('error', 'platforms_missing', 'platforms',
        'Model response had no "platforms" object; it was created empty.'));
    }

    platforms.forEach(function (platform) {
      var field = 'platforms.' + platform.id;
      var entry = data.platforms[platform.id];

      if (!entry || typeof entry !== 'object') {
        data.platforms[platform.id] = { title: '', keywords: [], category: '' };
        issues.push(issue('error', 'platform_block_missing', field,
          'Missing "' + platform.id + '" block; created an empty stub that must be filled manually.'));
        return;
      }

      /* title */
      var title = typeof entry.title === 'string' ? stripLeadingNoise(entry.title) : '';
      if (!title) {
        issues.push(issue('error', 'title_missing', field + '.title',
          'No title returned for ' + platform.label + '.'));
      }
      if (isPack) {
        var swappedTitle = swapEditableText(title);
        if (swappedTitle !== title) {
          issues.push(issue('fixed', 'editable_text_swapped', field + '.title',
            'Rule J: replaced "editable text" with "replaceable text" in the ' + platform.label + ' title.'));
          title = swappedTitle;
        }
      }
      var titleLow = title.toLowerCase();
      var fillerInTitle = containsBanned(titleLow);
      if (fillerInTitle) {
        issues.push(issue('warn', 'banned_word_in_title', field + '.title',
          'Rule C: title contains banned filler word "' + fillerInTitle + '" (' + platform.label + ').'));
      }
      if (platform.titleHardMax && title.length > platform.titleHardMax) {
        var originalLength = title.length;
        title = util.truncateAtWord(title, platform.titleHardMax);
        issues.push(issue('fixed', 'title_over_hard_limit', field + '.title',
          platform.label + ' title was ' + originalLength + ' chars, past the absolute maximum (' +
          platform.titleHardMax + '); hard-trimmed on a word boundary.'));
      } else if (platform.titleMax && title.length > platform.titleMax) {
        var trimmed = util.truncateAtWord(title, platform.titleMax);
        issues.push(issue('fixed', 'title_over_limit', field + '.title',
          platform.label + ' title was ' + title.length + ' chars, over the ' + platform.titleMax +
          '-char ceiling (rule ' + (isPack ? 'H' : 'G') + '); trimmed to ' + trimmed.length +
          ' chars on a word boundary.'));
        title = trimmed;
      }
      entry.title = title;

      /* keywords */
      var rawKeywords = Array.isArray(entry.keywords) ? entry.keywords : [];
      if (!Array.isArray(entry.keywords)) {
        issues.push(issue('error', 'keywords_not_array', field + '.keywords',
          'Keywords field was not an array; replaced with the recovered list.'));
      }
      var cleaned = [];
      var seen = {};
      var removedFiller = [];
      var removedDupes = [];

      rawKeywords.forEach(function (kw) {
        if (typeof kw !== 'string') return;
        var term = util.normalizeKeyword(isPack ? swapEditableText(kw) : kw);
        if (!term) return;
        var filler = containsBanned(term);
        if (filler) { removedFiller.push(term); return; }
        var dupeKey = term.split(' ').sort().join(' ');
        if (seen[term] || seen[dupeKey]) { removedDupes.push(term); return; }
        seen[term] = true;
        seen[dupeKey] = true;
        if (term !== kw) { /* silently normalised casing/format per rule E */ }
        cleaned.push(term);
      });

      if (removedFiller.length) {
        issues.push(issue('fixed', 'filler_keywords_removed', field + '.keywords',
          'Rule C: removed ' + removedFiller.length + ' filler keyword(s): ' + removedFiller.join(', ') + '.'));
      }
      if (removedDupes.length) {
        issues.push(issue('fixed', 'duplicate_keywords_removed', field + '.keywords',
          'Rule E: removed ' + removedDupes.length + ' duplicate/word-order duplicate(s): ' +
          removedDupes.slice(0, 6).join(', ') + (removedDupes.length > 6 ? '…' : '') + '.'));
      }
      if (cleaned.length > platform.keywordsMax) {
        var dropped = cleaned.length - platform.keywordsMax;
        cleaned = cleaned.slice(0, platform.keywordsMax);
        issues.push(issue('fixed', 'keywords_truncated', field + '.keywords',
          platform.label + ' accepts at most ' + platform.keywordsMax + ' keywords; dropped the ' +
          dropped + ' lowest-priority term(s).'));
      }
      if (cleaned.length < platform.keywordsMin) {
        issues.push(issue('warn', 'keyword_count_below_target', field + '.keywords',
          platform.label + ' needs at least ' + platform.keywordsMin + ' keywords; only ' +
          cleaned.length + ' survived validation.'));
      } else if (cleaned.length < platform.keywordsTarget[0]) {
        issues.push(issue('warn', 'keyword_count_below_target', field + '.keywords',
          platform.label + ' has ' + cleaned.length + ' keywords — below the ' +
          platform.keywordsTarget[0] + '-' + platform.keywordsTarget[1] + ' target band.'));
      }
      entry.keywords = cleaned;

      /* categories */
      if (platform.id === 'shutterstock') {
        var cats = Array.isArray(entry.categories)
          ? entry.categories.filter(function (c) { return typeof c === 'string' && c.trim(); })
          : [];
        cats = cats.slice(0, 2).map(function (c) { return util.tidyText(c); });
        if (Array.isArray(entry.categories) && entry.categories.length > 2) {
          issues.push(issue('fixed', 'categories_truncated', field + '.categories',
            'Shutterstock allows two categories; kept the first two.'));
        }
        if (entry.category && cats.indexOf(entry.category) === -1) cats.unshift(entry.category);
        entry.categories = cats.slice(0, 2);
      }
      if (typeof entry.category !== 'string') entry.category = '';
      if (platform.id === 'istock_getty') {
        var note = typeof entry.note === 'string' ? entry.note : '';
        if (!/controlled vocabulary/i.test(note)) {
          entry.note = 'Getty uses a controlled vocabulary: some keywords are mapped to preferred ' +
            'terms and categories must be chosen from Getty\'s own list — verify in the contributor portal.';
          issues.push(issue('fixed', 'getty_caveat_added', field + '.note',
            'Added the controlled-vocabulary caveat required for Getty exports.'));
        } else {
          entry.note = note;
        }
      }
    });

    /* ---- category_suggestion (rule K) ---- */
    var suggestion = typeof data.category_suggestion === 'string' ? util.tidyText(data.category_suggestion) : '';
    if (isPack) {
      if (!/graphic resources/i.test(suggestion)) {
        issues.push(issue('fixed', 'category_autofixed', 'category_suggestion',
          'Rule K: template_pack category was "' + (suggestion || '(empty)') +
          '"; set to "Graphic Resources".'));
        suggestion = 'Graphic Resources';
      }
    } else if (/graphic resources/i.test(suggestion)) {
      issues.push(issue('fixed', 'category_autofixed', 'category_suggestion',
        'Single-asset background was categorised as "Graphic Resources"; set to "Backgrounds/Textures" instead.'));
      suggestion = 'Backgrounds/Textures';
    }
    data.category_suggestion = suggestion || (isPack ? 'Graphic Resources' : 'Backgrounds/Textures');

    /* ---- flags (rule K + bookkeeping) ---- */
    var flags = Array.isArray(data.flags)
      ? data.flags.filter(function (f) { return typeof f === 'string' && f.trim(); })
        .map(function (f) { return util.tidyText(f).toLowerCase().replace(/\s+/g, '_'); })
      : [];
    if (!Array.isArray(data.flags)) {
      issues.push(issue('fixed', 'flags_normalized', 'flags', 'Flags were not an array; recreated.'));
    }

    var packHaystack = [
      data.description,
      data.platforms.adobe_stock ? data.platforms.adobe_stock.title : '',
      data.platforms.adobe_stock ? (data.platforms.adobe_stock.keywords || []).join(' ') : '',
      suggestion
    ].join(' ');

    if (isPack) {
      var vectorish = hasVectorCues(packHaystack);
      if (vectorish) {
        ['possible_vector_asset', 'confirm_file_type_ai_eps'].forEach(function (f) {
          if (flags.indexOf(f) === -1) {
            flags.push(f);
            issues.push(issue('fixed', 'vector_flag_added', 'flags',
              'Rule K: added flag "' + f + '" so the interface can ask the contributor to confirm the real file type.'));
          }
        });
      }
      if (hasTextCues(packHaystack) && flags.indexOf('pack_contains_text') === -1) {
        flags.push('pack_contains_text');
      }
    }

    data.flags = flags;
    /* ---- rule linters (warnings only) ---- */
    var adobe = data.platforms.adobe_stock || { title: '', keywords: [] };
    var adobeKeywords = adobe.keywords || [];
    var adobeTitle = adobe.title || '';

    if (!hasColourKeyword(adobeKeywords)) {
      issues.push(issue('warn', 'no_colour_keywords', 'platforms.adobe_stock.keywords',
        'Rules A/B: no colour keyword detected — every listing should carry its real colours.'));
    }

    if (isPack) {
      var packCue = PACK_CUE_WORDS.some(function (cue) {
        return adobeTitle.toLowerCase().indexOf(cue) >= 0;
      });
      if (!packCue) {
        issues.push(issue('warn', 'template_title_missing_pack_cue', 'platforms.adobe_stock.title',
          'Rule H: title does not name the template kind (poster templates / cover designs / ' +
          'banner set / collection). Buyers search for the product type explicitly.'));
      }
      var purposeHits = countDesignPurposeTerms(adobeKeywords);
      if (purposeHits.length < 3) {
        issues.push(issue('warn', 'design_purpose_keywords_thin', 'platforms.adobe_stock.keywords',
          'Rule I: only ' + purposeHits.length + ' design-purpose keyword(s) found (' +
          (purposeHits.join(', ') || 'none') +
          '). The template layer should sit alongside the colour and use-case keywords.'));
      }
    } else {
      var stuffing = (adobeTitle.match(/,/g) || []).length;
      if (stuffing >= 3) {
        issues.push(issue('warn', 'title_may_be_stuffed', 'platforms.adobe_stock.title',
          'Rule G: single-asset title contains ' + stuffing + ' commas — it may read as a keyword dump.'));
      }
      if (/editable text/i.test(adobeTitle + ' ' + adobeKeywords.join(' '))) {
        issues.push(issue('warn', 'editable_text_in_text_context', 'platforms.adobe_stock',
          'Rule J wording ("replaceable text" rather than "editable text") appears in a ' +
          'single-asset listing — confirm the asset really contains text to swap.'));
      }
      if (/\b(set|collection|pack)\b/i.test(adobeTitle)) {
        issues.push(issue('warn', 'pack_language_in_single_asset', 'platforms.adobe_stock.title',
          'Rule G: single-asset titles must not advertise a "set/collection"; if this really is a ' +
          'pack, switch the content-type toggle to template pack.'));
      }
    }

    /* ---- cross-keyword contradiction lint (rule D) ---- */
    var kwLow = adobeKeywords.join(' ').toLowerCase();
    function contradicts(a, b, message) {
      if (kwLow.indexOf(a) >= 0 && kwLow.indexOf(b) >= 0) {
        issues.push(issue('warn', 'contradictory_keywords', 'platforms.adobe_stock.keywords', message));
      }
    }
    contradicts('photo', 'vector', 'Rule D: "photo" and "vector" both present — the asset cannot be both.');
    contradicts('photo', 'illustration', 'Rule D: "photo" and "illustration" both present.');
    contradicts('3d', 'flat', 'Rule D: "3d" and "flat" both present.');

    /* ---- stats ---- */
    var stats = { errors: 0, fixed: 0, warnings: 0 };
    issues.forEach(function (i) {
      if (i.level === 'error') stats.errors++;
      else if (i.level === 'fixed') stats.fixed++;
      else stats.warnings++;
    });

    return {
      ok: stats.errors === 0,
      data: data,
      issues: issues,
      stats: stats,
      repaired: !!parsed.repaired
    };
  }

  return {
    validate: {
      validateAndFix: validateAndFix,
      extractJson: extractJson,
      containsBanned: containsBanned,
      swapEditableText: swapEditableText,
      COLOUR_WORDS: COLOUR_WORDS,
      TEXT_CUES: TEXT_CUES,
      VECTOR_CUES: VECTOR_CUES
    }
  };
});
