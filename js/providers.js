/*!
 * Provider registry + wire-format adapters.
 *
 * Registry pattern: every provider is a plain descriptor object. Adding a provider
 * means adding a descriptor here — nothing else in the app needs to change.
 *
 * wireFormat decides the request/response shape:
 *   "openai-chat-completions"   -> OpenAI, DeepSeek, and all gateway providers
 *   "anthropic-messages"        -> Anthropic native
 *   "gemini-generate-content"   -> Google Gemini native
 *
 * Gateways (xKiro / Vyce / Helyx / AgentRouter / SeekAi) are OpenAI-compatible by
 * default; their baseUrl values are editable placeholders and should be verified
 * against the gateway's own documentation before use.
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
  var store = MSMG.store;

  var WIRE_FORMATS = [
    { id: 'openai-chat-completions', label: 'OpenAI chat-completions (compatible)' },
    { id: 'anthropic-messages', label: 'Anthropic messages' },
    { id: 'gemini-generate-content', label: 'Gemini generateContent' }
  ];

  /* ------------------------------------------------------------------ *
   * The registry
   * ------------------------------------------------------------------ */
  var PROVIDERS = [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-flash',
      modelOptions: ['deepseek-flash', 'deepseek-v4-flash-vision-exp'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      isDefault: true,
      envKey: 'DEEPSEEK_API_KEY',
      costPerMTokIn: 0.22,
      costPerMTokOut: 0.88,
      notes: [
        'Primary/default provider.',
        'Native multimodal — accepts image_url payloads exactly like OpenAI chat-completions.',
        '"deepseek-flash" is the current GA model id (native vision built in). The older',
        '"deepseek-v4-flash-vision-exp" id still routes to the same model, but the plain id',
        'is the officially current name.',
        'Weaker at dense small-text OCR than at scene/composition understanding — irrelevant',
        'here (background/pattern/template analysis, not document OCR), so no special handling.',
        'Very low cost (~$0.22/1M input tokens), which is why it is the default.'
      ].join(' ')
    },
    {
      id: 'openai',
      label: 'OpenAI',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      modelOptions: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      envKey: 'OPENAI_API_KEY',
      costPerMTokIn: 2.5,
      costPerMTokOut: 10,
      notes: 'OpenAI-compatible baseline; any chat-completions model with vision support works.'
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      wireFormat: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-4-5',
      modelOptions: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
      authHeader: 'x-api-key',
      authPrefix: '',
      extraHeaders: { 'anthropic-version': '2023-06-01' },
      supportsVision: true,
      envKey: 'ANTHROPIC_API_KEY',
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      notes: 'Native messages API. Images are sent as base64 blocks before the text block.'
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      wireFormat: 'gemini-generate-content',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-2.5-flash',
      modelOptions: ['gemini-2.5-flash', 'gemini-2.5-pro'],
      authHeader: 'x-goog-api-key',
      authPrefix: '',
      supportsVision: true,
      envKey: 'GEMINI_API_KEY',
      costPerMTokIn: 0.3,
      costPerMTokOut: 2.5,
      notes: 'Key is sent as a header (never in the query string). System prompt goes in systemInstruction.'
    },
    {
      id: 'xkiro',
      label: 'xKiro (gateway)',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://api.xkiro.ai/v1',
      defaultModel: 'xkiro-vision-1',
      modelOptions: ['xkiro-vision-1'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      envKey: 'XKIRO_API_KEY',
      gateway: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      notes: 'OpenAI-compatible gateway. Default endpoint is a placeholder — verify with the gateway docs.'
    },
    {
      id: 'vyce',
      label: 'Vyce (gateway)',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://api.vyce.ai/v1',
      defaultModel: 'vyce-vision',
      modelOptions: ['vyce-vision'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      envKey: 'VYCE_API_KEY',
      gateway: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      notes: 'OpenAI-compatible gateway. Default endpoint is a placeholder — verify with the gateway docs.'
    },
    {
      id: 'helyx',
      label: 'Helyx (gateway)',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://api.helyx.ai/v1',
      defaultModel: 'helyx-vision',
      modelOptions: ['helyx-vision'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      envKey: 'HELYX_API_KEY',
      gateway: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      notes: 'OpenAI-compatible gateway. Default endpoint is a placeholder — verify with the gateway docs.'
    },
    {
      id: 'agentrouter',
      label: 'AgentRouter (gateway)',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://agentrouter.org/v1',
      defaultModel: 'agentrouter-vision',
      modelOptions: ['agentrouter-vision'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      envKey: 'AGENTROUTER_API_KEY',
      gateway: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      notes: 'OpenAI-compatible gateway. Default endpoint is a placeholder — verify with the gateway docs.'
    },
    {
      id: 'seekai',
      label: 'SeekAi (gateway)',
      wireFormat: 'openai-chat-completions',
      baseUrl: 'https://api.seekai.dev/v1',
      defaultModel: 'seekai-vision',
      modelOptions: ['seekai-vision'],
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      supportsVision: true,
      envKey: 'SEEKAI_API_KEY',
      gateway: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      notes: 'OpenAI-compatible gateway. Default endpoint is a placeholder — verify with the gateway docs.'
    },
    {
      id: 'mock',
      label: 'Mock (offline testing)',
      wireFormat: 'mock',
      baseUrl: '',
      defaultModel: 'mock-vision',
      modelOptions: ['mock-vision'],
      supportsVision: true,
      devOnly: true,
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      notes: 'Deterministic offline provider used by the test suite. Never use for real listings.'
    }
  ];

  var PROVIDER_BY_ID = PROVIDERS.reduce(function (acc, p) { acc[p.id] = p; return acc; }, {});
  var DEFAULT_PROVIDER_ID = (PROVIDERS.filter(function (p) { return p.isDefault; })[0] || PROVIDERS[0]).id;

  /* ------------------------------------------------------------------ *
   * Per-provider user configuration (key, model, baseUrl, tuning).
   * ------------------------------------------------------------------ */
  var CONFIG_KEY = 'providerConfig';
  var ACTIVE_KEY = 'activeProvider';

  function loadAllConfigs() {
    return store.get(CONFIG_KEY, {}) || {};
  }

  function getConfig(id) {
    var descriptor = PROVIDER_BY_ID[id];
    if (!descriptor) throw new Error('Unknown provider: ' + id);
    var saved = loadAllConfigs()[id] || {};
    return {
      id: id,
      apiKey: saved.apiKey || '',
      model: saved.model || descriptor.defaultModel,
      baseUrl: saved.baseUrl || descriptor.baseUrl,
      wireFormat: saved.wireFormat || descriptor.wireFormat,
      extraHeaders: saved.extraHeaders || descriptor.extraHeaders || {},
      temperature: typeof saved.temperature === 'number' ? saved.temperature : 0.2,
      // 4096 by default: a four-platform answer (titles + up to 50 keywords each) can
      // exceed 2048 tokens and would otherwise be cut off mid-JSON.
      maxTokens: typeof saved.maxTokens === 'number' ? saved.maxTokens : 4096,
      jsonMode: saved.jsonMode !== false
    };
  }

  function saveConfig(id, patch) {
    var all = loadAllConfigs();
    all[id] = Object.assign({}, all[id], patch);
    store.set(CONFIG_KEY, all);
    return getConfig(id);
  }

  function getActiveProviderId() {
    var id = store.get(ACTIVE_KEY, DEFAULT_PROVIDER_ID);
    return PROVIDER_BY_ID[id] ? id : DEFAULT_PROVIDER_ID;
  }

  function setActiveProviderId(id) {
    if (!PROVIDER_BY_ID[id]) return;
    store.set(ACTIVE_KEY, id);
  }

  function visibleProviders() {
    return PROVIDERS.filter(function (p) { return !p.devOnly || MSMG.devMode; });
  }

  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '••••';
    return key.slice(0, 4) + '••••' + key.slice(-4);
  }

  /* ------------------------------------------------------------------ *
   * Request builders (one per wire format)
   * ------------------------------------------------------------------ */
  function parseDataUrl(dataUrl) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(dataUrl || '');
    if (!m) throw new Error('Image must be a base64 data URL.');
    return { mimeType: m[1], base64: m[2] };
  }

  function trimBaseUrl(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  function buildRequest(descriptor, cfg, req) {
    var image = parseDataUrl(req.imageDataUrl);
    var headers = Object.assign({
      'Content-Type': 'application/json'
    }, cfg.extraHeaders || {});

    if (cfg.apiKey) {
      var headerName = descriptor.authHeader || 'Authorization';
      headers[headerName] = (descriptor.authPrefix || '') + cfg.apiKey;
    }

    var url, body;

    if (cfg.wireFormat === 'openai-chat-completions') {
      url = trimBaseUrl(cfg.baseUrl) + '/chat/completions';
      body = {
        model: cfg.model,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        messages: [
          { role: 'system', content: req.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: req.userText },
              { type: 'image_url', image_url: { url: req.imageDataUrl } }
            ]
          }
        ]
      };
      if (cfg.jsonMode) body.response_format = { type: 'json_object' };
    } else if (cfg.wireFormat === 'anthropic-messages') {
      url = trimBaseUrl(cfg.baseUrl) + '/messages';
      body = {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        system: req.systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
            { type: 'text', text: req.userText }
          ]
        }]
      };
    } else if (cfg.wireFormat === 'gemini-generate-content') {
      url = trimBaseUrl(cfg.baseUrl) + '/models/' + encodeURIComponent(cfg.model) + ':generateContent';
      body = {
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{
          role: 'user',
          parts: [
            { text: req.userText },
            { inline_data: { mime_type: image.mimeType, data: image.base64 } }
          ]
        }],
        generationConfig: {
          temperature: cfg.temperature,
          maxOutputTokens: cfg.maxTokens,
          responseMimeType: cfg.jsonMode ? 'application/json' : 'text/plain'
        }
      };
    } else {
      throw new Error('Unsupported wire format: ' + cfg.wireFormat);
    }

    return { url: url, headers: headers, body: body };
  }

  function parseResponse(wireFormat, json) {
    if (!json) throw new Error('Empty response body.');

    if (wireFormat === 'openai-chat-completions') {
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      var choice = (json.choices || [])[0] || {};
      var content = choice.message ? choice.message.content : choice.text;
      if (Array.isArray(content)) {
        content = content.map(function (part) { return part && part.text ? part.text : ''; }).join('');
      }
      return {
        text: content || '',
        usage: {
          inputTokens: (json.usage || {}).prompt_tokens || 0,
          outputTokens: (json.usage || {}).completion_tokens || 0
        },
        finishReason: choice.finish_reason || ''
      };
    }

    if (wireFormat === 'anthropic-messages') {
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      var text = (json.content || [])
        .filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return b.text; })
        .join('');
      return {
        text: text,
        usage: {
          inputTokens: (json.usage || {}).input_tokens || 0,
          outputTokens: (json.usage || {}).output_tokens || 0
        },
        finishReason: json.stop_reason || ''
      };
    }

    if (wireFormat === 'gemini-generate-content') {
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      var cand = (json.candidates || [])[0] || {};
      var parts = ((cand.content || {}).parts) || [];
      var joined = parts.map(function (p) { return p.text || ''; }).join('');
      var usage = json.usageMetadata || {};
      return {
        text: joined,
        usage: {
          inputTokens: usage.promptTokenCount || 0,
          outputTokens: usage.candidatesTokenCount || 0
        },
        finishReason: cand.finishReason || ''
      };
    }

    throw new Error('Unsupported wire format: ' + wireFormat);
  }

  function estimateCost(descriptor, usage, promptChars) {
    if (!descriptor || !descriptor.costPerMTokIn) return 0;
    var inTok = usage && usage.inputTokens ? usage.inputTokens : util.estimateTokens(promptChars);
    var outTok = usage && usage.outputTokens ? usage.outputTokens : 0;
    return (inTok / 1e6) * descriptor.costPerMTokIn + (outTok / 1e6) * descriptor.costPerMTokOut;
  }

  /* ------------------------------------------------------------------ *
   * Mock provider — deterministic canned model output for offline tests.
   * Scenario is picked from the local pre-check hint or an explicit override.
   * ------------------------------------------------------------------ */
  function buildMockResponse(scenario) {
    var single = {
      content_type: 'single_asset',
      description: 'A smooth deep blue to violet gradient background with a soft diagonal light sweep, used as a clean backdrop.',
      platforms: {
        adobe_stock: {
          title: 'Abstract blue violet gradient background with soft light sweep',
          keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper', 'smooth', 'blur', 'soft', 'light', 'digital', 'modern', 'design', 'screen', 'banner', 'presentation', 'website', 'copy space', 'colorful', 'vibrant', 'clean', 'minimal', 'texture', 'blurred', 'defocused', 'gradient background', 'purple', 'indigo', 'transition', 'elegant', 'luxury', 'technology', 'night', 'evening', 'atmosphere', 'surface', 'wall', 'beautiful background'],
          category: 'Backgrounds/Textures'
        },
        shutterstock: {
          title: 'Smooth blue and violet gradient background with soft diagonal light',
          keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper', 'smooth', 'soft', 'light', 'digital', 'modern', 'design', 'banner', 'presentation', 'website', 'copy space', 'colorful', 'vibrant', 'clean', 'minimal', 'texture', 'blurred', 'purple', 'indigo', 'technology'],
          category: 'Abstract',
          categories: ['Abstract', 'Backgrounds/Textures']
        },
        freepik: {
          title: 'Blue violet gradient background with soft light',
          keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper', 'smooth', 'soft', 'light', 'digital', 'modern', 'design', 'banner', 'presentation', 'copy space', 'colorful', 'minimal', 'texture', 'purple'],
          category: 'Backgrounds'
        },
        istock_getty: {
          title: 'Abstract blue violet gradient background with soft light sweep',
          keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper', 'smooth', 'blur', 'soft', 'light', 'digital', 'modern', 'design', 'copy space', 'colorful', 'minimal', 'texture'],
          category: 'Abstract',
          note: 'Getty controlled vocabulary: verify category and keyword mapping in the contributor portal.'
        }
      },
      category_suggestion: 'Backgrounds/Textures',
      flags: []
    };

    var pack = {
      content_type: 'template_pack',
      description: 'A set of four abstract poster templates built from flowing wave shapes, 3D spheres and glowing mesh lines on blue gradient backgrounds, each with replaceable text blocks.',
      platforms: {
        adobe_stock: {
          title: 'Poster templates set. Blue gradient waves, 3D spheres, mesh lines',
          keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner', 'collection', 'set', 'presentation', 'mockup', 'print', 'replaceable text', 'geometric', 'gradient', 'blue', 'abstract', 'wave', 'sphere', 'mesh', 'glowing', 'modern', 'design', 'graphic', 'flyer', 'brochure', 'business card', 'editable design', 'digital', 'background', 'wallpaper', 'copy space', 'corporate', 'marketing', 'advertising', 'creative', 'technology', '3d'],
          category: 'Graphic Resources'
        },
        shutterstock: {
          title: 'Abstract poster templates set with blue gradient waves, spheres and mesh lines',
          keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner', 'set', 'presentation', 'mockup', 'print', 'replaceable text', 'gradient', 'blue', 'abstract', 'wave', 'sphere', 'mesh', 'modern', 'design', 'graphic', 'brochure', 'marketing', 'background'],
          category: 'Abstract',
          categories: ['Abstract', 'Graphic Resources']
        },
        freepik: {
          title: 'Abstract poster template set, blue gradient waves and spheres',
          keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner', 'set', 'presentation', 'mockup', 'replaceable text', 'gradient', 'blue', 'abstract', 'wave', 'sphere', 'mesh', 'modern', 'design', 'graphic', 'brochure'],
          category: 'Graphic Resources'
        },
        istock_getty: {
          title: 'Abstract poster templates set with blue gradient waves and spheres',
          keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner', 'set', 'presentation', 'print', 'replaceable text', 'gradient', 'blue', 'abstract', 'wave', 'sphere', 'modern', 'design', 'graphic'],
          category: 'Graphic Resources',
          note: 'Getty controlled vocabulary: verify category and keyword mapping in the contributor portal.'
        }
      },
      category_suggestion: 'Graphic Resources',
      flags: ['possible_vector_asset', 'confirm_file_type_ai_eps', 'pack_contains_text']
    };

    return JSON.stringify(scenario === 'template_pack' ? pack : single, null, 2);
  }

  function mockCall(req) {
    var scenario = req.mockScenario ||
      (req.precheckHint === 'template_pack' ? 'template_pack' : 'single_asset');
    var text = buildMockResponse(scenario);
    return Promise.resolve({
      text: text,
      usage: {
        inputTokens: Math.max(120, util.estimateTokens(req.systemPrompt) + 800),
        outputTokens: util.estimateTokens(text)
      },
      finishReason: 'stop',
      truncated: false,
      raw: { provider: 'mock', scenario: scenario },
      latencyMs: 42
    });
  }

  /* ------------------------------------------------------------------ *
   * callVision — the single entry point used by the app.
   * ------------------------------------------------------------------ */
  function callVision(providerId, req) {
    var descriptor = PROVIDER_BY_ID[providerId];
    if (!descriptor) return Promise.reject(new Error('Unknown provider: ' + providerId));
    var cfg = getConfig(providerId);
    var started = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (cfg.wireFormat === 'mock') {
      return mockCall(req).then(function (res) {
        res.latencyMs = 42;
        return res;
      });
    }

    if (!cfg.apiKey) {
      return Promise.reject(new Error('No API key saved for ' + descriptor.label +
        '. Add one in the provider panel (stored locally in this browser).'));
    }

    var request;
    try {
      request = buildRequest(descriptor, cfg, req);
    } catch (e) {
      return Promise.reject(e);
    }

    var controller = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', function () { controller.abort(); });
    }

    var timeoutId = setTimeout(function () { controller.abort(); }, req.timeoutMs || 120000);

    return fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    }).then(function (response) {
      return response.text().then(function (raw) {
        clearTimeout(timeoutId);
        var json = null;
        try { json = JSON.parse(raw); } catch (e) { /* keep null */ }
        if (!response.ok) {
          var detail = json && json.error ? (json.error.message || JSON.stringify(json.error))
            : raw.slice(0, 400);
          throw new Error(descriptor.label + ' returned HTTP ' + response.status + ': ' + detail);
        }
        if (!json) throw new Error(descriptor.label + ' returned a non-JSON body: ' + raw.slice(0, 300));
        var parsed = parseResponse(cfg.wireFormat, json);
        var ended = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var finishReason = parsed.finishReason || '';
        // "length" (OpenAI/DeepSeek), "max_tokens" (Anthropic), "MAX_TOKENS" (Gemini)
        var truncated = /length|max_tokens|max_output_tokens|maxoutputtokens/i.test(finishReason);
        if (!parsed.text || !parsed.text.trim()) {
          throw new Error(descriptor.label + ' returned an empty answer' +
            (finishReason ? ' (finish reason: ' + finishReason + ')' : '') +
            '. If this is a reasoning model, or the answer was cut off, raise "Max tokens" in the ' +
            'provider panel and retry.');
        }
        return {
          text: parsed.text,
          usage: parsed.usage,
          finishReason: finishReason,
          truncated: truncated,
          raw: json,
          latencyMs: Math.round(ended - started),
          request: request,
          cfg: cfg
        };
      });
    }).catch(function (err) {
      clearTimeout(timeoutId);
      if (err && err.name === 'AbortError') {
        throw new Error('Request aborted (timeout or cancelled).');
      }
      throw err;
    });
  }

  /** Cheap connectivity probe: text-only tiny request. */
  function testConnection(providerId) {
    var descriptor = PROVIDER_BY_ID[providerId];
    if (!descriptor) return Promise.reject(new Error('Unknown provider'));
    var cfg = getConfig(providerId);
    if (cfg.wireFormat === 'mock') {
      return Promise.resolve({ ok: true, text: 'mock provider ready', latencyMs: 5 });
    }
    if (!cfg.apiKey) return Promise.reject(new Error('Add an API key first.'));

    var ping = {
      url: null, headers: { 'Content-Type': 'application/json' }, body: null
    };

    if (cfg.wireFormat === 'openai-chat-completions') {
      ping.url = trimBaseUrl(cfg.baseUrl) + '/chat/completions';
      ping.headers = Object.assign({ 'Content-Type': 'application/json' }, cfg.extraHeaders);
      ping.headers[descriptor.authHeader || 'Authorization'] = (descriptor.authPrefix || '') + cfg.apiKey;
      ping.body = {
        model: cfg.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
      };
    } else if (cfg.wireFormat === 'anthropic-messages') {
      ping.url = trimBaseUrl(cfg.baseUrl) + '/messages';
      ping.headers = Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        cfg.extraHeaders);
      ping.headers['x-api-key'] = cfg.apiKey;
      ping.body = {
        model: cfg.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
      };
    } else {
      ping.url = trimBaseUrl(cfg.baseUrl) + '/models/' + encodeURIComponent(cfg.model) + ':generateContent';
      ping.headers = Object.assign({ 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        cfg.extraHeaders);
      ping.body = {
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig: { maxOutputTokens: 8 }
      };
    }

    var started = Date.now();
    return fetch(ping.url, {
      method: 'POST',
      headers: ping.headers,
      body: JSON.stringify(ping.body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var json; try { json = JSON.parse(t); } catch (e) { json = null; }
        if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (json && json.error ? json.error.message : t.slice(0, 200)));
        var parsed = parseResponse(cfg.wireFormat, json);
        return { ok: true, text: parsed.text.trim().slice(0, 40), latencyMs: Date.now() - started };
      });
    });
  }

  return {
    providers: {
      WIRE_FORMATS: WIRE_FORMATS,
      list: PROVIDERS,
      byId: PROVIDER_BY_ID,
      DEFAULT_PROVIDER_ID: DEFAULT_PROVIDER_ID,
      visible: visibleProviders,
      getConfig: getConfig,
      saveConfig: saveConfig,
      getActiveProviderId: getActiveProviderId,
      setActiveProviderId: setActiveProviderId,
      maskKey: maskKey,
      callVision: callVision,
      testConnection: testConnection,
      buildRequest: buildRequest,
      parseResponse: parseResponse,
      estimateCost: estimateCost,
      buildMockResponse: buildMockResponse
    }
  };
});
