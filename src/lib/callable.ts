import {
  httpsCallable as firebaseHttpsCallable,
  type Functions,
  type HttpsCallable,
  type HttpsCallableOptions,
} from "firebase/functions";
import { getTeamAccountId } from "./active-account";

/**
 * Drop-in for firebase's `httpsCallable` that tells the backend which account
 * the call acts on. While a teammate is inside someone's account, every
 * payload carries `accountId` and the backend's resolveAccount
 * (functions/src/team-access.ts) checks they may. In the user's own account
 * nothing is added, exactly as before.
 *
 * Import this instead of `firebase/functions` for any callable.
 */
export function httpsCallable<RequestData = unknown, ResponseData = unknown>(
  functions: Functions,
  name: string,
  options?: HttpsCallableOptions,
): HttpsCallable<RequestData, ResponseData> {
  const fn = firebaseHttpsCallable<RequestData, ResponseData>(functions, name, options);
  const wrapped = ((data?: RequestData | null) => fn(withAccount(data))) as HttpsCallable<RequestData, ResponseData>;
  wrapped.stream = (data, streamOptions) => fn.stream(withAccount(data), streamOptions);
  return wrapped;
}

function withAccount<T>(data: T | null | undefined): T {
  const accountId = getTeamAccountId();
  if (!accountId) return data as T;
  if (data == null) return { accountId } as T;
  if (typeof data === "object" && !Array.isArray(data)) {
    return { accountId, ...(data as Record<string, unknown>) } as T;
  }
  return data as T;
}
