import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { Link } from 'react-router-dom';
import { BarChart3, Eye, HelpCircle, MoreVertical, Plus, Settings, Trash2, Edit, Search, Sparkles, Folder, ChevronRight, ArrowRight } from 'lucide-react';
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
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Switch,
  RadioGroup,
  RadioGroupItem,
  glassClasses,
} from '../components/ui';
import { db, storage } from '../firebase';
import { useChecks } from '../hooks/useChecks';
import { useNanoPlan } from '../hooks/useNanoPlan';
import { toast } from 'sonner';
import type { StatusPage, StatusPageLayout, StatusPageVisibility, Website, CustomLayoutConfig } from '../types';
import { buildFolderList, normalizeFolder, folderHasPrefix } from '../lib/folder-utils';

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
  const [formFolderPaths, setFormFolderPaths] = useState<Set<string>>(new Set());
  const [formLogoUrl, setFormLogoUrl] = useState('');
  const [formFaviconUrl, setFormFaviconUrl] = useState('');
  const [formBrandColor, setFormBrandColor] = useState('');
  const [formCustomDomain, setFormCustomDomain] = useState('');
  const [formCustomLayout, setFormCustomLayout] = useState<CustomLayoutConfig | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [faviconUploading, setFaviconUploading] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
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

  // Build folder structure for the selection UI
  const folderList = useMemo(() => buildFolderList(checks), [checks]);

  // Get checks that don't belong to any folder (root level)
  const rootChecks = useMemo(
    () => checks.filter((check) => !normalizeFolder(check.folder)),
    [checks]
  );

  // Calculate total selected count (individual checks + checks from selected folders)
  const totalSelectedCount = useMemo(() => {
    const selectedCheckIds = new Set(formCheckIds);
    // Add checks from selected folders
    for (const folderPath of formFolderPaths) {
      for (const check of checks) {
        if (folderHasPrefix(check.folder, folderPath)) {
          selectedCheckIds.add(check.id);
        }
      }
    }
    return selectedCheckIds.size;
  }, [formCheckIds, formFolderPaths, checks]);

  const openCreate = () => {
    setEditingPage(null);
    setFormName('');
    setFormVisibility('private');
    setFormLayout('grid-2');
    setFormGroupByFolder(hasFolders);
    setFormCheckIds(new Set());
    setFormFolderPaths(new Set());
    setFormLogoUrl('');
    setFormFaviconUrl('');
    setFormBrandColor('');
    setFormCustomDomain('');
    setFormCustomLayout(null);
    setCurrentStep(1);
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
    setFormFolderPaths(new Set(page.folderPaths || []));
    setFormLogoUrl(page.branding?.logoUrl ?? '');
    setFormFaviconUrl(page.branding?.faviconUrl ?? '');
    setFormBrandColor(page.branding?.brandColor ?? '');
    setFormCustomDomain(page.customDomain?.hostname ?? '');
    setFormCustomLayout(page.customLayout ?? null);
    setCurrentStep(1);
    setSearchQuery('');
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingPage(null);
    setCurrentStep(1);
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

  const toggleFolder = (folderPath: string) => {
    setFormFolderPaths((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  // Check if a check is included via folder selection
  const isCheckIncludedViaFolder = useCallback((checkId: string) => {
    const check = checks.find((c) => c.id === checkId);
    if (!check || !check.folder) return false;
    for (const folderPath of formFolderPaths) {
      if (folderHasPrefix(check.folder, folderPath)) {
        return true;
      }
    }
    return false;
  }, [checks, formFolderPaths]);

  // Get counts for each folder (including nested checks)
  const getFolderCheckCount = useCallback((folderPath: string) => {
    return checks.filter((check) => folderHasPrefix(check.folder, folderPath)).length;
  }, [checks]);

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
      folderPaths: Array.from(formFolderPaths),
      layout: formLayout,
      groupByFolder: formGroupByFolder,
      branding: hasBranding ? branding : null,
      customDomain: nextCustomDomain,
      customLayout: formLayout === 'custom' ? formCustomLayout : null,
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
                        {(page.folderPaths?.length ?? 0) > 0 && (
                          <span className="ml-1 text-xs">
                            + {page.folderPaths?.length} folder{page.folderPaths?.length === 1 ? '' : 's'}
                          </span>
                        )}
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
                    <p className="text-xs text-muted-foreground">Step {currentStep} of 3</p>
                  </div>
                </div>
              </div>

              {/* Progress Steps */}
              <div className="flex items-center gap-2 mb-6">
                {[1, 2, 3].map((step) => (
                  <div
                    key={step}
                    className={`flex-1 h-0.5 rounded-full transition-colors ${step <= currentStep ? 'bg-primary' : 'bg-muted'
                      }`}
                  />
                ))}
              </div>

              {/* Step Content */}
              <div className="min-w-0 flex flex-col flex-1 min-h-0 space-y-8">
                {/* Step 1: Basic Settings */}
                {currentStep === 1 && (
                  <div className="space-y-8">
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Basic Settings</h3>
                      <p className="text-xs text-muted-foreground">
                        Give your status page a name and choose who can see it
                      </p>
                    </div>

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
                        <p className="text-xs text-muted-foreground">
                          Public pages can be viewed by anyone with the link. Private pages require authentication.
                        </p>
                      </div>

                    </div>
                  </div>
                )}

                {/* Step 2: Select Checks */}
                {currentStep === 2 && (
                  <div className="flex flex-col gap-2 flex-1 min-h-0">
                    <div className="space-y-2 mb-4">
                      <h3 className="text-sm font-medium">Select Checks</h3>
                      <p className="text-xs text-muted-foreground">
                        Choose which checks to display on this status page
                      </p>
                    </div>

                    <div className="flex items-center justify-between">
                      <Label>Checks</Label>
                      <span className="text-xs text-muted-foreground">
                        {totalSelectedCount} selected
                        {formFolderPaths.size > 0 && (
                          <span className="ml-1">({formFolderPaths.size} folder{formFolderPaths.size > 1 ? 's' : ''})</span>
                        )}
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
                        ) : checks.length === 0 ? (
                          <div className="text-sm text-muted-foreground">No checks available yet.</div>
                        ) : searchQuery.trim() ? (
                          /* Search mode: show flat list of matching checks */
                          filteredChecks.length === 0 ? (
                            <div className="text-sm text-muted-foreground">No checks match your search.</div>
                          ) : (
                            filteredChecks.map((check) => {
                              const includedViaFolder = isCheckIncludedViaFolder(check.id);
                              return (
                                <label
                                  key={check.id}
                                  className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                                    includedViaFolder ? 'bg-primary/5 border-primary/30' : 'hover:bg-muted/40'
                                  }`}
                                >
                                  <Checkbox
                                    checked={formCheckIds.has(check.id) || includedViaFolder}
                                    onCheckedChange={() => toggleCheck(check.id)}
                                    disabled={includedViaFolder}
                                    className="mt-1"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm font-medium text-foreground truncate">
                                        {check.name}
                                      </span>
                                      {includedViaFolder && (
                                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                          via folder
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="text-xs text-muted-foreground break-all">
                                      {check.url}
                                    </div>
                                    {check.folder && (
                                      <div className="text-xs text-muted-foreground/70 mt-0.5 flex items-center gap-1">
                                        <Folder className="w-3 h-3" />
                                        {check.folder}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            })
                          )
                        ) : (
                          /* Normal mode: show folders first, then ungrouped checks */
                          <>
                            {/* Folders section */}
                            {folderList.length > 0 && (
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1 pb-1">
                                  Folders
                                </div>
                                {folderList
                                  .filter((folder) => folder.depth === 1)
                                  .map((folder) => {
                                    const checkCount = getFolderCheckCount(folder.path);
                                    const isSelected = formFolderPaths.has(folder.path);
                                    const subfolders = folderList.filter((f) => f.parentPath === folder.path);
                                    
                                    return (
                                      <div key={folder.path}>
                                        <label
                                          className={`flex items-center gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                                            isSelected ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40'
                                          }`}
                                        >
                                          <Checkbox
                                            checked={isSelected}
                                            onCheckedChange={() => toggleFolder(folder.path)}
                                          />
                                          <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
                                          <div className="min-w-0 flex-1">
                                            <div className="text-sm font-medium text-foreground">
                                              {folder.name}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                              {checkCount} check{checkCount !== 1 ? 's' : ''}
                                              {isSelected && ' (auto-includes new checks)'}
                                            </div>
                                          </div>
                                        </label>
                                        {/* Nested subfolders */}
                                        {subfolders.length > 0 && (
                                          <div className="ml-6 mt-1 space-y-1">
                                            {subfolders.map((subfolder) => {
                                              const subCheckCount = getFolderCheckCount(subfolder.path);
                                              const isSubSelected = formFolderPaths.has(subfolder.path);
                                              const parentSelected = formFolderPaths.has(folder.path);
                                              
                                              return (
                                                <label
                                                  key={subfolder.path}
                                                  className={`flex items-center gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                                                    isSubSelected || parentSelected ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40'
                                                  }`}
                                                >
                                                  <Checkbox
                                                    checked={isSubSelected || parentSelected}
                                                    onCheckedChange={() => toggleFolder(subfolder.path)}
                                                    disabled={parentSelected}
                                                  />
                                                  <ChevronRight className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                                                  <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
                                                  <div className="min-w-0 flex-1">
                                                    <div className="text-sm font-medium text-foreground">
                                                      {subfolder.name}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                      {subCheckCount} check{subCheckCount !== 1 ? 's' : ''}
                                                      {(isSubSelected || parentSelected) && ' (auto-includes new checks)'}
                                                    </div>
                                                  </div>
                                                </label>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            )}

                            {/* Divider between folders and individual checks */}
                            {folderList.length > 0 && (rootChecks.length > 0 || checks.some((c) => c.folder && !formFolderPaths.has(normalizeFolder(c.folder) ?? ''))) && (
                              <div className="border-t my-3" />
                            )}

                            {/* Individual checks section */}
                            <div className="space-y-1">
                              {(folderList.length > 0 || rootChecks.length > 0) && (
                                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1 pb-1">
                                  {folderList.length > 0 ? 'Individual Checks' : 'Checks'}
                                </div>
                              )}
                              {sortedChecks.map((check) => {
                                const includedViaFolder = isCheckIncludedViaFolder(check.id);
                                
                                return (
                                  <label
                                    key={check.id}
                                    className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                                      includedViaFolder ? 'bg-primary/5 border-primary/30 opacity-60' : 'hover:bg-muted/40'
                                    }`}
                                  >
                                    <Checkbox
                                      checked={formCheckIds.has(check.id) || includedViaFolder}
                                      onCheckedChange={() => toggleCheck(check.id)}
                                      disabled={includedViaFolder}
                                      className="mt-1"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-foreground truncate">
                                          {check.name}
                                        </span>
                                        {includedViaFolder && (
                                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                            via folder
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="text-xs text-muted-foreground break-all">
                                        {check.url}
                                      </div>
                                      {check.folder && !includedViaFolder && (
                                        <div className="text-xs text-muted-foreground/70 mt-0.5 flex items-center gap-1">
                                          <Folder className="w-3 h-3" />
                                          {check.folder}
                                        </div>
                                      )}
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                )}

                {/* Step 3: Appearance */}
                {currentStep === 3 && (
                  <div className="space-y-8">
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Appearance</h3>
                      <p className="text-xs text-muted-foreground">
                        Customize how your status page looks
                      </p>
                    </div>

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
                      <div
                        className={`flex items-start gap-3 rounded-md border-2 px-3 py-2 transition-colors ${
                          nano
                            ? `cursor-pointer ${formLayout === 'custom' ? 'border-primary/60 bg-primary/5' : 'border-amber-400/60 hover:border-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-950/20'}`
                            : 'border-amber-400/40'
                        }`}
                      >
                        <label
                          htmlFor={nano ? "status-layout-custom" : undefined}
                          className={`flex items-start gap-3 flex-1 ${nano ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
                          onClick={nano ? undefined : (e) => e.preventDefault()}
                        >
                          <RadioGroupItem id="status-layout-custom" value="custom" className="mt-1" disabled={!nano} />
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">Custom</span>
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400">
                                Nano
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">Drag and drop widgets to create your own layout.</div>
                          </div>
                        </label>
                        {!nano && (
                          <Button asChild size="sm" className="cursor-pointer shrink-0">
                            <Link to="/billing">Upgrade</Link>
                          </Button>
                        )}
                      </div>
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
                  </div>
                )}
              </div>

              {/* Navigation */}
              <div className="flex items-center justify-between pt-6 border-t mt-8">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCurrentStep(currentStep - 1)}
                  disabled={currentStep === 1}
                  className="h-8 px-3 text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  Back
                </Button>

                {currentStep < 3 ? (
                  <Button
                    type="button"
                    onClick={() => setCurrentStep(currentStep + 1)}
                    className="h-8 px-4"
                  >
                    Next
                    <ArrowRight className="w-3 h-3 ml-1" />
                  </Button>
                ) : (
                  <Button
                    onClick={handleSave}
                    disabled={saving || isUploading}
                    className="h-8 px-4"
                  >
                    {isUploading ? 'Uploading...' : saving ? 'Saving...' : editingPage ? 'Save Changes' : 'Create Status Page'}
                  </Button>
                )}
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
