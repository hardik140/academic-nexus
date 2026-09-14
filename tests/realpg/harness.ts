import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A DISPOSABLE local PostgreSQL for the tests PGlite cannot run: real
 * concurrent sessions, real row locks, real transaction interleaving.
 *
 * Uses the PostgreSQL binaries already installed on this machine (initdb,
 * pg_ctl, psql), a data directory under the OS temp folder, trust auth on
 * 127.0.0.1 and a high port. It never touches any configured Supabase
 * project: there is no URL, no key, and no network beyond loopback. When the
 * binaries are absent the suite reports itself BLOCKED rather than passing.
 *
 * Each test gets its own database cloned from a template that carries the
 * platform layer, the full migration chain 001..050 and the QA dataset —
 * the same three inputs the PGlite harness uses — so results are directly
 * comparable across the two engines.
 *
 * A "session" is one psql process; concurrency is two processes started
 * together. Ordering inside a race is made deterministic with pg_sleep on
 * the side that must arrive second.
 */

const CANDIDATE_BINS = [
  process.env.PG_BIN,
  "C:/Program Files/PostgreSQL/18/bin",
  "C:/Program Files/PostgreSQL/17/bin",
  "C:/Program Files/PostgreSQL/16/bin",
  "/usr/lib/postgresql/18/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/local/bin",
].filter((p): p is string => !!p);

export function pgBinDir(): string | null {
  for (const dir of CANDIDATE_BINS) {
    const exe = process.platform === "win32" ? ".exe" : "";
    if (existsSync(join(dir, `psql${exe}`)) && existsSync(join(dir, `initdb${exe}`)) && existsSync(join(dir, `pg_ctl${exe}`))) return dir;
  }
  return null;
}

export const REAL_PG_AVAILABLE = pgBinDir() !== null;

const exe = (name: string) => join(pgBinDir()!, process.platform === "win32" ? `${name}.exe` : name);
const ROOT = process.cwd();

export interface Cluster {
  port: number;
  dataDir: string;
  stop(): void;
  /** Creates a fresh database from the template; returns its name. */
  fork(): string;
  drop(dbName: string): void;
}

export interface SessionResult {
  code: number;
  stdout: string;
  stderr: string;
}

let counter = 0;

/**
 * A port nothing else is listening on.
 *
 * The first version of this picked at random from a 100-wide band, which
 * collided the moment two real-PostgreSQL test FILES ran in parallel — one
 * cluster would start and the other would fail or, worse, the second suite
 * would talk to the first suite's server. Asking the OS for an ephemeral
 * port and releasing it immediately is not race-free either, so the caller
 * retries; between the two, a collision needs two suites to be handed the
 * same port in the same instant AND for the retry to repeat it.
 */
function freePort(): number {
  const probe = spawnSync(
    process.execPath,
    ["-e", "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"],
    { encoding: "utf8" }
  );
  const port = Number(probe.stdout?.trim());
  if (!Number.isInteger(port) || port <= 1024) {
    // Fall back to a pid-derived port rather than a random one: two workers
    // on one machine never share a pid.
    return 54000 + (process.pid % 1000);
  }
  return port;
}

export function startCluster(attempt = 0): Cluster {
  const dataDir = mkdtempSync(join(tmpdir(), "nexus-realpg-"));
  const port = freePort();
  const initdb = spawnSync(exe("initdb"), ["-D", dataDir, "-U", "qa", "-A", "trust", "-E", "UTF8", "--no-locale"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (initdb.status !== 0) throw new Error(`initdb failed: ${initdb.stderr}`);
  // stdio MUST be 'ignore', not 'pipe': pg_ctl start launches the server as a
  // detached grandchild that inherits our stdio handles, and a piped stdout
  // stays open for the server's whole life — so spawnSync would wait forever
  // for an EOF that only comes at shutdown. The server's own output already
  // goes to the -l log file. (This is why it worked from an interactive shell
  // and hung under Node.)
  const logFile = join(dataDir, "server.log");
  const start = spawnSync(exe("pg_ctl"), ["-D", dataDir, "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c log_min_messages=warning`, "-l", logFile, "-w", "start"], { stdio: "ignore" });
  if (start.status !== 0) {
    let log = "";
    try { log = readFileSync(logFile, "utf8"); } catch { /* no log yet */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    // Almost always "address already in use" — another suite took the port
    // between our probe and the server binding it. Try again with a new one.
    if (attempt < 5) return startCluster(attempt + 1);
    throw new Error(`pg_ctl start failed after ${attempt + 1} attempts (status ${start.status})\n${log}`);
  }

  const cluster: Cluster = {
    port,
    dataDir,
    stop() {
      spawnSync(exe("pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
    },
    fork() {
      const name = `qa_${process.pid}_${++counter}`;
      owner(cluster, "postgres", `CREATE DATABASE ${name} TEMPLATE qa_template`);
      return name;
    },
    drop(dbName) {
      owner(cluster, "postgres", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    },
  };

  // Build the template once: platform, chain, dataset.
  owner(cluster, "postgres", "CREATE DATABASE qa_template");
  applyFile(cluster, "qa_template", join(ROOT, "tests/staging/platform.sql"));
  for (const f of readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    applyFile(cluster, "qa_template", join(ROOT, "supabase/migrations", f));
  }
  applyFile(cluster, "qa_template", join(ROOT, "tests/staging/qa-dataset.sql"));
  owner(cluster, "postgres", "UPDATE pg_database SET datistemplate = true WHERE datname = 'qa_template'");
  return cluster;
}

function baseArgs(cluster: Cluster, db: string): string[] {
  return ["-h", "127.0.0.1", "-p", String(cluster.port), "-U", "qa", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-X"];
}

function applyFile(cluster: Cluster, db: string, file: string) {
  const r = spawnSync(exe("psql"), [...baseArgs(cluster, db), "-f", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`applying ${file} failed:\n${r.stderr}`);
}

/** Runs SQL as the database owner (bypasses RLS) — for setup and verification only. */
export function owner(cluster: Cluster, db: string, sql: string): string {
  const r = spawnSync(exe("psql"), [...baseArgs(cluster, db), "-tA", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`owner sql failed: ${r.stderr}\n${sql}`);
  return r.stdout.trim();
}

/**
 * One session = one psql process running `script` from stdin. With `uid`
 * the script is prefixed the way a PostgREST request arrives: the JWT claim,
 * then the limited role. Returns exit code and both streams; a refused
 * statement shows up as code 3 (ON_ERROR_STOP) with the error on stderr.
 */
export function session(cluster: Cluster, db: string, script: string, uid?: string): Promise<SessionResult> {
  const prefix = uid ? `SET request.jwt.claim.sub = '${uid}';\nSET ROLE authenticated;\n` : "";
  return new Promise((resolve) => {
    const child = spawn(exe("psql"), [...baseArgs(cluster, db), "-tA"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.write(prefix + script + "\n");
    child.stdin.end();
  });
}

/** Starts every session at once and waits for all of them. */
export function concurrently(...runs: Array<Promise<SessionResult>>): Promise<SessionResult[]> {
  return Promise.all(runs);
}
