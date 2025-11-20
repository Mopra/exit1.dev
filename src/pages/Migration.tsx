import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, ResultCard } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, PageContainer } from '@/components/layout';
import { Download, UserCheck, Users, ShieldCheck, Shield } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { toast } from 'sonner';

const Migration: React.FC = () => {
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; exportedUsers?: number; message?: string } | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateEmail, setMigrateEmail] = useState('');
  const [migrateResult, setMigrateResult] = useState<{ success: boolean; message?: string; checksMigrated?: number; webhooksMigrated?: number; apiKeysMigrated?: number; emailSettingsMigrated?: boolean; bigQueryRowsMigrated?: number } | null>(null);
  const [fixingBigQuery, setFixingBigQuery] = useState(false);
  const [fixBigQueryResult, setFixBigQueryResult] = useState<{ success: boolean; message?: string; bigQueryRowsUpdated?: number } | null>(null);
  const [bulkMigrating, setBulkMigrating] = useState(false);
  const [bulkMigrateResult, setBulkMigrateResult] = useState<{ success: boolean; message?: string; totalUsers?: number; migratedUsers?: number; failedUsers?: number; results?: Array<{ email: string; success: boolean; message?: string; error?: string }> } | null>(null);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<{ success: boolean; message?: string; totalUsers?: number; validUsers?: number; invalidUsers?: number; results?: Array<{ email: string; valid: boolean; issues: string[]; checksCount?: number; webhooksCount?: number; apiKeysCount?: number; hasEmailSettings?: boolean }> } | null>(null);

  const handleExportDevUsers = async () => {
    try {
      setExporting(true);
      setExportResult(null);
      const exportDevUsers = httpsCallable(functions, 'exportDevUsers');
      const result = await exportDevUsers({ secretToken: 'migration-export-2024' });
      
      const data = result.data as { success: boolean; exportedUsers: number; totalUsers: number; message: string };
      setExportResult({
        success: data.success,
        exportedUsers: data.exportedUsers,
        message: data.message,
      });
      
      if (data.success) {
        toast.success(`Successfully exported ${data.exportedUsers} dev users to migration table!`);
      } else {
        toast.error('Export completed but may have had issues');
      }
    } catch (error: any) {
      console.error('Export error:', error);
      setExportResult({
        success: false,
        message: error.message || 'Unknown error',
      });
      toast.error('Failed to export dev users: ' + (error.message || 'Unknown error'));
    } finally {
      setExporting(false);
    }
  };

  const handleMigrateUser = async () => {
    if (!migrateEmail.trim()) {
      toast.error('Please enter an email address');
      return;
    }

    try {
      setMigrating(true);
      setMigrateResult(null);
      const migrateUser = httpsCallable(functions, 'migrateUser');
      const result = await migrateUser({ 
        email: migrateEmail.trim(),
        secretToken: 'migration-migrate-2024' 
      });
      
      const data = result.data as { 
        success: boolean; 
        message: string; 
        checksMigrated?: number; 
        webhooksMigrated?: number; 
        apiKeysMigrated?: number; 
        emailSettingsMigrated?: boolean;
        bigQueryRowsMigrated?: number;
        prodClerkUserId?: string;
      };
      
      setMigrateResult({
        success: data.success,
        message: data.message,
        checksMigrated: data.checksMigrated,
        webhooksMigrated: data.webhooksMigrated,
        apiKeysMigrated: data.apiKeysMigrated,
        emailSettingsMigrated: data.emailSettingsMigrated,
        bigQueryRowsMigrated: data.bigQueryRowsMigrated,
      });
      
      if (data.success) {
        toast.success(`Successfully migrated ${migrateEmail}!`);
        setMigrateEmail(''); // Clear the input
      } else {
        toast.error('Migration completed but may have had issues');
      }
    } catch (error: any) {
      console.error('Migration error:', error);
      setMigrateResult({
        success: false,
        message: error.message || 'Unknown error',
      });
      toast.error('Failed to migrate user: ' + (error.message || 'Unknown error'));
    } finally {
      setMigrating(false);
    }
  };

  const handleFixBigQueryData = async () => {
    if (!migrateEmail.trim()) {
      toast.error('Please enter an email address');
      return;
    }

    try {
      setFixingBigQuery(true);
      setFixBigQueryResult(null);
      const fixBigQueryData = httpsCallable(functions, 'fixBigQueryData');
      const result = await fixBigQueryData({ 
        email: migrateEmail.trim(),
        secretToken: 'migration-migrate-2024' 
      });
      
      const data = result.data as { 
        success: boolean; 
        message: string; 
        bigQueryRowsUpdated?: number;
      };
      
      setFixBigQueryResult({
        success: data.success,
        message: data.message,
        bigQueryRowsUpdated: data.bigQueryRowsUpdated,
      });
      
      if (data.success) {
        toast.success(`Successfully fixed BigQuery data for ${migrateEmail}!`);
      } else {
        toast.error('Failed to fix BigQuery data');
      }
    } catch (error: any) {
      console.error('Fix BigQuery error:', error);
      setFixBigQueryResult({
        success: false,
        message: error.message || 'Unknown error',
      });
      toast.error('Failed to fix BigQuery data: ' + (error.message || 'Unknown error'));
    } finally {
      setFixingBigQuery(false);
    }
  };

  const handleBulkMigrate = async () => {
    if (!confirm('This will migrate ALL remaining dev users to prod. Are you sure you want to continue?')) {
      return;
    }

    try {
      setBulkMigrating(true);
      setBulkMigrateResult(null);
      const migrateAllUsers = httpsCallable(functions, 'migrateAllUsers');
      const result = await migrateAllUsers({ 
        secretToken: 'migration-migrate-2024',
        batchSize: 10,
      });
      
      const data = result.data as { 
        success: boolean; 
        message: string; 
        totalUsers?: number;
        migratedUsers?: number;
        failedUsers?: number;
        results?: Array<{ email: string; success: boolean; message?: string; error?: string }>;
      };
      
      setBulkMigrateResult({
        success: data.success,
        message: data.message,
        totalUsers: data.totalUsers,
        migratedUsers: data.migratedUsers,
        failedUsers: data.failedUsers,
        results: data.results,
      });
      
      if (data.success) {
        toast.success(`Bulk migration complete: ${data.migratedUsers} migrated, ${data.failedUsers} failed`);
      } else {
        toast.error('Bulk migration failed');
      }
    } catch (error: any) {
      console.error('Bulk migration error:', error);
      setBulkMigrateResult({
        success: false,
        message: error.message || 'Unknown error',
      });
      toast.error('Failed to bulk migrate users: ' + (error.message || 'Unknown error'));
    } finally {
      setBulkMigrating(false);
    }
  };

  const handleValidateMigration = async () => {
    try {
      setValidating(true);
      setValidateResult(null);
      const validateMigration = httpsCallable(functions, 'validateMigration');
      const result = await validateMigration({ 
        secretToken: 'migration-migrate-2024',
      });
      
      const data = result.data as { 
        success: boolean; 
        message: string; 
        totalUsers?: number;
        validUsers?: number;
        invalidUsers?: number;
        results?: Array<{ email: string; valid: boolean; issues: string[]; checksCount?: number; webhooksCount?: number; apiKeysCount?: number; hasEmailSettings?: boolean }>;
      };
      
      setValidateResult({
        success: data.success,
        message: data.message,
        totalUsers: data.totalUsers,
        validUsers: data.validUsers,
        invalidUsers: data.invalidUsers,
        results: data.results,
      });
      
      if (data.success) {
        if (data.invalidUsers === 0) {
          toast.success(`All ${data.validUsers} migrated users are valid!`);
        } else {
          toast.warning(`Validation complete: ${data.validUsers} valid, ${data.invalidUsers} have issues`);
        }
      } else {
        toast.error('Validation failed');
      }
    } catch (error: any) {
      console.error('Validation error:', error);
      setValidateResult({
        success: false,
        message: error.message || 'Unknown error',
      });
      toast.error('Failed to validate migration: ' + (error.message || 'Unknown error'));
    } finally {
      setValidating(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader 
        title="Migration Tools" 
        description="Export dev users to migration table for gradual migration to production instance"
        icon={Shield}
      />
      
      <div className="flex-1 overflow-auto p-4 sm:p-6 flex items-center justify-center">
        <div className="container max-w-2xl w-full">
        <Card>
        <CardHeader>
          <CardTitle>Clerk Migration Tools</CardTitle>
          <CardDescription>
            Export dev users to migration table for gradual migration to production instance
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h3 className="font-semibold">Step 1: Export Dev Users</h3>
            <p className="text-sm text-muted-foreground">
              This will export all users from your Clerk dev instance to the Firestore migration table.
              This is required before migrating individual users.
            </p>
            <Button
              onClick={handleExportDevUsers}
              disabled={exporting}
              className="cursor-pointer"
            >
              <Download className={`h-4 w-4 mr-2 ${exporting ? 'animate-spin' : ''}`} />
              {exporting ? 'Exporting...' : 'Export Dev Users'}
            </Button>
          </div>

          {exportResult && (
            <ResultCard
              success={exportResult.success}
              title={exportResult.success ? 'Export Successful!' : 'Export Failed'}
              message={exportResult.message}
              details={
                <>
                  {exportResult.exportedUsers !== undefined && (
                    <span>Exported {exportResult.exportedUsers} users to migration table</span>
                  )}
                </>
              }
            />
          )}

          {/* Step 2: Migrate User Section */}
          <div className="pt-6 border-t mt-6 space-y-4" style={{ display: 'block' }}>
            <div className="space-y-3">
              <div>
                <h3 className="font-semibold text-lg">Step 2: Migrate User</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Migrate a user from dev instance to prod instance. This will create the user in prod, update all their data, and mark them as migrated.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="user@example.com"
                  value={migrateEmail}
                  onChange={(e) => setMigrateEmail(e.target.value)}
                  disabled={migrating}
                  className="flex-1"
                />
                <Button
                  onClick={handleMigrateUser}
                  disabled={migrating || !migrateEmail.trim()}
                  className="cursor-pointer"
                >
                  <UserCheck className={`h-4 w-4 mr-2 ${migrating ? 'animate-spin' : ''}`} />
                  {migrating ? 'Migrating...' : 'Migrate User'}
                </Button>
              </div>
            </div>

            {migrateResult && (
              <ResultCard
                success={migrateResult.success}
                title={migrateResult.success ? 'Migration Successful!' : 'Migration Failed'}
                message={migrateResult.message}
                details={
                  migrateResult.success && (
                    <>
                      <p>Migrated data:</p>
                      <ul className="list-disc list-inside mt-1 space-y-0.5">
                        {migrateResult.checksMigrated !== undefined && (
                          <li>Checks: {migrateResult.checksMigrated}</li>
                        )}
                        {migrateResult.webhooksMigrated !== undefined && (
                          <li>Webhooks: {migrateResult.webhooksMigrated}</li>
                        )}
                        {migrateResult.apiKeysMigrated !== undefined && (
                          <li>API Keys: {migrateResult.apiKeysMigrated}</li>
                        )}
                        {migrateResult.emailSettingsMigrated && (
                          <li>Email Settings: Migrated</li>
                        )}
                        {migrateResult.bigQueryRowsMigrated !== undefined && (
                          <li>BigQuery Logs: {migrateResult.bigQueryRowsMigrated} rows</li>
                        )}
                      </ul>
                      <p className="mt-2 text-xs">Note: User will need to reset their password after migration.</p>
                    </>
                  )
                }
              />
            )}

            <div className="pt-4 border-t space-y-4">
              <div className="space-y-2">
                <h3 className="font-semibold">Step 3: Fix BigQuery Data (Recovery)</h3>
                <p className="text-sm text-muted-foreground">
                  If you migrated before BigQuery support was added, use this to fix your logs and reports data.
                </p>
                <Button
                  onClick={handleFixBigQueryData}
                  disabled={fixingBigQuery || !migrateEmail.trim()}
                  variant="outline"
                  className="cursor-pointer"
                >
                  <UserCheck className={`h-4 w-4 mr-2 ${fixingBigQuery ? 'animate-spin' : ''}`} />
                  {fixingBigQuery ? 'Fixing...' : 'Fix BigQuery Data'}
                </Button>
              </div>

              {fixBigQueryResult && (
                <ResultCard
                  success={fixBigQueryResult.success}
                  title={fixBigQueryResult.success ? 'BigQuery Data Fixed!' : 'Fix Failed'}
                  message={fixBigQueryResult.message}
                  details={
                    <>
                      {fixBigQueryResult.bigQueryRowsUpdated !== undefined && (
                        <span>Updated {fixBigQueryResult.bigQueryRowsUpdated} rows in BigQuery</span>
                      )}
                    </>
                  }
                />
              )}
            </div>

            <div className="pt-4 border-t space-y-4">
              <div className="space-y-2">
                <h3 className="font-semibold">Step 4: Bulk Migrate All Remaining Users</h3>
                <p className="text-sm text-muted-foreground">
                  Automatically migrate all remaining dev users to prod. This will process users in batches and show progress.
                </p>
                <Button
                  onClick={handleBulkMigrate}
                  disabled={bulkMigrating}
                  variant="default"
                  className="cursor-pointer bg-purple-600 hover:bg-purple-700"
                >
                  <Users className={`h-4 w-4 mr-2 ${bulkMigrating ? 'animate-spin' : ''}`} />
                  {bulkMigrating ? 'Migrating...' : 'Migrate All Remaining Users'}
                </Button>
              </div>

              {bulkMigrateResult && (
                <ResultCard
                  success={bulkMigrateResult.success}
                  title={bulkMigrateResult.success ? 'Bulk Migration Complete!' : 'Bulk Migration Failed'}
                  message={bulkMigrateResult.message}
                  details={
                    <>
                      {bulkMigrateResult.totalUsers !== undefined && (
                        <>
                          <p>Total users: {bulkMigrateResult.totalUsers}</p>
                          <p>Migrated: {bulkMigrateResult.migratedUsers || 0}</p>
                          <p>Failed: {bulkMigrateResult.failedUsers || 0}</p>
                        </>
                      )}
                      {bulkMigrateResult.results && bulkMigrateResult.results.length > 0 && (
                        <div className="mt-2 max-h-40 overflow-y-auto">
                          <p className="text-xs font-semibold mb-1">Results:</p>
                          <ul className="text-xs space-y-0.5">
                            {bulkMigrateResult.results.slice(0, 20).map((result, idx) => (
                              <li key={idx} className={result.success ? 'text-green-600' : 'text-red-600'}>
                                {result.email}: {result.success ? '✓' : `✗ ${result.error || 'Failed'}`}
                              </li>
                            ))}
                            {bulkMigrateResult.results.length > 20 && (
                              <li className="text-muted-foreground">... and {bulkMigrateResult.results.length - 20} more</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </>
                  }
                />
              )}
            </div>

            <div className="pt-4 border-t space-y-4" style={{ display: 'block' }}>
              <div className="space-y-2">
                <h3 className="font-semibold text-lg">Step 5: Validate Migration</h3>
                <p className="text-sm text-muted-foreground">
                  Verify that all migrated users and their data (checks, webhooks, API keys, email settings) are correctly migrated.
                </p>
                <Button
                  onClick={handleValidateMigration}
                  disabled={validating}
                  variant="outline"
                  className="cursor-pointer"
                >
                  <ShieldCheck className={`h-4 w-4 mr-2 ${validating ? 'animate-spin' : ''}`} />
                  {validating ? 'Validating...' : 'Validate All Migrated Users'}
                </Button>
              </div>

              {validateResult && (
                <ResultCard
                  success={validateResult.success && (validateResult.invalidUsers ?? 0) === 0}
                  warning={validateResult.success && (validateResult.invalidUsers ?? 0) > 0}
                  title={
                    validateResult.success && (validateResult.invalidUsers ?? 0) === 0 ? 'All Users Valid!' : 
                    validateResult.success ? 'Validation Complete (Some Issues Found)' : 
                    'Validation Failed'
                  }
                  message={validateResult.message}
                  details={
                    <>
                      {validateResult.totalUsers !== undefined && (
                        <>
                          <p>Total migrated users: {validateResult.totalUsers}</p>
                          <p>Valid: {validateResult.validUsers || 0}</p>
                          <p>Issues found: {validateResult.invalidUsers || 0}</p>
                        </>
                      )}
                      {validateResult.results && validateResult.results.length > 0 && (
                        <div className="mt-2 max-h-60 overflow-y-auto">
                          <p className="text-xs font-semibold mb-1">User Details:</p>
                          <ul className="text-xs space-y-1">
                            {validateResult.results.slice(0, 30).map((result, idx) => (
                              <li key={idx} className={result.valid ? 'text-green-600' : 'text-red-600'}>
                                <span className="font-medium">{result.email}:</span> {result.valid ? '✓ Valid' : `✗ ${result.issues.join(', ')}`}
                                {result.checksCount !== undefined && (
                                  <span className="text-muted-foreground ml-2">
                                    ({result.checksCount} checks, {result.webhooksCount || 0} webhooks, {result.apiKeysCount || 0} API keys{result.hasEmailSettings ? ', email settings' : ''})
                                  </span>
                                )}
                              </li>
                            ))}
                            {validateResult.results.length > 30 && (
                              <li className="text-muted-foreground">... and {validateResult.results.length - 30} more</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </>
                  }
                />
              )}
            </div>

            <div className="pt-4 border-t">
              <h3 className="font-semibold mb-2">Next Steps:</h3>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                <li>After migrating, sign in with the prod instance</li>
                <li>Set admin status in Clerk dashboard (publicMetadata.admin = true) if needed</li>
                <li>Migrate other users gradually using the migration tool above</li>
              </ol>
            </div>
          </div>
          </CardContent>
      </Card>
        </div>
      </div>
    </PageContainer>
  );
};

export default Migration;

