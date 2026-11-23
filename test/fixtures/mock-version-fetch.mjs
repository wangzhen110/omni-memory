// Test-only fetch shim for scripts/daily-sync.mjs. Loaded with `--import`.
// It keeps the CLI integration test off the network while exercising the real
// identity gate, dirty-tree branch and same-day state file.
const version = process.env.OMNI_TEST_REMOTE_VERSION || '3.11.5';
const manifest = process.env.OMNI_TEST_MANIFEST_JSON || '';
const assetUrl = 'https://api.github.com/repos/wangzhen110/omni-memory/releases/assets/1';

globalThis.fetch = async url => {
  const target = String(url);
  if (target.includes('/releases/tags/')) {
    return new Response(JSON.stringify({
      assets: [{ name: 'omni-update-manifest-v2.json', url: assetUrl }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (target === assetUrl) {
    return new Response(manifest, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  if (target.includes('api.github.com')) {
    const content = Buffer.from(JSON.stringify({ version })).toString('base64');
    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (target.includes('raw.githubusercontent.com')) {
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch in test: ${target}`);
};
