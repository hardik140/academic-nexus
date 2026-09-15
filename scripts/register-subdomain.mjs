import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function main() {
  const configPath = join(homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml');
  if (!existsSync(configPath)) {
    console.error('No wrangler auth file found at', configPath);
    process.exit(1);
  }
  const toml = readFileSync(configPath, 'utf8');
  const tokenMatch = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!tokenMatch) {
    console.error('No oauth_token found in', configPath);
    process.exit(1);
  }
  const token = tokenMatch[1];
  const accountId = 'a059935851bdbe42c8718a75fea143d9';

  // First check if a subdomain already exists
  const currentRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const currentData = await currentRes.json();
  if (currentData.success && currentData.result?.subdomain) {
    console.log(`✅ Subdomain already registered: ${currentData.result.subdomain}.workers.dev`);
    return currentData.result.subdomain;
  }

  const candidates = ['hardik-nexus', 'academicnexus-erp', 'academic-nexus-prod', 'hardikchokhani'];
  let chosen = null;

  for (const name of candidates) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomains/${name}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    console.log(`Checking "${name}":`, data.success ? 'AVAILABLE' : (data.errors?.[0]?.message || data.errors));
    if (data.success || (data.errors && data.errors[0]?.code === 10032)) {
      chosen = name;
      break;
    }
  }

  if (!chosen) {
    chosen = `academic-nexus-${Math.random().toString(36).slice(2, 6)}`;
  }

  console.log(`\n⏳ Registering subdomain: ${chosen}.workers.dev ...`);
  const putRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ subdomain: chosen })
  });

  const putData = await putRes.json();
  if (putData.success) {
    console.log(`🎉 Successfully registered workers.dev subdomain: https://${chosen}.workers.dev`);
  } else {
    console.error('❌ Failed to register subdomain:', putData.errors);
  }
}

main().catch(console.error);
