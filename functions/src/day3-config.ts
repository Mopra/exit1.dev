// ============================================================================
// DAY3 WORKSPACE IDS
//
// Created by scripts/day3-scaffold.mjs and pinned here, mirroring how
// RESEND_TOPICS pins Resend's ids. Re-running the scaffold is idempotent and
// prints this map; anything new goes here.
// ============================================================================

export const DAY3_BASE_URL = "https://go.day3.app/api/v1";

export const DAY3_AUDIENCE_ID = "aud_scqybxdfqz6n1bhh3127";

// Topics mirror RESEND_TOPICS. All were created with default_subscribed: true,
// which is why the sync path never writes per-contact topic state: new contacts
// are opted in automatically. Kept here for the future preference center and
// because an unknown topic id in a batch payload rejects the whole request.
export const DAY3_TOPICS = {
  reengagement: "top_bt821fb1xf83kvaqyekb",
  onboarding: "top_n2a79hxfvv05mmfcmt04",
  promotions: "top_33tfzxjmxwmhdgdxahqa",
  educational: "top_47x9tz05jrywbq6fxf1g",
  product_updates: "top_z5jmdqa0jzhs5afd7jj2",
} as const;

export const DAY3_TOPIC_IDS: string[] = Object.values(DAY3_TOPICS);

// Day3 segments are saved filters evaluated live at read time, not membership
// lists — so unlike Resend there is nothing to sync. Writing plan_tier is
// enough for a contact to appear in the right segment. Listed for reference.
export const DAY3_SEGMENTS = {
  free: "seg_4jjj762c4md4hrwhbzv4",
  indie: "seg_x4ndsb9sn7kf8dx6cqf2",
  nano: "seg_052bgykj7r7pterhpcyx",
  pro: "seg_pwx283smkd03ha3ecbn7",
  paid: "seg_8k7j8bmr1jt800cpf5m1",
} as const;

// Day3 accepts up to 1,000 contacts per /contacts/batch call, and the whole
// call costs one request against the rate limit.
export const DAY3_BATCH_SIZE = 1000;
