import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createClerkClient } from "@clerk/backend";
import { getUserTierLive } from "./init";
import { CLERK_SECRET_KEY_DEV, CLERK_SECRET_KEY_PROD } from "./env";

type OrganizationBillingAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

type OrganizationBillingProfile = {
  companyName?: string;
  legalName?: string;
  email?: string;
  phone?: string;
  taxId?: string;
  taxIdLabel?: string;
  address?: OrganizationBillingAddress;
};

const FIELD_LIMITS = {
  companyName: 160,
  legalName: 160,
  email: 200,
  phone: 40,
  taxId: 80,
  taxIdLabel: 32,
  line1: 200,
  line2: 200,
  city: 100,
  region: 100,
  postalCode: 40,
  country: 100,
};

function trimValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function sanitizeAddress(payload: unknown): OrganizationBillingAddress | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const address: OrganizationBillingAddress = {
    line1: trimValue(record.line1, FIELD_LIMITS.line1),
    line2: trimValue(record.line2, FIELD_LIMITS.line2),
    city: trimValue(record.city, FIELD_LIMITS.city),
    region: trimValue(record.region, FIELD_LIMITS.region),
    postalCode: trimValue(record.postalCode, FIELD_LIMITS.postalCode),
    country: trimValue(record.country, FIELD_LIMITS.country),
  };
  const hasValue = Object.values(address).some((value) => value);
  return hasValue ? address : undefined;
}

function sanitizeProfile(payload: unknown): OrganizationBillingProfile | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const address = sanitizeAddress(record.address);
  const profile: OrganizationBillingProfile = {
    companyName: trimValue(record.companyName, FIELD_LIMITS.companyName),
    legalName: trimValue(record.legalName, FIELD_LIMITS.legalName),
    email: trimValue(record.email, FIELD_LIMITS.email),
    phone: trimValue(record.phone, FIELD_LIMITS.phone),
    taxId: trimValue(record.taxId, FIELD_LIMITS.taxId),
    taxIdLabel: trimValue(record.taxIdLabel, FIELD_LIMITS.taxIdLabel),
    address,
  };
  const hasValue = Boolean(
    profile.companyName ||
      profile.legalName ||
      profile.email ||
      profile.phone ||
      profile.taxId ||
      profile.taxIdLabel ||
      profile.address
  );
  return hasValue ? profile : null;
}

function safeSecretValue(secret: { value: () => string }): string | null {
  try {
    const value = secret.value();
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function isClerkNotFound(error: unknown): boolean {
  const err = error as { status?: number; errors?: Array<{ code?: string }> };
  return err?.status === 404 || err?.errors?.[0]?.code === "resource_not_found";
}

async function updateBillingProfileForInstance(params: {
  secretKey: string;
  instanceLabel: "prod" | "dev";
  organizationId: string;
  userId: string;
  billingProfile: OrganizationBillingProfile | null;
}) {
  const { secretKey, instanceLabel, organizationId, userId, billingProfile } = params;
  const client = createClerkClient({ secretKey });

  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId,
    userId: [userId],
    limit: 1,
  });

  if (!memberships.data.length) {
    logger.info(`No membership for ${userId} in org ${organizationId} (${instanceLabel}).`);
    return false;
  }

  await client.organizations.updateOrganizationMetadata(organizationId, {
    publicMetadata: { billingProfile },
  });

  logger.info(`Updated organization billing profile (${instanceLabel})`, {
    organizationId,
    userId,
  });
  return true;
}

export const updateOrganizationBillingProfile = onCall(
  { secrets: [CLERK_SECRET_KEY_PROD, CLERK_SECRET_KEY_DEV] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required");
    }
    const userTier = await getUserTierLive(uid);
    if (userTier !== "nano") {
      logger.warn(
        `User ${uid} attempted to update organization billing without Nano subscription (tier: ${userTier}).`
      );
      throw new HttpsError(
        "permission-denied",
        "Organization billing is only available on the Nano plan. Please upgrade to access this feature."
      );
    }

    const { organizationId, profile } = request.data || {};
    if (!organizationId || typeof organizationId !== "string") {
      throw new HttpsError("invalid-argument", "organizationId is required");
    }
    if (profile === undefined) {
      throw new HttpsError("invalid-argument", "profile is required");
    }

    const targetOrgId = organizationId.trim();
    if (!targetOrgId) {
      throw new HttpsError("invalid-argument", "organizationId is required");
    }

    const sanitizedProfile = sanitizeProfile(profile);
    const prodSecretKey = safeSecretValue(CLERK_SECRET_KEY_PROD);
    const devSecretKey = safeSecretValue(CLERK_SECRET_KEY_DEV);

    if (!prodSecretKey && !devSecretKey) {
      throw new HttpsError("failed-precondition", "Clerk configuration not found");
    }

    try {
      let updated = false;

      if (prodSecretKey) {
        try {
          updated = await updateBillingProfileForInstance({
            secretKey: prodSecretKey,
            instanceLabel: "prod",
            organizationId: targetOrgId,
            userId: uid,
            billingProfile: sanitizedProfile,
          });
        } catch (error) {
          if (isClerkNotFound(error)) {
            logger.info(`Organization ${targetOrgId} not found in prod instance.`);
          } else {
            logger.error("Failed to update org billing profile in prod", error);
            throw error;
          }
        }
      }

      if (!updated && devSecretKey) {
        try {
          updated = await updateBillingProfileForInstance({
            secretKey: devSecretKey,
            instanceLabel: "dev",
            organizationId: targetOrgId,
            userId: uid,
            billingProfile: sanitizedProfile,
          });
        } catch (error) {
          if (isClerkNotFound(error)) {
            logger.info(`Organization ${targetOrgId} not found in dev instance.`);
          } else {
            logger.error("Failed to update org billing profile in dev", error);
            throw error;
          }
        }
      }

      if (!updated) {
        throw new HttpsError("permission-denied", "Organization not found or access denied");
      }

      return { success: true };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      logger.error("updateOrganizationBillingProfile failed", error);
      throw new HttpsError("internal", "Failed to update organization billing profile");
    }
  }
);
