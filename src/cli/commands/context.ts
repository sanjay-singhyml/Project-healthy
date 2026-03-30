import { resolve } from "node:path";
import { printInfo, printSuccess, printWarning } from "../../utils/output.js";
import {
  buildContextDocument,
  writeContextFile,
  type ContextGenerationOptions,
} from "../../context/index.js";

interface RunContextCliOptions {
  output?: string;
  stdout?: boolean;
  fileContents?: boolean;
  diffs?: boolean;
  log?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
  splitOutput?: number;
  sort?: "path" | "changes";
  header?: string;
  headerFile?: string;
  gitLogLimit?: number;
  diffLimit?: number;
}

export async function runContextCommand(
  projectRoot: string,
  options: RunContextCliOptions,
): Promise<void> {
  const targetOutputPath = resolve(
    projectRoot,
    options.output || `project-context-${projectRoot.split(/[\\/]/).pop()}.xml`,
  );
  const contextOptions: ContextGenerationOptions = {
    outputPath: options.output,
    includeFileContents: options.fileContents,
    includeDiffs: options.diffs,
    includeGitLog: options.log,
    maxFileSizeBytes:
      typeof options.maxFileSize === "number"
        ? options.maxFileSize * 1024
        : undefined,
    maxFiles: options.maxFiles,
    splitOutputChars: options.stdout ? undefined : options.splitOutput,
    sortBy: options.sort,
    headerText: options.header,
    headerFile: options.headerFile,
    gitLogLimit: options.gitLogLimit,
    diffCharLimit: options.diffLimit,
  };

  if (options.stdout && options.splitOutput) {
    printWarning("--split-output is ignored when --stdout is enabled");
  }

  if (options.stdout) {
    const document = await buildContextDocument(projectRoot, contextOptions);
    process.stdout.write(document);
    if (!document.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return;
  }

  printInfo("Packing repository context...");
  const result = await writeContextFile(projectRoot, contextOptions);

  if (result.outputFiles.length === 1) {
    printSuccess(`Context file written to ${result.outputFiles[0]}`);
  } else {
    printSuccess(
      `Context split into ${result.outputFiles.length} files rooted at ${targetOutputPath}`,
    );
  }

  printInfo(
    `Packed ${result.packedFiles}/${result.totalFiles} files (${result.estimatedTokens} est. tokens)`,
  );
}
