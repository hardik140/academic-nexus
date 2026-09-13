import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { decryptCredential, encryptCredential, type SealedCredential } from "./crypto";
import type { ProviderCredential } from "./providers/types";

/**
 * Credential storage — the only module that touches
 * finance_integration_credentials.
 *
 * That table is absent from the `Database` type on purpose (see the note in
 * types/database.ts), because no client built from that type may read it:
 * migration 049 enables RLS on it with no policy, so `authenticated` — admin
 * included — sees nothing. The reads and writes here therefore go through a
 * deliberately narrow, locally-typed view of the table and MUST be given a
 * service-role client.
 *
 * Nothing in this file returns ciphertext to a caller, and nothing returns a
 * decrypted credential anywhere except into a ProviderContext inside the
 * worker process. There is no code path from here to a React component.
 */

type ServiceClient = SupabaseClient<Database>;

interface CredentialRow {
  connection_id: string;
  college_id: string;
  algorithm: "aes-256-gcm";
  key_version: number;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  token_expires_at: string | null;
  scopes: string[] | null;
}

/** Narrow escape hatch: this one table is intentionally outside Database. */
function table(db: ServiceClient) {
  return (db as unknown as {
    from(name: "finance_integration_credentials"): {
      select(cols: string): {
        eq(col: string, val: string): { maybeSingle(): Promise<{ data: CredentialRow | null; error: { message: string } | null }> };
      };
      upsert(row: Record<string, unknown>, opts?: { onConflict: string }): Promise<{ error: { message: string } | null }>;
      delete(): { eq(col: string, val: string): Promise<{ error: { message: string } | null }> };
    };
  }).from("finance_integration_credentials");
}

export async function storeCredential(
  db: ServiceClient,
  connectionId: string,
  collegeId: string,
  credential: ProviderCredential,
  meta: { tokenExpiresAt?: string | null; scopes?: string[] | null } = {}
): Promise<void> {
  // Throws CredentialStorageUnavailableError when FINANCE_CREDENTIAL_KEY is
  // unset — the caller turns that into "credential storage is not
  // configured" and refuses to create the connection. There is no weaker
  // fallback by design.
  const sealed = encryptCredential(credential);
  const { error } = await table(db).upsert(
    {
      connection_id: connectionId,
      college_id: collegeId,
      algorithm: sealed.algorithm,
      key_version: sealed.keyVersion,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      auth_tag: sealed.authTag,
      token_expires_at: meta.tokenExpiresAt ?? null,
      scopes: meta.scopes ?? null,
      rotated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id" }
  );
  if (error) throw new Error(`Could not store the credential: ${error.message}`);
}

export async function loadCredential(db: ServiceClient, connectionId: string): Promise<ProviderCredential> {
  const { data, error } = await table(db)
    .select("connection_id, college_id, algorithm, key_version, ciphertext, iv, auth_tag, token_expires_at, scopes")
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the credential: ${error.message}`);
  if (!data) return { kind: "none" };

  const sealed: SealedCredential = {
    algorithm: data.algorithm,
    keyVersion: data.key_version,
    ciphertext: data.ciphertext,
    iv: data.iv,
    authTag: data.auth_tag,
  };
  return decryptCredential<ProviderCredential>(sealed);
}

/** Used when a connection is disabled or a token is revoked (§73). */
export async function deleteCredential(db: ServiceClient, connectionId: string): Promise<void> {
  const { error } = await table(db).delete().eq("connection_id", connectionId);
  if (error) throw new Error(`Could not remove the credential: ${error.message}`);
}

/** Whether a credential exists — asked by the wizard without reading it. */
export async function hasCredential(db: ServiceClient, connectionId: string): Promise<boolean> {
  const { data } = await table(db).select("connection_id").eq("connection_id", connectionId).maybeSingle();
  return !!data;
}
