# AETHER // Minimalist LLM Studio

An ultra-sleek, minimalist LLM engineering playground and inference studio powered by the **Groq API**. Designed with a high-contrast **Jet Black**, **Muted Moss Green (`#6D8F63`)**, and **Neon Emerald (`#39FF88`)** aesthetic, providing zero-distraction AI interactions with deep reasoning and live telemetry.

---

## 🌟 Key Highlights & Minimalist Features

- **Minimalist Studio Workspace**:
  - Eliminated cluttered sidebars in favor of a focused conversational stage and a centered model selector.
  - **Settings & API Dropdown**: All hyperparameter sliders (Temperature, Max Tokens), stop sequences, API key configuration, and feature toggles (Web Search, Reasoning) live in a sleek dropdown menu in the header.
  - **Clear Chat**: Single-click button to reset the session and restore starter modes.
  - **Starter Conversation Modes**:
    - 🎨 **Creative Exploration**: Calibrated for high-variance creative ideation (Temp: 1.2, 600 Tokens).
    - 💼 **Practical & Business**: Calibrated for executive summaries and decision matrices (Temp: 0.6, 400 Tokens).
    - 🧮 **Mathematical & Logic**: Calibrated for deterministic chain-of-thought derivations (Temp: 0.1, 800 Tokens, Reasoning mode).
    - 💻 **Systems & Architecture**: Calibrated for low-latency concurrency refactors and strict API schemas (Temp: 0.2, 700 Tokens).
  - **Circled Info Badges `ⓘ`**: Instant popover explanations for key concepts (Temperature, Max Tokens, Stop Sequences, Web Search, Reasoning, Few-shot Learning, TTFT, TPS, and Rate Limits).
  - **Collapsible Metrics & Analysis Drawer**: Instant slide-out drawer providing live latency, generation throughput, token economics, and heuristic prompt analysis without cluttering the screen.

- **100% Faithful Backend Logic**:
  - Direct SSE streaming from Groq Chat Completions API (`https://api.groq.com/openai/v1`).
  - Model family capability gating (`openai/gpt-oss`, `qwen/qwen3`, etc.).
  - Bi-directionally synced sliders and number inputs.
  - Rule-based prompt heuristic engine (Zero-shot vs Few-shot detection, technique flags).
  - Accurate token accounting (`prompt_tokens`, `reasoning_tokens`, `completion_tokens`).
  - Rate limit quota tracking via `x-ratelimit-remaining-tokens`.
  - One-click **cURL** and **Python (OpenAI SDK)** code generation.

---

## 🚀 Running Locally or Deploying

### Option 1: View Locally (File or Server)
Open `index.html` directly in your browser, or start any static HTTP server:
```bash
python3 -m http.server 3000
```

### Option 2: Deploy to Vercel (1-Click)
1. Push to your GitHub repository:
   ```bash
   git push -u origin main
   ```
2. Import the project on [Vercel](https://vercel.com/new).
3. Keep default settings (Framework Preset: **Other**, Root Directory: `.`) and click **Deploy**.
