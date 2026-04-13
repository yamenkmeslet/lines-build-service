function extractBuildLocation(message) {
  if (!message || typeof message !== 'string') return {};
  const direct =
    message.match(/^\s*([^\s:]+\.(?:tsx?|jsx?)):(\d+):(\d+)/i) ||
    message.match(/\b(src\/[^\s:]+\.(?:tsx?|jsx?)):(\d+):(\d+)/i);
  if (direct) {
    return {
      file: direct[1].replace(/\\/g, '/'),
      line: Number(direct[2]),
      column: Number(direct[3]),
    };
  }

  const fileOnly =
    message.match(/^\s*([^\s:]+\.(?:tsx?|jsx?)):\d+/i) ||
    message.match(/\b(src\/[^\s:]+\.(?:tsx?|jsx?))(?::\d+)?/i);
  return fileOnly ? { file: fileOnly[1].replace(/\\/g, '/') } : {};
}

function extractImportSpecifier(message) {
  if (!message || typeof message !== 'string') return undefined;
  const match =
    message.match(/Could not resolve\s+["']([^"']+)["']/i) ||
    message.match(/No matching export.*?["']([^"']+)["']/i) ||
    message.match(/["'](\.\/[^"']+)["']/i);
  return match ? match[1].trim() : undefined;
}

function isBareImport(specifier) {
  if (!specifier || typeof specifier !== 'string') return false;
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@/'); 
}

function classifyBuildFailureClass(message, importSpecifier) {
  if (/No matching export|Missing export|does not provide an export named|has no exported member|is not exported/i.test(message)) {
    return 'EXPORT_ERROR';
  }
  if (/Could not resolve|Cannot find module|Module not found|Failed to resolve/i.test(message)) {
    return isBareImport(importSpecifier) ? 'MISSING_DEPENDENCY' : 'IMPORT_ERROR';
  }
  if (/Expected|Unexpected|Syntax error|Parse error|Transform failed|Unexpected token/i.test(message)) {
    return 'SYNTAX_ERROR';
  }
  if (/window is not defined|document is not defined|runtime/i.test(message)) {
    return 'RUNTIME_ERROR';
  }
  return 'UNKNOWN';
}

function inferExpectedFix(failureClass) {
  switch (failureClass) {
    case 'IMPORT_ERROR':
      return 'Fix the import path so it points to an existing local module.';
    case 'MISSING_DEPENDENCY':
      return 'Install or declare the missing package dependency, then rebuild.';
    case 'EXPORT_ERROR':
      return 'Fix the export/import contract so the referenced symbol exists.';
    case 'SYNTAX_ERROR':
      return 'Fix the syntax or JSX/TSX structure in the failing file, then rebuild.';
    case 'RUNTIME_ERROR':
      return 'Fix the runtime bootstrap error before retrying verification.';
    default:
      return 'Fix the reported build error and rebuild.';
  }
}

function inferSummary(failureClass) {
  switch (failureClass) {
    case 'IMPORT_ERROR':
      return 'Build failed due to an import resolution error';
    case 'MISSING_DEPENDENCY':
      return 'Build failed due to a missing dependency';
    case 'EXPORT_ERROR':
      return 'Build failed due to an export contract error';
    case 'SYNTAX_ERROR':
      return 'Build failed due to a syntax error';
    case 'RUNTIME_ERROR':
      return 'Runtime verification failed';
    default:
      return 'Build verification failed';
  }
}

function extractBuildDiagnostic(err, fallbackMessage) {
  const message = err instanceof Error ? err.message : String(fallbackMessage || 'Build failed');
  const errors = Array.isArray(err && err.errors) ? err.errors : [];
  const first = errors.length > 0 && errors[0] && typeof errors[0] === 'object' ? errors[0] : null;
  const location = first && first.location && typeof first.location === 'object' ? first.location : null;
  const extractedLocation = extractBuildLocation(message);
  const file =
    location && typeof location.file === 'string' && location.file.trim()
      ? location.file.replace(/\\/g, '/')
      : extractedLocation.file;
  const line =
    location && typeof location.line === 'number'
      ? location.line
      : extractedLocation.line;
  const column =
    location && typeof location.column === 'number'
      ? location.column
      : extractedLocation.column;
  const excerpt =
    location && typeof location.lineText === 'string' && location.lineText.trim()
      ? location.lineText.trim()
      : undefined;
  const importSpecifier = extractImportSpecifier(message);
  const failureClass = classifyBuildFailureClass(message, importSpecifier);
  const code = failureClass === 'UNKNOWN' ? 'UNKNOWN_BUILD_FAILURE' : failureClass;
  const diagnostic = {
    failureClass,
    code,
    primaryCode: code,
    summary: inferSummary(failureClass),
    source: 'build_service',
    message,
    reason: message,
    ...(file ? { file, failedFile: file } : {}),
    ...(importSpecifier ? { importSpecifier, failedImport: importSpecifier } : {}),
    ...(typeof line === 'number' ? { line } : {}),
    ...(typeof column === 'number' ? { column } : {}),
    ...(excerpt ? { excerpt } : {}),
    expectedFix: inferExpectedFix(failureClass),
    ...(file ? { affectedFiles: [file] } : {}),
    rawOutput: message,
    buildOutput: message,
    repairSuggested: true,
  };

  return diagnostic;
}

module.exports = {
  extractBuildDiagnostic,
};
