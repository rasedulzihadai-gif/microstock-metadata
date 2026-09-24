/*!
 * UI layer: virtualized queue list, results rendering, toasts.
 * Pure DOM, no framework — works from file://.
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
  var escapeHtml = util.escapeHtml;

  /* ------------------------------------------------------------------ *
   * Virtual list — keeps the DOM small when hundreds of images are queued.
   * ------------------------------------------------------------------ */
  function createVirtualList(scrollEl, options) {
    var rowHeight = options.rowHeight || 78;
    var overscan = options.overscan != null ? options.overscan : 4;
    var renderRow = options.renderRow;
    var items = [];
    var spacer = document.createElement('div');
    spacer.className = 'vlist-spacer';
    var layer = document.createElement('div');
    layer.className = 'vlist-layer';
    scrollEl.innerHTML = '';
    scrollEl.appendChild(spacer);
    scrollEl.appendChild(layer);
    var lastSignature = '';

    function viewportHeight() { return scrollEl.clientHeight || 420; }

    function paint(force) {
      var scrollTop = scrollEl.scrollTop;
      var start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
      var visible = Math.ceil(viewportHeight() / rowHeight) + overscan * 2;
      var end = Math.min(items.length, start + visible);
      var signature = [items.length, start, end, scrollTop].join('|') + '::' +
        items.slice(start, end).map(function (i) { return i.signature || i.id; }).join(',');

      if (!force && signature === lastSignature) return;
      lastSignature = signature;

      spacer.style.height = (items.length * rowHeight) + 'px';
      layer.style.transform = 'translateY(' + (start * rowHeight) + 'px)';
      var frag = document.createDocumentFragment();
      for (var i = start; i < end; i++) {
        var el = renderRow(items[i], i);
        if (!el) continue;
        el.style.height = (rowHeight - 8) + 'px';
        frag.appendChild(el);
      }
      layer.innerHTML = '';
      layer.appendChild(frag);
    }

    scrollEl.addEventListener('scroll', function () { paint(false); }, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { paint(true); }).observe(scrollEl);
    }

    return {
      setItems: function (nextItems) { items = nextItems; paint(true); },
      refresh: function () { paint(true); },
      scrollIntoView: function (index) {
        if (index < 0 || index >= items.length) return;
        var top = index * rowHeight;
        if (top < scrollEl.scrollTop || top + rowHeight > scrollEl.scrollTop + viewportHeight()) {
          scrollEl.scrollTop = top - viewportHeight() / 2 + rowHeight / 2;
        }
      },
      rowHeight: rowHeight
    };
  }

  /* ------------------------------------------------------------------ *
   * Toasts
   * ------------------------------------------------------------------ */
  function toast(message, kind) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () { el.classList.add('toast-out'); }, 3600);
    setTimeout(function () { el.remove(); }, 4200);
  }

  /* ------------------------------------------------------------------ *
   * Results rendering
   * ------------------------------------------------------------------ */
  var FLAG_EXPLANATIONS = {
    possible_vector_asset: 'The pack looks vector-built (AI/EPS/SVG).',
    confirm_file_type_ai_eps: 'Confirm the real exported file type (AI/EPS) before submitting.',
    pack_contains_text: 'Text/headline placeholders are visible — buyers replace that text.',
    content_type_hint_conflict: 'Your toggle disagreed with the model. Double-check which product type this is.',
    keyword_count_below_target: 'Fewer keywords than the platform target band.',
    text_not_visible: 'No text was found in the image.'
  };

  function levelLabel(level) {
    if (level === 'error') return 'Blocking';
    if (level === 'fixed') return 'Auto-fixed';
    return 'Review';
  }

  function renderBadge(label, value, kind) {
    return '<span class="badge' + (kind ? ' badge-' + kind : '') + '">' +
      '<span class="badge-label">' + escapeHtml(label) + '</span>' +
      '<span class="badge-value">' + escapeHtml(value) + '</span></span>';
  }

  function renderIssues(issues) {
    if (!issues || !issues.length) {
      return '<p class="ok-line">✓ No validation issues — every field passed the strict checks.</p>';
    }
    var order = { error: 0, fixed: 1, warn: 2 };
    var sorted = issues.slice().sort(function (a, b) {
      return (order[a.level] || 3) - (order[b.level] || 3);
    });
    return '<ul class="issue-list">' + sorted.map(function (i) {
      return '<li class="issue issue-' + escapeHtml(i.level) + '">' +
        '<span class="issue-level">' + escapeHtml(levelLabel(i.level)) + '</span>' +
        '<span class="issue-body"><code>' + escapeHtml(i.code) + '</code> ' + escapeHtml(i.message) + '</span>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function renderFlags(flags) {
    if (!flags || !flags.length) return '<p class="muted">No flags raised.</p>';
    return '<div class="chips">' + flags.map(function (f) {
      var why = FLAG_EXPLANATIONS[f];
      return '<span class="chip chip-flag" title="' + escapeHtml(why || f) + '">' + escapeHtml(f) + '</span>';
    }).join('') + '</div>';
  }

  function platformPanel(platform, entry, assetMeta) {
    var keywords = entry.keywords || [];
    var built = assetMeta && assetMeta.exports ? assetMeta.exports[platform.id] : null;
    var target = platform.keywordsTarget;
    var countClass = keywords.length >= target[0] ? 'good' : (keywords.length >= platform.keywordsMin ? 'warn' : 'bad');
    var categoryValue = platform.id === 'shutterstock' && Array.isArray(entry.categories)
      ? entry.categories.join(' · ')
      : (entry.category || assetMeta.categorySuggestion || '');

    var chips = keywords.map(function (k) {
      return '<span class="chip">' + escapeHtml(k) + '</span>';
    }).join('');

    var warnings = built && built.warnings.length
      ? '<ul class="warn-list">' + built.warnings.map(function (w) {
        return '<li>' + escapeHtml(w) + '</li>';
      }).join('') + '</ul>'
      : '';

    var caveats = built && built.caveats.length
      ? '<div class="caveat' + (built.controlledVocabulary ? ' caveat-strong' : '') + '">' +
        built.caveats.map(function (c) { return '<p>' + escapeHtml(c) + '</p>'; }).join('') + '</div>'
      : '';

    return '' +
      '<div class="platform-head">' +
      '<h3>' + escapeHtml(platform.label) + '</h3>' +
      '<span class="pill pill-' + countClass + '">' + keywords.length + ' keywords ' +
      '(target ' + target[0] + '-' + target[1] + ', max ' + platform.keywordsMax + ')</span>' +
      '<span class="pill">title ' + (entry.title || '').length + ' / ' + platform.titleMax + ' chars</span>' +
      '</div>' +
      (platform.notes ? '<p class="platform-note">' + escapeHtml(platform.notes) + '</p>' : '') +
      '<label class="field-label" for="title-' + platform.id + '">Title (editable — re-validates instantly)</label>' +
      '<input class="title-input" id="title-' + platform.id + '" data-platform="' + platform.id +
      '" data-field="title" value="' + escapeHtml(entry.title || '') + '">' +
      '<div class="platform-actions">' +
      '<button class="btn btn-sm" data-action="copy-title" data-platform="' + platform.id + '">Copy title</button>' +
      '<button class="btn btn-sm" data-action="copy-keywords" data-platform="' + platform.id + '">Copy keywords</button>' +
      '<button class="btn btn-sm" data-action="copy-csv" data-platform="' + platform.id + '">Copy CSV</button>' +
      '<button class="btn btn-sm btn-primary" data-action="download-csv" data-platform="' + platform.id + '">Download CSV</button>' +
      '</div>' +
      '<p class="field-label">Keywords — comma separated, edit to re-validate</p>' +
      '<textarea class="keywords-input" rows="3" data-platform="' + platform.id +
      '" data-field="keywords">' + escapeHtml(keywords.join(', ')) + '</textarea>' +
      '<div class="chips chips-keywords">' + chips + '</div>' +
      '<p class="muted">Category: <strong>' + escapeHtml(categoryValue || '(none)') + '</strong></p>' +
      (entry.note ? '<p class="muted">' + escapeHtml(entry.note) + '</p>' : '') +
      warnings + caveats;
  }

  function renderResults(host, ctx) {
    var item = ctx.item;
    var body = document.getElementById('resultsBody');
    var empty = document.getElementById('resultsEmpty');
    if (!body || !empty) return;

    if (!item) {
      empty.hidden = false;
      body.hidden = true;
      empty.innerHTML = '<div class="empty-inner"><div class="empty-icon">◫</div>' +
        '<h3>No asset selected</h3><p>Add images and generate metadata, then pick an item from the queue ' +
        'to inspect titles, keywords, validation notes and CSV exports.</p></div>';
      return;
    }

    empty.hidden = true;
    body.hidden = false;

    var meta = item.meta || {};
    var result = item.result;
    var precheck = item.precheck;

    if (item.status === 'error') {
      body.innerHTML = '<header class="result-head"><div><h2>' + escapeHtml(item.name) +
        '</h2><p class="muted">' + escapeHtml(item.error || 'Generation failed.') + '</p></div></header>' +
        '<div class="btn-row"><button class="btn btn-primary" data-action="retry">Retry</button>' +
        '<button class="btn btn-ghost" data-action="remove">Remove</button></div>';
      return;
    }

    if (!result) {
      body.innerHTML = '<header class="result-head"><div><h2>' + escapeHtml(item.name) +
        '</h2><p class="muted">Status: ' + escapeHtml(item.status) +
        (precheck ? ' · local pre-check: <strong>' + escapeHtml(precheck.contentType) + '</strong> (' +
          Math.round(precheck.confidence * 100) + '%)' : '') + '</p></div></header>';
      return;
    }

    var data = result.data;
    var contentType = MSMG.CONTENT_TYPES[data.content_type] || MSMG.CONTENT_TYPES.single_asset;
    var autoDetected = item.hint === 'auto';
    var issues = result.issues || [];
    var counts = result.stats || { errors: 0, fixed: 0, warnings: 0 };

    var tabs = MSMG.PLATFORMS.map(function (p, idx) {
      return '<button class="tab' + (idx === 0 ? ' is-active' : '') + '" data-tab="' + p.id + '">' +
        escapeHtml(p.short) + '</button>';
    }).join('');

    var panels = MSMG.PLATFORMS.map(function (p, idx) {
      var entry = data.platforms[p.id] || { title: '', keywords: [], category: '' };
      return '<div class="tab-panel' + (idx === 0 ? ' is-active' : '') + '" data-panel="' + p.id + '">' +
        platformPanel(p, entry, {
          exports: ctx.exports, categorySuggestion: data.category_suggestion
        }) + '</div>';
    }).join('');

    var signalLines = precheck ? precheck.evidence.map(function (e) {
      return '<li>' + escapeHtml(e) + '</li>';
    }).join('') : '';

    body.innerHTML = '' +
      '<header class="result-head">' +
      '<div class="result-preview"><img src="' + escapeHtml(item.thumbUrl || item.dataUrl) + '" alt=""></div>' +
      '<div class="result-meta">' +
      '<h2>' + escapeHtml(item.name) + '</h2>' +
      '<div class="badges">' +
      renderBadge('Content type', contentType.label, data.content_type === 'template_pack' ? 'pack' : 'single') +
      renderBadge(autoDetected ? 'Detection' : 'Toggle', autoDetected
        ? 'auto (pre-check ' + (precheck ? Math.round(precheck.confidence * 100) + '%' : 'n/a') + ')'
        : 'manual override') +
      renderBadge('Model', (meta.providerId || '?') + ' · ' + (meta.model || '?')) +
      renderBadge('Latency', (meta.latencyMs || 0) + ' ms') +
      (meta.cost ? renderBadge('Est. cost', util.formatCost(meta.cost)) : '') +
      renderBadge('Rule set', contentType.ruleSet) +
      '</div>' +
      '<p class="muted">' + escapeHtml(data.description || '') + '</p>' +
      '</div>' +
      '</header>' +

      '<div class="result-grid">' +
      '<section class="card">' +
      '<h3>Category suggestion</h3>' +
      '<p class="category-suggestion">' + escapeHtml(data.category_suggestion || '—') + '</p>' +
      '<h3>Flags</h3>' + renderFlags(data.flags) +
      '<h3>Validation <span class="muted">(' + counts.errors + ' blocking · ' + counts.fixed +
      ' auto-fixed · ' + counts.warnings + ' review)</span></h3>' +
      renderIssues(issues) +
      (precheck ? '<h3>Local pre-check signals</h3><p class="muted">' +
        escapeHtml(precheck.contentType) + ' (' + Math.round(precheck.confidence * 100) + '%)' +
        '</p><ul class="signal-list">' + signalLines + '</ul>' : '') +
      '</section>' +

      '<section class="card card-wide">' +
      '<div class="tabs">' + tabs + '</div>' +
      panels +
      '<div class="btn-row">' +
      '<button class="btn btn-primary" data-action="download-all">Download all CSVs</button>' +
      '<button class="btn" data-action="copy-all">Copy all metadata</button>' +
      '<button class="btn btn-ghost" data-action="retry">Re-generate</button>' +
      '<button class="btn btn-ghost" data-action="remove">Remove</button>' +
      '</div>' +
      '<details class="inspector"><summary>Prompt sent to the model</summary>' +
      '<p class="muted">Content-type hint: <strong>' + escapeHtml(item.hint || 'auto') +
      '</strong> · pre-check passed as advisory: <strong>' +
      escapeHtml(precheck ? precheck.contentType : 'none') + '</strong></p>' +
      '<pre class="prompt-pre">' + escapeHtml(ctx.systemPrompt || '') + '</pre></details>' +
      '<details class="inspector"><summary>Raw model output</summary>' +
      '<pre class="prompt-pre">' + escapeHtml(ctx.rawText || '(none)') + '</pre></details>' +
      '</section>' +
      '</div>';
  }

  return {
    ui: {
      createVirtualList: createVirtualList,
      toast: toast,
      renderResults: renderResults,
      renderIssues: renderIssues,
      FLAG_EXPLANATIONS: FLAG_EXPLANATIONS
    }
  };
});
