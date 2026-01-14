import * as logger from "firebase-functions/logger";
import * as tls from "tls";
import { URL } from "url";
import { CONFIG } from "./config";

export async function checkSSLCertificate(url: string): Promise<{
  valid: boolean;
  issuer?: string;
  subject?: string;
  validFrom?: number;
  validTo?: number;
  daysUntilExpiry?: number;
  error?: string;
}> {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const port = urlObj.port || (urlObj.protocol === "https:" ? 443 : 80);

    // Only check SSL for HTTPS URLs
    if (urlObj.protocol !== "https:") {
      return {
        valid: true,
      };
    }

    return new Promise((resolve) => {
      const socket = tls.connect({
        host: hostname,
        port: parseInt(port.toString()),
        servername: hostname, // SNI support
        rejectUnauthorized: false, // Don't reject on certificate errors, we'll check manually
        timeout: 10000, // 10 second timeout
      });

      socket.on("secureConnect", () => {
        const cert = socket.getPeerCertificate();

        if (!cert || Object.keys(cert).length === 0) {
          socket.destroy();
          resolve({
            valid: false,
            error: "No certificate received",
          });
          return;
        }

        const now = Date.now();
        const validFrom = new Date(cert.valid_from).getTime();
        const validTo = new Date(cert.valid_to).getTime();
        const daysUntilExpiry = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));

        const isValid = now >= validFrom && now <= validTo;

        socket.destroy();

        const sslData: {
          valid: boolean;
          issuer: string;
          subject: string;
          validFrom: number;
          validTo: number;
          daysUntilExpiry: number;
          error?: string;
        } = {
          valid: isValid,
          issuer: cert.issuer?.CN || cert.issuer?.O || "Unknown",
          subject: cert.subject?.CN || cert.subject?.O || hostname,
          validFrom,
          validTo,
          daysUntilExpiry,
        };

        if (!isValid) {
          sslData.error = `Certificate expired ${Math.abs(daysUntilExpiry)} days ago`;
        }

        resolve(sslData);
      });

      socket.on("error", (error) => {
        socket.destroy();
        resolve({
          valid: false,
          error: `SSL connection failed: ${error.message}`,
        });
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({
          valid: false,
          error: "SSL connection timeout",
        });
      });
    });
  } catch (error) {
    return {
      valid: false,
      error: `SSL check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export async function checkSecurityAndExpiry(url: string): Promise<{
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
}> {
  if (!CONFIG.ENABLE_SECURITY_LOOKUPS) {
    logger.info("Security lookups disabled via ENABLE_SECURITY_LOOKUPS flag");
    return {};
  }

  const [sslCertificate] = await Promise.allSettled([checkSSLCertificate(url)]);

  return {
    sslCertificate: sslCertificate.status === "fulfilled" ? sslCertificate.value : undefined,
  };
}
