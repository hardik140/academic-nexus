import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SECRET_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'QSTASH_URL',
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  // Signs every gate pass QR credential. Without it in the Worker's secret
  // store the scanner fails closed on the first scan of the deployment and
  // every student is turned away at the gate — lib/gate-security/credential.ts
  // has no development fallback, by design.
  'GATE_QR_SIGNING_KEY',
  'NEXT_PUBLIC_APP_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM'
];

function loadEnv() {
  if (!existsSync('.env.local')) {
    console.error('❌ .env.local file not found.');
    process.exit(1);
  }
  const content = readFileSync('.env.local', 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnv();
console.log('🔐 Syncing environment secrets to Cloudflare Worker (academic-nexus)...');

for (const key of SECRET_KEYS) {
  const value = env[key];
  if (!value || value.startsWith('your-') || value.includes('placeholder')) {
    console.log(`⚠️  Skipping ${key} (unset or placeholder)`);
    continue;
  }
  try {
    console.log(`⏳ Uploading secret: ${key}...`);
    execSync(`npx wrangler secret put ${key}`, {
      input: value,
      stdio: ['pipe', 'inherit', 'inherit']
    });
    console.log(`✅ Secret ${key} synced.`);
  } catch (err) {
    console.error(`❌ Failed to set secret ${key}:`, err.message);
  }
}

console.log('✨ All secrets synced successfully.');
