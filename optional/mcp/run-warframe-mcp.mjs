import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep the launcher compatible with Node.js 20.0-20.2, where AbortSignal.any
// is missing; newer runtimes take the native path.
function combineSignals(first, second) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener('abort', abort);
    second.addEventListener('abort', abort);
  }
  return controller.signal;
}

// Local launcher for the optional warframe-mcp integration. The upstream
// project must be cloned into integrations/warframe-mcp and built there; this
// launcher only wraps the process so the upstream sources stay untouched.
const entry = fileURLToPath(new URL('../../integrations/warframe-mcp/dist/index.js', import.meta.url));

async function main() {
  if (!fs.existsSync(entry)) {
    throw new Error('warframe-mcp integration is not installed or not built: '
      + `${entry} is missing. Follow the setup steps in optional/mcp/README.md.`);
  }
  // Identify this client to api.warframe.market without changing upstream code.
  const upstreamFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'api.warframe.market') {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('User-Agent', 'warframe-kb-template/0.1 (local MCP integration)');
      const deadline = AbortSignal.timeout(20_000);
      init = { ...init, headers, signal: init.signal ? combineSignals(init.signal, deadline) : deadline };
    }
    return upstreamFetch(input, init);
  };
  await import(pathToFileURL(entry).href);
}

main().catch(error => {
  console.error(`warframe-mcp launcher failed: ${error.message}`);
  process.exitCode = 1;
});
