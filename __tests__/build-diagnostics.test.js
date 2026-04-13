const { extractBuildDiagnostic } = require('../build-diagnostics');

describe('lines-build-service structured diagnostics', () => {
  it('classifies relative unresolved imports as IMPORT_ERROR', () => {
    const diagnostic = extractBuildDiagnostic(
      new Error('src/App.tsx:3:21: Could not resolve "./components/Hero"'),
      'fallback'
    );

    expect(diagnostic.failureClass).toBe('IMPORT_ERROR');
    expect(diagnostic.file).toBe('src/App.tsx');
    expect(diagnostic.importSpecifier).toBe('./components/Hero');
  });

  it('classifies bare unresolved imports as MISSING_DEPENDENCY', () => {
    const diagnostic = extractBuildDiagnostic(
      new Error('src/App.tsx:3:21: Could not resolve "framer-motion"'),
      'fallback'
    );

    expect(diagnostic.failureClass).toBe('MISSING_DEPENDENCY');
    expect(diagnostic.code).toBe('MISSING_DEPENDENCY');
  });

  it('classifies export mismatches as EXPORT_ERROR', () => {
    const diagnostic = extractBuildDiagnostic(
      new Error('src/App.tsx:3:8: No matching export in "src/Card.tsx" for import "Card"'),
      'fallback'
    );

    expect(diagnostic.failureClass).toBe('EXPORT_ERROR');
    expect(diagnostic.importSpecifier).toBe('src/Card.tsx');
  });

  it('classifies syntax errors as SYNTAX_ERROR', () => {
    const diagnostic = extractBuildDiagnostic(
      new Error('src/App.tsx:10:2: ERROR: Expected ")" but found "export"'),
      'fallback'
    );

    expect(diagnostic.failureClass).toBe('SYNTAX_ERROR');
    expect(diagnostic.line).toBe(10);
    expect(diagnostic.column).toBe(2);
  });
});
