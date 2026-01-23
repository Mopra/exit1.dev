import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { Link } from 'react-router-dom';
import { BarChart3, Eye, HelpCircle, MoreVertical, Plus, Settings, Trash2, Edit, Search, Sparkles } from 'lucide-react';
import { PageContainer, PageHeader } from '../components/layout';
import ChecksTableShell from '../components/check/ChecksTableShell';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmationModal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  EmptyState,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Switch,
  RadioGroup,
  RadioGroupItem,
  glassClasses,
  Alert,
  AlertDescription,
} from '../components/ui';
import { db, storage } from '../firebase';
import { useChecks } from '../hooks/useChecks';
import { useNanoPlan } from '../hooks/useNanoPlan';
import { toast } from 'sonner';
import type { StatusPage, StatusPageLayout, StatusPageVisibility, Website } from '../types';

type BrandAssetKind = 'logo' | 'favicon';

const BRAND_LIMITS = {
  logo: {
    maxInputBytes: 150 * 1024,
    maxWidth: 400,
    maxHeight: 200,
    accept: 'image/jpeg,image/png',
  },
  favicon: {
    maxInputBytes: 150 * 1024,
    maxWidth: 96,
    maxHeight: 96,
    accept: 'image/png,image/gif,image/x-icon,image/vnd.microsoft.icon',
  },
} as const;

const CUSTOM_DOMAIN_TARGET = 'app.exit1.dev';

// Free tier limit for status pages
const FREE_TIER_STATUS_PAGE_LIMIT = 1;

const normalizeDomainInput = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).hostname.replace(/\.$/, '');
    }
    if (trimmed.includes('/')) {
      return new URL(`https://${trimmed}`).hostname.replace(/\.$/, '');
    }
    return trimmed.split(':')[0].replace(/\.$/, '');
  } catch {
    return trimmed.split('/')[0].split(':')[0].replace(/\.$/, '');
  }
};

const isValidHostname = (value: string) => {
  if (!value || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => (
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith('-') &&
    !label.endsWith('-') &&
    /^[a-z0-9-]+$/i.test(label)
  ));
};

const normalizeBrandColor = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(trimmed)) {
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  }
  return trimmed;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const loadImageFromFile = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const previewUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(previewUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(previewUrl);
      reject(new Error('Unable to read image.'));
    };
    img.src = previewUrl;
  });

const validateImageDimensions = async (file: File, kind: BrandAssetKind) => {
  const { maxWidth, maxHeight } = BRAND_LIMITS[kind];
  const img = await loadImageFromFile(file);
  if (img.width > maxWidth || img.height > maxHeight) {
    throw new Error(
      `${kind === 'logo' ? 'Logo' : 'Favicon'} must be <= ${maxWidth}x${maxHeight}px.`
    );
  }
};

const Status: React.FC = () => {
  const { userId } = useAuth();
  const log = useCallback((msg: string) => {
    void msg;
  }, []);
  const { nano } = useNanoPlan();
  const { checks, loading: checksLoading } = useChecks(userId ?? null, log);

  const [statusPages, setStatusPages] = useState<StatusPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingPage, setEditingPage] = useState<StatusPage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StatusPage | null>(null);
  const [formName, setFormName] = useState('');
  const [formVisibility, setFormVisibility] = useState<StatusPageVisibility>('private');
  const [formLayout, setFormLayout] = useState<StatusPageLayout>('grid-2');
  const [formGroupByFolder, setFormGroupByFolder] = useState(false);
  const [formCheckIds, setFormCheckIds] = useState<Set<string>>(new Set());
  const [formLogoUrl, setFormLogoUrl] = useState('');
  const [formFaviconUrl, setFormFaviconUrl] = useState('');
  const [formBrandColor, setFormBrandColor] = useState('');
  const [formCustomDomain, setFormCustomDomain] = useState('');
  const [logoUploading, setLogoUploading] = useState(false);
  const [faviconUploading, setFaviconUploading] = useState(false);
  const [activeTab, setActiveTab] = useState<'checks' | 'appearance' | 'settings'>('checks');
  const [searchQuery, setSearchQuery] = useState('');

  // Free tier limit: 1 status page, Nano: unlimited
  const atFreeLimit = !nano && statusPages.length >= FREE_TIER_STATUS_PAGE_LIMIT;
  const canCreateStatusPage = nano || statusPages.length < FREE_TIER_STATUS_PAGE_LIMIT;

  useEffect(() => {
    if (!userId) {
      setStatusPages([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(
      collection(db, 'status_pages'),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<StatusPage, 'id'>),
        }));
        setStatusPages(data);
        setLoading(false);
      },
      (error) => {
        console.error('[Status] Failed to load status pages:', error);
        toast.error('Failed to load status pages');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  const sortedChecks = useMemo(() => {
    return [...checks].sort((a: Website, b: Website) => a.name.localeCompare(b.name));
  }, [checks]);

  const filteredChecks = useMemo(() => {
    if (!searchQuery.trim()) {
      return sortedChecks;
    }
    const query = searchQuery.toLowerCase().trim();
    return sortedChecks.filter((check) => 
      check.name.toLowerCase().includes(query) || 
      check.url.toLowerCase().includes(query)
    );
  }, [sortedChecks, searchQuery]);

  const hasFolders = useMemo(
    () => checks.some((check) => (check.folder ?? '').trim().length > 0),
    [checks]
  );

  const openCreate = () => {
    setEditingPage(null);
    setFormName('');
    setFormVisibility('private');
    setFormLayout('grid-2');
    setFormGroupByFolder(hasFolders);
    setFormCheckIds(new Set());
    setFormLogoUrl('');
    setFormFaviconUrl('');
    setFormBrandColor('');
    setFormCustomDomain('');
    setActiveTab('checks');
    setSearchQuery('');
    setFormOpen(true);
  };

  const openEdit = (page: StatusPage) => {
    setEditingPage(page);
    setFormName(page.name);
    setFormVisibility(page.visibility);
    setFormLayout(page.layout ?? 'grid-2');
    setFormGroupByFolder(page.groupByFolder ?? false);
    setFormCheckIds(new Set(page.checkIds || []));
    setFormLogoUrl(page.branding?.logoUrl ?? '');
    setFormFaviconUrl(page.branding?.faviconUrl ?? '');
    setFormBrandColor(page.branding?.brandColor ?? '');
    setFormCustomDomain(page.customDomain?.hostname ?? '');
    setActiveTab('checks');
    setSearchQuery('');
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingPage(null);
  };

  const toggleCheck = (checkId: string) => {
    setFormCheckIds((prev) => {
      const next = new Set(prev);
      if (next.has(checkId)) {
        next.delete(checkId);
      } else {
        next.add(checkId);
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!userId) {
      toast.error('You must be signed in to save status pages.');
      return;
    }
    if (logoUploading || faviconUploading) {
      toast.error('Wait for uploads to finish before saving.');
      return;
    }

    const trimmedName = formName.trim();
    if (trimmedName.length < 2) {
      toast.error('Status page name must be at least 2 characters.');
      return;
    }

    const normalizedCustomDomain = normalizeDomainInput(formCustomDomain);
    if (normalizedCustomDomain && !isValidHostname(normalizedCustomDomain)) {
      toast.error('Custom domain must be a valid hostname.');
      return;
    }
    if (normalizedCustomDomain && formVisibility !== 'public') {
      toast.error('Custom domains require public visibility.');
      return;
    }

    setSaving(true);
    const now = Date.now();
    const logoUrl = formLogoUrl.trim();
    const faviconUrl = formFaviconUrl.trim();
    const brandColor = formBrandColor.trim();
    const branding = {
      logoUrl: logoUrl.length > 0 ? logoUrl : null,
      faviconUrl: faviconUrl.length > 0 ? faviconUrl : null,
      brandColor: brandColor.length > 0 ? brandColor : null,
    };
    const hasBranding = Object.values(branding).some((value) => Boolean(value));

    const nextCustomDomain = (() => {
      if (!nano) {
        return editingPage?.customDomain ?? null;
      }
      if (!normalizedCustomDomain) {
        return null;
      }
      if (editingPage?.customDomain?.hostname === normalizedCustomDomain) {
        return editingPage.customDomain ?? null;
      }
      return {
        hostname: normalizedCustomDomain,
        status: 'pending' as const,
      };
    })();

    const payload = {
      name: trimmedName,
      visibility: formVisibility,
      checkIds: Array.from(formCheckIds),
      layout: formLayout,
      groupByFolder: formGroupByFolder,
      branding: hasBranding ? branding : null,
      customDomain: nextCustomDomain,
      updatedAt: now,
    };

    try {
      if (editingPage) {
        await updateDoc(doc(db, 'status_pages', editingPage.id), payload);
        toast.success('Status page updated.');
      } else {
        await addDoc(collection(db, 'status_pages'), {
          ...payload,
          userId,
          createdAt: now,
        });
        toast.success('Status page created.');
      }
      setFormOpen(false);
      setEditingPage(null);
    } catch (error) {
      console.error('[Status] Failed to save status page:', error);
      toast.error('Failed to save status page');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteDoc(doc(db, 'status_pages', deleteTarget.id));
      toast.success('Status page deleted.');
    } catch (error) {
      console.error('[Status] Failed to delete status page:', error);
      toast.error('Failed to delete status page');
    } finally {
      setDeleteTarget(null);
    }
  };

  const hasRows = !loading && statusPages.length > 0;
  const normalizedBrandColor = normalizeBrandColor(formBrandColor);
  const brandColorPreview =
    normalizedBrandColor && normalizedBrandColor.startsWith('#') ? normalizedBrandColor : '#000000';
  const isUploading = logoUploading || faviconUploading;
  const brandingDisabled = !nano;
  const normalizedCustomDomain = normalizeDomainInput(formCustomDomain);
  const customDomainIsValid = !normalizedCustomDomain || isValidHostname(normalizedCustomDomain);
  const customDomainDisabled = !nano;
  const showCustomDomainDns = normalizedCustomDomain && customDomainIsValid;
  const customDomainHostLabel = normalizedCustomDomain || 'status.example.com';

  const handleBrandUpload = async (kind: BrandAssetKind, file: File) => {
    if (!userId) {
      toast.error('You must be signed in to upload assets.');
      return;
    }

    const limits = BRAND_LIMITS[kind];
    if (!limits.accept.split(',').includes(file.type)) {
      toast.error(`Unsupported file type for ${kind}.`);
      return;
    }
    if (file.size > limits.maxInputBytes) {
      toast.error(`File too large. Max ${formatBytes(limits.maxInputBytes)} for ${kind}.`);
      return;
    }

    kind === 'logo' ? setLogoUploading(true) : setFaviconUploading(true);
    try {
      await validateImageDimensions(file, kind);
      const extension = file.name.split('.').pop()?.toLowerCase() || 'png';
      const path = [
        'status-branding',
        userId,
        editingPage?.id ?? 'draft',
        `${kind}-${Date.now()}.${extension}`,
      ].join('/');
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file, {
        contentType: file.type,
        cacheControl: 'public,max-age=31536000',
      });
      const downloadUrl = await getDownloadURL(storageRef);
      if (kind === 'logo') {
        setFormLogoUrl(downloadUrl);
      } else {
        setFormFaviconUrl(downloadUrl);
      }
      toast.success(`${kind === 'logo' ? 'Logo' : 'Favicon'} uploaded.`);
    } catch (error) {
      console.error('[Status] Upload failed:', error);
      const message = error instanceof Error ? error.message : `Failed to upload ${kind}.`;
      toast.error(message);
    } finally {
      kind === 'logo' ? setLogoUploading(false) : setFaviconUploading(false);
    }
  };

  const handleBrandDrop = (kind: BrandAssetKind) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void handleBrandUpload(kind, file);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title={
          <div className="flex items-center gap-2">
            <span>Status Pages</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5">
              Beta
            </Badge>
          </div>
        }
        description="Create shareable status pages with live check updates"
        icon={BarChart3}
        actions={(
          <Button 
            onClick={openCreate} 
            className="gap-2 cursor-pointer"
            disabled={!canCreateStatusPage}
            title={!canCreateStatusPage ? 'Upgrade to Nano for unlimited status pages' : undefined}
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Status Page</span>
          </Button>
        )}
      />

      <div className="flex-1 p-4 sm:p-6 min-h-0">
        <ChecksTableShell
          minWidthClassName="min-w-[720px]"
          hasRows={hasRows}
          emptyState={loading ? (
            <EmptyState
              variant="loading"
              title="Loading status pages"
              description="Fetching your status pages."
            />
          ) : (
            <EmptyState
              variant="empty"
              icon={HelpCircle}
              title="No status pages yet"
              description="Create a status page to share live uptime for selected checks."
              action={{ label: 'Create Status Page', onClick: openCreate }}
            />
          )}
          table={(
            <Table>
              <TableHeader className="bg-muted border-b">
                <TableRow>
                  <TableHead className="px-4 py-4 text-left w-[30%]">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Name
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-[15%]">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Checks
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-left w-[20%]">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Visibility
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-center w-[20%]">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      View
                    </div>
                  </TableHead>
                  <TableHead className="px-4 py-4 text-center w-[15%]">
                    <div className="text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground">
                      Actions
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-border">
                {statusPages.map((page) => (
                  <TableRow key={page.id} className="group">
                    <TableCell className="px-4 py-4">
                      <div className="font-medium text-sm text-foreground">
                        {page.name}
                      </div>
                      {page.customDomain?.hostname && (
                        <div className="text-xs text-muted-foreground mt-1 break-all">
                          {page.customDomain.hostname}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="text-sm text-muted-foreground">
                        {page.checkIds?.length ?? 0} {page.checkIds?.length === 1 ? 'check' : 'checks'}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <Badge variant={page.visibility === 'public' ? 'default' : 'secondary'}>
                        {page.visibility === 'public' ? 'Public' : 'Private'}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-4 text-center">
                      <Button asChild variant="ghost" size="icon" aria-label="View status page">
                        <Link to={`/status/${page.id}`} target="_blank" rel="noopener noreferrer">
                          <Eye className="w-4 h-4" />
                        </Link>
                      </Button>
                    </TableCell>
                    <TableCell className="px-4 py-4">
                      <div className="flex items-center justify-center">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton
                              icon={<MoreVertical className="w-4 h-4" />}
                              size="sm"
                              variant="ghost"
                              aria-label="More actions"
                              aria-haspopup="menu"
                              className="text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-1 transition-colors cursor-pointer"
                            />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className={`${glassClasses} z-[55]`}>
                            <DropdownMenuItem
                              onClick={() => openEdit(page)}
                              className="cursor-pointer font-mono"
                            >
                              <Settings className="w-3 h-3" />
                              <span className="ml-2">Settings</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(page)}
                              className="cursor-pointer font-mono text-destructive focus:text-destructive"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span className="ml-2">Delete</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {/* Upgrade row for free users at limit */}
                {atFreeLimit && (
                  <TableRow className="bg-primary/5 hover:bg-primary/10 transition-colors">
                    <TableCell colSpan={5} className="px-4 py-5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
                            <Sparkles className="w-4 h-4 text-primary" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              Want more status pages?
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Upgrade to Nano for unlimited status pages, custom branding, and custom domains.
                            </p>
                          </div>
                        </div>
                        <Button asChild size="sm" className="shrink-0 cursor-pointer gap-1.5">
                          <Link to="/billing">
                            <Sparkles className="w-3.5 h-3.5" />
                            Upgrade to Nano
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        />
      </div>

      <Sheet open={formOpen} onOpenChange={(open) => (open ? setFormOpen(true) : closeForm())}>
        <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0">
          <ScrollArea className="h-full">
            <div className="p-7 sm:p-8 flex flex-col h-full min-h-0">
              {/* Header */}
              <div className="flex items-center mb-10">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                    {editingPage ? (
                      <Edit className="w-4 h-4 text-primary" />
                    ) : (
                      <Plus className="w-4 h-4 text-primary" />
                    )}
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold">
                      {editingPage ? 'Edit Status Page' : 'New Status Page'}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Choose which checks appear on this status page and whether it is public.
                    </p>
                  </div>
                </div>
              </div>

              {/* Tabs Navigation */}
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'checks' | 'appearance' | 'settings')} className="min-w-0 flex flex-col flex-1 min-h-0">
                <TabsList className="w-full sm:w-fit">
                  <TabsTrigger value="checks">Checks</TabsTrigger>
                  <TabsTrigger value="appearance">Appearance</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>

                {/* Checks Tab */}
                <TabsContent value="checks" className="mt-4 flex flex-col min-h-0 flex-1">
                  <div className="flex flex-col gap-2 flex-1 min-h-0">
                    <div className="flex items-center justify-between">
                      <Label>Checks</Label>
                      <span className="text-xs text-muted-foreground">
                        {formCheckIds.size} selected
                      </span>
                    </div>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                      <Input
                        type="text"
                        placeholder="Search checks by name or URL..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                      />
                    </div>
                    <ScrollArea className="flex-1 rounded-md border min-h-0">
                      <div className="p-3 space-y-2">
                        {checksLoading ? (
                          <div className="text-sm text-muted-foreground">Loading checks...</div>
                        ) : filteredChecks.length === 0 ? (
                          <div className="text-sm text-muted-foreground">
                            {searchQuery.trim() ? 'No checks match your search.' : 'No checks available yet.'}
                          </div>
                        ) : (
                          filteredChecks.map((check) => (
                            <label
                              key={check.id}
                              className="flex items-start gap-3 rounded-md border px-3 py-2 hover:bg-muted/40 cursor-pointer"
                            >
                              <Checkbox
                                checked={formCheckIds.has(check.id)}
                                onCheckedChange={() => toggleCheck(check.id)}
                                className="mt-1"
                              />
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-foreground truncate">
                                  {check.name}
                                </div>
                                <div className="text-xs text-muted-foreground break-all">
                                  {check.url}
                                </div>
                              </div>
                            </label>
                          ))
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                </TabsContent>

                {/* Appearance Tab */}
                <TabsContent value="appearance" className="mt-4 space-y-4">
                  <div className="space-y-3">
                    <Label className="text-sm">Layout</Label>
                    <RadioGroup
                      value={formLayout}
                      onValueChange={(value) => setFormLayout(value as StatusPageLayout)}
                      className="gap-2"
                    >
                      <label
                        htmlFor="status-layout-grid-2"
                        className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                          formLayout === 'grid-2' ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40'
                        }`}
                      >
                        <RadioGroupItem id="status-layout-grid-2" value="grid-2" className="mt-1" />
                        <div>
                          <div className="text-sm font-medium text-foreground">2-column grid</div>
                          <div className="text-xs text-muted-foreground">Full width layout (current default).</div>
                        </div>
                      </label>
                      <label
                        htmlFor="status-layout-grid-3"
                        className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                          formLayout === 'grid-3' ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40'
                        }`}
                      >
                        <RadioGroupItem id="status-layout-grid-3" value="grid-3" className="mt-1" />
                        <div>
                          <div className="text-sm font-medium text-foreground">3-column grid</div>
                          <div className="text-xs text-muted-foreground">Full width, denser layout.</div>
                        </div>
                      </label>
                      <label
                        htmlFor="status-layout-single"
                        className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                          formLayout === 'single-5xl' ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40'
                        }`}
                      >
                        <RadioGroupItem id="status-layout-single" value="single-5xl" className="mt-1" />
                        <div>
                          <div className="text-sm font-medium text-foreground">Single column</div>
                          <div className="text-xs text-muted-foreground">Centered, max width 5xl.</div>
                        </div>
                      </label>
                    </RadioGroup>
                  </div>
                  <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
                    <div className="space-y-1">
                      <Label className="text-sm">Group by folder</Label>
                      <p className="text-xs text-muted-foreground">
                        Show checks grouped under their folder names on the public status page.
                      </p>
                    </div>
                    <Switch
                      checked={formGroupByFolder}
                      onCheckedChange={setFormGroupByFolder}
                    />
                  </div>
                  <div className="rounded-md border px-3 py-3 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Label className="text-sm">Branding</Label>
                          {!nano && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 uppercase tracking-wide">
                              Nano
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Add a logo, favicon, and brand color to personalize your public status page.
                        </p>
                      </div>
                      {!nano && (
                        <Button asChild size="sm" className="cursor-pointer">
                          <Link to="/billing">Upgrade to Nano</Link>
                        </Button>
                      )}
                    </div>
                    <div className={brandingDisabled ? 'opacity-50 pointer-events-none' : undefined} aria-disabled={brandingDisabled}>
                      <div className="grid gap-2">
                        <Label>Logo</Label>
                        <div
                          className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-muted/30 cursor-pointer"
                          onClick={() => {
                            const input = document.getElementById('status-logo-upload') as HTMLInputElement | null;
                            input?.click();
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onDrop={handleBrandDrop('logo')}
                        >
                          <div className="text-sm font-medium text-foreground">
                            {logoUploading ? 'Uploading…' : 'Drag & drop logo, or click to select'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            JPG/PNG · max 400x200px · {formatBytes(BRAND_LIMITS.logo.maxInputBytes)}.
                          </div>
                          <input
                            id="status-logo-upload"
                            type="file"
                            accept={BRAND_LIMITS.logo.accept}
                            className="hidden"
                            disabled={logoUploading}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file) {
                                void handleBrandUpload('logo', file);
                              }
                            }}
                          />
                        </div>
                        {formLogoUrl.trim().length > 0 && (
                          <div className="flex items-center gap-3 rounded-md border px-3 py-2 bg-muted/30">
                            <img
                              src={formLogoUrl.trim()}
                              alt="Brand logo preview"
                              className="h-8 w-auto max-w-[140px] object-contain"
                              loading="lazy"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                              }}
                            />
                            <span className="text-xs text-muted-foreground">Logo preview</span>
                          </div>
                        )}
                      </div>
                      <div className="grid gap-2 mt-4">
                        <Label>Favicon</Label>
                        <div
                          className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-muted/30 cursor-pointer"
                          onClick={() => {
                            const input = document.getElementById('status-favicon-upload') as HTMLInputElement | null;
                            input?.click();
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onDrop={handleBrandDrop('favicon')}
                        >
                          <div className="text-sm font-medium text-foreground">
                            {faviconUploading ? 'Uploading…' : 'Drag & drop favicon, or click to select'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            PNG/GIF/ICO · max 96x96px · {formatBytes(BRAND_LIMITS.favicon.maxInputBytes)}.
                          </div>
                          <input
                            id="status-favicon-upload"
                            type="file"
                            accept={BRAND_LIMITS.favicon.accept}
                            className="hidden"
                            disabled={faviconUploading}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file) {
                                void handleBrandUpload('favicon', file);
                              }
                            }}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2 mt-4">
                        <Label htmlFor="status-brand-color">Brand color</Label>
                        <div className="flex items-center gap-3">
                          <Input
                            id="status-brand-color"
                            value={formBrandColor}
                            onChange={(event) => setFormBrandColor(event.target.value)}
                            placeholder="#3B82F6"
                          />
                          <Input
                            type="color"
                            value={brandColorPreview}
                            onChange={(event) => setFormBrandColor(event.target.value)}
                            className="h-9 w-12 p-1"
                            aria-label="Pick brand color"
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Use a hex color (for example #3B82F6). This will be used as an accent on the public status page.
                        </p>
                      </div>
                    </div>
                  </div>
                </TabsContent>

                {/* Settings Tab */}
                <TabsContent value="settings" className="mt-4 space-y-4">
                  <div className="space-y-6">
                    <div className="grid gap-2">
                      <Label htmlFor="status-page-name">Name</Label>
                      <Input
                        id="status-page-name"
                        value={formName}
                        onChange={(event) => setFormName(event.target.value)}
                        placeholder="Production status"
                      />
                    </div>

                    <div className="grid gap-2">
                      <Label>Visibility</Label>
                      <Select
                        value={formVisibility}
                        onValueChange={(value) => setFormVisibility(value as StatusPageVisibility)}
                      >
                        <SelectTrigger className="w-full cursor-pointer">
                          <SelectValue placeholder="Select visibility" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="public" className="cursor-pointer">Public</SelectItem>
                          <SelectItem value="private" className="cursor-pointer">Private</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="rounded-md border px-3 py-3 space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Label className="text-sm">Custom domain</Label>
                            {!nano && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 uppercase tracking-wide">
                                Nano
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Serve this status page from your own domain (for example status.yourcompany.com).
                          </p>
                        </div>
                        {!nano && (
                          <Button asChild size="sm" className="cursor-pointer">
                            <Link to="/billing">Upgrade to Nano</Link>
                          </Button>
                        )}
                      </div>
                      <div className={customDomainDisabled ? 'opacity-50 pointer-events-none' : undefined} aria-disabled={customDomainDisabled}>
                        <div className="grid gap-2">
                          <Label htmlFor="status-custom-domain">Domain</Label>
                          <Input
                            id="status-custom-domain"
                            value={formCustomDomain}
                            onChange={(event) => setFormCustomDomain(event.target.value)}
                            placeholder="status.yourcompany.com"
                          />
                          {!customDomainIsValid && (
                            <p className="text-xs text-destructive">Enter a valid hostname (no paths or protocols).</p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            We recommend using a subdomain. Root domains may require ALIAS/ANAME or CNAME flattening.
                          </p>
                        </div>
                        {showCustomDomainDns && (
                          <div className="mt-4 rounded-md border bg-muted/40 px-3 py-3 space-y-2 text-xs">
                            <div className="font-semibold uppercase tracking-wide text-muted-foreground">
                              DNS instructions
                            </div>
                            <div className="grid gap-1">
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Type</span>
                                <span className="font-mono">CNAME</span>
                              </div>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Host</span>
                                <span className="font-mono break-all">{customDomainHostLabel}</span>
                              </div>
                              <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">Points to</span>
                                <span className="font-mono">{CUSTOM_DOMAIN_TARGET}</span>
                              </div>
                            </div>
                            <p className="text-muted-foreground">
                              If you use Cloudflare, set the record to DNS-only (no proxy). DNS changes can take up to 72 hours to propagate.
                            </p>
                          </div>
                        )}
                        {normalizedCustomDomain && formVisibility !== 'public' && (
                          <Alert className="mt-3">
                            <AlertDescription>
                              Custom domains require the status page to be public. Switch visibility to public before saving.
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              {/* Footer Actions */}
              <div className="flex items-center justify-end gap-2 pt-4 mt-auto">
                <Button variant="ghost" onClick={closeForm}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving || isUploading}>
                  {isUploading ? 'Uploading...' : saving ? 'Saving...' : editingPage ? 'Save Changes' : 'Create Status Page'}
                </Button>
              </div>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <ConfirmationModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete "${deleteTarget?.name}"?`}
        message="This action cannot be undone. The status page will be permanently removed."
        confirmText="Delete Status Page"
        variant="destructive"
      />
    </PageContainer>
  );
};

export default Status;
