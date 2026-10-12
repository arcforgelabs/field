import { getEvidenceIndex } from "./evidence-index.js";
import { getLedger } from "./ingestion-ledger.js";
import { readCurrentVisibleLedgerFiles } from "./quote-version-context.js";

export async function detectStaleEvidence({ jobDir, readOnly = false }) {
  const [ledger, index] = await Promise.all([
    getLedger({ jobDir, create: !readOnly }),
    getEvidenceIndex({ jobDir, create: !readOnly }),
  ]);
  const { visibleFiles } = await readCurrentVisibleLedgerFiles({
    jobDir,
    ledger,
  });

  const filesById = new Map(visibleFiles.map((file) => [file.fileId, file]));
  const filesByPath = new Map();
  for (const file of visibleFiles) {
    const existing = filesByPath.get(file.filePath) || [];
    existing.push(file);
    filesByPath.set(file.filePath, existing.sort((a, b) => compareIso(a.uploadedAt, b.uploadedAt)));
  }

  const uningestedFiles = visibleFiles.filter((file) => file.ingested !== true);
  const staleArtifacts = [];

  for (const artifact of index.artifacts) {
    const sourceFiles = artifact.sourceFileIds
      .map((fileId) => filesById.get(fileId))
      .filter(Boolean);

    if (!sourceFiles.length) continue;
    const artifactTimestamp = artifact.lastUpdatedAt || artifact.createdAt || null;

    for (const sourceFile of sourceFiles) {
      const newerFiles = (filesByPath.get(sourceFile.filePath) || []).filter((candidate) => {
        if (candidate.fileId === sourceFile.fileId) return false;
        if (!artifactTimestamp) return true;
        return compareIso(candidate.uploadedAt, artifactTimestamp) > 0;
      });

      if (!newerFiles.length) continue;
      staleArtifacts.push({
        artifactId: artifact.artifactId,
        path: artifact.path,
        sourceFileId: sourceFile.fileId,
        sourceFilePath: sourceFile.filePath,
        newerFileIds: newerFiles.map((file) => file.fileId),
        reason: "newer_source_file_registered",
      });
      break;
    }
  }

  return {
    uningestedFiles,
    staleArtifacts,
    needsReorchestration: uningestedFiles.length > 0 || staleArtifacts.length > 0,
  };
}

function compareIso(left, right) {
  return new Date(left || 0).getTime() - new Date(right || 0).getTime();
}
