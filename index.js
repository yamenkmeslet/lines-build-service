const express = require('express');
const esbuild = require('esbuild');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');
const { extractBuildDiagnostic } = require('./build-diagnostics');

const app = express();
app.use(express.json({ limit: '100mb' }));

// Default port 3002 — avoids collision with lines-ai-orchestrator which uses 3001.
const PORT = process.env.PORT || 3002;
// Next.js sends Authorization: Bearer BUILD_SERVICE_SECRET — accept same value here.
// Prefer BUILD_SECRET on the service; BUILD_SERVICE_SECRET is an alias for the shared token.
const BUILD_SECRET = String(process.env.BUILD_SECRET || process.env.BUILD_SERVICE_SECRET || '').trim();

if (process.env.NODE_ENV === 'production' && !BUILD_SECRET) {
  throw new Error('BUILD_SECRET or BUILD_SERVICE_SECRET must be configured in production');
}

function safeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function resolveSafeBuildPath(buildDir, filePath) {
  const normalized = String(filePath || '').replace(/^\/+/, '').trim();
  if (!normalized || normalized.includes('\0')) {
    return null;
  }
  const fullPath = path.resolve(buildDir, normalized);
  const relative = path.relative(buildDir, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return { normalized, fullPath };
}

function authMiddleware(req, res, next) {
  if (!BUILD_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, error: 'Build service secret is not configured', code: 'BUILD_SECRET_MISSING' });
    }
    console.warn('[lines-build-service] BUILD_SECRET is missing; allowing unauthenticated requests in non-production mode');
    return next();
  }
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!safeTokenEqual(token, BUILD_SECRET)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/build', authMiddleware, async (req, res) => {
  console.log('[lines-build-service] POST /build request received');
  const buildDir = path.join(__dirname, 'tmp', `lines-build-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  try {
    const { files } = req.body;
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing or invalid body: { files: Record<string, string> }', code: 'INVALID_REQUEST' });
    }

    await fs.promises.mkdir(buildDir, { recursive: true });
    const writtenRelativePaths = [];

    for (const [filePath, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue;
      const resolved = resolveSafeBuildPath(buildDir, filePath);
      if (!resolved) {
        return res.status(400).json({ success: false, error: `Invalid file path: ${filePath}`, code: 'INVALID_FILE_PATH' });
      }
      const { normalized, fullPath } = resolved;
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, content, 'utf-8');
      writtenRelativePaths.push(normalized);
    }

    const toPosix = (p) => (p || '').split(path.sep).join('/');

    const entryCandidates = [
      'src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js',
      'src/App.tsx', 'src/App.jsx', 'src/App.ts', 'src/App.js',
      'src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js',
    ];
    let entryPath = null;
    for (const name of entryCandidates) {
      const full = path.join(buildDir, name);
      try {
        await fs.promises.access(full);
        entryPath = full;
        break;
      } catch {
        // continue
      }
    }
    if (!entryPath) {
      const firstJs = writtenRelativePaths.find((p) => /\.(tsx?|jsx?)$/i.test(p));
      if (firstJs) {
        const resolved = resolveSafeBuildPath(buildDir, firstJs);
        if (resolved) entryPath = resolved.fullPath;
      }
    }
    if (!entryPath) {
      return res.status(400).json({ success: false, error: 'No entry file found (e.g. src/main.tsx, src/App.tsx)', code: 'NO_ENTRY' });
    }

    const collectedCss = [];
    const cssExtractPlugin = {
      name: 'css-extract',
      setup(build) {
        build.onResolve({ filter: /\.css$/ }, (args) => {
          const resolved = path.resolve(path.dirname(args.importer), args.path);
          return { path: toPosix(resolved), namespace: 'css-extract' };
        });
        build.onLoad({ filter: /.*/, namespace: 'css-extract' }, async (args) => {
          const filePath = args.path.split('/').join(path.sep);
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            collectedCss.push(content);
          } catch (e) {
            console.warn('[lines-build-service] css read failed:', filePath, e.message);
          }
          return { contents: 'module.exports = undefined;', loader: 'js' };
        });
      },
    };

    const reactIconsSubpackages = [
      'fa', 'fa6', 'md', 'io', 'io5', 'ai', 'bs', 'bi', 'fi', 'gi',
      'hi', 'hi2', 'im', 'lu', 'pi', 'ri', 'rx', 'si', 'sl', 'tb',
      'ti', 'vsc', 'wi', 'cg', 'ci', 'fc', 'go', 'gr', 'tfi', 'lia',
    ];
    const iconAliases = {};
    reactIconsSubpackages.forEach((pkg) => {
      try {
        iconAliases[`react-icons/${pkg}`] = require.resolve(`react-icons/${pkg}`);
      } catch (e) {
        // subpackage not present in this react-icons version; skip
      }
    });

    const safeResolve = (pkg) => {
      try { return require.resolve(pkg); } catch { return undefined; }
    };
    const jsxRuntime = safeResolve('react/jsx-runtime');
    const jsxDevRuntime = safeResolve('react/jsx-dev-runtime');
    const baseAliases = {
      ...(jsxRuntime ? { 'react/jsx-runtime': jsxRuntime } : {}),
      ...(jsxDevRuntime ? { 'react/jsx-dev-runtime': jsxDevRuntime } : {}),
      ...iconAliases,
    };

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      write: false,
      alias: baseAliases,
      jsx: 'automatic',
      plugins: [cssExtractPlugin],
      loader: {
        '.tsx': 'tsx',
        '.ts': 'ts',
        '.jsx': 'jsx',
        '.js': 'js',
        '.json': 'json',
      },
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      nodePaths: [path.join(__dirname, 'node_modules')],
    });

    const out = result.outputFiles[0];
    const bundleJs = out ? out.text : '';

    const rawCss = [
      '@tailwind base;',
      '@tailwind components;',
      '@tailwind utilities;',
      ...collectedCss
    ].join('\n');

    let bundledCss = '';
    try {
      const tailwindConfig = {
        content: [path.join(buildDir, '**/*.{js,jsx,ts,tsx,html}')],
        theme: { extend: {} },
        plugins: [],
      };
      
      const postcssResult = await postcss([
        tailwindcss(tailwindConfig),
        autoprefixer
      ]).process(rawCss, { from: undefined });
      
      bundledCss = postcssResult.css;
    } catch (postcssErr) {
      console.warn('[lines-build-service] postcss error:', postcssErr);
      bundledCss = rawCss; // Fallback
    }

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>App</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">${bundledCss ? `\n  <style>${bundledCss.replace(/<\/style>/gi, '\\3c/style>')}</style>` : ''}
</head>
<body>
  <div id="root"></div>
  <script>${bundleJs}</script>
</body>
</html>`;

    const assets = {};
    if (bundledCss) assets['main.css'] = bundledCss;

    res.json({ success: true, indexHtml, assets });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lines-build-service] build error:', err);
    const diagnostic = extractBuildDiagnostic(err, message);
    const code = diagnostic.code || 'UNKNOWN_BUILD_FAILURE';
    res.status(500).json({
      success: false,
      error: message,
      code,
      failureClass: diagnostic.failureClass,
      ...(diagnostic.failedFile ? { failedFile: diagnostic.failedFile } : {}),
      ...(diagnostic.failedImport ? { failedImport: diagnostic.failedImport } : {}),
      ...(diagnostic.file ? { file: diagnostic.file } : {}),
      ...(typeof diagnostic.line === 'number' ? { line: diagnostic.line } : {}),
      ...(typeof diagnostic.column === 'number' ? { column: diagnostic.column } : {}),
      diagnostic,
      diagnosticBundle: diagnostic,
    });
  } finally {
    try {
      await fs.promises.rm(buildDir, { recursive: true, force: true });
    } catch (e) {
      console.error('[lines-build-service] cleanup error:', e);
    }
  }
});

app.listen(PORT, () => {
  console.log(`[lines-build-service] listening on port ${PORT}`, {
    authEnabled: Boolean(BUILD_SECRET),
    healthPath: '/health',
    buildPath: 'POST /build',
  });
});
