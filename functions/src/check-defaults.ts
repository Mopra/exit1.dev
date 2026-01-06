import type { Website } from "./types";

export const DEFAULT_WEBSITE_EXPECTED_STATUS_CODES = [
  200,
  201,
  202,
  204,
  301,
  302,
  303,
  307,
  308,
] as const;

export const DEFAULT_API_EXPECTED_STATUS_CODES = [200, 201, 202, 204] as const;

export const getDefaultExpectedStatusCodes = (type?: Website["type"]) => {
  if (type === "website" || !type) {
    return [...DEFAULT_WEBSITE_EXPECTED_STATUS_CODES];
  }
  return [...DEFAULT_API_EXPECTED_STATUS_CODES];
};

export const getDefaultHttpMethod = (type?: Website["type"]) =>
  type === "website" || !type ? "HEAD" : "GET";
