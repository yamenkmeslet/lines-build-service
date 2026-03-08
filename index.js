const express = require('express');
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;
const BUILD_SECRET = process.env.BUILD_SECRET;

function authMiddleware(req, res, next) {
  if (!BUILD_SECRET) {
    return next();
  }
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== BUILD_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/build', authMiddleware, async (req, res) => {
  console.log('[lines-build-service] POST /build request received');
  const buildDir = path.join(os.tmpdir(), `lines-build-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  try {
    const { files } = req.body;
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing or invalid body: { files: Record<string, string> }' });
    }

    await fs.promises.mkdir(buildDir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue;
      const normalized = filePath.replace(/^\/+/, '').trim();
      if (!normalized) continue;
      const fullPath = path.join(buildDir, normalized);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, content, 'utf-8');
    }

    const reactShimPath = path.join(buildDir, '__react-shim.js');
    const reactDomShimPath = path.join(buildDir, '__react-dom-shim.js');
    await fs.promises.writeFile(reactShimPath, "module.exports = typeof window !== 'undefined' ? window.React : {};", 'utf-8');
    await fs.promises.writeFile(reactDomShimPath, "module.exports = typeof window !== 'undefined' ? window.ReactDOM : {};", 'utf-8');

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
      const firstJs = Object.keys(files).find((p) => /\.(tsx?|jsx?)$/.test(p));
      if (firstJs) {
        const normalized = firstJs.replace(/^\/+/, '').trim();
        entryPath = path.join(buildDir, normalized);
      }
    }
    if (!entryPath) {
      return res.status(400).json({ success: false, error: 'No entry file found (e.g. src/main.tsx, src/App.tsx)' });
    }

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      write: false,
      alias: {
        react: reactShimPath,
        'react-dom': reactDomShimPath,
      },
      loader: {
        '.tsx': 'tsx',
        '.ts': 'ts',
        '.jsx': 'jsx',
        '.js': 'js',
        '.json': 'json',
        '.css': 'css',
      },
      define: {
        'process.env.NODE_ENV': '"production"',
      },
    });

    const out = result.outputFiles[0];
    const bundleJs = out ? out.text : '';

    const REACT_CDN = 'https://unpkg.com/react@18/umd/react.production.min.js';
    const REACT_DOM_CDN = 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js';

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>App</title>
</head>
<body>
  <div id="root"></div>
  <script crossorigin src="${REACT_CDN}"></script>
  <script crossorigin src="${REACT_DOM_CDN}"></script>
  <script>${bundleJs}</script>
</body>
</html>`;

    res.json({ success: true, indexHtml, assets: {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lines-build-service] build error:', err);
    res.status(500).json({ success: false, error: message });
  } finally {
    try {
      await fs.promises.rm(buildDir, { recursive: true, force: true });
    } catch (e) {
      console.error('[lines-build-service] cleanup error:', e);
    }
  }
});

app.listen(PORT, () => {
  console.log(`[lines-build-service] listening on port ${PORT}`);
});
