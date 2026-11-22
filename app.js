"use strict";

/* ==================================================================
   1. SETTINGS
   WHAT THIS DOES: fixed values used everywhere. No API key here, ever:
   the user types the key into the page at runtime.
   ================================================================== */
const API_BASE = "https://api.groq.com/openai/v1";
const KEY_STORAGE_NAME = "groq-playground-key";   // sessionStorage slot name

// Used only if the live model list cannot be loaded.
const FALLBACK_MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
];
const PREFERRED_DEFAULT_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

// The models endpoint also lists speech and safety-filter models. Hide them.
const NON_CHAT_MODEL_PATTERN = /whisper|tts|orpheus|playai|prompt-guard|llama-guard/i;

const DEFAULT_PROMPT = [
  "Extract the entity, primary sector, and valuation from each tech announcement.",
  "",
  "Input: Stripe secured $600M financing at a $95B valuation to scale enterprise financial infrastructure.",
  "Output: {\"entity\": \"Stripe\", \"sector\": \"FinTech\", \"valuation\": \"$95B\"}",
  "",
  "Input: Mistral AI finalized a €600M Series B round valuing the European model provider at €5.8B.",
  "Output: {\"entity\": \"Mistral AI\", \"sector\": \"Artificial Intelligence\", \"valuation\": \"€5.8B\"}",
  "",
  "Input: Databricks closed a $500M series I funding round at an estimated $43B valuation.",
  "Output:",
].join("\n");

/* ==================================================================
   2. CAPABILITY MAP
   WHAT THIS DOES: records what each model family can do, so we never
   send a parameter a model does not support (the usual cause of a 400).
     reasoning: "none"     -> no thinking mode at all
                "optional" -> can be switched on and off
                "always"   -> always thinks; we can only choose to see it
     effort:    reasoning_effort value to send (null = don't send one)
     webSearch: supports the built-in browser_search tool
   ================================================================== */
const CAPABILITY_RULES = [
  { prefix: "openai/gpt-oss",         reasoning: "always",   effort: "low", webSearch: true },
  { prefix: "qwen/qwen3",             reasoning: "optional", effort: null,  webSearch: false },
  { prefix: "minimaxai/minimax-m2",   reasoning: "always", effort: null,  webSearch: false },
  { prefix: "meta-models/muse-spark", reasoning: "always",   effort: "low", webSearch: false },
];
const NO_CAPABILITIES = { reasoning: "none", effort: null, webSearch: false };

function getCapabilities(modelId) {
  return CAPABILITY_RULES.find(rule => modelId.startsWith(rule.prefix)) || NO_CAPABILITIES;
}

/* ==================================================================
   3. APP STATE
   WHAT THIS DOES: the few variables that change while the app runs.
   ================================================================== */
let conversation = [];          // [{role, content}] — the API remembers nothing, so we keep it
let isStreaming = false;
let abortController = null;     // lets the Stop button cancel the request
let modelsLoadedForKey = null;  // which key the model list was fetched with
let modelsRequest = null;       // that fetch, so we can wait for it
let wantsReasoning = false;     // the student's own toggle choices,
let wantsWebSearch = false;     // remembered when switching models
let replyCounter = 0;
let lastSentPrompt = "";        // shown in Prompt analysis after the box is cleared

const $ = id => document.getElementById(id);

/* ==================================================================
   4. API KEY FIELD
   WHAT THIS DOES: reads the key, and optionally keeps it in
   sessionStorage (dies when the tab closes — NOT localStorage).
   ================================================================== */
function getKey() {
  return $("apiKey").value.trim();
}

function saveKeyIfRemembered() {
  try {
    if ($("rememberKey").checked && getKey()) sessionStorage.setItem(KEY_STORAGE_NAME, getKey());
    else sessionStorage.removeItem(KEY_STORAGE_NAME);
  } catch (e) { /* storage blocked by the browser — key just won't be remembered */ }
}

function restoreKey() {
  try {
    const saved = sessionStorage.getItem(KEY_STORAGE_NAME);
    if (saved) { $("apiKey").value = saved; $("rememberKey").checked = true; }
  } catch (e) { /* ignore */ }
}

$("apiKey").addEventListener("input", saveKeyIfRemembered);
$("rememberKey").addEventListener("change", saveKeyIfRemembered);
$("apiKey").addEventListener("blur", () => { if (getKey()) ensureModelsLoaded(); });
$("clearKey").addEventListener("click", () => {
  $("apiKey").value = "";
  saveKeyIfRemembered();
  modelsLoadedForKey = null;
  fillModelDropdown(FALLBACK_MODELS, true);
  $("modelsStatus").textContent = "Fallback list — paste a key to load live models";
});

/* ==================================================================
   5. SLIDERS + NUMBER BOXES
   WHAT THIS DOES: keeps each slider and its number box in sync both ways.
   ================================================================== */
function updateSliderUI() {
  const tempVal = Number($("tempRange").value);
  const tag = $("tempTag");
  if (tag) {
    tag.textContent = tempVal <= 0.3 ? "Precise" : tempVal <= 0.9 ? "Balanced" : "Creative";
  }
  document.querySelectorAll(".preset-pill").forEach(pill => {
    const pillTemp = Number(pill.dataset.temp);
    pill.classList.toggle("active", Math.abs(pillTemp - tempVal) < 0.05);
  });

  const maxPill = $("maxTokensPillVal");
  if (maxPill) {
    maxPill.textContent = $("maxRange").value;
  }
}

function linkSlider(rangeId, boxId) {
  const range = $(rangeId), box = $(boxId);
  range.addEventListener("input", () => {
    box.value = range.value;
    updateSliderUI();
  });
  box.addEventListener("input", () => {
    range.value = box.value;
    updateSliderUI();
  });   // the slider clamps bad values
  box.addEventListener("change", () => {
    box.value = range.value;
    updateSliderUI();
  });  // snap box to the clamped value
}
linkSlider("tempRange", "tempBox");
linkSlider("maxRange", "maxBox");

// Preset temperature buttons
document.querySelectorAll(".preset-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    const val = btn.dataset.temp;
    $("tempRange").value = val;
    $("tempBox").value = val;
    updateSliderUI();
  });
});

/* ==================================================================
   6. MODEL DROPDOWN
   WHAT THIS DOES: asks Groq which models exist (once per key) and fills
   the dropdown. Falls back to a fixed, clearly labelled list on failure.
   ================================================================== */
function ensureModelsLoaded() {
  const key = getKey();
  if (key && key !== modelsLoadedForKey) {
    modelsLoadedForKey = key;
    modelsRequest = loadModels(key);
  }
  return modelsRequest;
}

async function loadModels(key) {
  $("modelsStatus").textContent = "Loading models…";
  try {
    const resp = await fetch(API_BASE + "/models", { headers: { Authorization: "Bearer " + key } });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const json = await resp.json();
    const ids = json.data
      .filter(m => m.active !== false && !NON_CHAT_MODEL_PATTERN.test(m.id))
      .map(m => m.id)
      .sort();
    if (ids.length === 0) throw new Error("no chat models returned");
    fillModelDropdown(ids, false);
    $("modelsStatus").textContent = ids.length + " models loaded";
  } catch (err) {
    fillModelDropdown(FALLBACK_MODELS, true);
    $("modelsStatus").textContent = "Could not load models (" + err.message + ") — showing fallback list";
  }
}

function fillModelDropdown(ids, isFallback) {
  const select = $("model");
  const previous = select.value;
  select.innerHTML = "";
  const group = document.createElement("optgroup");
  group.label = isFallback ? "Fallback list (not loaded from the API)" : "Live models from the API";
  for (const id of ids) {
    const caps = getCapabilities(id);
    const extras = [];
    if (caps.reasoning !== "none") extras.push("reasoning");
    if (caps.webSearch) extras.push("web search");
    const option = new Option(id + (extras.length ? "  · " + extras.join(", ") : ""), id);
    group.append(option);
  }
  select.append(group);
  // Keep the old choice if it still exists, otherwise pick a non-reasoning default.
  const choice = [previous, ...PREFERRED_DEFAULT_MODELS].find(id => ids.includes(id))
    || ids.find(id => getCapabilities(id).reasoning === "none")
    || ids[0];
  select.value = choice;
  applyCapabilityGating();
}

/* ==================================================================
   7. CAPABILITY GATING
   WHAT THIS DOES: disables a toggle (with a one-line reason) when the
   selected model cannot do that thing.
   ================================================================== */
function applyCapabilityGating() {
  const caps = getCapabilities($("model").value);

  const reasoning = $("reasoning");
  if (caps.reasoning === "none") {
    reasoning.checked = false; reasoning.disabled = true;
    $("reasoningReason").textContent = "This model has no reasoning mode.";
  } else if (caps.reasoning === "always") {
    reasoning.checked = true; reasoning.disabled = true;
    $("reasoningReason").textContent = "This model always thinks — you pay for it either way.";
  } else {
    reasoning.disabled = false; reasoning.checked = wantsReasoning;
    $("reasoningReason").textContent = "";
  }

  const web = $("webSearch");
  if (!caps.webSearch) {
    web.checked = false; web.disabled = true;
    $("webSearchReason").textContent = "This model has no web search (GPT-OSS models only).";
  } else {
    web.disabled = false; web.checked = wantsWebSearch;
    $("webSearchReason").textContent = "";
  }
}
$("model").addEventListener("change", applyCapabilityGating);
$("reasoning").addEventListener("change", e => { wantsReasoning = e.target.checked; });
$("webSearch").addEventListener("change", e => { wantsWebSearch = e.target.checked; });

/* ==================================================================
   8. PROMPT ANALYSIS (rule-based, no API call)
   WHAT THIS DOES: counts worked examples and spots prompt techniques,
   then explains every rule — fired or not — in the "Why" list.
   ================================================================== */

// Walks line by line: a question label opens a pair, the next answer
// label closes it. An answer label with nothing after it is the real
// question being asked, so it is NOT counted as an example.
function findAnsweredPairs(lines, questionPattern, answerPattern) {
  const found = [];
  let unanswered = 0, open = false;
  for (const line of lines) {
    if (questionPattern.test(line)) { open = true; continue; }
    const m = line.match(answerPattern);
    if (m && open) {
      open = false;
      if (m[1].trim()) found.push(line.trim());
      else unanswered++;
    }
  }
  return { found, unanswered };
}

// Tidy the prompt before matching: drop markdown bold (**Input:**), and
// put pairs written on one line ("Input: x Output: y") onto two lines.
function normalizePrompt(text) {
  return text
    .replace(/\*\*/g, "")
    .replace(/[ \t]+((?:Output|Answer|Label|Sentiment|Category|Result|Response)\s*:)/gi, "\n$1")
    .replace(/^(\s*Q\s*:.*?)[ \t]+(A\s*:)/gm, "$1\n$2");
}

// Any repeated "Label: ... / OtherLabel: ..." pattern, e.g.
// Review:/Sentiment:, Text:/Label:, English:/French:.
// The first label must appear at least twice, so a lone "Note:" line
// is not mistaken for an example.
function findLabelledPairs(lines) {
  const labelled = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z ]{0,24}?)\s*:(.*)$/);
    if (m) labelled.push({ name: m[1], key: m[1].toLowerCase() });
  }
  const timesSeen = {};
  for (const l of labelled) timesSeen[l.key] = (timesSeen[l.key] || 0) + 1;

  // Try each "label followed by a different label" pairing; keep the best.
  let best = { found: [], unanswered: 0, names: null };
  for (let i = 0; i + 1 < labelled.length; i++) {
    const q = labelled[i], a = labelled[i + 1];
    if (q.key === a.key || timesSeen[q.key] < 2) continue;
    const result = findAnsweredPairs(lines,
      new RegExp("^\\s*" + q.key + "\\s*:", "i"),
      new RegExp("^\\s*" + a.key + "\\s*:(.*)$", "i"));
    if (result.found.length > best.found.length) best = { ...result, names: [q.name, a.name] };
  }
  return best;
}

function analyzePrompt(rawText) {
  const text = normalizePrompt(rawText);
  const lines = text.split("\n");

  const io = findAnsweredPairs(lines, /^\s*Input\s*:/i, /^\s*Output\s*:(.*)$/i);
  const qa = findAnsweredPairs(lines, /^\s*Q\s*:/i, /^\s*A\s*:(.*)$/i);
  const labelled = findLabelledPairs(lines);
  const arrows = lines.filter(l => /\S\s*(->|=>)\s*\S/.test(l)).map(l => l.trim());
  const quoted = text.match(/"[^"\n]+"\s*(->|=>)\s*"[^"\n]+"/g) || [];
  const blocks = text.split(/^\s*(?:###|---)\s*$/m).filter(b => b.trim());
  const blockExamples = blocks.length > 1 ? blocks.length - 1 : 0;

  const exampleRules = [
    { label: "Input: / Output: pairs with an answer", count: io.found.length, quotes: io.found,
      extra: io.unanswered ? io.unanswered + " empty Output: ignored — that is the question, not an example." : "" },
    { label: "Q: / A: pairs with an answer", count: qa.found.length, quotes: qa.found,
      extra: qa.unanswered ? qa.unanswered + " empty A: ignored — that is the question." : "" },
    { label: labelled.names
        ? 'Labelled pairs "' + labelled.names[0] + ':" / "' + labelled.names[1] + ':" with an answer'
        : "Other labelled pairs (e.g. Review: / Sentiment:)",
      count: labelled.found.length, quotes: labelled.found,
      extra: labelled.unanswered ? labelled.unanswered + " empty answer ignored — that is the question." : "" },
    { label: "Lines with text on both sides of -> or =>", count: arrows.length, quotes: arrows, extra: "" },
    { label: 'Quoted pairs like "x" -> "y"', count: quoted.length, quotes: quoted, extra: "" },
    { label: "Blocks separated by ### or ---", count: blockExamples,
      quotes: blockExamples ? [blocks.length + " blocks found"] : [],
      extra: blockExamples ? "Every block except the last counts as an example." : "" },
  ];

  const techniqueRules = [
    { label: "Chain-of-Thought", pattern: /think step by step|let'?s think/i },
    { label: "Role prompting",   pattern: /you are an?\b|act as|pretend you are/i },
    { label: "Negative constraint", pattern: /\b(do not|never|avoid)\b/i },
    { label: "Format constraint",   pattern: /\b(json|table|bullets?)\b/i },
  ].map(rule => {
    const m = text.match(rule.pattern);
    return { label: rule.label, fired: !!m, quotes: m ? [m[0]] : [] };
  });

  const exampleCount = Math.max(...exampleRules.map(r => r.count));
  return { exampleCount, exampleRules, techniqueRules };
}

function renderPromptAnalysis() {
  // The box is cleared after Submit, so then we analyse what was just sent.
  const boxText = $("prompt").value;
  const useLastSent = !boxText.trim() && lastSentPrompt;
  $("analysisSource").textContent = useLastSent
    ? "Prompt box is empty — showing the prompt you last sent."
    : "Analysing the prompt box (updates as you type).";
  const result = analyzePrompt(useLastSent ? lastSentPrompt : boxText);
  const n = result.exampleCount;
  $("verdict").textContent = n === 0 ? "ZERO-SHOT" : n === 1 ? "ONE-SHOT" : "FEW-SHOT (" + n + ")";

  const chips = $("chips");
  chips.innerHTML = "";
  for (const t of result.techniqueRules.filter(t => t.fired)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = t.label;
    chips.append(chip);
  }

  const list = $("whyList");
  list.innerHTML = "";
  for (const r of result.exampleRules) {
    addWhyItem(list, r.count > 0, r.label + (r.count > 0 ? ": " + r.count : ": none found"), r.quotes, r.extra);
  }
  for (const t of result.techniqueRules) {
    addWhyItem(list, t.fired, t.label + (t.fired ? "" : ": not detected"), t.quotes, "");
  }

  // Update char counter
  const charCounter = $("promptCharCount");
  if (charCounter) {
    charCounter.textContent = boxText.length + " chars";
  }
}

// One line of the Why list: tick + quoted matched text, or a grey cross.
// Built with textContent so prompt text can never become HTML.
function addWhyItem(list, fired, label, quotes, extra) {
  const li = document.createElement("li");
  if (!fired) li.className = "off";
  li.append((fired ? "✓ " : "✗ ") + label);
  if (fired && quotes.length) {
    li.append(" — ");
    quotes.slice(0, 3).forEach((text, i) => {
      if (i > 0) li.append(", ");
      const q = document.createElement("q");
      q.textContent = text.length > 50 ? text.slice(0, 50) + "…" : text;
      li.append(q);
    });
    if (quotes.length > 3) li.append(" +" + (quotes.length - 3) + " more");
  }
  if (extra) {
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = extra;
    li.append(note);
  }
  list.append(li);
}

let analysisTimer = null;
function schedulePromptAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(renderPromptAnalysis, 300);   // run 300ms after typing stops
}
$("prompt").addEventListener("input", schedulePromptAnalysis);

/* ==================================================================
   9. SMALL MARKDOWN RENDERER
   WHAT THIS DOES: turns the model's markdown into HTML. It escapes all
   HTML FIRST, so a reply can never inject its own markup.
   Supports: ``` code blocks, # headings, - bullets, 1. lists,
   **bold** and `inline code`.
   ================================================================== */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderMarkdown(source) {
  // Splitting on ``` gives: text, code, text, code ... (odd parts are code).
  // An unfinished code block while streaming simply ends at the last part.
  const parts = escapeHtml(source).split("```");
  return parts.map((part, i) => {
    if (i % 2 === 0) return renderTextBlocks(part);
    const newline = part.indexOf("\n");
    const code = newline === -1 ? part : part.slice(newline + 1);   // drop the language name
    return '<div class="code-wrap"><button class="small copy-code">Copy</button>' +
           "<pre><code>" + code.replace(/\n$/, "") + "</code></pre></div>";
  }).join("");
}

function renderTextBlocks(text) {
  let html = "", listType = null, paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) html += "<p>" + paragraph.map(renderInline).join("<br>") + "</p>";
    paragraph = [];
  };
  const closeList = () => { if (listType) html += "</" + listType + ">"; listType = null; };
  const openList = type => { if (listType !== type) { closeList(); html += "<" + type + ">"; listType = type; } };

  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^\s*(#{1,4})\s+(.*)$/))) {
      flushParagraph(); closeList();
      const tag = m[1].length <= 2 ? "h3" : "h4";
      html += "<" + tag + ">" + renderInline(m[2]) + "</" + tag + ">";
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushParagraph(); openList("ul");
      html += "<li>" + renderInline(m[1]) + "</li>";
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph(); openList("ol");
      html += "<li>" + renderInline(m[1]) + "</li>";
    } else if (line.trim() === "") {
      flushParagraph(); closeList();
    } else {
      closeList(); paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return html;
}

// Inline code first (odd parts after splitting on `...`), then **bold** elsewhere.
function renderInline(text) {
  return text.split(/(`[^`]+`)/).map((piece, i) =>
    i % 2 === 1
      ? "<code>" + piece.slice(1, -1) + "</code>"
      : piece.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  ).join("");
}

/* ==================================================================
   10. BUILD THE REQUEST BODY
   WHAT THIS DOES: turns every control into JSON. This exact object is
   what gets POSTed, what "Request sent" shows, and what View code prints.
   ================================================================== */
function getStopSequences() {
  return $("stopSeq").value.split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);
}

function buildRequestBody(pendingUserText) {
  const model = $("model").value;
  const caps = getCapabilities(model);

  const messages = [];
  for (const m of conversation) messages.push({ role: m.role, content: m.content });
  if (pendingUserText) messages.push({ role: "user", content: pendingUserText });

  const body = {
    model,
    messages,
    temperature: Number($("tempRange").value),
    max_completion_tokens: Number($("maxRange").value),
  };

  const stop = getStopSequences();
  if (stop.length) body.stop = stop;

  // Reasoning: only send what this model family accepts.
  if (caps.reasoning === "optional") {
    if ($("reasoning").checked) body.reasoning_format = "parsed";   // thinking arrives in its own field
    else body.reasoning_effort = "none";                           // switch thinking off
  } else if (caps.reasoning === "always") {
    body.include_reasoning = true;                                 // it thinks anyway — let us see it
    if (caps.effort) body.reasoning_effort = caps.effort;
  }

  if (caps.webSearch && $("webSearch").checked) body.tools = [{ type: "browser_search" }];

  body.stream = true;
  body.stream_options = { include_usage: true };   // ask for token usage at the end of the stream
  return body;
}

/* ==================================================================
   11. SEND A MESSAGE AND STREAM THE REPLY
   WHAT THIS DOES: POSTs the body, reads the reply piece by piece, and
   updates the bubble and panels as each piece arrives.
   ================================================================== */
async function send() {
  const key = getKey();
  const text = $("prompt").value;
  if (!key) { addNotice("Paste your Groq API key in the left column first."); $("apiKey").focus(); return; }
  if (!text.trim()) return;
  await ensureModelsLoaded();

  conversation.push({ role: "user", content: text });
  addUserBubble(text);
  lastSentPrompt = text;
  $("prompt").value = "";
  schedulePromptAnalysis();

  const body = buildRequestBody();
  const view = createAssistantBubble(body);
  const run = { answer: "", thinking: "", sources: [], usage: null, finishReason: null, firstAnswerAt: null };
  const startedAt = performance.now();

  setStatus(view, body.tools ? "Searching the web..." : "Waiting for the first token...");
  setStreaming(true);
  abortController = new AbortController();
  try {
    const resp = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    showRateLimit(resp.headers);
    if (!resp.ok) throw await apiErrorFrom(resp);
    await readStream(resp, chunk => handleChunk(chunk, run, view));
    finishReply(view, run, startedAt, false);
  } catch (err) {
    if (err.name === "AbortError") {
      finishReply(view, run, startedAt, true);
    } else {
      showError(view, err);
      if (view.el.isConnected) forgetUnansweredQuestion();
    }
  } finally {
    setStreaming(false);
    abortController = null;
  }
}

// Server-Sent Events: the body is text made of lines like  data: {...json...}
// A network chunk can end in the middle of a line, so we keep the
// unfinished last line in `buffer` and finish it on the next read.
async function readStream(resp, onChunk) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) processSseLine(line, onChunk);
  }
  processSseLine(buffer, onChunk);
}

function processSseLine(line, onChunk) {
  line = line.trim();
  if (!line.startsWith("data:")) return;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return;            // the end-of-stream marker
  let chunk;
  try { chunk = JSON.parse(data); } catch (e) { return; }
  onChunk(chunk);
}

// One parsed chunk: may carry usage, search results, thinking text,
// answer text, and/or the finish reason.
function handleChunk(chunk, run, view) {
  if (chunk.error) throw makeApiError(0, chunk.error.message || "Error inside the stream");

  const usage = (chunk.x_groq && chunk.x_groq.usage) || chunk.usage;
  if (usage) run.usage = usage;

  const choice = chunk.choices && chunk.choices[0];
  if (!choice) return;
  const delta = choice.delta || {};

  if (delta.executed_tools) handleExecutedTools(delta.executed_tools, run, view);

  if (delta.reasoning) {
    run.thinking += delta.reasoning;
    view.thinking.hidden = false;
    if (run.firstAnswerAt === null) view.thinking.open = true;   // expanded while it streams
    view.thinkingText.textContent = run.thinking;
    view.thinkingText.scrollTop = view.thinkingText.scrollHeight;
    if (!run.sources.length && view.status.textContent.startsWith("Waiting")) view.status.hidden = true;
  }

  if (delta.content) {
    if (run.firstAnswerAt === null) {
      run.firstAnswerAt = performance.now();
      view.thinking.open = false;      // auto-collapse thinking at the first answer token
      view.status.hidden = true;
    }
    run.answer += delta.content;
    renderAnswer(view, run);
  }

  if (choice.finish_reason) run.finishReason = choice.finish_reason;
  scrollTranscript();
}

// Web search results. Groq reports the searches it ran in
// delta.executed_tools; each one may carry search_results.results[].
function handleExecutedTools(tools, run, view) {
  for (const tool of tools) {
    const results = (tool.search_results && tool.search_results.results) || [];
    if (results.length === 0) { setStatus(view, "Searching the web..."); continue; }
    for (const r of results) {
      if (!r || !r.url || run.sources.some(s => s.url === r.url)) continue;
      run.sources.push({ title: r.title || String(r.url), url: String(r.url) });
    }
    renderSources(view, run.sources);
  }
}

// Called once at the end — normally, or after the Stop button.
function finishReply(view, run, startedAt, stoppedByUser) {
  const endedAt = performance.now();
  renderAnswer(view, run);

  // If Reset was pressed mid-reply the bubble is gone — don't touch the new history.
  if (view.el.isConnected) {
    if (run.answer.trim()) conversation.push({ role: "assistant", content: run.answer });
    else forgetUnansweredQuestion();
  }

  // Stop-reason badge
  let badgeText, amber = false;
  if (stoppedByUser) badgeText = "stopped: cancelled by you";
  else if (run.finishReason === "length") { badgeText = "stopped: hit max tokens (" + view.maxTokens + ")"; amber = true; }
  else if (run.finishReason === "stop") badgeText = "stopped: end of sequence";
  else if (!run.finishReason) badgeText = "stopped: reason not reported by the API";
  else badgeText = "stopped: " + run.finishReason;
  view.badge.textContent = badgeText;
  view.badge.className = "badge" + (amber ? " amber" : "");
  view.badge.hidden = false;

  if (!stoppedByUser && run.finishReason === "length" && !run.answer.trim()) {
    view.warning.textContent = "No answer — the entire token budget was spent thinking. Raise Max tokens.";
    view.warning.hidden = false;
  }

  // Relabel the thinking panel once we know the real reasoning token count.
  if (run.thinking) {
    const n = reasoningTokensOf(run.usage);
    view.thinkingSummary.textContent = n === null
      ? "Thinking... (click to reopen)"
      : "Thinking... (" + n + " reasoning tokens, click to reopen)";
  }

  if (run.sources.length) setStatus(view, "Searched the web — " + run.sources.length + " sources", true);
  else if (view.searchRequested && !stoppedByUser) setStatus(view, "Web search was on, but no source list came back for this reply.", true);
  else view.status.hidden = true;

  view.copyBtn.hidden = false;
  view.copyBtn.onclick = () => copyText(run.answer, view.copyBtn);

  showSpeed(run, startedAt, endedAt);
  showUsage(run.usage);
  scrollTranscript();
}

// If a request failed, drop the question from the history so it is
// not sent twice next time.
function forgetUnansweredQuestion() {
  const last = conversation[conversation.length - 1];
  if (last && last.role === "user") conversation.pop();
}

/* ==================================================================
   12. CHAT BUBBLES
   WHAT THIS DOES: creates and updates the HTML for each message.
   ================================================================== */
function addUserBubble(text) {
  const welcome = $("welcomeDeck");
  if (welcome) welcome.style.display = "none";
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  $("transcript").append(el);
  scrollTranscript();
}

function addNotice(text) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  $("transcript").append(el);
  scrollTranscript();
}

function createAssistantBubble(body) {
  const id = "reply-" + (++replyCounter);
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML =
    '<details class="request"><summary>Request sent — the exact JSON body POSTed (your key travels in a header, not here)</summary><pre></pre></details>' +
    '<div class="meta"></div>' +
    '<div class="status" hidden></div>' +
    '<details class="thinking" hidden><summary>Thinking...</summary><div class="thinking-text"></div></details>' +
    '<div class="answer"></div>' +
    '<div class="sources"></div>' +
    '<div class="warning" hidden></div>' +
    '<div class="error" hidden></div>' +
    '<div class="msg-footer"><span class="badge" hidden></span><button class="small" hidden>Copy</button></div>';
  el.querySelector(".request pre").textContent = JSON.stringify(body, null, 2);
  el.querySelector(".meta").textContent =
    body.model + " · temperature " + body.temperature + " · max tokens " + body.max_completion_tokens;
  $("transcript").append(el);
  scrollTranscript();

  const q = selector => el.querySelector(selector);
  return {
    id, el,
    maxTokens: body.max_completion_tokens,
    searchRequested: !!body.tools,
    status: q(".status"),
    thinking: q(".thinking"),
    thinkingSummary: q(".thinking summary"),
    thinkingText: q(".thinking-text"),
    answer: q(".answer"),
    sources: q(".sources"),
    warning: q(".warning"),
    error: q(".error"),
    badge: q(".badge"),
    copyBtn: q(".msg-footer button"),
  };
}

function setStatus(view, text, done) {
  view.status.textContent = text;
  view.status.className = "status" + (done ? " done" : "");
  view.status.hidden = false;
}

// Render the answer. GPT-OSS writes its own internal markers like
// 【2†L6-L10】 — we strip those and append [1][2][3] links to the source cards.
function renderAnswer(view, run) {
  const clean = run.answer.replace(/【[^】]*】/g, "");
  let html = renderMarkdown(clean);
  if (run.sources.length && clean.trim()) {
    html += '<p class="note">Sources: ' + run.sources.map((s, i) =>
      '<a class="cite" href="#' + view.id + "-src-" + i + '">[' + (i + 1) + "]</a>").join("") + "</p>";
  }
  view.answer.innerHTML = html;
}

function renderSources(view, sources) {
  view.sources.innerHTML = "";
  sources.forEach((source, i) => {
    const card = document.createElement("a");
    card.className = "source-card";
    card.id = view.id + "-src-" + i;
    if (/^https?:\/\//i.test(source.url)) card.href = source.url;   // only real web links
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.textContent = "[" + (i + 1) + "] " + source.title;
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = hostnameOf(source.url);
    card.append(host);
    view.sources.append(card);
  });
}

// One malformed URL must never break the stream, so fall back to the raw text.
function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (e) { return url; }
}

function scrollTranscript() {
  const t = $("transcript");
  t.scrollTop = t.scrollHeight;
}

/* ==================================================================
   13. SPEED AND TOKEN PANELS
   WHAT THIS DOES: shows real timing and the usage numbers the API
   reports — nothing here is estimated.
   ================================================================== */
function reasoningTokensOf(usage) {
  const details = usage && usage.completion_tokens_details;
  return details && typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : null;
}

function showSpeed(run, startedAt, endedAt) {
  $("speedTtft").textContent = run.firstAnswerAt ? Math.round(run.firstAnswerAt - startedAt) : "–";
  $("speedTotal").textContent = ((endedAt - startedAt) / 1000).toFixed(2);
  const u = run.usage;
  let tps = "–";
  if (u && u.completion_tokens && u.completion_time) {
    tps = Math.round(u.completion_tokens / u.completion_time);       // Groq's own generation timer
  } else if (u && u.completion_tokens && run.firstAnswerAt) {
    tps = Math.round(u.completion_tokens / ((endedAt - run.firstAnswerAt) / 1000));
  }
  $("speedTps").textContent = tps;
}

function showUsage(usage) {
  const fmt = n => (typeof n === "number" ? n.toLocaleString() : "not reported");
  if (!usage) {
    for (const id of ["useInput", "useReasoning", "useOutput", "useTotal"]) $(id).textContent = "not reported";
    return;
  }
  const reasoning = reasoningTokensOf(usage);
  $("useInput").textContent = fmt(usage.prompt_tokens);
  $("useReasoning").textContent = fmt(reasoning);
  // completion_tokens includes thinking; subtract it so the four rows add up.
  $("useOutput").textContent = fmt(reasoning === null ? usage.completion_tokens : usage.completion_tokens - reasoning);
  $("useTotal").textContent = fmt(usage.total_tokens);
}

// Rate-limit headers. If Groq does not expose them to browser
// JavaScript (a CORS rule), headers.get() returns null.
function showRateLimit(headers) {
  const remaining = headers.get("x-ratelimit-remaining-tokens");
  const reset = headers.get("x-ratelimit-reset-tokens");
  const cell = $("useLeft");
  if (remaining === null) {
    cell.textContent = "not reported";
    cell.className = "num";
    $("useReset").textContent = "";
    return;
  }
  cell.textContent = Number(remaining).toLocaleString();
  cell.className = "num" + (Number(remaining) < 1000 ? " amber" : "");
  $("useReset").textContent = reset ? "resets in " + reset : "";
}

function resetInsightPanels() {
  for (const id of ["speedTtft", "speedTotal", "speedTps", "useInput", "useReasoning", "useOutput", "useTotal"]) {
    $(id).textContent = "–";
  }
}

/* ==================================================================
   14. ERRORS IN PLAIN LANGUAGE
   WHAT THIS DOES: maps API errors to sentences a beginner understands,
   with the raw API message in small grey text underneath.
   ================================================================== */
function makeApiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function apiErrorFrom(resp) {
  let message = resp.statusText || "Request failed";
  try {
    const text = await resp.text();
    try { message = JSON.parse(text).error.message || text; }
    catch (e) { message = text || message; }
  } catch (e) { /* keep statusText */ }
  return makeApiError(resp.status, message);
}

function friendlyError(status, message) {
  const m = (message || "").toLowerCase();
  if (status === 401) return "That API key was rejected. Check it on the Groq console.";
  if (status === 429) return "Rate limit hit — you have used up your tokens per minute. Wait about a minute, or lower Max tokens.";
  if (status === 413 || /context.*(length|window|too long|exceed)|too long|maximum context/.test(m)) {
    return "The conversation is too long. Press Reset conversation.";
  }
  if ((status === 400 || status === 404) && m.includes("model") &&
      /decommission|not found|does not exist|unknown|no longer/.test(m)) {
    return "This model is no longer available — pick another from the dropdown.";
  }
  return "The API returned an error" + (status ? " (HTTP " + status + ")" : "") + ".";
}

function showError(view, err) {
  let friendly;
  let raw = err.message;
  if (typeof err.status === "number") {
    friendly = friendlyError(err.status, err.message);
    if (err.status) raw = "HTTP " + err.status + ": " + err.message;
  } else if (/fetch|network|load failed/i.test(err.message)) {
    friendly = "Could not reach the API. Check your internet connection.";
  } else {
    friendly = "Something went wrong while reading the reply.";
  }
  view.status.hidden = true;
  view.error.textContent = friendly;
  const rawEl = document.createElement("span");
  rawEl.className = "raw";
  rawEl.textContent = raw;
  view.error.append(rawEl);
  view.error.hidden = false;
  scrollTranscript();
}

/* ==================================================================
   15. "VIEW CODE" PANEL
   WHAT THIS DOES: prints the current request as curl and as Python.
   The key appears only as $GROQ_API_KEY / os.environ["GROQ_API_KEY"].
   ================================================================== */
function makeCurl(body) {
  const json = JSON.stringify(body, null, 2).replace(/'/g, "'\\''");   // escape ' for the shell
  return [
    "curl -N " + API_BASE + "/chat/completions \\",
    '  -H "Authorization: Bearer $GROQ_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  -d '" + json + "'",
  ].join("\n");
}

// Convert a JSON value into Python syntax (true -> True, null -> None).
function toPython(value, indent) {
  const pad = "    ".repeat(indent + 1), end = "    ".repeat(indent);
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map(v => pad + toPython(v, indent + 1) + ",").join("\n") + "\n" + end + "]";
  }
  return "{\n" + Object.keys(value).map(k => pad + JSON.stringify(k) + ": " + toPython(value[k], indent + 1) + ",").join("\n") + "\n" + end + "}";
}

// Parameters the OpenAI Python client has no named argument for.
const GROQ_ONLY_PARAMS = ["include_reasoning", "reasoning_format"];

function makePython(body) {
  const lines = [
    "import os",
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    '    base_url="https://api.groq.com/openai/v1",',
    '    api_key=os.environ["GROQ_API_KEY"],',
    ")",
    "",
    "stream = client.chat.completions.create(",
  ];
  const extra = {};
  for (const [name, value] of Object.entries(body)) {
    if (GROQ_ONLY_PARAMS.includes(name)) extra[name] = value;
    else lines.push("    " + name + "=" + toPython(value, 1) + ",");
  }
  if (Object.keys(extra).length) {
    lines.push("    # Groq-only settings go in extra_body:");
    lines.push("    extra_body=" + toPython(extra, 1) + ",");
  }
  lines.push(
    ")",
    "",
    "for chunk in stream:",
    "    if chunk.choices and chunk.choices[0].delta.content:",
    '        print(chunk.choices[0].delta.content, end="", flush=True)',
    "print()",
  );
  return lines.join("\n");
}

function openCodePanel() {
  const pending = $("prompt").value.trim() ? $("prompt").value : null;
  const body = buildRequestBody(pending);
  $("curlCode").textContent = makeCurl(body);
  $("pythonCode").textContent = makePython(body);
  $("codeModal").hidden = false;
}
$("viewCodeBtn").addEventListener("click", openCodePanel);
$("closeCode").addEventListener("click", () => { $("codeModal").hidden = true; });
$("codeModal").addEventListener("click", e => {
  if (e.target === $("codeModal") || e.target.classList.contains("modal-backdrop")) {
    $("codeModal").hidden = true;
  }
});

/* ==================================================================
   16. COPY BUTTONS
   WHAT THIS DOES: copies text to the clipboard (with an older fallback
   for browsers that block the clipboard API) and says "Copied!".
   ================================================================== */
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const temp = document.createElement("textarea");
    temp.value = text;
    document.body.append(temp);
    temp.select();
    document.execCommand("copy");
    temp.remove();
  }
  const label = button.dataset.label || (button.dataset.label = button.textContent);
  button.textContent = "Copied!";
  setTimeout(() => { button.textContent = label; }, 1200);
}

// One listener handles every copy button, including ones inside code
// blocks that are re-created while the reply streams in.
document.addEventListener("click", e => {
  const codeButton = e.target.closest(".copy-code");
  if (codeButton) copyText(codeButton.parentElement.querySelector("code").textContent, codeButton);
  const panelButton = e.target.closest("[data-copy-target]");
  if (panelButton) copyText($(panelButton.dataset.copyTarget).textContent, panelButton);
});

/* ==================================================================
   17. BUTTONS AND KEYBOARD SHORTCUTS
   WHAT THIS DOES: Submit/Stop, Ctrl/Cmd+Enter, Escape, Reset.
   ================================================================== */
function setStreaming(on) {
  isStreaming = on;
  const btn = $("sendBtn");
  const textSpan = btn.querySelector(".btn-text");
  if (textSpan) textSpan.textContent = on ? "Stop" : "Submit";
  else btn.textContent = on ? "Stop" : "Submit";
  btn.className = on ? "stop send-btn" : "primary send-btn";
}

$("sendBtn").addEventListener("click", () => {
  if (isStreaming) abortController.abort();
  else send();
});

$("prompt").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (!isStreaming) send();
  }
});

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (isStreaming) abortController.abort();
  else $("codeModal").hidden = true;
});

$("resetBtn").addEventListener("click", () => {
  if (isStreaming) abortController.abort();
  conversation = [];
  lastSentPrompt = "";
  renderPromptAnalysis();
  $("transcript").innerHTML = "";
  const welcome = $("welcomeDeck");
  if (welcome) {
    welcome.style.display = "flex";
    $("transcript").append(welcome);
  }
  addNotice("Conversation reset — the next request starts from scratch.");
  resetInsightPanels();
  const modeLabel = $("currentModeLabel");
  if (modeLabel) modeLabel.textContent = "Custom Mode";
});

// Clear Chat action button
const clearChatBtn = $("clearChatBtn");
if (clearChatBtn) {
  clearChatBtn.addEventListener("click", () => {
    $("resetBtn").click();
  });
}

/* ==================================================================
   18. UI ENHANCEMENTS (DROPDOWN SETTINGS, MODES, INFO POPOVERS, DRAWER)
   ================================================================== */
// Settings & API Key Dropdown Menu
const settingsToggle = $("settingsDropdownToggle");
const settingsMenu = $("settingsDropdownMenu");
const closeSettings = $("closeSettingsDropdown");

if (settingsToggle && settingsMenu) {
  settingsToggle.addEventListener("click", e => {
    e.stopPropagation();
    const isHidden = settingsMenu.hidden;
    settingsMenu.hidden = !isHidden;
    settingsToggle.setAttribute("aria-expanded", String(isHidden));
  });

  if (closeSettings) {
    closeSettings.addEventListener("click", () => {
      settingsMenu.hidden = true;
      settingsToggle.setAttribute("aria-expanded", "false");
    });
  }

  document.addEventListener("click", e => {
    if (!settingsMenu.hidden && !settingsMenu.contains(e.target) && e.target !== settingsToggle && !settingsToggle.contains(e.target)) {
      settingsMenu.hidden = true;
      settingsToggle.setAttribute("aria-expanded", "false");
    }
  });
}

// Telemetry Drawer Toggle
const toggleTelemetryBtn = $("toggleTelemetryBtn");
const telemetryDrawer = $("telemetryDrawer");
const closeTelemetryDrawer = $("closeTelemetryDrawer");

if (toggleTelemetryBtn && telemetryDrawer) {
  toggleTelemetryBtn.addEventListener("click", () => {
    telemetryDrawer.hidden = !telemetryDrawer.hidden;
  });
  if (closeTelemetryDrawer) {
    closeTelemetryDrawer.addEventListener("click", () => {
      telemetryDrawer.hidden = true;
    });
  }
}

// API Key visibility toggle
const toggleKeyBtn = $("toggleKeyVisibility");
if (toggleKeyBtn) {
  toggleKeyBtn.addEventListener("click", () => {
    const input = $("apiKey");
    const isPass = input.type === "password";
    input.type = isPass ? "text" : "password";
    const eyeIcon = $("eyeIcon");
    if (eyeIcon) {
      eyeIcon.innerHTML = isPass
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
  });
}

// Starter Conversation Modes & Presets
const CONVERSATION_MODES = {
  creative: {
    label: "Creative Exploration Mode",
    temp: 1.2,
    tokens: 600,
    reasoning: false,
    prompt: [
      "Let's explore high-concept creative synthesis.",
      "Topic: Imagine a civilization that builds orbital computing habitats powered entirely by solar flares.",
      "Describe their architecture, computational paradigm, and societal philosophy.",
      "Write with vivid literary depth and unexpected metaphors."
    ].join("\n")
  },
  practical: {
    label: "Practical & Business Mode",
    temp: 0.6,
    tokens: 400,
    reasoning: false,
    prompt: [
      "Provide an executive briefing and strategic decision matrix on migrating from self-hosted Kafka clusters to a managed event streaming architecture.",
      "Structure your response with:",
      "1. TCO & Operational Overhead Analysis",
      "2. Reliability & SLA Guarantees",
      "3. Clear Recommendation with Risk Mitigation Steps"
    ].join("\n")
  },
  mathematical: {
    label: "Mathematical & Logic Mode",
    temp: 0.1,
    tokens: 800,
    reasoning: true,
    prompt: [
      "Solve this formal probability and logic puzzle step by step.",
      "Let's think step by step to prove the exact distribution:",
      "",
      "Problem: A bag contains 3 red balls and 5 green balls. You draw balls one by one without replacement until a red ball is drawn. What is the expected number of green balls drawn before the first red ball?",
      "",
      "Derive the solution mathematically with clear steps."
    ].join("\n")
  },
  engineering: {
    label: "Systems & Architecture Mode",
    temp: 0.2,
    tokens: 700,
    reasoning: true,
    prompt: [
      "You are a Principal Distributed Systems Engineer.",
      "Refactor the following Python async event processor to eliminate race conditions and avoid unbounded queue memory growth.",
      "Provide clean, production-grade asyncio code with backpressure mechanisms and type annotations.",
      "Do not use generic high-level summaries."
    ].join("\n")
  }
};

// Mode Menu Dropdown in Composer
const modeMenuToggle = $("modeMenuToggle");
const modeDropdownMenu = $("modeDropdownMenu");

if (modeMenuToggle && modeDropdownMenu) {
  modeMenuToggle.addEventListener("click", e => {
    e.stopPropagation();
    const isHidden = modeDropdownMenu.hidden;
    modeDropdownMenu.hidden = !isHidden;
    modeMenuToggle.setAttribute("aria-expanded", String(isHidden));
  });

  document.addEventListener("click", e => {
    if (!modeDropdownMenu.hidden && !modeDropdownMenu.contains(e.target) && e.target !== modeMenuToggle && !modeMenuToggle.contains(e.target)) {
      modeDropdownMenu.hidden = true;
      modeMenuToggle.setAttribute("aria-expanded", "false");
    }
  });
}

function applyConversationMode(modeKey) {
  if (modeKey === "custom") {
    const modeLabel = $("currentModeLabel");
    if (modeLabel) modeLabel.textContent = "Custom Mode";
    if (modeDropdownMenu) modeDropdownMenu.hidden = true;
    if (modeMenuToggle) modeMenuToggle.setAttribute("aria-expanded", "false");
    return;
  }

  const mode = CONVERSATION_MODES[modeKey];
  if (mode) {
    $("tempRange").value = mode.temp;
    $("tempBox").value = mode.temp;
    $("maxRange").value = mode.tokens;
    $("maxBox").value = mode.tokens;
    updateSliderUI();

    const caps = getCapabilities($("model").value);
    if (caps.reasoning === "optional") {
      $("reasoning").checked = mode.reasoning;
      wantsReasoning = mode.reasoning;
    }

    $("prompt").value = mode.prompt;
    schedulePromptAnalysis();

    const modeLabel = $("currentModeLabel");
    if (modeLabel) modeLabel.textContent = mode.label;

    if (modeDropdownMenu) modeDropdownMenu.hidden = true;
    if (modeMenuToggle) modeMenuToggle.setAttribute("aria-expanded", "false");

    $("prompt").focus();
  }
}

document.querySelectorAll(".mode-card").forEach(card => {
  card.addEventListener("click", () => applyConversationMode(card.dataset.mode));
});

document.querySelectorAll(".mode-menu-item").forEach(item => {
  item.addEventListener("click", () => applyConversationMode(item.dataset.mode));
});

// Circled (i) Info Popover Explanations
const INFO_EXPLANATIONS = {
  temperature: {
    title: "Temperature (Sampling Randomness)",
    text: "Controls randomness in token selection. Lower values (0.0 – 0.3) produce deterministic, highly focused answers ideal for code and math. Higher values (0.8 – 1.5) encourage creativity, unexpected metaphors, and diverse vocabulary."
  },
  maxTokens: {
    title: "Max Completion Tokens",
    text: "The hard ceiling on output generation length. On reasoning models, this budget includes hidden thinking tokens — setting this too low can result in the model spending all tokens thinking with none left for the final answer."
  },
  stopSeq: {
    title: "Stop Sequences",
    text: "Up to 4 custom string markers (e.g. 'Input:', '###') that instruct the model to immediately stop generating as soon as one of them appears in the output."
  },
  webSearch: {
    title: "Live Web Search (Tool)",
    text: "Allows the model to query external search engines to fetch up-to-date facts before writing. Incurs additional input token cost and latency."
  },
  reasoning: {
    title: "Internal Reasoning (CoT)",
    text: "Enables chain-of-thought thinking tokens before producing the final response. You can view the live thought stream in the collapsible Thinking drawer."
  },
  apiKey: {
    title: "Groq API Authentication",
    text: "Your personal Groq API key (starts with 'gsk_'). It is stored securely in your browser's sessionStorage and sent only in the Authorization header to api.groq.com."
  },
  shotLearning: {
    title: "Prompt Engineering & Few-Shot",
    text: "Zero-Shot: answering purely from model pre-training without worked examples. Few-Shot: providing one or more example (Input / Output) pairs in the prompt to condition the model's pattern and style."
  },
  ttft: {
    title: "Time To First Token (TTFT)",
    text: "Elapsed milliseconds from dispatching the HTTP request until the first completion token streams back to the browser. Web search and reasoning increase TTFT."
  },
  tps: {
    title: "Tokens Per Second (TPS)",
    text: "Generation throughput calculated from completion tokens divided by generation time. Groq LPU hardware typically delivers 200–500+ tokens/sec."
  },
  quota: {
    title: "Token Quota & Rate Limits",
    text: "Tracks your real-time tokens-per-minute quota reported in the 'x-ratelimit-remaining-tokens' API response header to prevent HTTP 429 rate limit errors."
  },
  telemetry: {
    title: "Live Inference Telemetry",
    text: "Real metrics reported directly by the Groq API server for latency, token economics, and streaming performance."
  }
};

const popover = $("infoPopover");
const popoverTitle = $("popoverTitle");
const popoverContent = $("popoverContent");
const closeInfoPopover = $("closeInfoPopover");

if (popover) {
  document.addEventListener("click", e => {
    const btn = e.target.closest(".info-btn[data-info]");
    if (btn) {
      e.stopPropagation();
      const infoKey = btn.dataset.info;
      const data = INFO_EXPLANATIONS[infoKey];
      if (data) {
        popoverTitle.textContent = data.title;
        popoverContent.textContent = data.text;
        popover.hidden = false;

        const rect = btn.getBoundingClientRect();
        let left = rect.left - 130;
        let top = rect.bottom + 8;
        if (left < 10) left = 10;
        if (left + 290 > window.innerWidth) left = window.innerWidth - 300;
        if (top + 170 > window.innerHeight) top = rect.top - 160;

        popover.style.left = left + "px";
        popover.style.top = top + "px";
      }
      return;
    }

    if (!popover.hidden && !popover.contains(e.target)) {
      popover.hidden = true;
    }
  });

  if (closeInfoPopover) {
    closeInfoPopover.addEventListener("click", () => {
      popover.hidden = true;
    });
  }
}

/* ==================================================================
   19. START-UP
   WHAT THIS DOES: fills the prompt box, restores a remembered key,
   loads models if we have a key, and runs the first prompt analysis.
   ================================================================== */
$("prompt").value = DEFAULT_PROMPT;
restoreKey();
fillModelDropdown(FALLBACK_MODELS, true);
$("modelsStatus").textContent = "Fallback list — paste a key to load live models";
if (getKey()) ensureModelsLoaded();
updateSliderUI();
renderPromptAnalysis();
