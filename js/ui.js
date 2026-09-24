/*!
 * UI layer: virtualised filmstrip, results workspace, toasts.
 * Pure DOM, no framework — works from file:// and from a static host.
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
   * Virtual list — keeps the DOM tiny with hundreds of assets queued.
   * Supports a horizontal filmstrip (axis: 'x') and a vertical list ('y').
   * ------------------------------------------------------------------ */
  function createVirtualList(scrollEl, options) {
    var axis = options.axis === 'x' ? 'x' : 'y';
    var itemSize = axis === 'x' ? (options.itemWidth || 112) : (options.rowHeight || 76);
    var overscan = options.overscan != null ? options.overscan : 4;
    var renderItem = options.renderRow;
    var items = [];
    var spacer = document.createElement('div');
    var layer = document.createElement('div');
    layer.className = axis === 'x' ? 'strip-track' : 'vlist-layer';
    if (axis === 'y') spacer.className = 'vlist-spacer';
    scrollEl.innerHTML = '';
    scrollEl.appendChild(spacer);
    scrollEl.appendChild(layer);
    var lastSignature = '';

    function viewportSize() {
      return axis === 'x' ? (scrollEl.clientWidth || 800) : (scrollEl.clientHeight || 420);
    }

    function paint(force) {
      var scrollPos = axis === 'x' ? scrollEl.scrollLeft : scrollEl.scrollTop;
      var start = Math.max(0, Math.floor(scrollPos / itemSize) - overscan);
      var visible = Math.ceil(viewportSize() / itemSize) + overscan * 2;
      var end = Math.min(items.length, start + visible);
      var signature = [items.length, start, end, Math.round(scrollPos)].join('|') + '::' +
        items.slice(start, end).map(function (i) { return i.signature || i.id; }).join(',');

      if (!force && signature === lastSignature) return;
      lastSignature = signature;

      if (axis === 'x') {
        spacer.style.width = (items.length * itemSize) + 'px';
        spacer.style.height = '1px';
        layer.style.transform = 'translateX(' + (start * itemSize) + 'px)';
      } else {
        spacer.style.height = (items.length * itemSize) + 'px';
        layer.style.transform = 'translateY(' + (start * itemSize) + 'px)';
      }

      var frag = document.createDocumentFragment();
      for (var i = start; i < end; i++) {
        var el = renderItem(items[i], i);
        if (!el) continue;
        if (axis === 'x') {
          el.style.left = ((i - start) * itemSize) + 'px';
          el.style.width = (itemSize - 12) + 'px';
        } else {
          el.style.height = (itemSize - 8) + 'px';
        }
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
        var pos = index * itemSize;
        if (axis === 'x') {
          if (pos < scrollEl.scrollLeft || pos + itemSize > scrollEl.scrollLeft + viewportSize()) {
            scrollEl.scrollLeft = pos - viewportSize() / 2 + itemSize / 2;
          }
        } else if (pos < scrollEl.scrollTop || pos + itemSize > scrollEl.scrollTop + viewportSize()) {
          scrollEl.scrollTop = pos - viewportSize() / 2 + itemSize / 2;
        }
      },
      itemSize: itemSize,
      axis: axis
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
   * Shared pieces
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

  function badge(label, value, kind) {
    return '<span class="badge' + (kind ? ' badge-' + kind : '') + '">' +
      '<span class="badge-label">' + escapeHtml(label) + '</span>' +
      '<span class="badge-value">' + escapeHtml(value) + '</span></span>';
  }

  function meter(value, max, state) {
    var pct = max ? util.clamp(Math.round((value / max) * 100), 0, 100) : 0;
    return '<div class="meter" data-state="' + escapeHtml(state || 'ok') + '"><i style="width:' + pct + '%"></i></div>';
  }

  function renderIssues(issues) {
    if (!issues || !issues.length) {
      return '<p class="ok-line">✓ Everything passed the strict checks — no issues raised.</p>';
    }
    var order = { error: 0, fixed: 1, warn: 2 };
    var sorted = issues.slice().sort(function (a, b) {
      return (order[a.level] || 3) - (order[b.level] || 3);
    });
    return '<ul class="issue-list">' + sorted.map(function (i) {
      return '<li class="issue issue-' + escapeHtml(i.level) + '">' +
        '<span class="issue-level">' + escapeHtml(levelLabel(i.level)) + '</span>' +
        '<span class="issue-body"><code>' + escapeHtml(i.code) + '</code>' + escapeHtml(i.message) + '</span>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function renderFlags(flags) {
    if (!flags || !flags.length) return '<p class="hint">No flags raised.</p>';
    return '<div class="chips">' + flags.map(function (f) {
      return '<span class="chip chip-flag" title="' + escapeHtml(FLAG_EXPLANATIONS[f] || f) + '">' +
        escapeHtml(f) + '</span>';
    }).join('') + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Platform panel
   * ------------------------------------------------------------------ */
  function platformPanel(platform, entry, assetMeta) {
    var keywords = entry.keywords || [];
    var built = assetMeta && assetMeta.exports ? assetMeta.exports[platform.id] : null;
    var target = platform.keywordsTarget;
    var titleLength = (entry.title || '').length;
    var keywordState = keywords.length >= target[0] ? 'ok'
      : (keywords.length >= platform.keywordsMin ? 'warn' : 'bad');
    var titleState = titleLength > platform.titleMax ? 'bad'
      : (titleLength > platform.titleMax * 0.92 ? 'warn' : 'ok');
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
      '<div class="panel-toolbar">' +
      '<h3>' + escapeHtml(platform.label) + '</h3>' +
      '<span class="pill pill-' + keywordState + '">' + keywords.length + ' keywords</span>' +
      '<span class="pill' + (titleState === 'bad' ? ' pill-bad' : '') + '">' + titleLength + ' / ' +
      platform.titleMax + ' chars</span>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-sm" data-action="copy-title" data-platform="' + platform.id + '">Copy title</button>' +
      '<button class="btn btn-sm" data-action="copy-keywords" data-platform="' + platform.id + '">Copy keywords</button>' +
      '<button class="btn btn-sm" data-action="copy-csv" data-platform="' + platform.id + '">Copy CSV</button>' +
      '<button class="btn btn-sm btn-primary" data-action="download-csv" data-platform="' + platform.id + '">Download CSV</button>' +
      '</div>' +

      (platform.notes ? '<p class="hint" style="margin-bottom:14px">' + escapeHtml(platform.notes) + '</p>' : '') +

      '<label class="field-label" for="title-' + platform.id + '">Title</label>' +
      '<input class="title-input" id="title-' + platform.id + '" data-platform="' + platform.id +
      '" data-field="title" value="' + escapeHtml(entry.title || '') + '" style="margin:6px 0 8px">' +
      '<div class="row" style="margin-bottom:20px">' +
      meter(titleLength, platform.titleMax, titleState) +
      '<span class="hint nowrap">' + titleLength + ' / ' + platform.titleMax + '</span>' +
      '</div>' +

      '<label class="field-label" for="kw-' + platform.id + '">Keywords — edit to re-validate instantly</label>' +
      '<textarea class="keywords-input" id="kw-' + platform.id + '" data-platform="' + platform.id +
      '" data-field="keywords" style="margin:6px 0 8px">' + escapeHtml(keywords.join(', ')) + '</textarea>' +
      '<div class="row" style="margin-bottom:16px">' +
      meter(keywords.length, platform.keywordsMax, keywordState) +
      '<span class="hint nowrap">' + keywords.length + ' / ' + platform.keywordsMax +
      ' · target ' + target[0] + '–' + target[1] + '</span>' +
      '</div>' +

      '<div class="chips chips-keywords">' + chips + '</div>' +

      '<div class="row" style="margin-top:18px; gap:16px; flex-wrap:wrap">' +
      '<span class="hint">Category: <strong>' + escapeHtml(categoryValue || '(none)') + '</strong></span>' +
      (entry.note ? '<span class="hint">' + escapeHtml(entry.note) + '</span>' : '') +
      '</div>' +
      warnings + caveats;
  }

  /* ------------------------------------------------------------------ *
   * Failure view — always explain what happened and how to fix it
   * ------------------------------------------------------------------ */
  function failureView(item, ctx) {
    var meta = item.meta || {};
    var result = item.result;
    var issues = result && result.issues ? result.issues : [];
    var usage = meta.usage || {};
    var truncated = meta.truncated || (result && result.truncatedRepair);

    var hint = truncated
      ? '<div class="callout callout-warn"><span aria-hidden="true">⚠︎</span><span>' +
      '<span class="callout-strong">The answer was cut off by the token limit.</span><br>' +
      'Open <em>Advanced provider settings</em>, raise <code>Max tokens</code> (4096 or more suits four ' +
      'platforms), then press Retry. Any complete part of the answer was already salvaged.</span></div>'
      : '';

    return '' +
      '<header class="result-head">' +
      '<div class="result-thumb">' + (item.thumbUrl
        ? '<img src="' + escapeHtml(item.thumbUrl) + '" alt="">'
        : '<span class="faint">no preview</span>') + '</div>' +
      '<div class="result-title">' +
      '<h2>' + escapeHtml(item.name) + '</h2>' +
      '<div class="badges">' +
      badge('Status', 'generation failed', 'error') +
      badge('Model', (meta.providerId || '?') + ' · ' + (meta.model || '?')) +
      badge('Attempts', String(meta.attempts || 1)) +
      badge('Finish reason', meta.finishReason || 'n/a') +
      '</div>' +
      '<p class="result-desc">' + escapeHtml(item.error || 'The provider did not return usable metadata.') + '</p>' +
      '</div>' +
      '<div class="head-actions">' +
      '<button class="btn btn-sm btn-primary" data-action="retry">Retry</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="remove">Remove</button>' +
      '</div>' +
      '</header>' +
      hint +
      '<div class="pad">' +
      '<div class="inspector-grid">' +
      '<section class="subcard">' +
      '<h3>Why it failed</h3>' + renderIssues(issues) +
      '</section>' +
      '<section class="subcard">' +
      '<h3>Diagnostics</h3>' +
      '<ul class="signal-list">' +
      '<li>provider / model: ' + escapeHtml((meta.providerId || '?') + ' · ' + (meta.model || '?')) + '</li>' +
      '<li>attempts: ' + escapeHtml(String(meta.attempts || 1)) +
      (meta.retried ? ' — the first answer was retried automatically' : '') + '</li>' +
      '<li>finish reason: <strong>' + escapeHtml(meta.finishReason || '(none)') + '</strong>' +
      (truncated ? ' (token ceiling reached)' : '') + '</li>' +
      '<li>tokens: ' + escapeHtml(String(usage.inputTokens || '?')) + ' in / ' +
      escapeHtml(String(usage.outputTokens || '?')) + ' out</li>' +
      '<li>latency: ' + escapeHtml(String(meta.latencyMs || 0)) + ' ms</li>' +
      '<li>raw answer: ' + escapeHtml(String(ctx.rawText ? ctx.rawText.length : 0)) + ' chars</li>' +
      '</ul>' +
      '<div class="btn-row" style="margin-top:14px">' +
      '<button class="btn btn-sm" data-action="copy-diagnostics">Copy diagnostics</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="retry">Retry</button>' +
      '</div>' +
      '</section>' +
      '</div>' +
      '<section class="subcard" style="margin-top:16px">' +
      '<h3>Raw model answer</h3>' +
      '<pre class="prompt-pre" style="margin-top:12px">' + escapeHtml(ctx.rawText || '(empty response)') + '</pre>' +
      '<details class="inspector"><summary>Prompt that was sent</summary>' +
      '<pre class="prompt-pre">' + escapeHtml(ctx.systemPrompt || '') + '</pre></details>' +
      '</section>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Results
   * ------------------------------------------------------------------ */
  function renderResults(host, ctx) {
    var item = ctx.item;
    var body = document.getElementById('resultsBody');
    var empty = document.getElementById('resultsEmpty');
    if (!body || !empty) return;

    if (!item) {
      empty.hidden = false;
      body.hidden = true;
      empty.innerHTML = '<div class="empty-inner">' +
        '<div class="empty-icon" aria-hidden="true">' +
        '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" ' +
        'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/>' +
        '<circle cx="8.5" cy="9" r="1.6"/><path d="M21 15.5l-4.5-4.5L7 20.5"/></svg></div>' +
        '<h3>No asset selected</h3>' +
        '<p>Add images on the left, or pick one from the library. Each asset gets type-aware titles, keywords, ' +
        'categories and ready-to-import CSVs for Adobe Stock, Shutterstock, Freepik and iStock/Getty.</p>' +
        '</div>';
      return;
    }

    empty.hidden = true;
    body.hidden = false;

    var result = item.result;

    if (!result || !result.data) {
      body.innerHTML = failureView(item, ctx);
      return;
    }

    var meta = item.meta || {};
    var precheck = item.precheck;
    var data = result.data;
    var contentType = MSMG.CONTENT_TYPES[data.content_type] || MSMG.CONTENT_TYPES.single_asset;
    var autoDetected = item.hint === 'auto';
    var issues = result.issues || [];
    var counts = result.stats || { errors: 0, fixed: 0, warnings: 0 };
    var adobe = data.platforms.adobe_stock || { keywords: [] };

    var tabs = MSMG.PLATFORMS.map(function (p, idx) {
      return '<button class="tab' + (idx === 0 ? ' is-active' : '') + '" role="tab" data-tab="' + p.id +
        '" aria-selected="' + (idx === 0) + '">' + escapeHtml(p.short) + '</button>';
    }).join('');

    var panels = MSMG.PLATFORMS.map(function (p, idx) {
      var entry = data.platforms[p.id] || { title: '', keywords: [], category: '' };
      return '<div class="tab-panel' + (idx === 0 ? ' is-active' : '') + '" role="tabpanel" data-panel="' + p.id + '">' +
        platformPanel(p, entry, {
          exports: ctx.exports, categorySuggestion: data.category_suggestion
        }) + '</div>';
    }).join('');

    var signalLines = precheck && precheck.evidence ? precheck.evidence.map(function (e) {
      return '<li>' + escapeHtml(e) + '</li>';
    }).join('') : '<li>No pre-check evidence recorded.</li>';

    var validationPill = counts.errors
      ? '<span class="pill pill-bad">' + counts.errors + ' blocking</span>'
      : '<span class="pill pill-good">Clean</span>';

    body.innerHTML = '' +
      '<header class="result-head">' +
      '<div class="result-thumb"><img src="' + escapeHtml(item.thumbUrl || item.dataUrl) + '" alt=""></div>' +
      '<div class="result-title">' +
      '<h2>' + escapeHtml(item.name) + '</h2>' +
      '<div class="badges">' +
      badge('Content type', contentType.label, data.content_type === 'template_pack' ? 'pack' : 'single') +
      badge(autoDetected ? 'Detected' : 'Toggle', autoDetected
        ? (precheck ? Math.round(precheck.confidence * 100) + '%' : 'n/a') : 'manual') +
      badge('Rule set', contentType.ruleSet) +
      '</div>' +
      (data.description ? '<p class="result-desc">' + escapeHtml(data.description) + '</p>' : '') +
      '</div>' +
      '<div class="head-actions">' +
      '<button class="btn btn-sm btn-primary" data-action="download-all">Download all CSVs</button>' +
      '<button class="btn btn-sm" data-action="copy-all">Copy all</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="retry" title="Re-generate with the current settings">Regenerate</button>' +
      '<button class="btn btn-sm btn-ghost" data-action="remove">Remove</button>' +
      '</div>' +
      '</header>' +

      '<div class="stat-grid">' +
      '<div class="stat"><span class="k">Category</span><span class="v">' +
      escapeHtml(data.category_suggestion || '—') + '</span></div>' +
      '<div class="stat"><span class="k">Model</span><span class="v mono">' +
      escapeHtml((meta.providerId || '?') + ' · ' + (meta.model || '?')) + '</span></div>' +
      '<div class="stat"><span class="k">Latency</span><span class="v">' + escapeHtml(String(meta.latencyMs || 0)) +
      ' ms</span></div>' +
      '<div class="stat"><span class="k">Tokens</span><span class="v mono">' +
      escapeHtml(String((meta.usage && meta.usage.inputTokens) || '?')) + ' in / ' +
      escapeHtml(String((meta.usage && meta.usage.outputTokens) || '?')) + ' out</span></div>' +
      '<div class="stat"><span class="k">Adobe keywords</span><span class="v">' +
      escapeHtml(String((adobe.keywords || []).length)) + ' / 49</span></div>' +
      '<div class="stat"><span class="k">Validation</span><span class="v">' + validationPill + '</span></div>' +
      '</div>' +

      '<div class="pad">' +
      '<div class="panel-toolbar" style="margin-bottom:18px">' +
      '<div class="tabs" role="tablist" aria-label="Marketplace">' + tabs + '</div>' +
      '<span class="spacer"></span>' +
      (meta.cost ? '<span class="pill">est. ' + escapeHtml(util.formatCost(meta.cost)) + '</span>' : '') +
      (meta.retried ? '<span class="pill pill-warn" title="The first answer was cut off or invalid">auto-retried</span>' : '') +
      '</div>' +

      panels +

      '<div class="inspector-grid" style="margin-top:24px">' +
      '<section class="subcard">' +
      '<h3>Validation <span class="faint" style="font-weight:400">· ' + counts.errors + ' blocking · ' +
      counts.fixed + ' auto-fixed · ' + counts.warnings + ' review</span></h3>' +
      renderIssues(issues) +
      '</section>' +
      '<section class="subcard">' +
      '<h3>Flags &amp; pre-check</h3>' +
      renderFlags(data.flags) +
      (precheck ? '<p class="hint" style="margin-top:12px">Local layout pre-check suggested <strong>' +
        escapeHtml(precheck.contentType) + '</strong> (' + Math.round(precheck.confidence * 100) +
        '% confidence) — a hint to the model, never the decision.</p>' +
        '<ul class="signal-list" style="margin-top:8px">' + signalLines + '</ul>' : '') +
      '</section>' +
      '</div>' +

      '<details class="inspector"><summary>Prompt that was sent</summary>' +
      '<p class="hint">Content-type hint: <strong>' + escapeHtml(item.hint || 'auto') +
      '</strong> · pre-check passed as advisory: <strong>' +
      escapeHtml(precheck ? precheck.contentType : 'none') + '</strong></p>' +
      '<pre class="prompt-pre">' + escapeHtml(ctx.systemPrompt || '') + '</pre></details>' +

      '<details class="inspector"><summary>Raw model answer</summary>' +
      '<pre class="prompt-pre">' + escapeHtml(ctx.rawText || '(none)') + '</pre></details>' +
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
