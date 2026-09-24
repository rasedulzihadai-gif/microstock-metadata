# Microstock Metadata Generator

[![tests](https://github.com/rasedulzihadai-gif/microstock-metadata/actions/workflows/tests.yml/badge.svg)](https://github.com/rasedulzihadai-gif/microstock-metadata/actions/workflows/tests.yml)
[![deploy](https://github.com/rasedulzihadai-gif/microstock-metadata/actions/workflows/deploy.yml/badge.svg)](https://github.com/rasedulzihadai-gif/microstock-metadata/actions/workflows/deploy.yml)

**Live app:** <https://rasedulzihadai-gif.github.io/microstock-metadata/> ·
**Self-test page:** <https://rasedulzihadai-gif.github.io/microstock-metadata/tests/browser-test.html>

Type-aware metadata (titles, keywords, categories, bulk-upload CSVs) for four stock marketplaces —
**Adobe Stock, Shutterstock, Freepik and iStock/Getty** — with a first-class distinction between the two
product types that buyers search for completely differently.

No build step, no dependencies: open `index.html` in a browser and it runs.

---

## 1. Why content type matters

A single background/texture asset and a vector "graphic resources" template pack are **different products**
on every marketplace, and they follow different metadata conventions. Real top-ranking Adobe Stock listings
show this clearly:

| | Single background | Template / design pack |
|---|---|---|
| Title | describes **one** visual — subject + colours + style | describes **what the set contains** — 2–4 distinct elements + style direction + template kind |
| Keywords | subject, colours, style, use cases | the same, **plus** a design-purpose layer (poster, template, layout, cover, flier, booklet, banner, collection, set, presentation, mockup, print…) |
| Category | Backgrounds/Textures / Abstract | **Graphic Resources** |
| Text wording | — | "**replaceable** text", never "editable text" |
| File-type flags | — | vector/AI-EPS uncertainty must be surfaced to the contributor |

Using the wrong convention produces *technically valid but weaker* metadata. This app classifies the upload
first, then applies the matching rule branch.

---

## 2. Content-type detection (STEP 0 of the prompt)

1. **Optional contributor hint** — the segmented toggle (`Auto-detect` / `Single background` /
   `Template / design pack`). Default is auto-detect.
2. **Local layout pre-check** (`js/detect.js`) — a real pixel analysis of the preview: Sobel edge density,
   uniform-gutter panel segmentation, text-band detection (short high-contrast runs), grid regularity via
   autocorrelation, and per-region colour spread. It works on *layout*, not colour — the two test fixtures
   share the same gradient palette and are still separated correctly.
3. The model performs the final classification, with the hint and the pre-check supplied as (respectively) a
   strong prior and a labelled *weak prior*. Disagreement between the toggle and the model raises the
   `content_type_hint_conflict` flag instead of silently overriding either side.

---

## 3. Rule sets

**Shared core (A–F) — both content types**

| Rule | Subject |
|---|---|
| A | Colour accuracy — only colours genuinely present, buyer-friendly colour words |
| B | Subject / style / use-case keyword pool, in priority order |
| C | No filler words (beautiful, amazing, 4K, professional, stock photo…) |
| D | No contradictions or unverifiable claims (no "3D" on flat, no "photo" for vector…) |
| E | Keyword format — lowercase, US English, no duplicates, no brands |
| F | Keyword count, priority order and per-platform limits |

**Single assets add:** **G — one-visual title** with the real character ceilings (Adobe ≤ 70, Freepik ≤ 70,
Shutterstock ≤ 100, iStock ≤ 120).

**Template packs keep A–F and add:**

| Rule | Subject |
|---|---|
| H | Collection-style title: 2–4 visually distinct elements + overall style/colour + template kind, **same character ceilings as G** (trim elements rather than exceed the limit) |
| I | Design-purpose keywords, **alongside** the colour and use-case layer (not instead of it) |
| J | Vector-text wording: "replaceable text", never "editable text" (other design properties may still be "editable") |
| K | Category = Graphic Resources, plus vector/file-type flags so the UI can ask the contributor to confirm AI/EPS |

The self-check checklist in the prompt branches the same way (A–G for one type, A–F + H–K for the other).

---

## 4. Providers

A plain registry (`js/providers.js`) — one descriptor object per provider, three wire formats
(`openai-chat-completions`, `anthropic-messages`, `gemini-generate-content`). Adding a provider means adding a
descriptor; nothing else changes.

| id | Label | Default model | Notes |
|---|---|---|---|
| **`deepseek`** | **DeepSeek** *(default, pre-selected)* | `deepseek-flash` | `https://api.deepseek.com/v1`, `Authorization: Bearer …`, native multimodal (image_url like OpenAI), ~$0.22/1M input tokens. Legacy `deepseek-v4-flash-vision-exp` id still offered. |
| `openai` | OpenAI | `gpt-4o` | chat-completions + image_url |
| `anthropic` | Anthropic | `claude-sonnet-4-5` | native messages, base64 image block |
| `gemini` | Google Gemini | `gemini-2.5-flash` | native generateContent with `inline_data`, key sent as a header |
| `xkiro` / `vyce` / `helyx` / `agentrouter` / `seekai` | gateways | — | OpenAI-compatible; **base URLs are editable placeholders** — verify against each gateway's docs |
| `mock` | Mock (offline testing) | — | deterministic responses, visible only with `?dev=1`, used by the test suite |

Every provider has its own key, model, base URL, wire format, temperature, max-tokens and extra-headers slot;
switching providers never touches another provider's configuration. A **Test connection** button probes the
endpoint with a tiny text-only request.

Keys are stored only in this browser's `localStorage` and are never sent anywhere except the configured
endpoint.

---

## 5. Validation layer

Nothing from the model is trusted (`js/validate.js`):

* defensive JSON extraction (markdown fences, prose, trailing commas) with a report of what was recovered;
* field-contract checks — `content_type` enum, `description`, all four platform blocks, types, empty values;
* rule enforcement with auto-fixes: keyword normalisation/dedupe, filler removal, character-ceiling trimming
  on word boundaries, per-platform keyword caps, "editable text" → "replaceable text" (packs), category
  correction (both directions), Shutterstock two-category cap, guaranteed Getty controlled-vocabulary caveat,
  flags for vector/file-type uncertainty;
* linters that warn rather than rewrite: missing pack cue in a pack title, thin design-purpose layer,
  collection language in a single-asset title, colour-free keyword lists, contradictory keyword pairs;
* every change is reported as *blocking*, *auto-fixed* or *review* and shown in the UI;
* the validator never invents keywords to reach a target count — it warns instead.

Editing a title or keyword list in the results panel re-runs the whole validation layer locally (no API call).

---

## 6. CSV exports

| Platform | Delimiter | Quoting | Columns | Extras |
|---|---|---|---|---|
| Adobe Stock | `,` | `"` | `Filename, Title, Keywords, Category, Releases` | keywords comma-joined inside the field; **filename capped at 30 chars with a warning** |
| Shutterstock | `,` | `"` | `Filename, Description, Keywords, Categories` | max two categories, primary first |
| Freepik | `;` | `'` | `Filename, Title, Keywords, Category` | internal apostrophes doubled |
| iStock/Getty | `,` | `"` | `Filename, Description, Keywords, Categories` | controlled-vocabulary caveat attached to the export |

All values are always quoted, quote characters are doubled, and newlines are flattened so one asset is one
record. A combined export block is also available.

---

## 7. Using it

1. Open `index.html` (add `?dev=1` to expose the offline mock provider).
2. Drop images on the upload panel (or paste from the clipboard). Each image is downscaled locally and
   pre-checked for layout structure.
3. Pick the content type: leave **Auto-detect**, or force **Single background** / **Template / design pack**.
4. Choose a provider, paste an API key, **Save provider** (and optionally **Test connection**).
5. **Generate metadata** — one vision call per asset, sequential for predictable cost. Cancel is always
   available; batches show progress, per-asset keyword counts and issue counters.
6. Review the results panel: content type + detection, category suggestion, flags, validation notes, the four
   platform tabs (editable, re-validated on edit), copy/download buttons, plus the exact prompt and raw model
   output for auditing.

The queue is virtualised, so hundreds of images stay smooth.

---

## 8. Testing

```bash
node tests/run-tests.js            # offline suite (64 assertions)
node tests/run-tests.js --live     # also calls a real provider when a key is in the env
node tests/make-fixtures.js        # regenerate tests/fixtures/*.png
```

The suite covers the provider registry and all three wire formats, prompt branching (A–G vs A–F + H–K),
content-type detection on **genuine rendered scenes**, the validation/auto-fix layer, all four CSV formats, and
an end-to-end *generate → validate → export* pipeline for both content types. A JSON report is written to
`tests/last-report.json`.

Live mode uses `DEEPSEEK_API_KEY` (or `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) and sends the
two fixture images to the real model, asserting classification, rule compliance and category for each.

**Browser self-test:** open `tests/browser-test.html`. It paints the two fixtures on canvases, runs the real
detector, then pushes them through the production pipeline (mock provider) and checks the acceptance criteria
in-page — 30 assertions. The same page has an optional live section where you can paste a key to run both
fixtures against a real provider.

Fixtures (shared by both suites, defined once in `js/scenes.js`):

* `single-background-512x384.png` — one smooth blue-violet gradient with a soft light sweep.
* `template-pack-512x384.png` — four poster-style panels on the same gradient, each with headline glyph
  blocks, body lines, an accent circle and an accent bar.

---

## 9. File map

```
index.html              app shell
styles.css              theme
script.js               bootstrap (starts the app)
js/core.js              namespace, platform contracts, limits, utilities, storage
js/providers.js         provider registry + wire-format adapters + connection probe
js/prompts.js           STEP 0 classification, rules A-G / H-K, self-check, output contract
js/validate.js          strict output validation + auto-fixes + linters
js/export.js            four CSV specs, escaping, filename rules, downloads
js/detect.js            layout-based content-type pre-check (pure + browser wrappers)
js/scenes.js            the two fixture artworks (shared by app tests)
js/ui.js                virtualised queue list, results rendering, toasts
js/app.js               pipeline, queue orchestration, panels
tests/run-tests.js      Node suite (offline + optional live)
tests/browser-test.html in-browser self-test page
tests/png.js            PNG encoder + grayscale helpers
tests/make-fixtures.js  writes tests/fixtures/*.png
.github/workflows/      tests.yml (CI) + deploy.yml (GitHub Pages)
```

---

## 10. Running on GitHub

The app is a static site, so GitHub Pages can serve it as-is, and Actions can run the test suite.

**What is included**

* `.github/workflows/tests.yml` — runs the offline suite on every push and pull request, uploads
  `tests/last-report.json` as a build artifact, and can run the *live* suite on manual dispatch when a
  `DEEPSEEK_API_KEY` repository secret exists (never on ordinary pushes, so live calls never cost money
  unexpectedly).
* `.github/workflows/deploy.yml` — stages `index.html`, `styles.css`, `script.js`, `js/` and `tests/` (so the
  "Run self-test" page works when hosted) and deploys them to GitHub Pages.
* `.gitignore` — excludes generated artefacts (`tests/last-report.json`, `_site/`) and the unrelated
  `woodmart.8.2.7.zip` archive that was sitting in the folder. Remove that line if you want the zip tracked.

**Publishing**

```bash
git init -b main
git add -A
git commit -m "Microstock metadata generator: content-type aware rules + CSV exports"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The `deploy`
workflow runs on the next push (or trigger it from *Actions → deploy → Run workflow*), after which the app is
live at `https://<you>.github.io/<repo>/`.

**Hosting caveats**

* The page calls the provider API **directly from the visitor's browser**, so the chosen provider must send
  CORS headers. Providers that do not will fail with a network error in the hosted build; the connection test
  button tells you straight away.
* API keys are stored per-visitor in `localStorage` — a public deployment never carries anyone's key, and
  nothing is proxied through GitHub. Never commit a key to the repository.
* Everything else (detection, prompts, validation, CSV building) runs locally in the browser.

---

## 11. Known limitations

* The model cannot know the real exported file format from a JPEG preview — that is why rule K raises
  `confirm_file_type_ai_eps` instead of asserting the format.
* Gateway base URLs and model ids are placeholders; confirm them with each gateway.
* Getty/iStock keywords are subject to a controlled vocabulary, so exports are a starting point to verify in
  the contributor portal, not a guaranteed mapping.
* DeepSeek is used for scene/composition understanding, not OCR — fine for this app, but don't rely on it to
  transcribe dense small text in a mockup.
