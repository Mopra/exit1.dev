import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAdmin } from '@/hooks/useAdmin';
import { PageHeader, PageContainer } from '@/components/layout';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Badge,
  Checkbox,
  ScrollArea,
  ConfirmationModal,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { Shield, Mail, Loader2, Users, Search, Send, Filter } from 'lucide-react';
import EmailEditor from '@/components/admin/EmailEditor';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/firebase';
import { toast } from 'sonner';
import type { PlatformUser } from '@/components/admin/UserTable';
import { useAuth } from '@clerk/clerk-react';

type RecipientMode = 'all' | 'select';
type ChecksFilter = 'all' | 'with-checks' | 'without-checks';

const BulkEmail: React.FC = () => {
  const { isAdmin, loading: adminLoading } = useAdmin();
  const { getToken } = useAuth();
  const [subject, setSubject] = useState('');
  const [htmlBody, setHtmlBody] = useState('');
  const [recipientMode, setRecipientMode] = useState<RecipientMode>('select');
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [allUsers, setAllUsers] = useState<PlatformUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [checksFilter, setChecksFilter] = useState<ChecksFilter>('all');
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState({ sent: 0, total: 0 });
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  // Fetch all users when "select" mode is enabled
  const fetchAllUsers = useCallback(async () => {
    if (recipientMode !== 'select') return;

    setLoadingUsers(true);
    try {
      const token = await getToken({ template: 'integration_firebase' });
      if (!token) {
        throw new Error('Authentication required');
      }

      const getAllUsers = httpsCallable(functions, 'getAllUsers');
      const allUsersList: PlatformUser[] = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const result = await getAllUsers({ page, limit: 100, instance: 'prod' });
        
        if (result.data && typeof result.data === 'object' && 'success' in result.data) {
          const data = result.data as {
            success: boolean;
            data: PlatformUser[];
            pagination?: {
              hasNext: boolean;
            };
          };
          
          if (data.success && data.data) {
            allUsersList.push(...data.data);
            hasMore = data.pagination?.hasNext || false;
            page++;
          } else {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      }

      setAllUsers(allUsersList);
    } catch (error) {
      console.error('Error fetching users:', error);
      toast.error('Failed to fetch users');
    } finally {
      setLoadingUsers(false);
    }
  }, [recipientMode, getToken]);

  useEffect(() => {
    if (recipientMode === 'select') {
      fetchAllUsers();
    } else {
      setAllUsers([]);
      setSelectedUserIds(new Set());
    }
  }, [recipientMode, fetchAllUsers]);

  // Clean up selectedUserIds to remove any opted-out users
  useEffect(() => {
    const optedInUserIds = new Set(
      allUsers.filter(user => user.emailOptedOut !== true).map(user => user.id)
    );
    setSelectedUserIds(prev => {
      const cleaned = new Set(Array.from(prev).filter(id => optedInUserIds.has(id)));
      return cleaned.size !== prev.size ? cleaned : prev;
    });
  }, [allUsers]);

  const filteredUsers = useMemo(() => {
    // Filter out opted-out users - only show users who haven't opted out
    let filtered = allUsers.filter(user => user.emailOptedOut !== true);
    
    // Apply checks filter
    if (checksFilter === 'with-checks') {
      filtered = filtered.filter(user => (user.checksCount || 0) > 0);
    } else if (checksFilter === 'without-checks') {
      filtered = filtered.filter(user => (user.checksCount || 0) === 0);
    }
    
    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (user) =>
          user.email.toLowerCase().includes(query) ||
          (user.displayName || '').toLowerCase().includes(query)
      );
    }
    
    return filtered;
  }, [allUsers, searchQuery, checksFilter]);

  const recipientCount = useMemo(() => {
    // Only count users who haven't opted out
    const optedInUsers = allUsers.filter(user => user.emailOptedOut !== true);
    if (recipientMode === 'all') {
      return optedInUsers.length || 'All';
    }
    return selectedUserIds.size;
  }, [recipientMode, allUsers, selectedUserIds.size]);

  const handleSelectAll = () => {
    if (selectedUserIds.size === filteredUsers.length) {
      setSelectedUserIds(new Set());
    } else {
      setSelectedUserIds(new Set(filteredUsers.map((u) => u.id)));
    }
  };

  const handleSelectUser = (userId: string) => {
    const newSelected = new Set(selectedUserIds);
    if (newSelected.has(userId)) {
      newSelected.delete(userId);
    } else {
      newSelected.add(userId);
    }
    setSelectedUserIds(newSelected);
  };

  const handleSend = async () => {
    if (!subject.trim()) {
      toast.error('Subject is required');
      return;
    }

    if (!htmlBody.trim()) {
      toast.error('Email body is required');
      return;
    }

    if (recipientMode === 'select' && selectedUserIds.size === 0) {
      toast.error('Please select at least one recipient');
      return;
    }

    setConfirmModalOpen(true);
  };

  const handleConfirmSend = async () => {
    setConfirmModalOpen(false);
    setSending(true);
    setSendProgress({ sent: 0, total: 0 });

    try {
      const sendBulkEmail = httpsCallable(functions, 'sendBulkEmail');
      const recipientIds =
        recipientMode === 'select' && selectedUserIds.size > 0
          ? Array.from(selectedUserIds)
          : undefined;

      const result = await sendBulkEmail({
        subject: subject.trim(),
        htmlBody: htmlBody.trim(),
        recipientIds,
      });

      if (result.data && typeof result.data === 'object') {
        const data = result.data as {
          success: boolean;
          sent: number;
          failed: number;
          total: number;
          errors?: string[];
        };

        if (data.success) {
          toast.success('Emails sent successfully', {
            description: `Sent to ${data.sent} recipients${data.failed > 0 ? `, ${data.failed} failed` : ''}`,
            duration: 5000,
          });

          // Reset form
          setSubject('');
          setHtmlBody('');
          setSelectedUserIds(new Set());
          setRecipientMode('select');
        } else {
          throw new Error('Failed to send emails');
        }
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Failed to send emails';
      toast.error('Failed to send emails', {
        description: errorMessage,
        duration: 5000,
      });
    } finally {
      setSending(false);
      setSendProgress({ sent: 0, total: 0 });
    }
  };

  if (adminLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-full max-w-md p-6 bg-card border rounded-lg">
            <div className="text-center space-y-4">
              <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
              <div>
                <h2 className="text-2xl font-semibold">Access Denied</h2>
                <p className="text-muted-foreground mt-2">
                  You don't have permission to access this page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Bulk Email"
        description="Send emails to all users or selected recipients"
        icon={Mail}
        actions={
          <Badge variant="outline" className="gap-2 px-3 py-1.5">
            <Users className="w-4 h-4" />
            {recipientCount} {typeof recipientCount === 'number' && recipientCount === 1 ? 'recipient' : 'recipients'}
          </Badge>
        }
      />

      <div className="space-y-6 p-6">
        <Card className="bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40 border-sky-200/50">
          <CardHeader>
            <CardTitle>Compose Email</CardTitle>
            <CardDescription>Create and send emails to your users</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="email-subject">Subject</Label>
              <Input
                id="email-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Enter email subject..."
                disabled={sending}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email-body">Body</Label>
              <EmailEditor
                value={htmlBody}
                onChange={setHtmlBody}
                placeholder="Enter email content..."
              />
            </div>

            <div className="space-y-4">
              <Label>Recipients</Label>
              <RadioGroup
                value={recipientMode}
                onValueChange={(value) => setRecipientMode(value as RecipientMode)}
                disabled={sending}
                className="space-y-2"
              >
                <div className="flex items-center space-x-2 cursor-pointer">
                  <RadioGroupItem value="all" id="all-users" />
                  <Label htmlFor="all-users" className="cursor-pointer">
                    All Users
                  </Label>
                </div>
                <div className="flex items-center space-x-2 cursor-pointer">
                  <RadioGroupItem value="select" id="select-users" />
                  <Label htmlFor="select-users" className="cursor-pointer">
                    Select Users
                  </Label>
                </div>
              </RadioGroup>

              {recipientMode === 'select' && (
                <Card className="border-border/50">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Select Recipients</CardTitle>
                      <Badge variant="secondary">{selectedUserIds.size} selected</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                        <Input
                          type="text"
                          placeholder="Search users..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-10"
                          disabled={loadingUsers}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Filter className="w-4 h-4 text-muted-foreground" />
                        <Select
                          value={checksFilter}
                          onValueChange={(value) => setChecksFilter(value as ChecksFilter)}
                          disabled={loadingUsers}
                        >
                          <SelectTrigger className="w-[180px]">
                            <SelectValue placeholder="Filter by checks" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Users</SelectItem>
                            <SelectItem value="with-checks">With Checks</SelectItem>
                            <SelectItem value="without-checks">Without Checks</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {loadingUsers ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-primary" />
                      </div>
                    ) : (
                      <ScrollArea className="h-[300px] w-full rounded-md border">
                        <div className="p-4 space-y-2">
                          {filteredUsers.length > 0 && (
                            <div className="flex items-center space-x-2 pb-2 border-b cursor-pointer">
                              <Checkbox
                                checked={selectedUserIds.size === filteredUsers.length && filteredUsers.length > 0}
                                onCheckedChange={handleSelectAll}
                                className="cursor-pointer"
                              />
                              <Label className="text-sm cursor-pointer">Select All</Label>
                            </div>
                          )}
                          {filteredUsers.map((user) => (
                            <div
                              key={user.id}
                              className="flex items-center space-x-2 p-2 rounded hover:bg-muted/50 cursor-pointer"
                              onClick={() => handleSelectUser(user.id)}
                            >
                              <Checkbox
                                checked={selectedUserIds.has(user.id)}
                                onCheckedChange={() => handleSelectUser(user.id)}
                                className="cursor-pointer"
                              />
                              <div className="flex-1">
                                <div className="text-sm font-medium">{user.displayName || user.email}</div>
                                {user.displayName && (
                                  <div className="text-xs text-muted-foreground">{user.email}</div>
                                )}
                              </div>
                            </div>
                          ))}
                          {filteredUsers.length === 0 && (
                            <div className="text-center py-8 text-muted-foreground">
                              {searchQuery ? 'No users found' : 'No users available'}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button
                onClick={handleSend}
                disabled={
                  sending ||
                  !subject.trim() ||
                  !htmlBody.trim() ||
                  (recipientMode === 'select' && selectedUserIds.size === 0) ||
                  (recipientMode === 'select' && allUsers.length === 0)
                }
                className="cursor-pointer gap-2"
              >
                {sending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Send Email
                  </>
                )}
              </Button>
            </div>

            {sending && sendProgress.total > 0 && (
              <div className="space-y-2">
                <Progress value={(sendProgress.sent / sendProgress.total) * 100} />
                <p className="text-xs text-muted-foreground text-center">
                  Sending {sendProgress.sent}/{sendProgress.total}...
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmationModal
        isOpen={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        onConfirm={handleConfirmSend}
        title="Confirm Send Email"
        message={`Are you sure you want to send this email to ${recipientCount} ${typeof recipientCount === 'number' && recipientCount === 1 ? 'recipient' : 'recipients'}?`}
        confirmText="Send Email"
        cancelText="Cancel"
        variant="info"
        icon={Mail}
      />
    </PageContainer>
  );
};

export default BulkEmail;

