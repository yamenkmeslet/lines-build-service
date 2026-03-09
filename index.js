const express = require('express');
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '100mb' }));

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
  const buildDir = path.join(__dirname, 'tmp', `lines-build-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  try {
    const { files } = req.body;
    if (!files || typeof files !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing or invalid body: { files: Record<string, string> }', code: 'INVALID_REQUEST' });
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

    const toPosix = (p) => (p || '').split(path.sep).join('/');
    const reactShimPath = path.resolve(buildDir, '__react-shim.js');
    const reactDomShimPath = path.resolve(buildDir, '__react-dom-shim.js');
    const reactDomClientShimPath = path.resolve(buildDir, '__react-dom-client-shim.js');
    console.log('reactShimPath:', reactShimPath);
    await fs.promises.writeFile(path.join(buildDir, '__react-shim.js'), "module.exports = typeof window !== 'undefined' ? window.React : {};", 'utf-8');
    await fs.promises.writeFile(path.join(buildDir, '__react-dom-shim.js'), "module.exports = typeof window !== 'undefined' ? window.ReactDOM : {};", 'utf-8');
    await fs.promises.writeFile(
      path.join(buildDir, '__react-dom-client-shim.js'),
      "var ReactDOM = typeof window !== 'undefined' ? window.ReactDOM : {};\nmodule.exports = { createRoot: ReactDOM.createRoot || function() { throw new Error('createRoot requires ReactDOM'); }, hydrateRoot: ReactDOM.hydrateRoot || function() { throw new Error('hydrateRoot requires ReactDOM'); } };",
      'utf-8'
    );

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

    const reactDomClientFirstPlugin = {
      name: 'react-dom-client-first',
      setup(build) {
        build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
          path: reactDomClientShimPath,
        }));
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

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      write: false,
      alias: {
        'react-dom/client': reactDomClientShimPath,
        'react': reactShimPath,
        'react-dom': reactDomShimPath,
        'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
        'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
        ...iconAliases,
      },
      plugins: [
        reactDomClientFirstPlugin,
        cssExtractPlugin,
      ],
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
    const bundledCss = collectedCss.join('\n');

    const REACT_CDN = 'https://unpkg.com/react@18/umd/react.production.min.js';
    const REACT_DOM_CDN = 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js';

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>App</title>${bundledCss ? `\n  <style>${bundledCss.replace(/<\/style>/gi, '\\3c/style>')}</style>` : ''}
</head>
<body>
  <div id="root"></div>
  <script crossorigin src="${REACT_CDN}"></script>
  <script crossorigin src="${REACT_DOM_CDN}"></script>
  <script src="https://unpkg.com/framer-motion@11/dist/framer-motion.js"></script>
  <script>${bundleJs}</script>
</body>
</html>`;

    const assets = {};
    if (bundledCss) assets['main.css'] = bundledCss;

    res.json({ success: true, indexHtml, assets });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[lines-build-service] build error:', err);
    const code = message.includes('Could not resolve') || message.includes('resolve') ? 'RESOLVE_FAILED' : message.includes('Build') || message.includes('build') ? 'BUILD_FAILED' : 'BUILD_FAILED';
    res.status(500).json({ success: false, error: message, code });
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
