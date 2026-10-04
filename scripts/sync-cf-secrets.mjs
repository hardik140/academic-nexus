import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Pushes secrets to the production Worker (academic-nexus).
 *
 *   npm run cf:secrets              upload
 *   npm run cf:secrets -- --dry-run list what would be uploaded (names only)
 *
 * Values are never printed.
 *
 * REDIS CREDENTIAL ISOLATION
 *
 * This script used to copy UPSTASH_REDIS_REST_URL/TOKEN from .env.local, so
 * the production Worker and every developer machine shared ONE Upstash
 * database and one token: anyone with a working checkout could read, forge
 * or delete production cache entries and rate-limit counters (Redis audit,
 * finding E2).
 *
 * Now the Upstash credentials are PRODUCTION-ONLY keys: they are read from
 * .env.production.local (git-ignored, held only by whoever deploys), never
 * from .env.local. And the sync refuses outright when that file points at
 * the same Upstash host as .env.local — that would be the shared database
 * again under a new file name. Every other key is synced as before.
 */

const SECRET_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
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
  'SMTP_FROM',
  // AES-256-GCM key for finance integration credentials (lib/finance/crypto.ts)
  'FINANCE_CREDENTIAL_KEY',
  'NEXT_PUBLIC_APP_NAME'
];

/** Read only from .env.production.local; never from .env.local. */
export const PRODUCTION_ONLY_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

export function parseEnv(content) {
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

const usable = (value) => !!value && !value.startsWith('your-') && !value.includes('placeholder');

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * What to upload, decided without side effects (tests/sync-cf-secrets.test.ts).
 * Returns names only.
 */
export function planSecretSync(devEnv, prodEnv) {
  const upload = [];
  const skipped = [];
  const refused = [];

  for (const key of SECRET_KEYS) {
    if (usable(devEnv[key])) upload.push({ key, from: '.env.local' });
    else skipped.push({ key, reason: 'unset or placeholder in .env.local' });
  }

  const prodUrl = prodEnv?.UPSTASH_REDIS_REST_URL;
  const prodToken = prodEnv?.UPSTASH_REDIS_REST_TOKEN;
  if (!prodEnv) {
    for (const key of PRODUCTION_ONLY_KEYS) {
      skipped.push({ key, reason: 'no .env.production.local — the Worker keeps its current value' });
    }
  } else if (!usable(prodUrl) || !usable(prodToken)) {
    for (const key of PRODUCTION_ONLY_KEYS) {
      skipped.push({ key, reason: 'URL and token must both be set in .env.production.local — the Worker keeps its current value' });
    }
  } else {
    const prodHost = hostOf(prodUrl);
    const devHost = hostOf(devEnv.UPSTASH_REDIS_REST_URL ?? '');
    if (!prodHost) {
      refused.push({ key: 'UPSTASH_REDIS_REST_URL', reason: 'is not a URL in .env.production.local' });
    } else if (devHost && devHost === prodHost) {
      refused.push({
        key: 'UPSTASH_REDIS_REST_URL',
        reason: '.env.production.local and .env.local name the SAME Upstash database; production must have its own',
      });
    } else if (devEnv.UPSTASH_REDIS_REST_TOKEN && devEnv.UPSTASH_REDIS_REST_TOKEN === prodToken) {
      refused.push({ key: 'UPSTASH_REDIS_REST_TOKEN', reason: 'is identical in .env.production.local and .env.local' });
    } else {
      for (const key of PRODUCTION_ONLY_KEYS) upload.push({ key, from: '.env.production.local' });
    }
  }
  return { upload, skipped, refused };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync('.env.local')) {
    console.error('❌ .env.local file not found.');
    process.exit(1);
  }
  const devEnv = parseEnv(readFileSync('.env.local', 'utf8'));
  const prodEnv = existsSync('.env.production.local') ? parseEnv(readFileSync('.env.production.local', 'utf8')) : null;
  const plan = planSecretSync(devEnv, prodEnv);

  if (plan.refused.length) {
    for (const r of plan.refused) console.error(`❌ ${r.key} ${r.reason}.`);
    console.error('Nothing was uploaded.');
    process.exit(1);
  }
  for (const s of plan.skipped) console.log(`⚠️  Skipping ${s.key} (${s.reason})`);
  if (dryRun) {
    for (const u of plan.upload) console.log(`would upload ${u.key} (from ${u.from})`);
    return;
  }

  console.log('🔐 Syncing environment secrets to Cloudflare Worker (academic-nexus)...');
  const sources = { '.env.local': devEnv, '.env.production.local': prodEnv };
  for (const { key, from } of plan.upload) {
    try {
      console.log(`⏳ Uploading secret: ${key}...`);
      execSync(`npx wrangler secret put ${key}`, {
        input: sources[from][key],
        stdio: ['pipe', 'inherit', 'inherit']
      });
      console.log(`✅ Secret ${key} synced.`);
    } catch (err) {
      console.error(`❌ Failed to set secret ${key}:`, err.message);
    }
  }
  console.log('✨ All secrets synced successfully.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
