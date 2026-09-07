/**
 * Batched Clerk user lookups.
 *
 * One place for the "resolve N user ids to emails and profile facts" loop.
 * Before this both onboarding.ts (admin response table) and lifecycle.ts (the
 * nightly sweep) carried their own copy of the same 100-id chunk loop, the same
 * primary-email resolution and the same warn-and-skip error handling. Clerk's
 * list API has already changed shape once; a fix here now reaches both.
 */
import * as logger from "firebase-functions/logger";
import { createClerkClient } from "@clerk/backend";

/** Clerk's getUserList accepts at most 100 ids per call. */
export const CLERK_LIST_CHUNK = 100;

export interface ClerkUserFacts {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Milliseconds since epoch, or null when Clerk did not return it. */
  createdAt: number | null;
  /** Milliseconds of last sign-in. The only honest "last active" signal we have. */
  lastSignInAt: number | null;
}

/**
 * Resolve facts for many users in batches. A failed batch is logged and its
 * users are simply absent from the result; callers must treat a missing entry
 * as "unknown this run", never as "no email".
 */
export async function fetchClerkUserFacts(
  userIds: string[],
  secretKey: string,
  scope = "clerk-users",
): Promise<Map<string, ClerkUserFacts>> {
  const out = new Map<string, ClerkUserFacts>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return out;

  const client = createClerkClient({ secretKey });

  for (let i = 0; i < unique.length; i += CLERK_LIST_CHUNK) {
    const chunk = unique.slice(i, i + CLERK_LIST_CHUNK);
    try {
      const res = await client.users.getUserList({ userId: chunk, limit: chunk.length });
      for (const u of res.data ?? []) {
        const primary = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)
          ?? u.emailAddresses?.[0];
        out.set(u.id, {
          email: primary?.emailAddress ?? null,
          firstName: u.firstName ?? null,
          lastName: u.lastName ?? null,
          createdAt: u.createdAt ?? null,
          lastSignInAt: u.lastSignInAt ?? null,
        });
      }
    } catch (e) {
      logger.warn(`[${scope}] Clerk user batch failed; those users are skipped this run`, {
        error: (e as Error)?.message ?? String(e),
        chunkSize: chunk.length,
      });
    }
  }
  return out;
}

/** Convenience for callers that only want addresses. */
export async function fetchClerkEmails(
  userIds: string[],
  secretKey: string,
  scope?: string,
): Promise<Map<string, string>> {
  const facts = await fetchClerkUserFacts(userIds, secretKey, scope);
  const out = new Map<string, string>();
  for (const [id, f] of facts) if (f.email) out.set(id, f.email);
  return out;
}
