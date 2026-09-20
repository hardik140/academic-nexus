const fs = require('fs');
const path = require('path');

/**
 * Next.js NFT (Node File Trace) only traces the CommonJS entrypoint (build/src/index.js)
 * for middleware/proxy functions because next/dist/server/lib/trace/tracer.js requires it
 * using require('@opentelemetry/api').
 *
 * OpenNext bundles Node.js middleware with esbuild using { conditions: ['module'], mainFields: ['module', 'main'] }.
 * In the upstream @opentelemetry/api package.json, "module" points to "./build/esm/index.js",
 * which was not traced by Next.js and therefore does not exist in .open-next/middleware/node_modules/@opentelemetry/api.
 *
 * This patch aligns the "module" field to the traced "build/src/index.js" so esbuild can resolve it.
 */
function patchOpenTelemetry() {
  const pkgPath = path.join(__dirname, '..', 'node_modules', '@opentelemetry', 'api', 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    let changed = false;

    if (pkg.module !== 'build/src/index.js') {
      pkg.module = 'build/src/index.js';
      changed = true;
    }

    if (pkg.exports && pkg.exports['.']) {
      if (pkg.exports['.'].module !== './build/src/index.js') {
        pkg.exports['.'].module = './build/src/index.js';
        changed = true;
      }
      if (pkg.exports['.'].esnext !== './build/src/index.js') {
        pkg.exports['.'].esnext = './build/src/index.js';
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log('[patch-opentelemetry] Aligned @opentelemetry/api package.json module field to build/src/index.js');
    }
  } catch (err) {
    console.warn('[patch-opentelemetry] Warning: Failed to patch @opentelemetry/api:', err.message);
  }
}

patchOpenTelemetry();
