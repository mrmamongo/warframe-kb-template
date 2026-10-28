import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Offline-friendly smoke check for the optional warframe-mcp integration.
// It makes no assumptions about the upstream tool count or percentages: any
// installed version is accepted as long as the handshake and a lookup work.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const integrationDirectory = path.join(root, 'integrations', 'warframe-mcp');
const launcher = path.join(here, 'run-warframe-mcp.mjs');

function fail(message) {
  console.error(`warframe-mcp smoke check failed: ${message}`);
  console.error('Setup steps are described in optional/mcp/README.md.');
  process.exit(1);
}

if (!fs.existsSync(path.join(integrationDirectory, 'dist', 'index.js'))) {
  fail(`the integration is not built: ${path.join(integrationDirectory, 'dist', 'index.js')} is missing`);
}
const packageJson = path.join(integrationDirectory, 'package.json');
if (!fs.existsSync(packageJson)) fail(`the integration package.json is missing: ${packageJson}`);

const require = createRequire(packageJson);
let Client;
let StdioClientTransport;
try {
  ({ Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href));
  ({ StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href));
} catch (error) {
  fail(`the MCP client SDK is not installed (${error.message}); run npm ci in integrations/warframe-mcp`);
}

const report = {
  checked_at: new Date().toISOString(),
  integration: 'mpeciakk/warframe-mcp',
  transport: 'stdio',
  tools: [],
  checks: [],
  ok: false,
};
const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], stderr: 'pipe' });
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
const client = new Client({ name: 'warframe-kb-template-smoke', version: '0.1.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  report.tools = tools.map(tool => tool.name);
  report.checks.push({ name: 'list_tools', ok: tools.length > 0, tool_count: tools.length });
  console.log(JSON.stringify({ handshake: true, tool_count: tools.length, tools: report.tools }));
  const lookup = tools.find(tool => tool.name === 'lookup_warframe');
  if (!lookup) {
    report.checks.push({ name: 'lookup_warframe', ok: null, skipped: 'the installed upstream version does not expose this tool' });
  } else {
    try {
      const result = await client.callTool({ name: 'lookup_warframe', arguments: { names: ['Excalibur'] } },
        undefined, { timeout: 30_000 });
      const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const ok = !result.isError && text.trim().length > 0 && !/Error (looking|checking)|fetch failed|HTTP \d{3}|No warframe found/i.test(text);
      report.checks.push({ name: 'lookup_warframe', arguments: { names: ['Excalibur'] }, ok, output_preview: text.slice(0, 1600) });
      console.log(JSON.stringify({ name: 'lookup_warframe', ok, output_preview: text.slice(0, 1600) }));
    } catch (error) {
      report.checks.push({ name: 'lookup_warframe', ok: false, error: error.message });
      console.log(JSON.stringify({ name: 'lookup_warframe', ok: false, error: error.message }));
    }
  }
} catch (error) {
  report.checks.push({ name: 'handshake', ok: false, error: error.message });
  console.error(JSON.stringify({ handshake: false, error: error.message }));
} finally {
  try {
    await client.close();
  } catch {
    // The transport may already be closed after a failed handshake.
  }
  report.ok = report.checks.length > 0 && report.checks.every(check => check.ok !== false);
  const directory = path.join(root, 'data', 'imports');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(directory, `${stamp}-warframe-mcp-smoke.json`);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: report.ok, report_file: reportFile, tool_count: report.tools.length }));
}
if (!report.ok) process.exitCode = 1;
