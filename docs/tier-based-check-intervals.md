# Tier-Based Check Intervals

This document describes the tier-based check interval limits implemented for free and nano users.

## Overview

Check intervals determine how frequently a website, API endpoint, TCP, or UDP check is executed. To balance infrastructure costs and provide value to paying users, minimum check intervals are enforced based on the user's subscription tier.

## Tier Limits

| Tier | Minimum Check Interval | Available Intervals |
|------|------------------------|---------------------|
| **Free** | 5 minutes (300 seconds) | 5 min, 10 min, 15 min, 30 min, 1 hour, 24 hours |
| **Nano** | 2 minutes (120 seconds) | 2 min, 5 min, 10 min, 15 min, 30 min, 1 hour, 24 hours |

## Configuration

The minimum check intervals are configurable in `functions/src/config.ts`:

```typescript
// Tier-based minimum check intervals (in minutes, consistent with CHECK_INTERVAL_MINUTES)
MIN_CHECK_INTERVAL_MINUTES_FREE: 5,
MIN_CHECK_INTERVAL_MINUTES_NANO: 2,
```

To change these values:

1. Update the constants in `functions/src/config.ts`
2. Update the corresponding constants in `src/components/check/CheckForm.tsx` (frontend)
3. Redeploy both frontend and backend

## Implementation Details

### Backend Validation (`functions/src/checks.ts`)

The backend validates check frequency against the user's tier in two places:

1. **`addCheck`**: When creating a new check, the frequency is validated against the user's tier
2. **`updateCheck`**: When updating an existing check, if the frequency is being changed, it's validated against the user's tier

Helper functions in `functions/src/config.ts`:

```typescript
// Get minimum check interval in minutes for a given tier
getMinCheckIntervalMinutesForTier(tier: 'free' | 'nano'): number

// Get minimum check interval in seconds for a given tier (for frontend compatibility)
getMinCheckIntervalSecondsForTier(tier: 'free' | 'nano'): number

// Validate check frequency (in minutes) against tier limits
validateCheckFrequencyForTier(frequencyMinutes: number, tier: 'free' | 'nano')
```

### Frontend UI (`src/components/check/CheckForm.tsx`)

The frontend:

1. Uses the `useNanoPlan()` hook to determine the user's tier
2. Calculates `minCheckIntervalSeconds` based on the tier
3. Passes `minSeconds` prop to `CheckIntervalSelector` to filter available options
4. When editing a check, clamps the displayed interval to the user's minimum if the saved value is below their current tier limit

### Check Interval Selector (`src/components/ui/CheckIntervalSelector.tsx`)

The `CheckIntervalSelector` component accepts optional `minSeconds` and `maxSeconds` props to filter the available interval options. This ensures users only see intervals they're allowed to select.

## Unit Conversion

- **Frontend**: Works with seconds (60, 120, 300, etc.)
- **Backend/Firestore**: Stores frequency in minutes
- **Conversion**: Frontend divides by 60 when sending to backend

## Edge Cases

### Downgrade Scenario

If a user downgrades from nano to free:

1. Existing checks with 2-minute intervals continue to run at 2 minutes (grandfathered)
2. When editing such a check, the UI shows the next valid interval for their tier (5 minutes)
3. Backend validation prevents saving any interval below the tier minimum

### Upgrade Scenario

If a user upgrades from free to nano:

1. The UI immediately shows 2-minute option
2. User can update existing checks to use shorter intervals

## Error Messages

If a user attempts to set an interval below their tier minimum:

```
Check interval too short for your plan. Minimum allowed: X minutes
```

## Related Files

- `functions/src/config.ts` - Backend configuration and validation helpers
- `functions/src/checks.ts` - Check creation and update with tier validation
- `src/components/check/CheckForm.tsx` - Frontend form with tier-aware interval selection
- `src/components/ui/CheckIntervalSelector.tsx` - Interval selector component
- `src/hooks/useNanoPlan.ts` - Hook for detecting user's subscription tier
