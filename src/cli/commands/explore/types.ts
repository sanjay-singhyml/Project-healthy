// ph explore — type definitions

export type HeatLevel = "h1" | "h2" | "h3" | "h4" | "h5";

export interface FileEntry {
  /** forward-slash relative path from project root */
  path: string;
  type: "file" | "dir";
  name: string;
  children?: FileEntry[];
  lastCommit?: {
    hash: string;
    message: string;
    author: string;
    date: string;
    age: string;
  };
  changeCount: number;
  heat: HeatLevel;
}

export interface CommitInfo {
  hash: string;
  fullHash: string;
  message: string;
  author: string;
  date: string;
  age: string;
  additions: number;
  deletions: number;
}

export interface HotFile {
  path: string;
  changeCount: number;
  heat: HeatLevel;
  lastAge: string;
}

export interface AnalysisSymbol {
  name: string;
  file: string;
  kind: string;
  line: number;
}

export interface ExploreAnalysis {
  descriptor: {
    name: string;
    type: string;
    language: string;
    framework: string;
    fileCount: number;
    dependencyCount: number;
    moduleCount: number;
  };
  overview: string;
  healthScore: number | null;
  generatedAt: string | null;
  hotFiles: HotFile[];
  moduleScores: Array<{
    moduleId: string;
    moduleName: string;
    score: number;
    status: string;
    findingCount: number;
  }>;
  topFindings: Array<{
    severity: string;
    type: string;
    message: string;
    file?: string;
  }>;
  topActions: string[];
  symbolSummary: {
    totalSymbols: number;
    uniqueFiles: number;
    sample: AnalysisSymbol[];
  };
}

export interface ExploreSnapshot {
  files: FileEntry[];
  astIndex: Record<string, { file: string; line: number; kind: string }>;
  analysis: ExploreAnalysis;
  projectRoot: string;
}

export interface GitFileInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  changeCount: number;
}

export interface ExploreOptions {
  port?: number;
}
