# Project Health (ph) 🚀

**The unified CLI & IDE tool for deep codebase intelligence**

`project-healthy` (ph) is an advanced, all-in-one CLI binary and IDE extension
designed to run deep, automated analyses on any software repository. It combines
eight parallel analysis modules and an AI intelligence layer powered by
**MegaLLM** to provide actionable insights, unified health scores, and
conversational code interaction.

---

## 📖 Executive Summary

Developers often juggle between multiple tools to evaluate codebase health—CI
dashboards, linters, security scanners, documentation wikis, and PR reviewers.
`ph` solves this fragmentation by offering **one command, one score, and one
conversation**.

Running `ph scan` orchestrates eight analysis modules in parallel to generate a
comprehensive 0-100 codebase health score, severity-ranked findings, and an
actionable top-3 task list. An embedded AI layer powers conversational code
interrogation, PR reviews, onboarding document generation, and intelligent
documentation updates.

## 🎯 Primary Goals

- **Single Binary**: Fast, global installation (`npm install -g project-healthy`).
- **Parallel Analysis**: Eight distinct modules run concurrently (under 60s for
  typical projects).
- **Unified Scoring**: 0–100 weighted health score with actionable insights.
- **MegaLLM-powered AI**: High-quality LLM integrations routed through a
  backend proxy (supporting Claude, GPT, Gemini, etc.).
- **Zero-Code Model Swapping**: Switch LLM providers simply by updating the
  proxy's `.env` file.
- **Open Access**: No authentication required — download the CLI from npm and start using AI features immediately.
- **IDE & CI/CD Support**: VS Code extension included, alongside CI pipeline
  integration (e.g., block merges if score drops below a threshold).

---

## 🏗 Architecture Overview

### 1. Analysis Pipeline

The execution pipeline seamlessly integrates multiple insights:
`User runs: ph scan` → **Analysis Orchestrator** (Runs M01 to M08 concurrently)
→ **Score Aggregator** (Computes `HealthReport`) → **Output Layer** (Displays
Terminal | JSON | HTML)

### 2. Local Context Cache (`.ph-cache/`)

The tool leverages a local workspace cache located at the project root to
support AI grounding and temporal state checks:

- `ast-index.json`: Maps symbol names to locations.
- `docs-index.json`: Maps source files to their referencing doc sections.
- `last-scan.json`: Context injector for AI queries.
- `sessions/`: Chat history files for persistent context.

### 3. AI Proxy Architecture

AI calls are brokered via a developer-operated backend microservice. The proxy
interacts with the MegaLLM API using secured keys on the server side. No
third-party LLM API keys run on the developer's local machine. The CLI connects
directly to the hosted backend with no authentication required.

---

## 🧩 Core Analysis Modules (M-01 to M-08)

`ph` calculates your health score using eight diverse, weighted modules.

| ID       | Module Name             | Weight | Primary Purpose                             | How it works                                                                  |
| :------- | :---------------------- | :----: | :------------------------------------------ | :---------------------------------------------------------------------------- |
| **M-05** | **Dependency Security** |  20%   | Detect CVEs & license risks.                | Analyzes `npm audit`/`pip-audit` and license compatibility.                   |
| **M-02** | **Code Quality**        |  18%   | Linting, complexity, duplicates, dead code. | Runs ESLint, computes cyclomatic complexity, checks via `ts-prune` & `jscpd`. |
| **M-01** | **CI/CD Pipeline**      |  15%   | Build reliability & CI bottlenecks.         | Analyzes CI YAML and fetches run history from GitHub/GitLab.                  |
| **M-04** | **Test Flakiness**      |  14%   | Detects inconsistently failing tests.       | Parses JUnit XML reports cross-referenced against Git commit history.         |
| **M-07** | **Env Integrity**       |  13%   | `.env` drift and secret leakage prevention. | Scans `git history` for secrets, diffs `.env.example`, checks Dockerfiles.    |
| **M-08** | **Build Performance**   |  10%   | Caching efficiency & build bottlenecks.     | Parses CI logs to find duration anomalies and cache misses.                   |
| **M-03** | **Docs Freshness**      |   6%   | Identifies stale documentation.             | Correlates source code modification dates against related markdown sections.  |
| **M-06** | **PR Complexity**       |   4%   | Flags PRs too large or complex for review.  | Computes lines changed, cross-module impact, and review turnaround times.     |

### Health Score Labels

- **90–100 (EXCELLENT)**: No immediate action needed.
- **75–89 (GOOD)**: Address low-severity issues during sprints.
- **60–74 (MODERATE)**: Remediation sprint required within 2 weeks.
- **40–59 (HIGH RISK)**: Immediate action required on critical issues.
- **0–39 (CRITICAL)**: Block new features; dedicated remediation needed.

---

## 🤖 AI Features (Powered by MegaLLM)

All features are invoked securely through the proxy and maintain grounded
context via the local `.ph-cache/`.

1. **`ph ask` (Natural Language Interrogation)** Ask plain-English questions
   about the codebase. Replaces generic advice with specific `file:line` citations.
2. **`ph review` (PR Review Co-pilot)** Senior-level review of a branch or PR.
   Highlights bugs, security gaps, untested paths, and complexity spikes based
   on actual test coverage.
3. **`ph brief` (Onboarding Briefing Generator)** Automatically creates an
   `ONBOARDING.md` containing architecture summaries, ownership maps, entry points, etc.
4. **`ph chat` (Conversational Codebase REPL)** A persistent terminal chat session.
5. **`ph fix` (Self-Healing Codebase Engine)** Automatically remediate findings
   from your last scan using MegaLLM patch generation. It triages, fixes, and
   validates findings, supporting auto-generated fixes (complexity refactoring,
   dead exports, secret leaks, etc.).
   Modes: `--auto` (fully automated fix loop), `--interactive`, `--dry-run`, `--ai`.
6. **Git Hook (Commit Doc Updater)** A surgical `post-commit` hook that
   automatically amends (or opens a PR to update) documentation sections that
   reference code you just changed.

---

## 🛠 Tech Stack

**Strictly TypeScript & Node.js ecosystem (Zero Java)**

- **CLI**: `commander`, `chalk`, `ora`, `execa`, `keytar`, `pkg`
- **AI Integration**: `openai` (configured to point to MegaLLM baseURL)
- **Security Checkers**: `license-checker`, `js-yaml`, `dotenv`
- **Code Analyzers**: `@typescript-eslint/typescript-estree`,
  `complexity-report-es`, `ts-prune`, `jscpd`
- **APIs & Data Gathering**: `@octokit/rest`, `simple-git`, `fast-xml-parser`

---

## 🚀 Getting Started

### Hosted NPM Installation (Recommended)

**No API keys or complex configuration needed!** Just install from NPM and start using:

```bash
# Install the package globally
npm install -g project-healthy

# Navigate to your project
cd your-project-folder

# Jump into the interactive CLI shell
ph init
```

The CLI automatically uses our hosted backend for AI features out of the box.

### 1. Initialization / Interactive Shell

```bash
cd your-project-folder
ph init
```

`ph init` acts as your interactive CLI shell! It activates an interactive, continuous
command loop. You can input commands straight from the prompt, remaining active until
you press `Ctrl+C` or close the terminal. Additionally, it generates the `.ph-cache/`
context folder, builds your `project-health.config.ts`, and installs the smart git hooks.

### 2. Running a Scan

```bash
ph scan --format terminal
```

Runs the 8 parallel modules and logs the score to stdout. Use `--format html`
for an interactive report, `--format sarif` for security tool integration, or
`--fail-under 80` in CI/CD pipelines.

### 3. Web Dashboard Integration

```bash
ph dashboard --port 8080
```

Launches a robust data integration Web Dashboard. We have implemented robust,
null-safe parsing for overview pages. If you're building upon our Dashboard UI
(e.g. Discharge Station Cards, Rain Gauge, Barrage Level), it includes
responsive design updates via flexible wrapping utilities, ensuring metrics won't overlap.

### 4. Interactive Repository Explorer

```bash
ph explore
```

Launches a local web UI at `http://localhost:7878` with a file tree with activity heat maps,
commit history for each file, click-to-expand diffs inline, and module health impact visualization.

### 5. Self-Healing Auto-Fix Engine Pipeline

```bash
# Auto-fix all fixable findings automatically (Full pipeline)
ph fix --auto

# Interactive selection of findings to fix
ph fix --interactive

# Preview AI-powered fix patches without applying
ph fix --dry-run
```

The auto-fix engine is fully capable of treating high-severity findings
like secret leaks, complexity limits (e.g., M-02 code clones, sliding window threshold alerts),
and large file technical debt out of the box using MegaLLM!

### 6. Additional Commands

```bash
# General AI assistance
ph ask "What are the main entry points?"

# Fast CI check with 30s timeout (exits 1 if below threshold)
ph ci-check --fail-under 80

# Compare current branch against base
ph diff --base main

# Print latest health score from cache
ph score

# Historical score trend analysis
ph trend

# AI Codebase Chat
ph chat
```

---

## 💻 Running the CLI Locally (From Source)

If you'd like to extend `project-health` or run the uncompiled source code yourself,
you need to clone the repository and configure the required environment formats:

### Step 1. Clone & Build

```bash
git clone https://github.com/Sanjay-Shahyml/Project-health.git
cd Project-health
npm install
npm run build
```

_(Optional) Create a global link for the local binary:_

```bash
npm link
# Now you can use 'project-health' globally calling your local build
```

### Step 2. CLI Environment Variables (`.env`)

You can supply optional tokens to extend CLI capabilities (e.g. GitHub/GitLab integrations)
by creating a `.env` in the root of the standard repo.

Copy the `.env.example` to `.env` in the root directory and configure as needed:

```env
# Point to your own locally running AI proxy
PROJECT_HEALTH_BACKEND_URL="http://localhost:3000/v1"

# Needed for CI/CD checks (M-01) and PR complexity (M-06)
GITHUB_TOKEN=ghp_your_github_token_here
GITLAB_TOKEN=glpat_your_gitlab_token_here

# Needed for Snyk Dependency Security checks (M-05)
SNYK_TOKEN=your_snyk_token_here
```

---

## Standalone AI Proxy Microservice (`ai-proxy/`)

For developers intending to utilize their own MegaLLM API keys, the proxy
logic has been isolated into its own production-ready Node.js microservice
(`ai-proxy/`). This proxy centralizes AI request handling, secures API keys
preventing leaks to client devices, and manages API rate limits locally.
No authentication is required — anyone can use the AI features.

### Step 1: Proxy Configuration

Navigate to the `ai-proxy` directory and setup environment variables:

```bash
cd ai-proxy
cp .env.example .env.local
```

### Step 2: Edit `.env.local`

Update `.env.local` to point to your AI provider variables, limits, and server settings:

```env
# AI Provider (MegaLLM API integration)
MEGALLM_API_KEY=sk-your-megallm-api-key
MEGALLM_BASE_URL=https://ai.megallm.io/v1
MEGALLM_MODEL=claude-sonnet-4-6

# Configuration
MEGALLM_MAX_TOKENS=120000
MEGALLM_TEMPERATURE=0.7

# Proxy network
PORT=3000
RATE_LIMIT_RPM=60
```

### Step 3: Start the Microservice

Start the decoupled proxy! Once deployed, it handles LLM interactions securely.

```bash
npm run start:proxy   # from the repo root
# OR
cd ai-proxy && npm start
```

Make sure your client configuring the CLI `PROJECT_HEALTH_BACKEND_URL` is pointing directly
at this proxy URL (e.g., `http://localhost:3000/v1`).
