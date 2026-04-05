import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { Link } from 'react-router-dom';
import { BarChart3, Eye, HelpCircle, MoreVertical, Plus, Settings, Trash2, Edit, Search, Sparkles, Folder, ChevronRight, ChevronDown, Check, Zap } from 'lucide-react';
import { PageContainer, PageHeader, DocsLink } from '../components/layout';
import ChecksTableShell from '../components/check/ChecksTableShell';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmationModal,
  DowngradeBanner,
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
  SheetTitle,
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
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../components/ui';
import { db, storage } from '../firebase';
import { useChecks } from '../hooks/useChecks';
import { useNanoPlan } from '../hooks/useNanoPlan';
import { toast } from 'sonner';
import type { StatusPage, StatusPageLayout, StatusPageVisibility, Website, CustomLayoutConfig } from '../types';
import { buildFolderList, normalizeFolder } from '../lib/folder-utils';

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
  const [formCustomLayout, setFormCustomLayout] = useState<CustomLayoutConfig | null>(null);
  const [formShowPoweredBy, setFormShowPoweredBy] = useState(true);
  const [logoUploading, setLogoUploading] = useState(false);
  const [faviconUploading, setFaviconUploading] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Free tier limit: 1 status page, Nano: unlimited
  const atFreeLimit = !nano && statusPages.length >= FREE_TIER_STATUS_PAGE_LIMIT;
  const canCreateStatusPage = nano || statusPages.length < FREE_TIER_STATUS_PAGE_LIMIT;
  const hasDowngradedPages = statusPages.some((p) => p.disabledReason === 'plan_downgrade');

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

  // Calculate resolved check IDs (individual checks + checks from selected folders)
  // This resolves folder selections to explicit check IDs at save time
  // Each folder selection only includes its direct checks, not subfolder checks
  const resolvedCheckIds = useMemo(() => {
    const selectedCheckIds = new Set(formCheckIds);
    // Add checks from selected folders (exact match only — subfolders are independent)
    for (const folderPath of formFolderPaths) {
      for (const check of checks) {
        if (normalizeFolder(check.folder) === folderPath) {
          selectedCheckIds.add(check.id);
        }
      }
    }
    return selectedCheckIds;
  }, [formCheckIds, formFolderPaths, checks]);

  const totalSelectedCount = resolvedCheckIds.size;

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
    setFormCustomLayout(null);
    setChecksOpen(false);
    setAppearanceOpen(false);
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
    setFormCustomLayout(page.customLayout ?? null);
    setFormShowPoweredBy(page.showPoweredBy !== false);
    setChecksOpen(true);
    setAppearanceOpen(true);
    setSearchQuery('');
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingPage(null);
    setChecksOpen(false);
    setAppearanceOpen(false);
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
        // Also deselect any subfolders
        for (const f of folderList) {
          if (f.parentPath === folderPath) next.delete(f.path);
        }
      } else {
        next.add(folderPath);
        // Also select any subfolders
        for (const f of folderList) {
          if (f.parentPath === folderPath) next.add(f.path);
        }
      }
      return next;
    });
  };

  // Check if a check is included via folder selection
  const isCheckIncludedViaFolder = useCallback((checkId: string) => {
    const check = checks.find((c) => c.id === checkId);
    if (!check || !check.folder) return false;
    const checkFolder = normalizeFolder(check.folder);
    if (!checkFolder) return false;
    return formFolderPaths.has(checkFolder);
  }, [checks, formFolderPaths]);

  // Get counts for each folder (including nested checks)
  const getFolderCheckCount = useCallback((folderPath: string) => {
    return checks.filter((check) => normalizeFolder(check.folder) === folderPath).length;
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

    setSaving(true);
    const now = Date.now();
    const logoUrl = formLogoUrl.trim();
    const faviconUrl = formFaviconUrl.trim();
    const brandColor = normalizeBrandColor(formBrandColor);
    const branding = {
      logoUrl: logoUrl.length > 0 ? logoUrl : null,
      faviconUrl: faviconUrl.length > 0 ? faviconUrl : null,
      brandColor: brandColor || null,
    };
    const hasBranding = Object.values(branding).some((value) => Boolean(value));

    // Store individual check selections + folder paths separately
    // The backend dynamically resolves folder paths to include current folder contents
    const payload = {
      name: trimmedName,
      visibility: formVisibility,
      checkIds: Array.from(formCheckIds),
      folderPaths: Array.from(formFolderPaths),
      layout: formLayout,
      groupByFolder: formGroupByFolder,
      branding: hasBranding ? branding : null,
      customLayout: formLayout === 'custom' ? formCustomLayout : null,
      showPoweredBy: formShowPoweredBy,
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
          <div className="flex items-center gap-2">
            <DocsLink path="/status-pages" label="Status pages docs" />
            <Button
              onClick={openCreate}
              className="gap-2 cursor-pointer"
              disabled={!canCreateStatusPage}
              title={!canCreateStatusPage ? 'Upgrade to Nano for unlimited status pages' : undefined}
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Status Page</span>
            </Button>
          </div>
        )}
      />

      <div className="flex-1 p-2 sm:p-4 md:p-6 min-h-0 space-y-4">
        {hasDowngradedPages && !nano && (
          <DowngradeBanner message="Status pages require a Nano subscription. Upgrade to re-enable your status pages." />
        )}
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
                              Upgrade to Nano for unlimited status pages and custom branding.
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
        <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0 overflow-hidden">
          <SheetTitle className="sr-only">{editingPage ? 'Edit Status Page' : 'New Status Page'}</SheetTitle>
          <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-viewport]]:!overflow-x-hidden">
            <div className="p-7 sm:p-8 min-w-0">
              {/* Header */}
              <div className="flex items-center gap-3 mb-8">
                <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                  {editingPage ? (
                    <Edit className="w-4 h-4 text-primary" />
                  ) : (
                    <Plus className="w-4 h-4 text-primary" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    {editingPage ? 'Edit Status Page' : 'New Status Page'}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {editingPage ? 'Update your status page configuration' : 'Share uptime with your users'}
                  </p>
                </div>
              </div>

              <div className="space-y-6">
                {/* ── Essential Fields ── */}
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="status-page-name" className="text-xs font-medium text-muted-foreground">Name</Label>
                    <Input
                      id="status-page-name"
                      value={formName}
                      onChange={(event) => setFormName(event.target.value)}
                      placeholder="Production Status"
                      className="h-10 text-sm mt-1.5"
                      autoFocus
                    />
                  </div>

                  <div>
                    <Label className="text-xs font-medium text-muted-foreground">Visibility</Label>
                    <Select
                      value={formVisibility}
                      onValueChange={(value) => setFormVisibility(value as StatusPageVisibility)}
                    >
                      <SelectTrigger className="h-10 text-sm mt-1.5">
                        <SelectValue placeholder="Select visibility" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="public">Public</SelectItem>
                        <SelectItem value="private">Private</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      Public pages can be viewed by anyone with the link.
                    </p>
                  </div>
                </div>

                {/* ── Submit Button ── */}
                <Button
                  onClick={handleSave}
                  disabled={saving || isUploading}
                  className="w-full h-11 text-sm font-medium"
                >
                  {isUploading ? (
                    <>
                      <Zap className="w-4 h-4 mr-2 animate-pulse" />
                      Uploading...
                    </>
                  ) : saving ? (
                    <>
                      <Zap className="w-4 h-4 mr-2 animate-pulse" />
                      Saving...
                    </>
                  ) : (
                    <>
                      {editingPage ? <Check className="w-4 h-4 mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                      {editingPage ? 'Save Changes' : 'Create Status Page'}
                    </>
                  )}
                </Button>

                {/* ── Select Checks (collapsible) ── */}
                <Collapsible open={checksOpen} onOpenChange={setChecksOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 w-full py-3 group cursor-pointer">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors px-2">
                      <Folder className="w-3.5 h-3.5" />
                      Checks
                      {totalSelectedCount > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-1">{totalSelectedCount}</Badge>}
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${checksOpen ? 'rotate-180' : ''}`} />
                    </span>
                    <div className="h-px flex-1 bg-border/60" />
                  </CollapsibleTrigger>

                  <CollapsibleContent className="pt-2">
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-3">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                        <Input
                          type="text"
                          placeholder="Search checks..."
                          aria-label="Search checks"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="pl-10 h-8 text-xs"
                        />
                      </div>
                      <ScrollArea className="h-64 rounded-lg border border-border/30">
                        <div className="p-2 space-y-1">
                          {checksLoading ? (
                            <div className="text-xs text-muted-foreground p-2">Loading checks...</div>
                          ) : checks.length === 0 ? (
                            <div className="text-xs text-muted-foreground p-2">No checks available yet.</div>
                          ) : searchQuery.trim() ? (
                            filteredChecks.length === 0 ? (
                              <div className="text-xs text-muted-foreground p-2">No checks match your search.</div>
                            ) : (
                              filteredChecks.map((check) => {
                                const includedViaFolder = isCheckIncludedViaFolder(check.id);
                                return (
                                  <label
                                    key={check.id}
                                    className={`flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${
                                      includedViaFolder ? 'bg-primary/5' : 'hover:bg-muted/40'
                                    }`}
                                  >
                                    <Checkbox
                                      checked={formCheckIds.has(check.id) || includedViaFolder}
                                      onCheckedChange={() => toggleCheck(check.id)}
                                      disabled={includedViaFolder}
                                      className="mt-0.5"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-xs font-medium truncate">{check.name}</span>
                                        {includedViaFolder && (
                                          <Badge variant="secondary" className="text-[10px] px-1 py-0">via folder</Badge>
                                        )}
                                      </div>
                                      <div className="text-[10px] text-muted-foreground font-mono truncate">{check.url}</div>
                                    </div>
                                  </label>
                                );
                              })
                            )
                          ) : (
                            <>
                              {folderList.length > 0 && (
                                <div className="space-y-0.5">
                                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 pb-1">Folders</div>
                                  {folderList
                                    .filter((folder) => folder.depth === 1)
                                    .map((folder) => {
                                      const checkCount = getFolderCheckCount(folder.path);
                                      const isSelected = formFolderPaths.has(folder.path);
                                      const subfolders = folderList.filter((f) => f.parentPath === folder.path);
                                      return (
                                        <div key={folder.path}>
                                          <label className={`flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : 'hover:bg-muted/40'}`}>
                                            <Checkbox checked={isSelected} onCheckedChange={() => toggleFolder(folder.path)} />
                                            <Folder className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                            <span className="text-xs font-medium flex-1">{folder.name}</span>
                                            <span className="text-[10px] text-muted-foreground">{checkCount}</span>
                                          </label>
                                          {subfolders.length > 0 && (
                                            <div className="ml-5 space-y-0.5">
                                              {subfolders.map((subfolder) => {
                                                const subCheckCount = getFolderCheckCount(subfolder.path);
                                                const isSubSelected = formFolderPaths.has(subfolder.path);
                                                return (
                                                  <label key={subfolder.path} className={`flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${isSubSelected ? 'bg-primary/5' : 'hover:bg-muted/40'}`}>
                                                    <Checkbox checked={isSubSelected} onCheckedChange={() => toggleFolder(subfolder.path)} />
                                                    <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/50 shrink-0" />
                                                    <Folder className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                                    <span className="text-xs font-medium flex-1">{subfolder.name}</span>
                                                    <span className="text-[10px] text-muted-foreground">{subCheckCount}</span>
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
                              {folderList.length > 0 && (rootChecks.length > 0 || checks.some((c) => c.folder && !formFolderPaths.has(normalizeFolder(c.folder) ?? ''))) && (
                                <div className="border-t border-border/30 my-2" />
                              )}
                              <div className="space-y-0.5">
                                {(folderList.length > 0 || rootChecks.length > 0) && (
                                  <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 pb-1">
                                    {folderList.length > 0 ? 'Individual Checks' : 'Checks'}
                                  </div>
                                )}
                                {sortedChecks.map((check) => {
                                  const includedViaFolder = isCheckIncludedViaFolder(check.id);
                                  return (
                                    <label
                                      key={check.id}
                                      className={`flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors ${
                                        includedViaFolder ? 'bg-primary/5 opacity-60' : 'hover:bg-muted/40'
                                      }`}
                                    >
                                      <Checkbox
                                        checked={formCheckIds.has(check.id) || includedViaFolder}
                                        onCheckedChange={() => toggleCheck(check.id)}
                                        disabled={includedViaFolder}
                                        className="mt-0.5"
                                      />
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                          <span className="text-xs font-medium truncate">{check.name}</span>
                                          {includedViaFolder && (
                                            <Badge variant="secondary" className="text-[10px] px-1 py-0">via folder</Badge>
                                          )}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground font-mono truncate">{check.url}</div>
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
                  </CollapsibleContent>
                </Collapsible>

                {/* ── Appearance (collapsible) ── */}
                <Collapsible open={appearanceOpen} onOpenChange={setAppearanceOpen}>
                  <CollapsibleTrigger className="flex items-center gap-2 w-full py-3 group cursor-pointer">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors px-2">
                      <Settings className="w-3.5 h-3.5" />
                      Appearance
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${appearanceOpen ? 'rotate-180' : ''}`} />
                    </span>
                    <div className="h-px flex-1 bg-border/60" />
                  </CollapsibleTrigger>

                  <CollapsibleContent className="space-y-4 pt-2">
                    {/* Layout */}
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-3">
                      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Layout</div>
                      <RadioGroup
                        value={formLayout}
                        onValueChange={(value) => setFormLayout(value as StatusPageLayout)}
                        className="gap-1.5"
                      >
                        {[
                          { id: 'grid-2', label: '2-column grid', desc: 'Full width (default)' },
                          { id: 'grid-3', label: '3-column grid', desc: 'Full width, denser' },
                          { id: 'single-5xl', label: 'Single column', desc: 'Centered, max 5xl' },
                        ].map((opt) => (
                          <label
                            key={opt.id}
                            htmlFor={`status-layout-${opt.id}`}
                            className={`flex items-center gap-3 rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                              formLayout === opt.id ? 'bg-primary/5 border border-primary/30' : 'hover:bg-muted/30 border border-transparent'
                            }`}
                          >
                            <RadioGroupItem id={`status-layout-${opt.id}`} value={opt.id} />
                            <div>
                              <div className="text-xs font-medium">{opt.label}</div>
                              <div className="text-[10px] text-muted-foreground">{opt.desc}</div>
                            </div>
                          </label>
                        ))}
                        <div
                          className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                            nano
                              ? `cursor-pointer ${formLayout === 'custom' ? 'bg-primary/5 border-primary/30' : 'border-amber-400/40 hover:border-amber-400/60'}`
                              : 'border-amber-400/30'
                          }`}
                        >
                          <label
                            htmlFor={nano ? "status-layout-custom" : undefined}
                            className={`flex items-center gap-3 flex-1 ${nano ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
                            onClick={nano ? undefined : (e) => e.preventDefault()}
                          >
                            <RadioGroupItem id="status-layout-custom" value="custom" disabled={!nano} />
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium">Custom</span>
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400">
                                  Nano
                                </Badge>
                              </div>
                              <div className="text-[10px] text-muted-foreground">Drag and drop widgets</div>
                            </div>
                          </label>
                          {!nano && (
                            <Button asChild size="sm" className="cursor-pointer shrink-0 h-7 text-xs">
                              <Link to="/billing">Upgrade</Link>
                            </Button>
                          )}
                        </div>
                      </RadioGroup>
                    </div>

                    {/* Options */}
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-medium">Group by folder</div>
                          <div className="text-[10px] text-muted-foreground">Group checks under folder names on the public page</div>
                        </div>
                        <Switch
                          checked={formGroupByFolder}
                          onCheckedChange={setFormGroupByFolder}
                        />
                      </div>
                    </div>

                    {/* Branding */}
                    <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Branding</div>
                          {!nano && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 uppercase tracking-wide">Nano</Badge>
                          )}
                        </div>
                        {!nano && (
                          <Button asChild size="sm" className="cursor-pointer h-7 text-xs">
                            <Link to="/billing">Upgrade</Link>
                          </Button>
                        )}
                      </div>
                      <div className={brandingDisabled ? 'opacity-50 pointer-events-none space-y-4' : 'space-y-4'} aria-disabled={brandingDisabled}>
                        <div>
                          <Label className="text-xs font-medium">Logo</Label>
                          <div
                            className="mt-1.5 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/40 px-4 py-4 text-center transition-colors hover:bg-muted/20 cursor-pointer"
                            onClick={() => {
                              const input = document.getElementById('status-logo-upload') as HTMLInputElement | null;
                              input?.click();
                            }}
                            onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
                            onDrop={handleBrandDrop('logo')}
                          >
                            <div className="text-xs font-medium text-foreground">
                              {logoUploading ? 'Uploading...' : 'Drop logo or click to select'}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              JPG/PNG, max 400x200px, {formatBytes(BRAND_LIMITS.logo.maxInputBytes)}
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
                                if (file) void handleBrandUpload('logo', file);
                              }}
                            />
                          </div>
                          {formLogoUrl.trim().length > 0 && (
                            <div className="flex items-center gap-3 rounded-lg border border-border/30 px-3 py-2 bg-muted/20 mt-2">
                              <img
                                src={formLogoUrl.trim()}
                                alt="Brand logo preview"
                                className="h-8 w-auto max-w-[140px] object-contain"
                                loading="lazy"
                                onError={(event) => { event.currentTarget.style.display = 'none'; }}
                              />
                              <span className="text-[10px] text-muted-foreground">Logo preview</span>
                            </div>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs font-medium">Favicon</Label>
                          <div
                            className="mt-1.5 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/40 px-4 py-4 text-center transition-colors hover:bg-muted/20 cursor-pointer"
                            onClick={() => {
                              const input = document.getElementById('status-favicon-upload') as HTMLInputElement | null;
                              input?.click();
                            }}
                            onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
                            onDrop={handleBrandDrop('favicon')}
                          >
                            <div className="text-xs font-medium text-foreground">
                              {faviconUploading ? 'Uploading...' : 'Drop favicon or click to select'}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              PNG/GIF/ICO, max 96x96px, {formatBytes(BRAND_LIMITS.favicon.maxInputBytes)}
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
                                if (file) void handleBrandUpload('favicon', file);
                              }}
                            />
                          </div>
                        </div>
                        <div>
                          <Label htmlFor="status-brand-color" className="text-xs font-medium">Brand color</Label>
                          <div className="flex items-center gap-2 mt-1.5">
                            <Input
                              id="status-brand-color"
                              value={formBrandColor}
                              onChange={(event) => setFormBrandColor(event.target.value)}
                              placeholder="#3B82F6"
                              className="h-8 text-xs font-mono"
                            />
                            <Input
                              type="color"
                              value={brandColorPreview}
                              onChange={(event) => setFormBrandColor(event.target.value)}
                              className="h-8 w-10 p-0.5"
                              aria-label="Pick brand color"
                            />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-1.5">
                            Hex color used as accent on the public status page.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Powered by attribution */}
                    {nano && (
                      <div className="rounded-xl bg-muted/20 border border-border/30 p-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-xs font-medium">Show "Powered by exit1.dev"</div>
                            <div className="text-[10px] text-muted-foreground">Display exit1 attribution on your public status page</div>
                          </div>
                          <Switch
                            checked={formShowPoweredBy}
                            onCheckedChange={setFormShowPoweredBy}
                          />
                        </div>
                      </div>
                    )}
                  </CollapsibleContent>
                </Collapsible>
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
