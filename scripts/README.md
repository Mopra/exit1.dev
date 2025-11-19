# Clerk Migration Scripts

Scripts for migrating users from Clerk development instance to production instance.

## Prerequisites

1. **Environment Variables:**
   - `CLERK_SECRET_KEY_DEV`: Development instance secret key
   - `CLERK_SECRET_KEY_PROD` or `CLERK_SECRET_KEY`: Production instance secret key
   - `GOOGLE_APPLICATION_CREDENTIALS`: Path to Firebase Admin SDK service account JSON (optional, uses default credentials if not set)

2. **Dependencies:**
   ```bash
   npm install -D tsx
   # Or use ts-node if preferred
   ```

3. **Firebase Admin SDK:**
   - Configure Firebase Admin SDK credentials
   - Ensure Firestore database is initialized

## Scripts

### 1. export-dev-users.ts

Exports all users from Clerk dev instance to the `userMigrations` Firestore collection.

**Usage:**
```bash
npx tsx scripts/export-dev-users.ts
```

**What it does:**
- Fetches all users from Clerk dev instance
- Creates migration records in Firestore `userMigrations` collection
- Sets `instance: 'dev'` and `migrated: false` for all dev users

**Output:**
- Creates/updates documents in `userMigrations` collection
- Each document ID is the normalized email address
- Document contains: `devClerkUserId`, `instance: 'dev'`, `migrated: false`

### 2. migrate-user.ts

Migrates a single user from dev to prod instance.

**Usage:**
```bash
npx tsx scripts/migrate-user.ts <email>
```

**Example:**
```bash
npx tsx scripts/migrate-user.ts user@example.com
```

**What it does:**
1. Fetches user data from dev Clerk instance
2. Creates user in prod Clerk instance (or finds existing)
3. Updates all Firestore documents:
   - `checks` collection: Updates `userId` from dev to prod
   - `webhooks` collection: Updates `userId` from dev to prod
   - `emailSettings` collection: Migrates document from dev userId to prod userId
   - `apiKeys` collection: Updates `userId` from dev to prod
4. Updates migration table: Sets `migrated: true`, `prodClerkUserId`, `instance: 'prod'`

**Important Notes:**
- **Passwords cannot be migrated directly** - users will need to reset their password or use Clerk's password export feature (requires support request)
- User metadata (publicMetadata, privateMetadata, etc.) is migrated
- If user already exists in prod instance, the script will use the existing user

### 3. validate-migration.ts

Validates that a migrated user's data is correct.

**Usage:**
```bash
npx tsx scripts/validate-migration.ts <email>
```

**Example:**
```bash
npx tsx scripts/validate-migration.ts user@example.com
```

**What it checks:**
- User exists in migration table and is marked as migrated
- No documents still reference dev Clerk user ID
- All documents correctly reference prod Clerk user ID
- Data statistics (checks, webhooks, emailSettings, apiKeys)

**Output:**
- Validation status (valid/invalid)
- List of errors (if any)
- List of warnings (if any)
- Data statistics

## Migration Workflow

1. **Export dev users:**
   ```bash
   npx tsx scripts/export-dev-users.ts
   ```
   This populates the migration table with all dev users.

2. **Migrate users (one at a time or in batches):**
   ```bash
   npx tsx scripts/migrate-user.ts user1@example.com
   npx tsx scripts/migrate-user.ts user2@example.com
   # ... etc
   ```

3. **Validate migrations:**
   ```bash
   npx tsx scripts/validate-migration.ts user1@example.com
   ```

4. **Repeat steps 2-3 for all users**

## Troubleshooting

### Error: "User not found in migration table"
- Run `export-dev-users.ts` first to populate the migration table

### Error: "CLERK_SECRET_KEY_DEV not set"
- Set the environment variable: `export CLERK_SECRET_KEY_DEV="your_dev_key"`

### Error: "User already exists in prod instance"
- The script will automatically use the existing user
- This is normal if the user was created manually

### Password Migration
- Passwords cannot be migrated automatically
- Options:
  1. Users reset their password after migration
  2. Request password export from Clerk support (includes hashed passwords)
  3. Use Clerk's password import feature with exported passwords

## Safety

- All scripts use Firestore transactions/batches where possible
- Scripts validate data before making changes
- Migration table tracks migration status to prevent duplicate migrations
- Validation script helps catch any issues

## Notes

- Migration is a one-way process (dev → prod)
- After migration, users should use prod instance for authentication
- Dev instance can be kept active during migration period
- Once all users are migrated, dev instance support can be removed

