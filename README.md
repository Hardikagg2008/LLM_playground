# AETHER // LLM Engine & Reasoning Playground

A futuristic, high-performance web-based LLM testing and engineering studio built on the **Groq API**. It features real-time streaming inference, deep reasoning mode inspection, web search tool integration, live telemetry (TTFT, TPS, latency), rule-based prompt engineering analysis, and one-click code generation for Python and cURL.

---

## 🌟 Key Features & Logic

- **100% Faithful Logic & API Integration**:
  - Full compatibility with the Groq Chat Completions API (`https://api.groq.com/openai/v1`).
  - Real-time Server-Sent Events (SSE) streaming reader.
  - Model family capability map with automatic feature gating:
    - `openai/gpt-oss` (Always-on reasoning, web search enabled).
    - `qwen/qwen3` (Optional reasoning, parsed reasoning format).
    - `minimaxai/minimax-m2` & `meta-models/muse-spark` (Reasoning models).
  - Temperature slider (0 to 2.0 with step 0.05) synced bi-directionally with number input and preset anchors (Precise, Balanced, Creative).
  - Max Token budget slider (50 to 1,000 tokens) with thinking token awareness.
  - Stop sequence parsing (up to 4 custom delimiters).
  - Secure in-memory or `sessionStorage` API key management (dies on tab close).
  - Dynamic live model fetching from `/models` with fallback list.

- **Deep Prompt Analysis Engine**:
  - Instant rule-based classification: `ZERO-SHOT`, `ONE-SHOT`, `FEW-SHOT (N)`.
  - Technique detection:
    - **Chain-of-Thought** (`think step by step`, `let's think`)
    - **Role Prompting** (`you are an`, `act as`, `pretend you are`)
    - **Negative Constraints** (`do not`, `never`, `avoid`)
    - **Format Constraints** (`json`, `table`, `bullet`)
  - Rule-by-rule diagnostic breakdown with matched text extraction.

- **Real-Time Telemetry & Quota Economics**:
  - **TTFT (Time to First Token)** in milliseconds.
  - **Total Latency** in seconds.
  - **TPS (Tokens Per Second)** throughput calculation.
  - Accurate token distribution: Prompt tokens, Reasoning tokens, Completion tokens, and Total tokens.
  - Live rate limit remaining tokens and minute reset tracking (`x-ratelimit-remaining-tokens`).

- **Developer Export & Diagnostics**:
  - Full request JSON payload inspection in conversation history.
  - Thinking / reasoning stream block with auto-collapse when answer begins.
  - Web search citations with domain chips and deep links.
  - One-click **cURL** and **Python (OpenAI SDK)** code generation matching current session parameters and conversation state.
  - Markdown renderer with inline code, copy-code blocks, lists, and headers.

---

## 🎨 UI Redesign Highlights

Unlike conventional developer tools with static, monochrome rectangles, AETHER provides a next-generation AI studio interface:

1. **Ambient Glassmorphism**: Layered glass panels with dark carbon backgrounds, subtle radial glows, and high-contrast glowing accents.
2. **Modern Control Deck**: Modular parameter cards with interactive sliders, custom switches, and quick presets.
3. **Conversational Stage**: Frosted user message bubbles, high-tech assistant response cards with interactive JSON inspector, and animated pulsating reasoning block.
4. **Telemetry & Intelligence Tabs**: Tabbed inspector organizing prompt heuristics and performance telemetry into a clean HUD.
5. **Quick Preset Prompts**: One-click pills for Few-Shot Classification, Chain-of-Thought, JSON Extraction, and Architect Role.

---

## 🚀 Running Locally

You can run this project using any static HTTP server:

```bash
# Using Python
python3 -m http.server 3000

# Or using Node.js npx
npx serve .
```

Open `http://localhost:3000` in your browser.

---

## 📦 Deployment to Vercel

This repository is ready for immediate deployment on Vercel:

1. Push this folder to a GitHub repository.
2. Import the project on [Vercel](https://vercel.com).
3. Set Framework Preset to **Other** (Root directory: `.`).
4. Click **Deploy**.
