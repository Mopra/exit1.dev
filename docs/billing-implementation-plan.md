## Billing (Clerk B2C) – Implementation Plan

Goal: introduce a paid “nano” plan alongside “free_user”, add a Billing page with Clerk’s `<PricingTable />`, and surface it between “Account” and “Log out” in the user profile nav. No feature gating yet; keep room to gate later via Clerk Plans/Features.

### References
- Clerk Billing for B2C SaaS: https://clerk.com/docs/nextjs/guides/billing/for-b2c (Billing is beta; pin SDK versions).

### Assumptions / Open Items
- App uses Clerk React stack (confirm exact package: `@clerk/clerk-react` vs `@clerk/nextjs`) and version supports Billing/PricingTable.
- Plan slugs: `free_user` (free), `nano` (paid). Both public in Clerk Dashboard; no features yet.
- Sign-in required to reach Billing; signed-out users get redirected/guarded.

### Work Plan
1) **Dashboard setup**
   - Enable Billing in Clerk dashboard; choose payment gateway (dev gateway for local, Stripe for prod).
   - Create plans `free_user` and `nano`, mark “Publicly available”. If needed, add placeholder feature group for future gating.
   - Note any required Stripe keys/webhooks for prod readiness.

2) **Dependency + config**
   - Verify Clerk SDK version supports Billing components; pin versions (per beta warning).
   - Confirm env vars in `.env`/deployment for Clerk publishable/secret keys already used.

3) **Routing + nav placement**
   - Identify profile/user menu component (likely in `src/components/layout/...` or Clerk `UserButton` overrides).
   - Insert “Billing” link between “Account” and “Log out”; ensure shadcn styling matches existing menu and cursor-pointer on clickables.
   - Wire route to `/billing`.

4) **Billing page**
   - Create `/billing` route/page guarded by SignedIn/Protect (Clerk) or equivalent.
   - Render `<PricingTable />` inside shadcn container with frosted-blue glass aesthetic (per design preference), responsive max width.
   - Add brief copy: current plan shown from Clerk session if available; note nano is paid, features to follow.

5) **Gating & data hooks (future-ready)**
   - Locate plan/tier helpers (e.g., `useUserTier`); prepare to read Clerk plan/feature via `has({ plan: 'nano' })` or Protect.
   - Add TODOs where feature checks will live once nano features ship.

6) **QA plan**
   - Dev: create/cancel subscription on nano via dev gateway; ensure pricing table shows both plans.
   - Nav: Billing appears in correct order; back/forward works; signed-out redirect behavior correct.
   - Responsive check (mobile/desktop). Confirm no regressions to Account/Logout actions.

