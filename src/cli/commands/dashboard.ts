import type { Command } from "commander";
import express from "express";
import { watch } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createLogger } from "../../utils/logger.js";
import { createCacheManager } from "../../cache/index.js";
import {
  runAllModules,
  createHealthReport,
  modules,
} from "../../modules/index.js";
import { createConfigManager } from "../../config/index.js";
import { shouldIgnorePath } from "../../utils/ignore.js";
import { getScoreBand } from "../../types/index.js";
import type { HealthReport } from "../../types/index.js";

const log = createLogger("ph:dashboard");

// Global event emitter for SSE
const scanEvents = new EventEmitter();

export class WebDashboard {
  private app = express();
  private scanning = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private lastScanAt: string | null = null;
  private report: HealthReport | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly port: number,
    private readonly proxyUrl: string,
  ) {}

  async start(): Promise<void> {
    // 1. Try loading cached data for immediate display
    const cache = createCacheManager(this.projectRoot);
    const cached = await cache.getLastScan();

    // Check if cached data is complete (has all 8 modules)
    const isCacheComplete =
      cached && cached.modules && cached.modules.length >= 8;

    if (cached && isCacheComplete) {
      this.report = cached;
      this.lastScanAt = new Date(cached.generatedAt).toISOString();
    } else {
      // Trigger a silent initial scan if nothing is cached or incomplete
      this.runScan().catch((err) => log("Initial scan failed", err));
    }

    // Always run a fresh scan on startup to get complete data
    this.runScan().catch((err) => log("Startup scan failed", err));

    this.setupRoutes();
    this.startWatcher();

    const server = this.app.listen(this.port, () => {
      console.log(
        `\n🌊 project-health Web Dashboard running at http://localhost:${this.port}\n`,
      );
      console.log("  Press 'q' + Enter or Ctrl+C to stop the server.\n");
    });

    try {
      const open = await import("open");
      await open.default(`http://localhost:${this.port}`);
    } catch {
      console.log(`Open your browser to: http://localhost:${this.port}`);
    }

    // Listen for 'q' on stdin to shut down
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.resume();
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (key: string) => {
        if (key.trim().toLowerCase() === "q") {
          console.log("\nShutting down dashboard...");
          server.close();
          process.exit(0);
        }
      });
    }

    // Keep process alive for web server
    process.on("SIGINT", () => {
      console.log("\nShutting down dashboard...");
      server.close();
      process.exit(0);
    });
  }

  // ── Routes ─────────────────────────────────────────────────────────────────
  private setupRoutes() {
    // API: Current Data
    this.app.get("/api/data", (req, res) => {
      res.json({
        report: this.report,
        lastScanAt: this.lastScanAt,
        scanning: this.scanning,
      });
    });

    // API: Server-Sent Events (Live Reloads)
    this.app.get("/api/events", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // Tell client we are connected
      res.write("data: connected\n\n");

      const onScanStart = () => res.write("event: scan-start\ndata: {}\n\n");
      const onScanComplete = (data: any) =>
        res.write(`event: scan-complete\ndata: ${JSON.stringify(data)}\n\n`);
      const onScanError = (err: any) =>
        res.write(
          `event: scan-error\ndata: ${JSON.stringify({ error: err.message })}\n\n`,
        );

      scanEvents.on("scan-start", onScanStart);
      scanEvents.on("scan-complete", onScanComplete);
      scanEvents.on("scan-error", onScanError);

      req.on("close", () => {
        scanEvents.off("scan-start", onScanStart);
        scanEvents.off("scan-complete", onScanComplete);
        scanEvents.off("scan-error", onScanError);
        res.end();
      });
    });

    // API: Force Rescan
    this.app.post("/api/scan", (req, res) => {
      if (!this.scanning) {
        this.runScan().catch((err) => log("Manual scan failed", err));
      }
      res.json({ status: "started" });
    });

    // UI payload
    this.app.get("/", (req, res) => {
      res.send(this.getWebUI());
    });
  }

  // ── Scan Logic ─────────────────────────────────────────────────────────────
  private async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    scanEvents.emit("scan-start");

    try {
      const config = await createConfigManager(this.projectRoot).load();
      const results = await runAllModules(config, modules);
      this.report = await createHealthReport(results, config, this.projectRoot);
      this.lastScanAt = new Date().toISOString();

      scanEvents.emit("scan-complete", {
        report: this.report,
        lastScanAt: this.lastScanAt,
      });
    } catch (err) {
      log("Scan error: %O", err);
      scanEvents.emit("scan-error", err);
    } finally {
      this.scanning = false;
    }
  }

  // ── File Watcher ───────────────────────────────────────────────────────────
  private startWatcher(): void {
    try {
      watch(this.projectRoot, { recursive: true }, (_ev, filename) => {
        if (!filename || this.scanning) return;
        if (shouldIgnorePath(filename.toString())) return;

        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          log("File changed %s, triggering scan", filename);
          this.runScan().catch((err) => log("Auto-scan failed", err));
        }, 1500);
      });
    } catch (err) {
      log("Watcher error: %O", err);
    }
  }

  // ── HTML/CSS/JS (Vite style) ────────────────────────────────────────────────
  private getWebUI(): string {
    const projectName = this.projectRoot.split(/[\\/]/).pop() || "project";

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ph dashboard — ${projectName}</title>
  <style>
    /* Modern sleek aesthetics */
    :root {
      --bg: #09090b;
      --card: #111115;
      --border: #27272a;
      --text: #fafafa;
      --muted: #a1a1aa;
      --brand: #3b82f6;
      --excellent: #10b981;
      --good: #3b82f6;
      --moderate: #eab308;
      --high-risk: #f97316;
      --critical: #ef4444;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
    }

    .title-group h1 {
      font-size: 1.5rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .status-badge {
      font-size: 0.875rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: all 0.3s ease;
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--excellent);
    }

    .status-badge.scanning .status-dot {
      background: var(--moderate);
      animation: pulse 1s infinite alternate;
    }

    @keyframes pulse {
      from { opacity: 0.5; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1.2); }
    }

    .btn {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.2s;
    }
    .btn:hover { background: #1f1f22; }

    /* Layout Grid */
    .grid {
      display: grid;
      grid-template-columns: 350px 1fr;
      gap: 2rem;
      align-items: start;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }

    .card-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 1.5rem;
    }

    /* Gauge */
    .gauge-container {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      margin-bottom: 2rem;
    }

    .gauge-svg {
      width: 200px;
      height: 200px;
      transform: rotate(-90deg);
    }

    .gauge-circle-bg {
      fill: none;
      stroke: var(--border);
      stroke-width: 12;
    }

    .gauge-circle {
      fill: none;
      stroke: var(--brand); /* Updated dynamically */
      stroke-width: 12;
      stroke-linecap: round;
      stroke-dasharray: 565.48; /* 2 * pi * r */
      stroke-dashoffset: 565.48;
      transition: stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.5s ease;
    }

    .gauge-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
    }

    .gauge-value {
      font-size: 3.5rem;
      font-weight: 700;
      line-height: 1;
      letter-spacing: -0.05em;
    }

    .gauge-label {
      font-size: 0.875rem;
      color: var(--muted);
      margin-top: 0.25rem;
      font-weight: 500;
    }

    .band-badge {
      display: inline-block;
      padding: 0.25rem 1rem;
      border-radius: 999px;
      font-size: 0.875rem;
      font-weight: 600;
      background: rgba(255,255,255,0.1);
      margin-top: 1rem;
    }

    .stats-row {
      display: flex;
      justify-content: space-around;
      border-top: 1px solid var(--border);
      padding-top: 1.5rem;
    }

    .stat {
      text-align: center;
    }
    
    .stat-val { font-size: 1.5rem; font-weight: 600; }
    .stat-lbl { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }

    /* Module Bars */
    .modules-grid {
      display: grid;
      gap: 1.25rem;
    }

    .module-item {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .mod-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.875rem;
      font-weight: 500;
    }

    .mod-name { color: var(--text); }
    .mod-score { font-variant-numeric: tabular-nums; font-weight: 600; }

    .bar-bg {
      height: 8px;
      background: var(--border);
      border-radius: 999px;
      overflow: hidden;
    }

    .bar-fill {
      height: 100%;
      background: var(--brand); /* Updated dynamically */
      border-radius: 999px;
      width: 0%;
      transition: width 1s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.5s ease;
    }

    /* Findings List */
    .findings-container {
      margin-top: 2rem;
    }

    .findings-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-height: 400px;
      overflow-y: auto;
      padding-right: 1rem;
    }

    /* Custom scrollbar */
    .findings-list::-webkit-scrollbar { width: 6px; }
    .findings-list::-webkit-scrollbar-track { background: var(--bg); border-radius: 3px; }
    .findings-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .finding-item {
      display: flex;
      gap: 1rem;
      padding: 1rem;
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      transition: background 0.2s;
    }

    .finding-item:hover {
      background: rgba(255,255,255,0.05);
    }

    .sev-badge {
      font-size: 0.65rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-weight: 700;
      letter-spacing: 0.05em;
      height: fit-content;
      text-transform: uppercase;
    }
    .sev-CRITICAL { background: rgba(239, 68, 68, 0.2); color: var(--critical); }
    .sev-HIGH     { background: rgba(249, 115, 22, 0.2); color: var(--high-risk); }
    .sev-MEDIUM   { background: rgba(234, 179, 8, 0.2); color: var(--moderate); }
    .sev-LOW      { background: rgba(59, 130, 246, 0.2); color: var(--good); }

    .finding-content { flex: 1; }
    .finding-msg { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; line-height: 1.4; color: #e4e4e7; }
    .finding-meta { font-size: 0.75rem; color: var(--muted); display: flex; gap: 1rem; }
    .finding-file { font-family: monospace; color: #a1a1aa; }

    /* Top Actions */
    .top-actions {
      margin-top: 2rem;
      background: rgba(59, 130, 246, 0.05);
      border: 1px solid rgba(59, 130, 246, 0.2);
    }

    .top-actions .card-title { color: var(--brand); margin-bottom: 1rem; }
    .actions-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .actions-list li {
      position: relative;
      padding-left: 1.5rem;
      font-size: 0.875rem;
      color: #e4e4e7;
    }
    .actions-list li::before {
      content: "→";
      position: absolute;
      left: 0;
      color: var(--brand);
    }

    .empty-state {
      padding: 3rem;
      text-align: center;
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 12px;
    }

    @media (max-width: 1024px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--brand)"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <h1>ph dashboard <span style="color:var(--muted);font-weight:400">/ ${projectName}</span></h1>
      </div>
      <div style="display:flex; gap: 1rem; align-items: center;">
        <button class="btn" onclick="forceScan()">Force Rescan</button>
        <div id="statusBadge" class="status-badge">
          <div class="status-dot"></div>
          <span id="statusText">Live</span>
        </div>
      </div>
    </header>

    <div class="grid" id="mainGrid" style="display: none;">
      <!-- Left Column: Overall Score -->
      <div>
        <div class="card">
          <div class="card-title">Health Score</div>
          
          <div class="gauge-container">
            <svg class="gauge-svg" viewBox="0 0 200 200">
              <circle class="gauge-circle-bg" cx="100" cy="100" r="90"></circle>
              <circle class="gauge-circle" id="scoreCircle" cx="100" cy="100" r="90"></circle>
            </svg>
            <div class="gauge-text">
              <div class="gauge-value" id="scoreValue">--</div>
              <div class="gauge-label">/ 100</div>
              <div class="band-badge" id="bandBadge">...</div>
            </div>
          </div>

          <div class="stats-row">
            <div class="stat">
              <div class="stat-val" id="statFindings">0</div>
              <div class="stat-lbl">Findings</div>
            </div>
            <div class="stat">
              <div class="stat-val" id="statModules">0</div>
              <div class="stat-lbl">Modules</div>
            </div>
          </div>
        </div>

        <div class="card top-actions" id="topActionsCard" style="display: none;">
          <div class="card-title">Priority Actions</div>
          <ul class="actions-list" id="topActionsList"></ul>
        </div>
      </div>

      <!-- Right Column: Modules & Findings -->
      <div>
        <div class="card" style="margin-bottom: 2rem;">
          <div class="card-title">Modules</div>
          <div class="modules-grid" id="modulesGrid">
            <!-- Injected via JS -->
          </div>
        </div>

        <div class="findings-container">
          <h2 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">Top Findings</h2>
          <div class="findings-list" id="findingsList">
            <!-- Injected via JS -->
          </div>
        </div>
      </div>
    </div>
    
    <div id="emptyGrid" class="empty-state">
      <h3>No scan data available.</h3>
      <p style="margin-top: 0.5rem;">Scanning your repository for the first time...</p>
    </div>
  </div>

  <script>
    // Constants mapping
    const MODULE_NAMES = {
      "M-01": "CI/CD Pipeline",
      "M-02": "Code Quality",
      "M-03": "Docs Freshness",
      "M-04": "Test Flakiness",
      "M-05": "Security",
      "M-06": "PR Complexity",
      "M-07": "Environment Integrity",
      "M-08": "Build Perf"
    };

    function getColor(score) {
      if (score >= 90) return "var(--excellent)";
      if (score >= 75) return "var(--good)";
      if (score >= 60) return "var(--moderate)";
      if (score >= 40) return "var(--high-risk)";
      return "var(--critical)";
    }

    function getBand(score) {
      if (score >= 90) return "EXCELLENT";
      if (score >= 75) return "GOOD";
      if (score >= 60) return "MODERATE";
      if (score >= 40) return "HIGH RISK";
      return "CRITICAL";
    }

    const state = { report: null, scanning: false, lastScanAt: null };

    // Update DOM
    function render() {
      if (!state.report) {
        document.getElementById("mainGrid").style.display = "none";
        document.getElementById("emptyGrid").style.display = "block";
        return;
      }
      document.getElementById("mainGrid").style.display = "grid";
      document.getElementById("emptyGrid").style.display = "none";

      const r = state.report;
      
      // Update Score
      document.getElementById("scoreValue").innerText = r.score;
      document.getElementById("statFindings").innerText = r.findings.length;
      document.getElementById("statModules").innerText = r.modules.length;
      
      const badge = document.getElementById("bandBadge");
      badge.innerText = getBand(r.score);
      const color = getColor(r.score);
      badge.style.color = color;
      badge.style.backgroundColor = \`\${color}22\`; // 22 is ~15% opacity hex

      // Animate gauge
      const circle = document.getElementById("scoreCircle");
      const radius = circle.r.baseVal.value;
      const circumference = radius * 2 * Math.PI;
      const offset = circumference - (r.score / 100) * circumference;
      circle.style.strokeDashoffset = offset;
      circle.style.stroke = color;

      // Top actions
      const actionsCard = document.getElementById("topActionsCard");
      const actionsList = document.getElementById("topActionsList");
      if (r.topActions && r.topActions.length > 0) {
        actionsCard.style.display = "block";
        actionsList.innerHTML = r.topActions.map(a => \`<li>\${a}</li>\`).join("");
      } else {
        actionsCard.style.display = "none";
      }

      // Modules
      const modGrid = document.getElementById("modulesGrid");
      // Fixed order 1 to 8
      const order = ["M-01","M-02","M-03","M-04","M-05","M-06","M-07","M-08"];
      modGrid.innerHTML = order.map(id => {
        const m = r.modules.find(x => x.moduleId === id);
        if (!m) return "";
        const mcol = getColor(m.score);
        return \`<div class="module-item">
          <div class="mod-header">
            <span class="mod-name">\${id} · \${MODULE_NAMES[id] || m.moduleName}</span>
            <span class="mod-score" style="color: \${mcol}">\${m.score} / 100</span>
          </div>
          <div class="bar-bg">
            <div class="bar-fill" style="width: \${m.score}%; background: \${mcol}"></div>
          </div>
        </div>\`;
      }).join("");

      // Findings
      const findList = document.getElementById("findingsList");
      if (r.findings.length === 0) {
        findList.innerHTML = \`<div style="text-align:center;color:var(--excellent);padding:2rem;">
          <svg style="width:32px;height:32px;margin:0 auto 1rem;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          Awesome! No strict findings detected.
        </div>\`;
      } else {
        const sorted = [...r.findings].sort((a,b) => {
          const ord = {CRITICAL:0, HIGH:1, MEDIUM:2, LOW:3};
          return (ord[a.severity]||9) - (ord[b.severity]||9);
        });
        
        findList.innerHTML = sorted.map(f => \`<div class="finding-item">
          <div class="sev-badge sev-\${f.severity}">\${f.severity}</div>
          <div class="finding-content">
            <div class="finding-msg">\${f.message}</div>
            <div class="finding-meta">
              <span>\${f.moduleId}</span>
              \${f.file ? \`<span class="finding-file">\${f.file}\${f.line ? ':'+f.line : ''}</span>\` : ''}
            </div>
          </div>
        </div>\`).join("");
      }
    }

    function setStatus(isScanning) {
      const badge = document.getElementById("statusBadge");
      const text = document.getElementById("statusText");
      state.scanning = isScanning;
      
      if (isScanning) {
        badge.className = "status-badge scanning";
        text.innerText = "Scanning...";
      } else {
        badge.className = "status-badge";
        const d = state.lastScanAt ? new Date(state.lastScanAt) : new Date();
        text.innerText = "Live · " + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
      }
    }

    // Connect SSE
    function connect() {
      const initScan = async () => {
        const res = await fetch("/api/data");
        const data = await res.json();
        state.report = data.report;
        state.lastScanAt = data.lastScanAt;
        setStatus(data.scanning);
        render();
      };
      initScan();

      const evtSource = new EventSource("/api/events");
      evtSource.onmessage = function(event) {
        if (event.data === "connected") return;
      };
      
      evtSource.addEventListener("scan-start", function() {
        setStatus(true);
      });
      
      evtSource.addEventListener("scan-complete", function(e) {
        const data = JSON.parse(e.data);
        state.report = data.report;
        state.lastScanAt = data.lastScanAt;
        setStatus(false);
        render();
      });

      evtSource.addEventListener("scan-error", function(e) {
        setStatus(false);
        console.error("Scan error from server", e.data);
      });

      evtSource.onerror = function() {
        console.error("EventSource failed.");
      };
    }

    // Triggers manual scan
    async function forceScan() {
      if (state.scanning) return;
      setStatus(true);
      await fetch("/api/scan", { method: "POST" });
    }

    connect();
  </script>
</body>
</html>`;
  }
}

// ── Commander registration ───────────────────────────────────────────────────
export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .alias("dash")
    .description(
      "Launch the interactive Web Dashboard for project-health (auto-updates on save)",
    )
    .option(
      "-p, --port <number>",
      "Port to run the dashboard web UI on",
      "8080",
    )
    .option(
      "--proxy <url>",
      "Proxy URL",
      process.env.PROJECT_HEALTH_BACKEND_URL ?? "http://localhost:3000",
    )
    .action(async (options) => {
      const port = parseInt(options.port, 10) || 8080;
      const dash = new WebDashboard(process.cwd(), port, options.proxy);
      await dash.start();
    });
}
