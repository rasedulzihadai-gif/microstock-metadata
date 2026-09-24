/*!
 * Test suite for the microstock metadata generator.
 *
 *   node tests/run-tests.js            offline suite (always runs)
 *   node tests/run-tests.js --live     also calls a real provider if a key is in the env
 *
 * Covers: provider registry, prompt branching (A-G vs A-F + H-K), content-type
 * detection on genuine rendered scenes, the validation/auto-fix layer, all four CSV
 * formats, and an end-to-end generate -> validate -> export pipeline for both
 * content types (including real provider calls when a key is available).
 */
'use strict';

var fs = require('fs');
var path = require('path');

var core = require('../js/core.js');
var providersMod = require('../js/providers.js');
var promptsMod = require('../js/prompts.js');
var validateMod = require('../js/validate.js');
var exportsMod = require('../js/export.js');
var detectMod = require('../js/detect.js');
var fixtures = require('./png.js');

var MSMG = Object.assign({}, core, providersMod, promptsMod, validateMod, exportsMod, detectMod);

var util = MSMG.util;
var providers = MSMG.providers;
var prompts = MSMG.prompts;
var validate = MSMG.validate;
var exportsApi = MSMG.exports;
var detect = MSMG.detect;

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */
var results = [];
var currentSection = '';

function section(name) {
  currentSection = name;
  console.log('\n\x1b[1m' + name + '\x1b[0m');
}

async function test(name, fn) {
  var started = Date.now();
  try {
    await fn();
    results.push({ section: currentSection, name: name, ok: true, ms: Date.now() - started });
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    results.push({ section: currentSection, name: name, ok: false, ms: Date.now() - started, error: err.message });
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      \x1b[31m' + err.message + '\x1b[0m');
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function ok(value, msg) {
  if (!value) throw new Error(msg || 'expected a truthy value');
}

function includes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error((msg ? msg + ': ' : '') + 'expected to find ' + JSON.stringify(needle));
  }
}

function notIncludes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) !== -1) {
    throw new Error((msg ? msg + ': ' : '') + 'did not expect ' + JSON.stringify(needle));
  }
}

function lte(value, limit, msg) {
  if (!(value <= limit)) throw new Error((msg ? msg + ': ' : '') + value + ' > ' + limit);
}

function hasIssue(result, code) {
  return result.issues.some(function (i) { return i.code === code; });
}

/* ------------------------------------------------------------------ *
 * Sample payloads (what a well-behaved model should return)
 * ------------------------------------------------------------------ */
function singleAssetPayload(overrides) {
  var base = {
    content_type: 'single_asset',
    description: 'A smooth deep blue to violet gradient background with a soft diagonal light sweep.',
    platforms: {
      adobe_stock: {
        title: 'Abstract blue violet gradient background with soft light sweep',
        keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper',
          'smooth', 'blur', 'soft', 'light', 'digital', 'modern', 'design', 'banner', 'presentation',
          'website', 'copy space', 'colorful', 'vibrant', 'clean', 'minimal', 'texture', 'purple',
          'indigo', 'transition', 'technology', 'surface', 'wall', 'defocused'],
        category: 'Backgrounds/Textures'
      },
      shutterstock: {
        title: 'Smooth blue and violet gradient background with soft diagonal light',
        keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper',
          'smooth', 'soft', 'light', 'digital', 'modern', 'design', 'banner', 'presentation',
          'website', 'copy space', 'colorful', 'vibrant', 'clean', 'minimal', 'texture', 'blurred',
          'purple', 'indigo', 'technology'],
        category: 'Abstract',
        categories: ['Abstract', 'Backgrounds/Textures']
      },
      freepik: {
        title: 'Blue violet gradient background with soft light',
        keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper',
          'smooth', 'soft', 'light', 'digital', 'modern', 'design', 'banner', 'presentation',
          'copy space', 'colorful', 'minimal', 'texture', 'purple'],
        category: 'Backgrounds'
      },
      istock_getty: {
        title: 'Abstract blue violet gradient background with soft light sweep',
        keywords: ['background', 'gradient', 'blue', 'violet', 'abstract', 'backdrop', 'wallpaper',
          'smooth', 'blur', 'soft', 'light', 'digital', 'modern', 'design', 'copy space', 'colorful',
          'minimal', 'texture'],
        category: 'Abstract'
      }
    },
    category_suggestion: 'Backgrounds/Textures',
    flags: []
  };
  return Object.assign(base, overrides || {});
}

function templatePackPayload(overrides) {
  var base = {
    content_type: 'template_pack',
    description: 'Four abstract poster templates with flowing waves, 3D spheres and glowing mesh lines on blue gradient backgrounds, each with replaceable text blocks.',
    platforms: {
      adobe_stock: {
        title: 'Poster templates set. Blue gradient waves, 3D spheres, mesh lines',
        keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner',
          'collection', 'set', 'presentation', 'mockup', 'print', 'replaceable text', 'geometric',
          'gradient', 'blue', 'abstract', 'wave', 'sphere', 'mesh', 'glowing', 'modern', 'design',
          'graphic', 'flyer', 'brochure', 'business card', 'editable design', 'digital', 'background',
          'wallpaper', 'copy space', 'corporate', 'marketing', 'advertising', 'creative', 'technology'],
        category: 'Graphic Resources'
      },
      shutterstock: {
        title: 'Abstract poster templates set with blue gradient waves, spheres and mesh lines',
        keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner',
          'set', 'presentation', 'mockup', 'print', 'replaceable text', 'gradient', 'blue', 'abstract',
          'wave', 'sphere', 'mesh', 'modern', 'design', 'graphic', 'brochure', 'marketing', 'background'],
        category: 'Abstract',
        categories: ['Abstract', 'Graphic Resources']
      },
      freepik: {
        title: 'Abstract poster template set, blue gradient waves and spheres',
        keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner',
          'set', 'presentation', 'mockup', 'replaceable text', 'gradient', 'blue', 'abstract', 'wave',
          'sphere', 'mesh', 'modern', 'design', 'graphic', 'brochure'],
        category: 'Graphic Resources'
      },
      istock_getty: {
        title: 'Abstract poster templates set with blue gradient waves and spheres',
        keywords: ['poster', 'template', 'vector', 'layout', 'cover', 'flier', 'booklet', 'banner',
          'set', 'presentation', 'print', 'replaceable text', 'gradient', 'blue', 'abstract', 'wave',
          'sphere', 'modern', 'design', 'graphic'],
        category: 'Graphic Resources'
      }
    },
    category_suggestion: 'Graphic Resources',
    flags: ['possible_vector_asset', 'confirm_file_type_ai_eps']
  };
  return Object.assign(base, overrides || {});
}

/* ------------------------------------------------------------------ *
 * Pipeline helper — mirrors js/app.js generate()
 * ------------------------------------------------------------------ */
var ELEMENT_WORDS = ['wave', 'sphere', 'mesh', 'circle', 'bar', 'line', 'ribbon', 'arc', 'ring', 'blob', 'polygon'];

function localPrecheck(scenario, W, H) {
  var scene = scenario === 'template_pack'
    ? fixtures.templatePackScene(W, H)
    : fixtures.singleBackgroundScene(W, H);
  var g = fixtures.grayFromScene(scene, W, H);
  return detect.classifySignals(detect.computeSignalsFromGray(g.gray, W, H, g.colorCount));
}

async function runPipeline(scenario, options) {
  options = options || {};
  var providerId = options.providerId || 'mock';
  var dataUrl = fixtures.toDataUrl(scenario === 'template_pack'
    ? fixtures.templatePackPng(384, 288)
    : fixtures.singleBackgroundPng(384, 288));

  var precheck = localPrecheck(scenario, 192, 144);

  var systemPrompt = prompts.buildSystemPrompt({
    contentTypeHint: options.hint || null,
    precheck: precheck
  });

  var response = await providers.callVision(providerId, {
    systemPrompt: systemPrompt,
    userText: prompts.buildUserText({ filename: 'fixture.jpg' }),
    imageDataUrl: dataUrl,
    mockScenario: scenario,
    precheckHint: scenario,
    timeoutMs: 180000
  });

  var validated = validate.validateAndFix(response.text, {
    contentTypeHint: options.hint || null,
    platforms: MSMG.PLATFORMS
  });

  var built = {};
  ['adobe_stock', 'shutterstock', 'freepik', 'istock_getty'].forEach(function (p) {
    built[p] = exportsApi.buildCsv(p, validated.data.platforms[p], { filename: 'fixture.jpg' });
  });

  return {
    precheck: precheck,
    systemPrompt: systemPrompt,
    response: response,
    validated: validated,
    exports: built
  };
}

/* ------------------------------------------------------------------ *
 * 1. Provider registry
 * ------------------------------------------------------------------ */
async function suiteProviders() {
  section('1. Provider registry');

  await test('DeepSeek is present, default-selected, OpenAI-wire compatible', function () {
    var deepseek = providers.byId.deepseek;
    ok(deepseek, 'deepseek not registered');
    eq(deepseek.wireFormat, 'openai-chat-completions');
    eq(deepseek.baseUrl, 'https://api.deepseek.com/v1');
    eq(deepseek.defaultModel, 'deepseek-flash');
    eq(deepseek.authHeader, 'Authorization');
    eq(deepseek.authPrefix, 'Bearer ');
    eq(providers.DEFAULT_PROVIDER_ID, 'deepseek', 'DeepSeek must be the default provider');
  });

  await test('every other provider slot survives (Gemini, Anthropic, OpenAI, gateways)', function () {
    ['deepseek', 'openai', 'anthropic', 'gemini', 'xkiro', 'vyce', 'helyx', 'agentrouter', 'seekai']
      .forEach(function (id) { ok(providers.byId[id], 'missing provider slot: ' + id); });
  });

  await test('legacy vision model id is still offered for DeepSeek', function () {
    ok(providers.byId.deepseek.modelOptions.indexOf('deepseek-v4-flash-vision-exp') !== -1,
      'legacy model id dropped from DeepSeek options');
    eq(providers.getConfig('deepseek').model, 'deepseek-flash', 'current name must be the default');
  });

  await test('provider configs are independent per provider', function () {
    providers.saveConfig('gemini', { apiKey: 'GEMINI_TEST_KEY', model: 'gemini-2.5-pro' });
    providers.saveConfig('deepseek', { apiKey: 'DS_TEST_KEY' });
    eq(providers.getConfig('gemini').model, 'gemini-2.5-pro');
    eq(providers.getConfig('deepseek').model, 'deepseek-flash', 'deepseek model must stay independent');
    eq(providers.getConfig('deepseek').apiKey, 'DS_TEST_KEY');
    eq(providers.getConfig('anthropic').apiKey, '', 'anthropic must be untouched');
  });

  await test('request builder produces OpenAI-shape image_url payloads for DeepSeek', function () {
    var req = providers.buildRequest(providers.byId.deepseek, providers.getConfig('deepseek'), {
      systemPrompt: 'SYS', userText: 'USER',
      imageDataUrl: fixtures.toDataUrl(fixtures.singleBackgroundPng(48, 32))
    });
    eq(req.url, 'https://api.deepseek.com/v1/chat/completions');
    eq(req.headers.Authorization, 'Bearer DS_TEST_KEY');
    eq(req.body.messages[0].role, 'system');
    eq(req.body.messages[1].content[0].type, 'text');
    eq(req.body.messages[1].content[1].type, 'image_url');
    eq(req.body.model, 'deepseek-flash');
  });

  await test('request builder produces native Gemini and Anthropic shapes too', function () {
    var geminiReq = providers.buildRequest(providers.byId.gemini,
      Object.assign({}, providers.getConfig('gemini'), { apiKey: 'GK' }), {
        systemPrompt: 'SYS', userText: 'USER',
        imageDataUrl: fixtures.toDataUrl(fixtures.singleBackgroundPng(32, 32))
      });
    includes(geminiReq.url, ':generateContent');
    eq(geminiReq.headers['x-goog-api-key'], 'GK');
    ok(geminiReq.body.systemInstruction, 'gemini needs systemInstruction');

    var anthropicReq = providers.buildRequest(providers.byId.anthropic,
      Object.assign({}, providers.getConfig('anthropic'), { apiKey: 'AK' }), {
        systemPrompt: 'SYS', userText: 'USER',
        imageDataUrl: fixtures.toDataUrl(fixtures.singleBackgroundPng(32, 32))
      });
    includes(anthropicReq.url, '/messages');
    eq(anthropicReq.headers['x-api-key'], 'AK');
    eq(anthropicReq.body.messages[0].content[0].type, 'image');
  });

  await test('response parsers handle all three wire formats', function () {
    eq(providers.parseResponse('openai-chat-completions', {
      choices: [{ message: { content: 'openai-text' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }).text, 'openai-text');
    eq(providers.parseResponse('anthropic-messages', {
      content: [{ type: 'text', text: 'anthropic-' }, { type: 'text', text: 'text' }]
    }).text, 'anthropic-text');
    eq(providers.parseResponse('gemini-generate-content', {
      candidates: [{ content: { parts: [{ text: 'gemini-text' }] } }]
    }).text, 'gemini-text');
  });

  await test('missing API key fails with a clear, actionable error', async function () {
    var threw = null;
    try {
      await providers.callVision('openai', {
        systemPrompt: 'S', userText: 'U',
        imageDataUrl: fixtures.toDataUrl(fixtures.singleBackgroundPng(32, 32))
      });
    } catch (e) { threw = e; }
    ok(threw, 'expected an error');
    includes(threw.message, 'No API key');
  });

  await test('regression: connection probe sends Content-Type: application/json', async function () {
    var calls = [];
    var realFetch = global.fetch;
    global.fetch = function (url, init) {
      calls.push({ url: url, headers: init.headers, body: init.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: function () {
          return Promise.resolve(JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 }
          }));
        }
      });
    };
    try {
      providers.saveConfig('deepseek', { apiKey: 'k' });
      await providers.testConnection('deepseek');
    } finally {
      global.fetch = realFetch;
    }
    eq(calls.length, 1, 'one probe request');
    eq(calls[0].headers['Content-Type'], 'application/json');
    eq(calls[0].headers.Authorization, 'Bearer k');
    includes(calls[0].body, '"model"');
  });

  await test('regression: vision request also carries Content-Type and auth headers', function () {
    var req = providers.buildRequest(providers.byId.deepseek, providers.getConfig('deepseek'), {
      systemPrompt: 'S', userText: 'U',
      imageDataUrl: fixtures.toDataUrl(fixtures.singleBackgroundPng(32, 32))
    });
    eq(req.headers['Content-Type'], 'application/json');
    eq(req.headers.Authorization, 'Bearer k');
  });
}

/* ------------------------------------------------------------------ *
 * 2. Prompt engine
 * ------------------------------------------------------------------ */
async function suitePrompts() {
  section('2. Prompt engine (content-type branching)');

  await test('system prompt contains the shared core and both rule branches', function () {
    var prompt = prompts.buildSystemPrompt({});
    ['A. COLOUR ACCURACY', 'B. SUBJECT AND USE-CASE KEYWORD POOL', 'C. NO FILLER WORDS',
      'D. NO CONTRADICTIONS', 'E. KEYWORD FORMAT AND LANGUAGE', 'F. KEYWORD COUNT',
      'G. TITLE — ONE VISUAL', 'H. COLLECTION-STYLE TITLE', 'I. DESIGN-PURPOSE KEYWORDS',
      'J. VECTOR-TEXT WORDING', 'K. FILE-TYPE-AWARE CATEGORY']
      .forEach(function (rule) { includes(prompt, rule); });
  });

  await test('rule J forbids "editable text" and prescribes "replaceable text"', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, 'never "editable text"');
    includes(prompt, '"replaceable text"');
    includes(prompt, 'ONLY to text-related claims');
  });

  await test('rule K pins Graphic Resources for packs and mentions the vector confirm flag', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, '"Graphic Resources"');
    includes(prompt, 'confirm_file_type_ai_eps');
  });

  await test('rule H keeps the same character ceilings as rule G', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, 'SAME numbers as rule G');
    includes(prompt, 'Adobe Stock      ≤ 70 characters');
    includes(prompt, 'Freepik          ≤ 70 characters');
    includes(prompt, 'keep the 2-3 most');
  });

  await test('rule I adds design-purpose keywords alongside B and A', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, 'ALONGSIDE rule B');
    includes(prompt, 'never\n   instead of them');
  });

  await test('self-check branches per content type', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, 'IF content_type = "single_asset" — check the output against A-G');
    includes(prompt, 'IF content_type = "template_pack" — check the output against A-F PLUS H-K');
    includes(prompt, 'H. each title names 2-4 elements');
    includes(prompt, 'J. text is called "replaceable text"');
    includes(prompt, 'state the classification to yourself');
  });

  await test('output contract declares content_type plus the four platform blocks', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, '"content_type": "single_asset" | "template_pack"');
    ['adobe_stock', 'shutterstock', 'freepik', 'istock_getty'].forEach(function (p) {
      includes(prompt, '"' + p + '"');
    });
  });

  await test('hint toggle is injected as a strong prior with a conflict flag', function () {
    var prompt = prompts.buildSystemPrompt({ contentTypeHint: 'template_pack' });
    includes(prompt, 'tagged this upload as: "template_pack"');
    includes(prompt, 'flag "content_type_hint_conflict"');
  });

  await test('auto-detect path says so explicitly', function () {
    var prompt = prompts.buildSystemPrompt({});
    includes(prompt, 'classify from the image alone (auto-detection)');
  });

  await test('local pre-check is passed as an advisory signal only', function () {
    var prompt = prompts.buildSystemPrompt({
      precheck: { contentType: 'template_pack', confidence: 0.82, evidence: ['4 content regions', '3 text bands'] }
    });
    includes(prompt, 'advisory only, may be wrong');
    includes(prompt, 'template_pack" with confidence 82%');
    includes(prompt, 'weak prior');
  });

  await test('no hint and no precheck still produce a complete prompt', function () {
    var prompt = prompts.buildSystemPrompt({});
    ok(prompt.length > 4000, 'prompt looks truncated: ' + prompt.length);
    includes(prompt, 'STEP 0 — CONTENT-TYPE CLASSIFICATION');
  });
}

/* ------------------------------------------------------------------ *
 * 3. Content-type detection
 * ------------------------------------------------------------------ */
async function suiteDetection() {
  section('3. Content-type detection (genuine rendered scenes)');

  await test('single background scene -> single_asset', function () {
    var W = 192, H = 144;
    var g = fixtures.grayFromScene(fixtures.singleBackgroundScene(W, H), W, H);
    var verdict = detect.classifySignals(detect.computeSignalsFromGray(g.gray, W, H, g.colorCount));
    console.log('      edgeDensity=' + verdict.signals.edgeDensity.toFixed(4) +
      ' panels=' + verdict.signals.panelCount +
      ' textBands=' + verdict.signals.textBandCount +
      ' regularity=' + verdict.signals.regularity.toFixed(2) +
      ' colours=' + verdict.signals.colorCount +
      ' -> \x1b[36m' + verdict.contentType + '\x1b[0m (' + verdict.confidence + ')');
    eq(verdict.contentType, 'single_asset');
    ok(verdict.confidence >= 0.8, 'expected high confidence, got ' + verdict.confidence);
  });

  await test('multi-element poster pack scene -> template_pack', function () {
    var W = 192, H = 144;
    var g = fixtures.grayFromScene(fixtures.templatePackScene(W, H), W, H);
    var verdict = detect.classifySignals(detect.computeSignalsFromGray(g.gray, W, H, g.colorCount));
    console.log('      edgeDensity=' + verdict.signals.edgeDensity.toFixed(4) +
      ' panels=' + verdict.signals.panelCount +
      ' textBands=' + verdict.signals.textBandCount +
      ' regularity=' + verdict.signals.regularity.toFixed(2) +
      ' colours=' + verdict.signals.colorCount +
      ' -> \x1b[36m' + verdict.contentType + '\x1b[0m (' + verdict.confidence + ')');
    eq(verdict.contentType, 'template_pack');
    ok(verdict.signals.panelCount >= 2, 'expected multiple panels, got ' + verdict.signals.panelCount);
    ok(verdict.signals.textBandCount >= 2, 'expected text bands, got ' + verdict.signals.textBandCount);
    ok(verdict.confidence >= 0.7, 'expected high confidence, got ' + verdict.confidence);
  });

  await test('detection is layout-driven, not colour-driven (same palette both scenes)', function () {
    var W = 128, H = 96;
    var flat = fixtures.grayFromScene(fixtures.singleBackgroundScene(W, H), W, H);
    var pack = fixtures.grayFromScene(fixtures.templatePackScene(W, H), W, H);
    var flatVerdict = detect.classifySignals(detect.computeSignalsFromGray(flat.gray, W, H, flat.colorCount));
    var packVerdict = detect.classifySignals(detect.computeSignalsFromGray(pack.gray, W, H, pack.colorCount));
    ok(flatVerdict.score < packVerdict.score,
      'layout score must separate the scenes: ' + flatVerdict.score + ' vs ' + packVerdict.score);
  });

  await test('classifySignals handles synthetic extremes', function () {
    var packLike = detect.classifySignals({
      width: 192, height: 144, aspectRatio: 1.33, edgeDensity: 0.18, colorCount: 800,
      panelCount: 4, gutterRatio: 0.2, textBandCount: 6, regularity: 0.6, peakRatio: 3, panelColorSpread: 0.4
    });
    eq(packLike.contentType, 'template_pack');
    var flatLike = detect.classifySignals({
      width: 192, height: 144, aspectRatio: 1.33, edgeDensity: 0.002, colorCount: 40,
      panelCount: 1, gutterRatio: 0, textBandCount: 0, regularity: 0.05, peakRatio: 1, panelColorSpread: 0
    });
    eq(flatLike.contentType, 'single_asset');
  });
}

/* ------------------------------------------------------------------ *
 * 4. Validation + auto-fix layer
 * ------------------------------------------------------------------ */
async function suiteValidation() {
  section('4. Validation and auto-fix layer');

  await test('fenced JSON surrounded by prose is recovered', function () {
    var raw = 'Sure! Here is the metadata:\n```json\n' + JSON.stringify(singleAssetPayload()) + '\n```\nHope that helps.';
    var res = validate.validateAndFix(raw, { contentTypeHint: 'single_asset' });
    ok(res.data, 'no data extracted');
    eq(res.data.content_type, 'single_asset');
    ok(hasIssue(res, 'json_extracted_from_prose'));
  });

  await test('unparseable output fails loudly', function () {
    var res = validate.validateAndFix('the model refused to answer', {});
    eq(res.ok, false);
    eq(res.data, null);
    ok(hasIssue(res, 'json_parse_failed'));
  });

  await test('missing content_type is an error and falls back to the hint', function () {
    var payload = singleAssetPayload();
    delete payload.content_type;
    var res = validate.validateAndFix(JSON.stringify(payload), { contentTypeHint: 'single_asset' });
    eq(res.data.content_type, 'single_asset');
    ok(hasIssue(res, 'content_type_missing'));
    eq(res.stats.errors, 1);
  });

  await test('content-type variants are normalised', function () {
    var res = validate.validateAndFix(JSON.stringify(singleAssetPayload({ content_type: 'Graphic Resources' })), {});
    eq(res.data.content_type, 'template_pack', '"Graphic Resources" should read as a template_pack');
    ok(hasIssue(res, 'content_type_normalized'));
  });

  await test('hint conflict is reported without overriding the model', function () {
    var res = validate.validateAndFix(JSON.stringify(templatePackPayload()), { contentTypeHint: 'single_asset' });
    eq(res.data.content_type, 'template_pack');
    ok(hasIssue(res, 'content_type_hint_conflict'));
  });

  await test('keywords are normalised: lowercase, deduped, word-order dupes dropped', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = ['Background', 'BACKGROUND', 'blue gradient', 'gradient blue'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    var kws = res.data.platforms.adobe_stock.keywords;
    eq(JSON.stringify(kws), JSON.stringify(['background', 'blue gradient']));
    ok(hasIssue(res, 'duplicate_keywords_removed'));
  });

  await test('rule C filler keywords are stripped', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = ['background', 'beautiful', 'high quality', 'blue gradient', 'professional'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    eq(JSON.stringify(res.data.platforms.adobe_stock.keywords), JSON.stringify(['background', 'blue gradient']));
    ok(hasIssue(res, 'filler_keywords_removed'));
  });

  await test('Adobe title over 70 chars is trimmed on a word boundary', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.title =
      'Abstract blue violet gradient background with soft diagonal light sweep and glowing particles';
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    var title = res.data.platforms.adobe_stock.title;
    lte(title.length, 70, 'Adobe title');
    ok(hasIssue(res, 'title_over_limit'));
    eq(title, title.trim());
    notIncludes(title, '  ');
  });

  await test('Adobe keyword cap (49) is enforced by dropping the weakest tail', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = [];
    for (var i = 0; i < 60; i++) payload.platforms.adobe_stock.keywords.push('term' + i);
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    eq(res.data.platforms.adobe_stock.keywords.length, 49);
    eq(res.data.platforms.adobe_stock.keywords[0], 'term0', 'strongest keywords must survive');
    ok(hasIssue(res, 'keywords_truncated'));
  });

  await test('"editable text" becomes "replaceable text" for packs (rule J)', function () {
    var payload = templatePackPayload();
    payload.platforms.adobe_stock.title = 'Poster templates set with editable text and gradient waves';
    payload.platforms.adobe_stock.keywords = ['editable text', 'editable design', 'poster'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    var adobe = res.data.platforms.adobe_stock;
    includes(adobe.title, 'replaceable text');
    ok(adobe.keywords.indexOf('replaceable text') !== -1, 'keyword should be swapped');
    ok(adobe.keywords.indexOf('editable design') !== -1,
      'rule J must only swap text-related claims, not shapes/design wording');
    ok(hasIssue(res, 'editable_text_swapped'));
  });

  await test('single-asset "editable text" is warned about, not silently swapped', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = ['background', 'editable text', 'blue'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'editable_text_in_text_context'));
  });

  await test('rule K: pack category is forced to Graphic Resources', function () {
    var res = validate.validateAndFix(
      JSON.stringify(templatePackPayload({ category_suggestion: 'Backgrounds/Textures' })), {});
    eq(res.data.category_suggestion, 'Graphic Resources');
    ok(hasIssue(res, 'category_autofixed'));
  });

  await test('rule K: single-asset category is forced away from Graphic Resources', function () {
    var res = validate.validateAndFix(
      JSON.stringify(singleAssetPayload({ category_suggestion: 'Graphic Resources' })), {});
    eq(res.data.category_suggestion, 'Backgrounds/Textures');
    ok(hasIssue(res, 'category_autofixed'));
  });

  await test('rule K: vector packs get the file-type confirmation flags', function () {
    var res = validate.validateAndFix(JSON.stringify(templatePackPayload({ flags: [] })), {});
    ok(res.data.flags.indexOf('confirm_file_type_ai_eps') !== -1, 'missing confirm_file_type_ai_eps');
    ok(res.data.flags.indexOf('possible_vector_asset') !== -1, 'missing possible_vector_asset');
    ok(res.data.flags.indexOf('pack_contains_text') !== -1, 'missing pack_contains_text');
  });

  await test('rule H linter: pack title without a pack cue word is flagged', function () {
    var payload = templatePackPayload();
    payload.platforms.adobe_stock.title = 'Blue gradient waves with spheres and mesh lines';
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'template_title_missing_pack_cue'));
  });

  await test('rule I linter: missing design-purpose keywords are flagged', function () {
    var payload = templatePackPayload();
    payload.platforms.adobe_stock.keywords = ['blue', 'gradient', 'abstract', 'waves', 'spheres'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'design_purpose_keywords_thin'));
  });

  await test('rule G linter: "set/collection" language in a single-asset title is flagged', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.title = 'Blue gradient backgrounds collection with soft light';
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'pack_language_in_single_asset'));
  });

  await test('rule A/B linter: colour-free keyword list is flagged', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = ['background', 'texture', 'abstract', 'surface', 'wall'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'no_colour_keywords'));
  });

  await test('rule D linter: contradictory keywords are flagged', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = ['photo', 'vector', 'background', 'blue'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'contradictory_keywords'));
  });

  await test('Getty controlled-vocabulary caveat is guaranteed in the note field', function () {
    var res = validate.validateAndFix(JSON.stringify(singleAssetPayload()), {});
    includes(res.data.platforms.istock_getty.note, 'controlled vocabulary');
    ok(hasIssue(res, 'getty_caveat_added'));
  });

  await test('Shutterstock categories are capped at two, primary first', function () {
    var payload = singleAssetPayload();
    payload.platforms.shutterstock.categories = ['A', 'B', 'C'];
    payload.platforms.shutterstock.category = 'D';
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    eq(JSON.stringify(res.data.platforms.shutterstock.categories), JSON.stringify(['D', 'A']));
    ok(hasIssue(res, 'categories_truncated'));
  });

  await test('missing platform block becomes a loud error, not a silent pass', function () {
    var payload = singleAssetPayload();
    delete payload.platforms.freepik;
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    eq(res.ok, false);
    ok(hasIssue(res, 'platform_block_missing'));
  });

  await test('below-target keyword counts warn but never pad', function () {
    var payload = singleAssetPayload();
    payload.platforms.adobe_stock.keywords = ['background', 'blue', 'gradient'];
    var res = validate.validateAndFix(JSON.stringify(payload), {});
    ok(hasIssue(res, 'keyword_count_below_target'));
    eq(res.data.platforms.adobe_stock.keywords.length, 3, 'validator must never invent keywords');
  });
}

/* ------------------------------------------------------------------ *
 * 5. CSV exports
 * ------------------------------------------------------------------ */
async function suiteExports() {
  section('5. CSV export formats');

  await test('Adobe: comma + double quotes, keywords comma-joined in one field', function () {
    var built = exportsApi.buildCsv('adobe_stock', {
      title: 'Abstract blue violet gradient background',
      keywords: ['background', 'blue gradient'],
      category: 'Backgrounds/Textures'
    }, { filename: 'gradient_01.jpg' });
    var lines = built.csv.trim().split('\r\n');
    eq(lines[0], '"Filename","Title","Keywords","Category","Releases"');
    eq(lines[1], '"gradient_01","Abstract blue violet gradient background","background,blue gradient","Backgrounds/Textures",""');
  });

  await test('Adobe: filenames over 30 characters are capped with a warning', function () {
    var built = exportsApi.buildCsv('adobe_stock', {
      title: 'T', keywords: ['blue'], category: 'Backgrounds/Textures'
    }, { filename: 'very_long_descriptive_filename_abcdefghijklmno.png' });
    var stem = built.csv.trim().split('\r\n')[1].split('","')[0].replace('"', '');
    lte(stem.length, 30, 'Adobe filename stem');
    ok(built.warnings.some(function (w) { return w.indexOf('30') !== -1; }),
      'expected a 30-character filename warning, got ' + JSON.stringify(built.warnings));
  });

  await test('Shutterstock: Filename/Description/Keywords/Categories header, two categories', function () {
    var built = exportsApi.buildCsv('shutterstock', {
      title: 'Smooth blue violet gradient background', keywords: ['background', 'gradient'],
      category: 'Abstract', categories: ['Abstract', 'Backgrounds/Textures']
    }, { filename: 'gradient_01.jpg' });
    var lines = built.csv.trim().split('\r\n');
    eq(lines[0], '"Filename","Description","Keywords","Categories"');
    includes(lines[1], '"Abstract,Backgrounds/Textures"');
  });

  await test('Freepik: semicolon delimiter with single-quote quoting', function () {
    var built = exportsApi.buildCsv('freepik', {
      title: 'Poster templates set with replaceable text',
      keywords: ['poster', 'template'], category: 'Graphic Resources'
    }, { filename: 'pack_01.jpg' });
    eq(built.csv.trim().split('\r\n')[0], "'Filename';'Title';'Keywords';'Category'");
    eq(exportsApi.SPECS.freepik.delimiter, ';');
    eq(exportsApi.SPECS.freepik.quote, "'");
  });

  await test('Freepik: internal apostrophes are doubled', function () {
    eq(exportsApi.escapeField("designer's poster", "'"), "'designer''s poster'");
  });

  await test('double quotes inside values are doubled for Adobe/Shutterstock', function () {
    eq(exportsApi.escapeField('a "quoted" word', '"'), '"a ""quoted"" word"');
  });

  await test('newlines are flattened so a record stays on one line', function () {
    var built = exportsApi.buildCsv('adobe_stock', {
      title: 'Line one\nline two', keywords: ['blue\nviolet'], category: 'Abstract'
    }, { filename: 'x.jpg' });
    eq(built.csv.trim().split('\r\n').length, 2, 'a record must occupy exactly one line');
  });

  await test('iStock/Getty export carries the controlled-vocabulary caveat', function () {
    var built = exportsApi.buildCsv('istock_getty', {
      title: 'Blue gradient background', keywords: ['background'], category: 'Abstract'
    }, { filename: 'x.jpg' });
    ok(built.controlledVocabulary, 'controlledVocabulary flag missing');
    ok(built.caveats.some(function (c) { return /CONTROLLED VOCABULARY/.test(c); }),
      'caveat text missing: ' + JSON.stringify(built.caveats));
    eq(built.csv.trim().split('\r\n')[0], '"Filename","Description","Keywords","Categories"');
  });

  await test('per-platform keyword caps are re-enforced at export time', function () {
    var many = [];
    for (var i = 0; i < 80; i++) many.push('k' + i);
    var built = exportsApi.buildCsv('adobe_stock', { title: 'T', keywords: many, category: 'Abstract' },
      { filename: 'x.jpg' });
    var cells = built.csv.trim().split('\r\n')[1].slice(1, -1).split('","');
    eq(cells[2].split(',').length, 49);
    ok(built.warnings.some(function (w) { return /49/.test(w); }));
  });

  await test('combined export contains all four platform blocks', function () {
    var combined = exportsApi.buildCombined({
      title: 'Blue gradient background', keywords: ['background', 'blue gradient'], category: 'Abstract'
    }, { filename: 'x.jpg' });
    ['# Adobe Stock', '# Shutterstock', '# Freepik', '# iStock / Getty Images']
      .forEach(function (marker) { includes(combined, marker); });
  });
}

/* ------------------------------------------------------------------ *
 * 6. End-to-end pipeline
 * ------------------------------------------------------------------ */
async function suitePipeline() {
  section('6. End-to-end pipeline (canonical outputs)');

  await test('AUTO-DETECT on a genuine single background -> single_asset + rules A-G', async function () {
    var run = await runPipeline('single_asset', {});
    eq(run.precheck.contentType, 'single_asset', 'local pre-check');
    eq(run.validated.data.content_type, 'single_asset');

    var adobe = run.validated.data.platforms.adobe_stock;
    lte(adobe.title.length, 70, 'Adobe title ceiling');
    lte(adobe.keywords.length, 49, 'Adobe keyword cap');
    ok(adobe.keywords.length >= 30, 'expected a full keyword set, got ' + adobe.keywords.length);
    eq(run.validated.data.category_suggestion, 'Backgrounds/Textures');

    var titleLow = adobe.title.toLowerCase();
    ['set', 'collection', 'pack'].forEach(function (word) {
      notIncludes(titleLow, word, 'single-asset title must not use collection language');
    });
    eq(run.validated.data.flags.indexOf('confirm_file_type_ai_eps'), -1,
      'single assets must not be flagged as vector packs');
    includes(run.systemPrompt, 'No content-type hint was supplied');
    eq(adobe.keywords.indexOf('beautiful background'), -1, 'filler must be stripped end-to-end');

    console.log('      title:    ' + adobe.title + '  (' + adobe.title.length + ' chars)');
    console.log('      keywords: ' + adobe.keywords.length + ' -> ' + adobe.keywords.slice(0, 8).join(', ') + '…');
    console.log('      category: ' + run.validated.data.category_suggestion);
  });

  await test('AUTO-DETECT on a genuine multi-element pack -> template_pack + rules H-K', async function () {
    var run = await runPipeline('template_pack', {});
    eq(run.precheck.contentType, 'template_pack', 'local pre-check');
    eq(run.validated.data.content_type, 'template_pack');

    var adobe = run.validated.data.platforms.adobe_stock;
    lte(adobe.title.length, 70, "Adobe title ceiling (rule H keeps G's numbers)");
    eq(run.validated.data.category_suggestion, 'Graphic Resources', 'rule K');

    var titleLow = adobe.title.toLowerCase();
    var elementHits = ELEMENT_WORDS.filter(function (w) { return titleLow.indexOf(w) !== -1; });
    ok(elementHits.length >= 2 && elementHits.length <= 4,
      'rule H wants 2-4 contained elements in the title, found ' + elementHits.length +
      ': ' + JSON.stringify(elementHits) + ' in "' + adobe.title + '"');

    var packCue = ['set', 'collection', 'pack', 'template'].some(function (w) { return titleLow.indexOf(w) !== -1; });
    ok(packCue, 'rule H requires the pack kind in the title');

    var kwLow = adobe.keywords.join(' ').toLowerCase();
    ['template', 'poster', 'layout', 'cover'].forEach(function (w) { includes(kwLow, w, 'rule I keyword'); });
    includes(kwLow, 'blue', 'template packs still need colour keywords');
    notIncludes(kwLow, 'editable text', 'rule J');
    includes(kwLow, 'replaceable text', 'rule J');

    ok(run.validated.data.flags.indexOf('confirm_file_type_ai_eps') !== -1,
      'rule K requires the vector file-type confirmation flag on the pack');
    ok(run.validated.data.flags.indexOf('pack_contains_text') !== -1,
      'pack text must be flagged so the UI can ask about file type/text');

    ['adobe_stock', 'shutterstock', 'freepik', 'istock_getty'].forEach(function (p) {
      ok(run.exports[p].csv.length > 0, p + ' csv must be built');
    });

    console.log('      title:    ' + adobe.title + '  (' + adobe.title.length + ' chars)');
    console.log('      elements found in title: ' + elementHits.join(', '));
    console.log('      keywords: ' + adobe.keywords.length + ' (design-purpose: ' +
      adobe.keywords.filter(function (k) {
        return MSMG.DESIGN_PURPOSE_POOL.indexOf(k) !== -1;
      }).join(', ') + ')');
    console.log('      category: ' + run.validated.data.category_suggestion + '  flags: ' + run.validated.data.flags.join(', '));
  });

  await test('toggle hint "Template / design pack" is honoured end-to-end', async function () {
    var run = await runPipeline('template_pack', { hint: 'template_pack' });
    includes(run.systemPrompt, 'tagged this upload as: "template_pack"');
    eq(run.validated.data.content_type, 'template_pack');
    eq(run.validated.data.category_suggestion, 'Graphic Resources');
  });

  await test('toggle hint "Single background" is honoured end-to-end', async function () {
    var run = await runPipeline('single_asset', { hint: 'single_asset' });
    includes(run.systemPrompt, 'tagged this upload as: "single_asset"');
    eq(run.validated.data.content_type, 'single_asset');
  });

  await test('exported pack CSV round-trips through a naive parser with counts intact', async function () {
    var run = await runPipeline('template_pack', {});
    var line = run.exports.adobe_stock.csv.trim().split('\r\n')[1];
    ok(line.charAt(0) === '"' && line.charAt(line.length - 1) === '"', 'row must be fully quoted');
    var cells = line.slice(1, -1).split('","');
    eq(cells.length, 5, 'five Adobe columns');
    eq(cells[2].split(',').length, run.validated.data.platforms.adobe_stock.keywords.length);
    lte(cells[2].split(',').length, 49);
  });

  await test('both content types produce all four CSVs with correct delimiters', async function () {
    var single = await runPipeline('single_asset', {});
    var pack = await runPipeline('template_pack', {});
    [single, pack].forEach(function (run) {
      includes(run.exports.freepik.csv, ';');
      notIncludes(run.exports.freepik.csv.split('\r\n')[0], ',');
      includes(run.exports.adobe_stock.csv, '"');
      includes(run.exports.istock_getty.csv, '"Filename","Description","Keywords","Categories"');
    });
  });
}

/* ------------------------------------------------------------------ *
 * 7. Live provider tests (optional)
 * ------------------------------------------------------------------ */
var LIVE_PROVIDER = null;
var LIVE_KEY = null;
(function pickLive() {
  if (process.env.DEEPSEEK_API_KEY) { LIVE_PROVIDER = 'deepseek'; LIVE_KEY = process.env.DEEPSEEK_API_KEY; }
  else if (process.env.OPENAI_API_KEY) { LIVE_PROVIDER = 'openai'; LIVE_KEY = process.env.OPENAI_API_KEY; }
  else if (process.env.ANTHROPIC_API_KEY) { LIVE_PROVIDER = 'anthropic'; LIVE_KEY = process.env.ANTHROPIC_API_KEY; }
  else if (process.env.GEMINI_API_KEY) { LIVE_PROVIDER = 'gemini'; LIVE_KEY = process.env.GEMINI_API_KEY; }
  else if (process.env.GOOGLE_API_KEY) { LIVE_PROVIDER = 'gemini'; LIVE_KEY = process.env.GOOGLE_API_KEY; }
})();

async function suiteLive() {
  section('7. Live provider tests (' + (LIVE_PROVIDER ? LIVE_PROVIDER : 'skipped') + ')');

  if (!LIVE_PROVIDER) {
    console.log('  \x1b[33m•\x1b[0m skipped — no provider API key in the environment');
    console.log('      set DEEPSEEK_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)');
    console.log('      and rerun `node tests/run-tests.js --live` to test real model output.');
    return;
  }

  providers.saveConfig(LIVE_PROVIDER, { apiKey: LIVE_KEY });

  await test('LIVE: connection probe', async function () {
    var res = await providers.testConnection(LIVE_PROVIDER);
    ok(res.ok, 'connection failed');
    console.log('      replied ' + JSON.stringify(res.text) + ' in ' + res.latencyMs + 'ms');
  });

  await test('LIVE: genuine single background -> single_asset, rules A-G metadata', async function () {
    var run = await runPipeline('single_asset', { providerId: LIVE_PROVIDER });
    eq(run.validated.data.content_type, 'single_asset', 'model classification');
    var adobe = run.validated.data.platforms.adobe_stock;
    lte(adobe.title.length, 70);
    ok(adobe.keywords.length >= 25, 'expected a substantial keyword set, got ' + adobe.keywords.length);
    eq(run.validated.data.flags.indexOf('confirm_file_type_ai_eps'), -1);
    console.log('      title: ' + adobe.title);
    console.log('      keywords: ' + adobe.keywords.length + ' | category: ' + run.validated.data.category_suggestion);
    console.log('      latency: ' + run.response.latencyMs + 'ms');
  });

  await test('LIVE: genuine multi-element pack -> template_pack, rules H-K metadata', async function () {
    var run = await runPipeline('template_pack', { providerId: LIVE_PROVIDER });
    eq(run.validated.data.content_type, 'template_pack', 'model classification');
    var adobe = run.validated.data.platforms.adobe_stock;
    lte(adobe.title.length, 70);
    eq(run.validated.data.category_suggestion, 'Graphic Resources', 'rule K');
    notIncludes(adobe.keywords.join(' ').toLowerCase(), 'editable text', 'rule J');

    var titleLow = adobe.title.toLowerCase();
    var elementHits = ELEMENT_WORDS.filter(function (w) { return titleLow.indexOf(w) !== -1; });
    ok(elementHits.length >= 1, 'rule H title should name contained elements, got: ' + adobe.title);
    console.log('      title: ' + adobe.title);
    console.log('      elements: ' + (elementHits.join(', ') || '(none matched the fixture vocabulary)'));
    console.log('      flags: ' + run.validated.data.flags.join(', '));
    console.log('      latency: ' + run.response.latencyMs + 'ms');
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('\x1b[1mMicrostock Metadata Generator — test suite\x1b[0m');
  console.log('version ' + MSMG.VERSION + ' | node ' + process.version);
  console.log('detection tests run real pixel analysis on rendered scenes');

  await suiteProviders();
  await suitePrompts();
  await suiteDetection();
  await suiteValidation();
  await suiteExports();
  await suitePipeline();
  await suiteLive();

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.filter(function (r) { return !r.ok; });

  fs.writeFileSync(path.join(__dirname, 'last-report.json'), JSON.stringify({
    version: MSMG.VERSION,
    node: process.version,
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: passed,
    failed: failed.length,
    liveProvider: LIVE_PROVIDER || null,
    results: results
  }, null, 2));

  console.log('\n' + (failed.length ? '\x1b[31m' : '\x1b[32m') + 'RESULT: ' + passed + '/' + results.length +
    ' passed\x1b[0m   (report: tests/last-report.json)');
  if (failed.length) {
    failed.forEach(function (f) {
      console.log('  \x1b[31m✗\x1b[0m [' + f.section + '] ' + f.name + ' — ' + f.error);
    });
    process.exitCode = 1;
  }
}

main().catch(function (err) {
  console.error('\x1b[31mTest runner crashed:\x1b[0m', err);
  process.exitCode = 1;
});
