# Project Health (ph) 🚀

**The unified CLI & IDE tool for deep codebase intelligence**

`project-health` (ph) is an advanced, all-in-one CLI binary and IDE extension
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

- **Single Binary**: Fast, global installation (`npm install -g ph`).
- **Parallel Analysis**: Eight distinct modules run concurrently (under 60s for
  typical projects).
- **Unified Scoring**: 0–100 weighted health score with actionable insights.
- **MegaLLM-powered AI**: High-quality LLM integrations routed through a secure
  backend proxy (supporting Claude, GPT, Gemini, etc.).
- **Zero-Code Model Swapping**: Switch LLM providers simply by updating the
  proxy's `.env` file.
- **Secure Architecture**: API keys are isolated on the proxy server; the CLI
  only uses temporary JWTs.
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

AI calls are brokered via a developer-operated backend proxy ensuring high
security. The user's CLI authenticates via JWT, while the Proxy interacts with
the MegaLLM API using secured keys. No third-party LLM API keys run on the
developer's local machine.

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
   about the codebase. Replaces generic advice with specific `file:line`
   citations.
2. **`ph review` (PR Review Co-pilot)** Senior-level review of a branch or PR.
   Highlights bugs, security gaps, untested paths, and complexity spikes based
   on actual test coverage.
3. **`ph brief` (Onboarding Briefing Generator)** Automatically creates an
   `ONBOARDING.md` containing architecture summaries, ownership maps, entry
   points, and known debt areas.
4. **`ph chat` (Conversational Codebase REPL)** A persistent terminal chat
   session. Your latest scan is injected as context, turning the AI into a
   project-aware pairing partner.
5. **`ph fix` (Self-Healing Codebase Engine)** Automatically remediate findings
   from your last scan. Supports command-based fixes (CVE upgrades, eslint
   `--fix`, `.env` sync, tsconfig incremental) and AI-powered fixes (JSDoc,
   complexity refactoring, dead exports, stale docs). Modes: `--auto`,
   `--interactive`, `--dry-run`, `--ai`.
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

### Zero-Config Setup (Recommended)

**No API keys or configuration needed!** Just install and start using:

```bash
# Install globally
npm install -g project-health

# Navigate to your project
cd your-project-folder

# Initialize and run your first scan
ph init
ph scan
```

That's it! The CLI automatically uses our hosted backend for AI features.

### 1. Initialization

```bash
cd your-project-folder
ph init
```

Generates the `.ph-cache/` context folder, builds your
`project-health.config.ts`, and installs the smart git hooks.

### 2. Running a Scan

```bash
ph scan --format terminal
```

Runs the 8 parallel modules and logs the score to stdout. Use `--format html`
for an interactive report, `--format sarif` for security tool integration, or
`--fail-under 80` in CI/CD pipelines. Use `--project-type library|webapp|cli-tool|microservice|prototype` to apply type-specific weight presets.

### 3. Interactive Repository Explorer

```bash
ph explore
```

Launches a local web UI at `http://localhost:7878` with:

- **File tree** with activity heat map (red = recently changed, green = stable)
- **Commit history** for each file with author avatars
- **Click-to-expand diffs** inline
- **Module health impact** visualization per file
- **Search/filter** files in the sidebar

Use `--port 8080` to customize the port.

### 4. LLM-Ready Repository Context

```bash
ph context
```

Generates a repomix-style XML context file for the current repository. The
output includes repository metadata, directory structure, git context, and
file contents so an LLM can load the codebase in one artifact.

Useful options:

- `--output project-context.xml` to choose the destination file
- `--no-file-contents` to emit metadata-only context
- `--split-output 200000` to split very large outputs into numbered files
- `--sort changes` to order files by git change frequency
- `--header-file CONTEXT.md` to inject extra project instructions into the pack

### 5. AI Features (Zero-Config)

All AI features work out of the box with the hosted backend:

```bash
# Ask questions about your codebase
ph ask "What are the main entry points?"

# Get AI PR review
ph review

# Generate onboarding document
ph brief

# Interactive chat with codebase context
ph chat
```

### 6. Self-Healing Auto-Fix

```bash
# Auto-fix all fixable findings
ph fix --auto

# Interactive selection of findings to fix
ph fix --interactive

# Preview fixes without applying
ph fix --dry-run

# Enable AI-powered fixes for complex issues
ph fix --ai
```

### 7. Additional Commands

```bash
# Fast CI check with 30s timeout (exits 1 if below threshold)
ph ci-check --fail-under 80

# Compare current branch against base
ph diff --base main

# Print latest health score from cache
ph score

# Historical score trend analysis
ph trend

# Web dashboard with live scores and auto-rescan
ph dashboard --port 8080
```

### 8. Self-Hosted Proxy (Optional)

For enterprise users who want to use their own MegaLLM API key:

```bash
# Create .env file with your API key
cp .env.example .env
# Edit .env and set MEGALLM_API_KEY=your-api-key

# Run your own proxy server
npm run start:proxy

# Configure CLI to use your proxy
export PROJECT_HEALTH_BACKEND_URL=http://localhost:3000
ph scan
```

### 9. Debug Logging

```bash
DEBUG=ph:* ph scan          # full trace output from all modules
DEBUG=ph:cli ph scan        # CLI lifecycle only
DEBUG=ph:security ph scan   # dependency security module only
DEBUG=ph:quality ph scan    # code quality module only
DEBUG=ph:flakiness ph scan  # test flakiness module only
DEBUG=ph:cicd ph scan       # CI/CD pipeline module only
DEBUG=ph:env ph scan        # environment integrity module only
DEBUG=ph:buildperf ph scan  # build performance module only
DEBUG=ph:cache ph scan      # cache operations only
```

Run `DEBUG=ph:* ph scan` for full trace output. All error paths in catch blocks
are logged via the `debug` package under `ph:*` namespaces.

---

## 📈 Deep Analysis & Strategy

The `project-health` tool represents a massive shift from fragmented repository
analysis to unified intelligence.

**Strengths & Innovative Angles:**

- **Holistic Insight**: Tools like Codecov, Snyk, or SonarCloud limit themselves
  to coverage, security, or code quality respectively. `ph` acts as the
  aggregate layer evaluating _team process_ (PR complexity, CI efficiency)
  alongside _code metrics_ (security, flakiness).
- **AI Grounding architecture**: Instead of feeding an LLM isolated code chunks,
  `.ph-cache/` serves a distilled representation of _code health combined with
  AST mappings_. This results in drastically reduced hallucinations and higher
  relevancy (e.g., finding the precise `PaymentService.ts:142` loop).
- **Enterprise Security First**: Bypassing direct API key usage on local
  developer machines by implementing a JWT proxy architecture significantly
  de-risks enterprise rollouts compared to other LLM coding tools.
- **Continuous Documentation**: The surgical AI Git Hook (AI-05) fixes one of
  the oldest developer problems: documentation rot. By isolating updates
  strictly to the touched module references via AST extraction, it changes
  documentation from a chore to an automated byproduct of coding.

**Implementation Nuances to Watch:**

- Executing 8 heavily distinct analytical processes (running tools like `execa`,
  memory-heavy TypeScript AST parsing, and network-bound API pulls) concurrently
  within a 60s hard timeout will require aggressive optimization and graceful
  error degradation.
- The MegaLLM abstraction provides invaluable flexibility to negotiate
  hardware/cost constraints but necessitates robust fallback error handling
  within the Proxy layer.

By prioritizing speed, accurate AI grounding, and a seamless developer
experience, `project-health` is positioned to be a foundational piece of any
professional engineering team's stack.
