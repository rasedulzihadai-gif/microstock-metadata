/*!
 * Application logic: uploads, image preparation, content-type pre-check,
 * generation pipeline, queue orchestration, exports and panel wiring.
 *
 * coreGenerate() is DOM-free so the test suite (and the browser test page) can drive
 * the exact production pipeline.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./providers.js'),
      require('./prompts.js'), require('./validate.js'), require('./export.js'),
      require('./detect.js'), require('./ui.js'));
  } else {
    root.MSMG = root.MSMG || {};
    Object.assign(root.MSMG, factory(root.MSMG, root.MSMG, root.MSMG, root.MSMG, root.MSMG, root.MSMG));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
  function (MSMG, providersMod, promptsMod, validateMod, exportMod, detectMod, uiMod) {
    'use strict';

    var util = MSMG.util;
    var providers = (providersMod && providersMod.providers) || MSMG.providers;
    var prompts = (promptsMod && promptsMod.prompts) || MSMG.prompts;
    var validate = (validateMod && validateMod.validate) || MSMG.validate;
    var exportApi = (exportMod && exportMod.exports) || MSMG.exports;
    var detect = (detectMod && detectMod.detect) || MSMG.detect;
    var ui = (uiMod && uiMod.ui) || MSMG.ui;

    var PLATFORMS = MSMG.PLATFORMS;
    var PREVIEW_MAX_DIM = 1280;
    var THUMB_MAX_DIM = 240;

    var SETTINGS = {
      hint: 'contentTypeHint',
      autoGenerate: 'autoGenerate',
      showPrompt: 'showPrompt'
    };

    var state = {
      items: [],
      selectedId: null,
      hint: MSMG.store.get(SETTINGS.hint, 'auto'),
      autoGenerate: MSMG.store.get(SETTINGS.autoGenerate, false),
      processing: false,
      cancelRequested: false,
      virtualList: null,
      seen: {}
    };

    /* ------------------------------------------------------------------ *
     * Pipeline (DOM-free)
     * ------------------------------------------------------------------ */
    function noop() {}

    async function coreGenerate(options) {
      var providerId = options.providerId || providers.getActiveProviderId();
      var hint = options.hint && options.hint !== 'auto' ? options.hint : null;
      var precheck = options.precheck || null;

      var systemPrompt = prompts.buildSystemPrompt({
        contentTypeHint: hint,
        precheck: precheck
      });
      var userText = prompts.buildUserText({ filename: options.filename });

      var response = await providers.callVision(providerId, {
        systemPrompt: systemPrompt,
        userText: userText,
        imageDataUrl: options.dataUrl,
        signal: options.signal,
        mockScenario: options.mockScenario,
        precheckHint: precheck ? precheck.contentType : null,
        timeoutMs: options.timeoutMs || 180000
      });

      var validated = validate.validateAndFix(response.text, {
        contentTypeHint: hint,
        platforms: PLATFORMS
      });

      var built = {};
      if (validated.data && validated.data.platforms) {
        PLATFORMS.forEach(function (p) {
          built[p.id] = exportApi.buildCsv(p.id, validated.data.platforms[p.id] || {}, {
            filename: options.filename
          });
        });
      }

      var descriptor = providers.byId[providerId] || {};
      return {
        providerId: providerId,
        model: (response.cfg && response.cfg.model) || providers.getConfig(providerId).model,
        systemPrompt: systemPrompt,
        userText: userText,
        rawText: response.text,
        usage: response.usage,
        latencyMs: response.latencyMs,
        cost: providers.estimateCost(descriptor, response.usage, systemPrompt + userText),
        validated: validated,
        exports: built
      };
    }

    /** Re-run the validation layer on an edited data object (no API call). */
    function revalidate(data, hint) {
      var res = validate.validateAndFix(JSON.stringify(data), {
        contentTypeHint: hint && hint !== 'auto' ? hint : null,
        platforms: PLATFORMS
      });
      return res;
    }

    /* ------------------------------------------------------------------ *
     * Image preparation
     * ------------------------------------------------------------------ */
    function loadImage(src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('Could not decode the image.')); };
        img.src = src;
      });
    }

    function scaleToCanvas(img, maxDim) {
      var iw = img.naturalWidth || img.width;
      var ih = img.naturalHeight || img.height;
      var scale = Math.min(1, maxDim / Math.max(iw, ih));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(8, Math.round(iw * scale));
      canvas.height = Math.max(8, Math.round(ih * scale));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    async function prepareImage(file) {
      var original = await detect.readAsDataUrl(file);
      var img = await loadImage(original);
      var previewCanvas = scaleToCanvas(img, PREVIEW_MAX_DIM);
      var thumbCanvas = scaleToCanvas(img, THUMB_MAX_DIM);
      return {
        dataUrl: previewCanvas.toDataURL('image/jpeg', 0.9),
        thumbUrl: thumbCanvas.toDataURL('image/jpeg', 0.72),
        width: previewCanvas.width,
        height: previewCanvas.height
      };
    }

    /* ------------------------------------------------------------------ *
     * Queue
     * ------------------------------------------------------------------ */
    function createItem(file) {
      return {
        id: util.uid('item'),
        file: file,
        name: file.name,
        size: file.size,
        status: 'queued',
        hint: state.hint,
        precheck: null,
        result: null,
        meta: null,
        error: null,
        signature: 'queued'
      };
    }

    function touch(item, status) {
      item.status = status;
      item.signature = [status, item.result && item.result.data ? item.result.data.content_type : '',
        item.precheck ? item.precheck.contentType : '',
        (item.result && item.result.stats ? item.result.stats.errors + '/' + item.result.stats.fixed + '/' + item.result.stats.warnings : '')
      ].join('|');
    }

    async function addFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
        if (!f) return false;
        return /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name || '');
      });
      if (!files.length) {
        ui.toast('No image files found in that drop.', 'warn');
        return;
      }

      var added = [];
      files.forEach(function (file) {
        var key = file.name + '::' + file.size;
        if (state.seen[key]) {
          ui.toast('Skipped duplicate: ' + file.name, 'warn');
          return;
        }
        state.seen[key] = true;
        var item = createItem(file);
        state.items.push(item);
        added.push(item);
      });

      render();
      if (state.items.length) {
        if (!state.selectedId) selectItem(state.items[0].id);
        state.virtualList && state.virtualList.scrollIntoView(state.items.length - 1);
      }

      var hydratePool = util.createPool(3); // decode/downscale up to three images at once
      await Promise.all(added.map(function (item) { return hydratePool(function () { return hydrateItem(item); }); }));
      render();

      if (state.autoGenerate) generateAll();
    }

    async function hydrateItem(item) {
      try {
        var prepared = await prepareImage(item.file);
        item.dataUrl = prepared.dataUrl;
        item.thumbUrl = prepared.thumbUrl;
        item.width = prepared.width;
        item.height = prepared.height;
        touch(item, 'analyzing');
        item.precheck = await detect.analyzeDataUrl(item.dataUrl);
        touch(item, 'ready');
      } catch (err) {
        item.error = err.message;
        touch(item, 'error');
      }
      if (state.selectedId === item.id) renderResults();
    }

    async function processItem(item, apiPool) {
      if (item.status === 'error' && !item.dataUrl) return;
      try {
        if (!item.dataUrl) await hydrateItem(item);
        if (!item.precheck) {
          item.precheck = await detect.analyzeDataUrl(item.dataUrl);
        }
        if (state.cancelRequested) { touch(item, 'cancelled'); return; }

        touch(item, 'generating');
        renderQueueOnly();

        var controller = new AbortController();
        item.controller = controller;

        var trace = await apiPool(function () {
          if (state.cancelRequested) throw new Error('Cancelled before start.');
          return coreGenerate({
            dataUrl: item.dataUrl,
            filename: item.name,
            hint: item.hint !== 'auto' ? item.hint : state.hint,
            precheck: item.precheck,
            signal: controller.signal,
            providerId: providers.getActiveProviderId()
          });
        });

        item.result = trace.validated;
        item.meta = trace;
        item.error = trace.validated.ok ? null : 'Validation found blocking issues.';
        touch(item, trace.validated.data ? 'done' : 'error');
      } catch (err) {
        item.error = err.message;
        item.controller = null;
        touch(item, /cancel/i.test(err.message) ? 'cancelled' : 'error');
      } finally {
        item.controller = null;
        render();
      }
    }

    async function generateAll() {
      if (state.processing) return;
      var pending = state.items.filter(function (i) {
        return i.status === 'queued' || i.status === 'ready' || i.status === 'cancelled' || i.status === 'error';
      });
      if (!pending.length) {
        ui.toast(state.items.length ? 'Nothing left to generate.' : 'Add some images first.', 'warn');
        return;
      }

      var providerId = providers.getActiveProviderId();
      var cfg = providers.getConfig(providerId);
      if (cfg.wireFormat !== 'mock' && !cfg.apiKey) {
        ui.toast('Add an API key for ' + (providers.byId[providerId] || {}).label + ' first.', 'error');
        return;
      }

      state.processing = true;
      state.cancelRequested = false;
      renderControls();

      var apiPool = util.createPool(1); // one vision call at a time: predictable rate/cost
      var total = pending.length, done = 0;

      await Promise.all(pending.map(function (item) {
        return processItem(item, apiPool).then(function () {
          done++;
          updateProgress(done, total);
        });
      }));

      state.processing = false;
      render();
      ui.toast('Finished ' + total + ' asset' + (total === 1 ? '' : 's') + '.', 'ok');
    }

    function cancelAll() {
      if (!state.processing) return;
      state.cancelRequested = true;
      state.items.forEach(function (item) {
        if (item.controller) item.controller.abort();
      });
      ui.toast('Cancelling after the in-flight request…', 'warn');
    }

    function removeItem(id) {
      state.items = state.items.filter(function (i) { return i.id !== id; });
      if (state.selectedId === id) {
        state.selectedId = state.items.length ? state.items[0].id : null;
      }
      render();
    }

    function clearQueue() {
      state.items = [];
      state.seen = {};
      state.selectedId = null;
      render();
    }

    function selectItem(id) {
      state.selectedId = id;
      renderResults();
      renderQueueOnly();
    }

    /* ------------------------------------------------------------------ *
     * Rendering
     * ------------------------------------------------------------------ */
    function statusBadge(item) {
      var map = {
        queued: ['queued', 'Queued'],
        analyzing: ['analyzing', 'Analysing'],
        ready: ['ready', 'Ready'],
        generating: ['generating', 'Generating'],
        done: ['done', 'Done'],
        cancelled: ['cancelled', 'Cancelled'],
        error: ['error', 'Failed']
      };
      var entry = map[item.status] || ['queued', item.status];
      return '<span class="status status-' + entry[0] + '">' + util.escapeHtml(entry[1]) + '</span>';
    }

    function queueRow(item) {
      var el = document.createElement('div');
      el.className = 'queue-row' + (state.selectedId === item.id ? ' is-selected' : '');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.dataset.id = item.id;

      var typeBadge = '';
      if (item.result && item.result.data) {
        var ct = MSMG.CONTENT_TYPES[item.result.data.content_type];
        typeBadge = '<span class="mini-badge mini-' + item.result.data.content_type + '">' +
          util.escapeHtml(ct ? ct.shortLabel : item.result.data.content_type) + '</span>';
      } else if (item.precheck) {
        typeBadge = '<span class="mini-badge mini-hint" title="local pre-check">' +
          util.escapeHtml(item.precheck.contentType === 'template_pack' ? 'Pack?' : 'Single?') + '</span>';
      }

      var kw = item.result && item.result.data && item.result.data.platforms.adobe_stock
        ? (item.result.data.platforms.adobe_stock.keywords || []).length + ' kw'
        : (item.status === 'generating' ? '…' : '');

      var issueInfo = '';
      if (item.result && item.result.stats) {
        var s = item.result.stats;
        issueInfo = '<span class="mini-stat' + (s.errors ? ' is-bad' : '') + '">' + s.errors + ' blk</span>' +
          '<span class="mini-stat' + (s.fixed ? ' is-fixed' : '') + '">' + s.fixed + ' fix</span>' +
          '<span class="mini-stat' + (s.warnings ? ' is-warn' : '') + '">' + s.warnings + ' rev</span>';
      }

      el.innerHTML =
        '<div class="queue-thumb">' + (item.thumbUrl
          ? '<img src="' + util.escapeHtml(item.thumbUrl) + '" alt="">'
          : '<span class="thumb-placeholder">…</span>') + '</div>' +
        '<div class="queue-info">' +
        '<p class="queue-name" title="' + util.escapeHtml(item.name) + '">' + util.escapeHtml(item.name) + '</p>' +
        '<p class="queue-sub">' + statusBadge(item) + typeBadge +
        '<span class="mini-stat">' + util.escapeHtml(kw) + '</span>' + issueInfo + '</p>' +
        '</div>' +
        '<div class="queue-actions">' +
        '<button class="icon-btn" data-row-action="retry" title="Re-generate">⟳</button>' +
        '<button class="icon-btn" data-row-action="remove" title="Remove">✕</button>' +
        '</div>';

      el.addEventListener('click', function (ev) {
        var action = ev.target && ev.target.dataset ? ev.target.dataset.rowAction : null;
        if (action === 'remove') { ev.stopPropagation(); removeItem(item.id); return; }
        if (action === 'retry') {
          ev.stopPropagation();
          item.result = null;
          item.error = null;
          touch(item, 'queued');
          render();
          generateAll();
          return;
        }
        selectItem(item.id);
      });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectItem(item.id); }
      });
      return el;
    }

    function renderQueueOnly() {
      if (state.virtualList) state.virtualList.setItems(state.items);
    }

    function render() {
      renderQueueOnly();
      var count = document.getElementById('queueCount');
      if (count) {
        count.textContent = state.items.length + (state.items.length === 1 ? ' item' : ' items');
      }
      var doneCount = state.items.filter(function (i) { return i.status === 'done'; }).length;
      var totalCost = state.items.reduce(function (a, i) {
        return a + (i.meta && i.meta.cost ? i.meta.cost : 0);
      }, 0);
      var batchStatus = document.getElementById('batchStatus');
      if (batchStatus) {
        batchStatus.textContent = state.items.length
          ? doneCount + ' of ' + state.items.length + ' generated' +
            (totalCost ? ' · est. spend ' + util.formatCost(totalCost) : '')
          : 'Nothing queued yet.';
      }
      renderResults();
      renderControls();
    }

    function renderControls() {
      var generate = document.getElementById('generateAll');
      var cancel = document.getElementById('cancelAll');
      if (generate) generate.disabled = state.processing;
      if (cancel) cancel.disabled = !state.processing;
    }

    function updateProgress(done, total) {
      var bar = document.getElementById('batchProgress');
      if (bar) bar.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    }

    function renderResults() {
      var item = state.items.filter(function (i) { return i.id === state.selectedId; })[0] || null;
      ui.renderResults(document.getElementById('resultsBody'), {
        item: item,
        exports: item && item.meta ? item.meta.exports : null,
        systemPrompt: item && item.meta ? item.meta.systemPrompt : '',
        rawText: item && item.meta ? item.meta.rawText : ''
      });
    }

    /* ------------------------------------------------------------------ *
     * Results interactions
     * ------------------------------------------------------------------ */
    function selectedItem() {
      return state.items.filter(function (i) { return i.id === state.selectedId; })[0] || null;
    }

    function currentExports(item) {
      if (!item || !item.result || !item.result.data) return null;
      var built = {};
      PLATFORMS.forEach(function (p) {
        built[p.id] = exportApi.buildCsv(p.id, item.result.data.platforms[p.id] || {}, {
          filename: item.name
        });
      });
      return built;
    }

    function handleResultAction(action, platformId, target) {
      var item = selectedItem();
      if (!item || !item.result || !item.result.data) return;
      var data = item.result.data;
      var built = currentExports(item);

      if (action === 'copy-title' || action === 'copy-keywords') {
        var entry = data.platforms[platformId];
        if (!entry) return;
        var text = action === 'copy-title' ? entry.title : entry.keywords.join(', ');
        util.copyText(text).then(function () {
          ui.toast('Copied ' + (action === 'copy-title' ? 'title' : entry.keywords.length + ' keywords') +
            ' for ' + MSMG.PLATFORM_BY_ID[platformId].label + '.', 'ok');
        }, function () { ui.toast('Clipboard blocked by the browser.', 'error'); });
        return;
      }

      if (action === 'copy-csv') {
        util.copyText(built[platformId].csv).then(function () {
          ui.toast('Copied ' + MSMG.PLATFORM_BY_ID[platformId].label + ' CSV to clipboard.', 'ok');
        }, function () { ui.toast('Clipboard blocked by the browser.', 'error'); });
        return;
      }

      if (action === 'download-csv') {
        exportApi.download(platformId, data.platforms[platformId] || {}, { filename: item.name });
        ui.toast('Downloaded ' + built[platformId].filename, 'ok');
        return;
      }

      if (action === 'download-all') {
        PLATFORMS.forEach(function (p) {
          exportApi.download(p.id, data.platforms[p.id] || {}, { filename: item.name });
        });
        ui.toast('Downloaded all four platform CSVs.', 'ok');
        return;
      }

      if (action === 'copy-all') {
        var blocks = PLATFORMS.map(function (p) {
          var e = data.platforms[p.id] || {};
          return p.label + '\nTitle: ' + e.title + '\nKeywords (' + (e.keywords || []).length + '): ' +
            (e.keywords || []).join(', ');
        });
        util.copyText(blocks.join('\n\n')).then(function () {
          ui.toast('Copied all platform metadata.', 'ok');
        }, function () { ui.toast('Clipboard blocked by the browser.', 'error'); });
        return;
      }

      if (action === 'retry') {
        item.result = null;
        item.error = null;
        touch(item, 'queued');
        render();
        generateAll();
        return;
      }

      if (action === 'remove') removeItem(item.id);
      void target;
    }

    function handleEdit(target) {
      var item = selectedItem();
      if (!item || !item.result || !item.result.data) return;
      var platformId = target.dataset.platform;
      var field = target.dataset.field;
      if (!platformId || !field) return;

      var draft = JSON.parse(JSON.stringify(item.result.data));
      if (field === 'title') {
        draft.platforms[platformId].title = target.value;
      } else if (field === 'keywords') {
        draft.platforms[platformId].keywords = String(target.value)
          .split(',').map(function (k) { return k.trim(); }).filter(Boolean);
      }

      var revalidated = revalidate(draft, item.hint !== 'auto' ? item.hint : state.hint);
      item.result = revalidated;
      item.meta.exports = buildExports(item);
      render();
      ui.toast('Re-validated against the rule set.', 'ok');
    }

    function buildExports(item) {
      var built = {};
      if (!item.result || !item.result.data) return built;
      PLATFORMS.forEach(function (p) {
        built[p.id] = exportApi.buildCsv(p.id, item.result.data.platforms[p.id] || {}, { filename: item.name });
      });
      return built;
    }

    /* ------------------------------------------------------------------ *
     * Provider panel
     * ------------------------------------------------------------------ */
    function fillProviderSelect() {
      var select = document.getElementById('providerSelect');
      if (!select) return;
      var active = providers.getActiveProviderId();
      select.innerHTML = providers.visible().map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === active ? ' selected' : '') + '>' +
          util.escapeHtml(p.label) + (p.isDefault ? '  ★ default' : '') + '</option>';
      }).join('');
      loadProviderFields(active);
    }

    function loadProviderFields(id) {
      var cfg = providers.getConfig(id);
      var descriptor = providers.byId[id];
      var notes = document.getElementById('providerNotes');
      var keyInput = document.getElementById('providerKey');
      var modelInput = document.getElementById('providerModel');
      var modelList = document.getElementById('providerModelList');
      var baseUrl = document.getElementById('providerBaseUrl');
      var wire = document.getElementById('providerWire');
      var temp = document.getElementById('providerTemp');
      var maxTokens = document.getElementById('providerMaxTokens');
      var headers = document.getElementById('providerHeaders');
      var jsonMode = document.getElementById('providerJsonMode');

      if (notes) {
        notes.innerHTML = (descriptor.isDefault ? '<strong>Default provider.</strong> ' : '') +
          util.escapeHtml(descriptor.notes || '') +
          (descriptor.envKey ? ' <span class="muted">(env: ' + descriptor.envKey + ')</span>' : '');
      }
      if (keyInput) {
        keyInput.value = '';
        keyInput.placeholder = cfg.apiKey ? 'saved: ' + providers.maskKey(cfg.apiKey) : 'paste your API key';
      }
      if (modelInput) modelInput.value = cfg.model;
      if (modelList) {
        modelList.innerHTML = (descriptor.modelOptions || []).map(function (m) {
          return '<option value="' + util.escapeHtml(m) + '"></option>';
        }).join('');
      }
      if (baseUrl) baseUrl.value = cfg.baseUrl || '';
      if (wire) {
        wire.innerHTML = providers.WIRE_FORMATS.map(function (w) {
          return '<option value="' + w.id + '"' + (w.id === cfg.wireFormat ? ' selected' : '') + '>' +
            util.escapeHtml(w.label) + '</option>';
        }).join('');
      }
      if (temp) temp.value = cfg.temperature;
      if (maxTokens) maxTokens.value = cfg.maxTokens;
      if (headers) headers.value = Object.keys(cfg.extraHeaders || {}).length
        ? JSON.stringify(cfg.extraHeaders) : '';
      if (jsonMode) jsonMode.checked = cfg.jsonMode !== false;
    }

    function saveProviderFromFields() {
      var id = document.getElementById('providerSelect').value;
      var keyInput = document.getElementById('providerKey');
      var patch = {
        model: document.getElementById('providerModel').value.trim(),
        baseUrl: document.getElementById('providerBaseUrl').value.trim(),
        wireFormat: document.getElementById('providerWire').value,
        temperature: parseFloat(document.getElementById('providerTemp').value) || 0,
        maxTokens: parseInt(document.getElementById('providerMaxTokens').value, 10) || 2048,
        jsonMode: document.getElementById('providerJsonMode').checked
      };
      if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();

      var rawHeaders = document.getElementById('providerHeaders').value.trim();
      if (rawHeaders) {
        try { patch.extraHeaders = JSON.parse(rawHeaders); }
        catch (e) { ui.toast('Extra headers must be valid JSON.', 'error'); return; }
      } else {
        patch.extraHeaders = {};
      }

      providers.saveConfig(id, patch);
      if (keyInput) keyInput.value = '';
      loadProviderFields(id);
      ui.toast('Saved settings for ' + providers.byId[id].label + '.', 'ok');
    }

    function clearProviderKey() {
      var id = document.getElementById('providerSelect').value;
      providers.saveConfig(id, { apiKey: '' });
      loadProviderFields(id);
      ui.toast('Cleared the stored key for ' + providers.byId[id].label + '.', 'warn');
    }

    async function testProvider() {
      var id = document.getElementById('providerSelect').value;
      var status = document.getElementById('providerStatus');
      var keyInput = document.getElementById('providerKey');

      // Let people probe a key they just typed without committing it first.
      if (keyInput && keyInput.value.trim()) {
        providers.saveConfig(id, { apiKey: keyInput.value.trim() });
        loadProviderFields(id);
      }

      if (status) status.textContent = 'Testing…';
      try {
        var res = await providers.testConnection(id);
        if (status) {
          status.textContent = '✓ ' + providers.byId[id].label + ' responded in ' + res.latencyMs +
            ' ms: ' + (res.text || 'ok');
        }
      } catch (err) {
        if (status) status.textContent = '✕ ' + err.message;
      }
    }

    /* ------------------------------------------------------------------ *
     * Content-type toggle
     * ------------------------------------------------------------------ */
    function setHint(hint) {
      state.hint = hint;
      MSMG.store.set(SETTINGS.hint, hint);
      var host = document.getElementById('contentTypeToggle');
      if (host) {
        Array.prototype.forEach.call(host.querySelectorAll('button'), function (btn) {
          var active = btn.dataset.value === hint;
          btn.classList.toggle('is-active', active);
          btn.setAttribute('aria-checked', String(active));
        });
      }
      var text = document.getElementById('contentTypeHintText');
      if (text) {
        text.textContent = hint === 'auto'
          ? 'Auto-detect: the vision model classifies the upload, and a local layout pre-check is passed along as a weak prior.'
          : 'Manual hint: the model treats this as ' + MSMG.CONTENT_TYPES[hint].label.toLowerCase() +
          ' unless the image clearly contradicts it (which raises a flag). Applies to newly added files; use "Re-generate" to apply it to an existing item.';
      }
      state.items.forEach(function (item) { item.hint = hint; });
    }

    /* ------------------------------------------------------------------ *
     * init
     * ------------------------------------------------------------------ */
    function init() {
      var viewport = document.getElementById('queueViewport');
      if (viewport) {
        state.virtualList = ui.createVirtualList(viewport, {
          rowHeight: 78,
          renderRow: function (item) { return queueRow(item); }
        });
      }

      var dropzone = document.getElementById('dropzone');
      var fileInput = document.getElementById('fileInput');
      if (dropzone && fileInput) {
        dropzone.addEventListener('click', function () { fileInput.click(); });
        dropzone.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
        });
        fileInput.addEventListener('change', function () {
          addFiles(fileInput.files);
          fileInput.value = '';
        });
        ['dragenter', 'dragover'].forEach(function (evt) {
          dropzone.addEventListener(evt, function (e) {
            e.preventDefault();
            dropzone.classList.add('is-dragover');
          });
        });
        ['dragleave', 'drop'].forEach(function (evt) {
          dropzone.addEventListener(evt, function (e) {
            e.preventDefault();
            dropzone.classList.remove('is-dragover');
          });
        });
        dropzone.addEventListener('drop', function (e) {
          if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        });
      }

      document.addEventListener('paste', function (e) {
        if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
        addFiles(e.clipboardData.files);
      });

      var toggle = document.getElementById('contentTypeToggle');
      if (toggle) {
        toggle.addEventListener('click', function (e) {
          var btn = e.target.closest('button[data-value]');
          if (btn) setHint(btn.dataset.value);
        });
      }

      var autoGen = document.getElementById('autoGenerate');
      if (autoGen) {
        autoGen.checked = !!state.autoGenerate;
        autoGen.addEventListener('change', function () {
          state.autoGenerate = autoGen.checked;
          MSMG.store.set(SETTINGS.autoGenerate, state.autoGenerate);
        });
      }

      var generate = document.getElementById('generateAll');
      if (generate) generate.addEventListener('click', function () { generateAll(); });
      var cancel = document.getElementById('cancelAll');
      if (cancel) cancel.addEventListener('click', cancelAll);
      var clear = document.getElementById('clearQueue');
      if (clear) clear.addEventListener('click', clearQueue);

      var providerSelect = document.getElementById('providerSelect');
      if (providerSelect) {
        providerSelect.addEventListener('change', function () {
          providers.setActiveProviderId(providerSelect.value);
          loadProviderFields(providerSelect.value);
          document.getElementById('providerStatus').textContent = '';
        });
      }
      var saveBtn = document.getElementById('saveProvider');
      if (saveBtn) saveBtn.addEventListener('click', saveProviderFromFields);
      var testBtn = document.getElementById('testProvider');
      if (testBtn) testBtn.addEventListener('click', testProvider);
      var clearKey = document.getElementById('clearKey');
      if (clearKey) clearKey.addEventListener('click', clearProviderKey);

      var resultsBody = document.getElementById('resultsBody');
      if (resultsBody) {
        resultsBody.addEventListener('click', function (e) {
          var tab = e.target.closest('.tab');
          if (tab) {
            var wrap = tab.closest('.card-wide');
            Array.prototype.forEach.call(wrap.querySelectorAll('.tab'), function (t) {
              t.classList.toggle('is-active', t === tab);
            });
            Array.prototype.forEach.call(wrap.querySelectorAll('.tab-panel'), function (p) {
              p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
            });
            return;
          }
          var btn = e.target.closest('[data-action]');
          if (!btn) return;
          handleResultAction(btn.dataset.action, btn.dataset.platform, btn);
        });
        resultsBody.addEventListener('change', function (e) {
          var t = e.target;
          if (t.matches('[data-platform][data-field]')) handleEdit(t);
        });
      }

      fillProviderSelect();
      setHint(state.hint);
      render();
    }

    return {
      app: {
        state: state,
        init: init,
        coreGenerate: coreGenerate,
        revalidate: revalidate,
        buildExports: buildExports,
        addFiles: addFiles,
        generateAll: generateAll,
        cancelAll: cancelAll,
        setHint: setHint,
        selectItem: selectItem,
        prepareImage: prepareImage,
        localPrecheck: detect.analyzeDataUrl
      }
    };
  });
