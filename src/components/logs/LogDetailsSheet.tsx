import React from 'react';
import { Button, ScrollArea, Sheet, SheetContent, SheetTitle, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Spinner } from '../ui';
import { Badge } from '../ui/badge';
// Removed unused Separator
// Removed internal ScrollArea to avoid inner scrolling and overflow
import { Copy, AlertCircle, CheckCircle, XCircle, PauseCircle, Pencil, Trash2, Check, X } from 'lucide-react';
import StatusBadge from '../ui/StatusBadge';
import { formatResponseTime } from '../../utils/formatters';
import { copyToClipboard, copyRowData } from '../../utils/clipboard';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { apiClient } from '../../api/client';
import type { LogNote } from '../../api/types';

interface LogEntry {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteUrl: string;
  time: string;
  date: string;
  status: 'online' | 'offline' | 'unknown' | 'UP' | 'REDIRECT' | 'REACHABLE_WITH_ERROR' | 'DOWN' | 'disabled';
  statusCode?: number;
  responseTime?: number;
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  error?: string;
  timestamp: number;
  timezone?: string;
  localTime?: string;
  targetHostname?: string;
  targetIp?: string;
  targetIpsJson?: string;
  targetIpFamily?: number;
  targetCountry?: string;
  targetRegion?: string;
  targetCity?: string;
  targetLatitude?: number;
  targetLongitude?: number;
  targetAsn?: string;
  targetOrg?: string;
  targetIsp?: string;
  cdnProvider?: string;
  edgePop?: string;
  edgeRayId?: string;
  edgeHeadersJson?: string;
  isManual?: boolean;
  manualMessage?: string;
}

interface LogDetailsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  logEntry: LogEntry | null;
  defaultTab?: 'comment' | 'details' | 'raw';
  autoFocusTextarea?: boolean;
}

export const LogDetailsSheet: React.FC<LogDetailsSheetProps> = ({
  isOpen,
  onClose,
  logEntry,
  defaultTab = 'details',
  autoFocusTextarea = false
}) => {
  const [noteText, setNoteText] = React.useState('');
  const [notes, setNotes] = React.useState<LogNote[]>([]);
  const [notesLoading, setNotesLoading] = React.useState(false);
  const [notesError, setNotesError] = React.useState<string | null>(null);
  const [noteActionError, setNoteActionError] = React.useState<string | null>(null);
  const [noteAction, setNoteAction] = React.useState<{ type: 'add' | 'update' | 'delete'; noteId?: string } | null>(null);
  const [activeTab, setActiveTab] = React.useState<'comment' | 'details' | 'raw'>(defaultTab);
  const [selectedNoteId, setSelectedNoteId] = React.useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    setNoteText('');
    setNotes([]);
    setNotesError(null);
    setNotesLoading(false);
    setEditingNoteId(null);
    setEditText('');
    setSelectedNoteId(null);
    setNoteActionError(null);
    setNoteAction(null);
  }, [logEntry?.id]);

  React.useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  React.useEffect(() => {
    if (isOpen && activeTab === 'comment' && autoFocusTextarea && textareaRef.current) {
      // Small delay to ensure the sheet is fully rendered
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, [isOpen, activeTab, autoFocusTextarea]);

  React.useEffect(() => {
    if (!editingNoteId) return;
    setTimeout(() => {
      editTextareaRef.current?.focus();
    }, 100);
  }, [editingNoteId]);

  React.useEffect(() => {
    let isActive = true;
    const loadNotes = async () => {
      if (!isOpen || !logEntry) {
        setNotes([]);
        setNotesLoading(false);
        setNotesError(null);
        return;
      }

      setNotesLoading(true);
      setNotesError(null);
      const response = await apiClient.getLogNotes(logEntry.websiteId, logEntry.id);
      if (!isActive) return;

      if (response.success && response.data) {
        const sorted = [...response.data].sort((a, b) => b.createdAt - a.createdAt);
        setNotes(sorted);
        setSelectedNoteId((prev) => {
          if (prev && sorted.some((note) => note.id === prev)) {
            return prev;
          }
          return sorted[0]?.id ?? null;
        });
      } else {
        setNotes([]);
        setNotesError(response.error || 'Failed to load comments');
      }
      setNotesLoading(false);
    };

    loadNotes();
    return () => {
      isActive = false;
    };
  }, [isOpen, logEntry]);

  const handleCopy = async (text: string, type: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      // Could add toast notification here
      console.log(`${type} copied to clipboard`);
    }
  };

  const isAdding = noteAction?.type === 'add';
  const isUpdating = noteAction?.type === 'update';
  const isDeleting = noteAction?.type === 'delete';
  const isBusy = !!noteAction;

  const handleAddNote = React.useCallback(async () => {
    if (!logEntry || isBusy) {
      return;
    }

    const trimmed = noteText.trim();
    if (!trimmed) {
      return;
    }

    setNoteActionError(null);
    setNoteAction({ type: 'add' });
    try {
      const response = await apiClient.addLogNote(logEntry.websiteId, logEntry.id, trimmed);
      if (response.success && response.data) {
        const newNote = response.data;
        setNotes((prev) => [newNote, ...prev]);
        setSelectedNoteId(newNote.id);
        setNoteText('');
      } else {
        setNoteActionError(response.error || 'Failed to add comment');
      }
    } catch (error) {
      console.error('Failed to add comment:', error);
      setNoteActionError('Failed to add comment');
    } finally {
      setNoteAction(null);
    }
  }, [isBusy, logEntry, noteText]);

  const handleStartEdit = React.useCallback((note: LogNote) => {
    setEditingNoteId(note.id);
    setEditText(note.message);
    setSelectedNoteId(note.id);
  }, []);

  const handleCancelEdit = React.useCallback(() => {
    setEditingNoteId(null);
    setEditText('');
  }, []);

  const handleSaveEdit = React.useCallback(async () => {
    if (!logEntry || !editingNoteId || isBusy) {
      return;
    }

    const trimmed = editText.trim();
    if (!trimmed) {
      return;
    }

    const existing = notes.find((note) => note.id === editingNoteId);
    if (!existing) {
      handleCancelEdit();
      return;
    }
    if (trimmed === existing.message) {
      handleCancelEdit();
      return;
    }

    setNoteActionError(null);
    setNoteAction({ type: 'update', noteId: editingNoteId });
    try {
      const response = await apiClient.updateLogNote(logEntry.websiteId, logEntry.id, editingNoteId, trimmed);
      if (response.success && response.data) {
        setNotes((prev) =>
          prev.map((note) => (note.id === response.data!.id ? response.data! : note))
        );
        handleCancelEdit();
      } else {
        setNoteActionError(response.error || 'Failed to update comment');
      }
    } catch (error) {
      console.error('Failed to update comment:', error);
      setNoteActionError('Failed to update comment');
    } finally {
      setNoteAction(null);
    }
  }, [editText, editingNoteId, handleCancelEdit, isBusy, logEntry, notes]);

  const handleDeleteNote = React.useCallback(async (noteId: string) => {
    if (!logEntry || isBusy) {
      return;
    }

    setNoteActionError(null);
    setNoteAction({ type: 'delete', noteId });
    try {
      const response = await apiClient.deleteLogNote(logEntry.websiteId, logEntry.id, noteId);
      if (response.success) {
        setNotes((prev) => {
          const next = prev.filter((note) => note.id !== noteId);
          setSelectedNoteId((current) => {
            if (current && next.some((note) => note.id === current)) {
              return current;
            }
            return next[0]?.id ?? null;
          });
          return next;
        });
        if (editingNoteId === noteId) {
          handleCancelEdit();
        }
      } else {
        setNoteActionError(response.error || 'Failed to delete comment');
      }
    } catch (error) {
      console.error('Failed to delete comment:', error);
      setNoteActionError('Failed to delete comment');
    } finally {
      setNoteAction(null);
    }
  }, [editingNoteId, handleCancelEdit, isBusy, logEntry]);

  React.useEffect(() => {
    if (!isOpen || activeTab !== 'comment') return;

    const handler = (event: KeyboardEvent) => {
      const isModEnter = (event.key === 'Enter' && (event.metaKey || event.ctrlKey));
      if (isModEnter) {
        event.preventDefault();
        if (editingNoteId) {
          void handleSaveEdit();
        } else {
          void handleAddNote();
        }
        return;
      }

      if (event.key === 'Escape' && editingNoteId) {
        event.preventDefault();
        handleCancelEdit();
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isTypingTarget) {
        return;
      }

      if ((event.key === 'e' || event.key === 'E') && selectedNoteId) {
        const note = notes.find((item) => item.id === selectedNoteId);
        if (note) {
          event.preventDefault();
          handleStartEdit(note);
        }
        return;
      }

      if ((event.key === 'Backspace' || event.key === 'Delete') && selectedNoteId) {
        const note = notes.find((item) => item.id === selectedNoteId);
        if (!note) return;
        event.preventDefault();
        if (window.confirm('Delete this comment?')) {
          void handleDeleteNote(note.id);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [activeTab, editingNoteId, isOpen, notes, selectedNoteId, handleAddNote, handleSaveEdit, handleCancelEdit, handleDeleteNote, handleStartEdit]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
      case 'UP':
      case 'REDIRECT':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'offline':
      case 'DOWN':
      case 'REACHABLE_WITH_ERROR':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'disabled':
        return <PauseCircle className="w-4 h-4 text-amber-500" />;
      default:
        return <AlertCircle className="w-4 h-4 text-yellow-500" />;
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-full sm:max-w-sm md:max-w-md lg:max-w-lg p-0">
        <SheetTitle className="sr-only">Log details</SheetTitle>
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex flex-col gap-2 p-4 pr-12 sm:pr-14 border-b bg-background/80 backdrop-blur supports-backdrop-blur:backdrop-blur-md">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
              <div className="flex items-center gap-3 min-w-0">
                {logEntry && (
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 flex-shrink-0">
                    {getStatusIcon(logEntry.status)}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold truncate">Log Details</h2>
                  {logEntry?.isManual && (
                    <Badge variant="outline" className="mt-1 text-[10px] font-mono uppercase">
                      Manual log
                    </Badge>
                  )}
                  {logEntry && (
                    <p className="text-xs text-muted-foreground truncate">
                      {`${logEntry.time} UTC • ${logEntry.date}`}
                      {logEntry.localTime && <span className="text-primary/70"> ({logEntry.localTime})</span>}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {logEntry && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="Copy all details"
                          onClick={() => handleCopy(copyRowData(logEntry), 'All Details')}
                          className="h-8 px-2 cursor-pointer"
                        >
                          <Copy className="w-4 h-4 mr-2" />
                          Copy all
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Copy all details</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          </div>

          {/* Body */}
          <ScrollArea className="flex-1">
            <div className="px-4 sm:px-6 py-4">
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'comment' | 'details' | 'raw')} className="min-w-0">
                <TabsList className="w-full sm:w-fit">
                  <TabsTrigger value="comment">Comments</TabsTrigger>
                  <TabsTrigger value="details">All Details</TabsTrigger>
                  <TabsTrigger value="raw">Raw Data</TabsTrigger>
                </TabsList>

                <TabsContent value="comment" className="mt-4 space-y-4">
                  {logEntry ? (
                    <div className="space-y-4">
                      <div className="rounded-lg space-y-4 bg-black">
                        <div className="relative">
                          <Textarea
                            ref={textareaRef}
                            placeholder="Add a comment, e.g., Root cause fixed"
                            value={noteText}
                            onChange={(event) => setNoteText(event.target.value)}
                            className="min-h-[110px] font-mono text-sm text-white border-slate-700/50 p-4 placeholder:text-slate-500"
                          />
                        </div>
                        {noteActionError && (
                          <div className="text-sm text-destructive">{noteActionError}</div>
                        )}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                          <Button
                            size="default"
                            variant="outline"
                            onClick={() => void handleAddNote()}
                            disabled={isBusy || !noteText.trim()}
                            className="h-8"
                          >
                            {isAdding ? <Spinner size="sm" className="mr-2" /> : null}
                            {isAdding ? 'Saving...' : 'Add comment'}
                          </Button>
                        </div>
                      </div>

                      <div className="rounded-lg space-y-4 py-4">
                        {notesError && (
                          <div className="text-sm text-destructive">{notesError}</div>
                        )}
                        {notesLoading ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner size="sm" className="text-muted-foreground" />
                            Loading comments...
                          </div>
                        ) : notes.length ? (
                          <div className="space-y-3">
                            {notes.map((note) => {
                              const isSelected = note.id === selectedNoteId;
                              const isEditing = note.id === editingNoteId;
                              const isEdited = note.updatedAt > note.createdAt;
                              const isUpdatingNote = isUpdating && noteAction?.noteId === note.id;
                              const isDeletingNote = isDeleting && noteAction?.noteId === note.id;
                              return (
                                <div
                                  key={note.id}
                                  className={`rounded-lg border bg-background/60 p-3 space-y-2 ${isSelected ? 'ring-1 ring-primary/40' : ''}`}
                                  onClick={() => setSelectedNoteId(note.id)}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs text-muted-foreground">
                                      {new Date(note.createdAt).toLocaleString()}
                                      {isEdited ? ' (edited)' : ''}
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          handleStartEdit(note);
                                        }}
                                        disabled={isBusy}
                                        className="h-7 px-2"
                                      >
                                        <Pencil className="w-4 h-4" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          if (window.confirm('Delete this comment?')) {
                                            void handleDeleteNote(note.id);
                                          }
                                        }}
                                        disabled={isBusy}
                                        className="h-7 px-2 text-destructive"
                                      >
                                        {isDeletingNote ? <Spinner size="sm" /> : <Trash2 className="w-4 h-4" />}
                                      </Button>
                                    </div>
                                  </div>
                                  {isEditing ? (
                                    <div className="space-y-3">
                                      <Textarea
                                        ref={editTextareaRef}
                                        value={editText}
                                        onChange={(event) => setEditText(event.target.value)}
                                        className="min-h-[110px] font-mono text-sm"
                                      />
                                      <div className="flex items-center justify-end gap-2">
                                        <Button
                                          size="sm"
                                          onClick={() => void handleSaveEdit()}
                                          disabled={isUpdatingNote || !editText.trim()}
                                          className="h-8"
                                        >
                                          {isUpdatingNote ? <Spinner size="sm" className="mr-2" /> : <Check className="w-4 h-4 mr-1" />}
                                          Save
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={handleCancelEdit}
                                          disabled={isUpdatingNote}
                                          className="h-8"
                                        >
                                          <X className="w-4 h-4 mr-1" />
                                          Cancel
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <p className="text-sm whitespace-pre-wrap break-words">{note.message}</p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">No comments yet.</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">Select a log to add comments.</div>
                  )}
                </TabsContent>

                <TabsContent value="details" className="mt-4 space-y-4">
                  {logEntry ? (
                    <div className="space-y-4">
                      {logEntry.isManual && (
                        <div className="rounded-lg p-3 sm:p-4 bg-sky-500/10 border border-sky-500/20 space-y-2">
                          <div className="text-xs uppercase tracking-wide text-sky-700/80 dark:text-sky-200/80 font-mono">Manual entry</div>
                          <div className="text-sm text-foreground whitespace-pre-wrap break-words">
                            {logEntry.manualMessage || 'No manual message provided.'}
                          </div>
                        </div>
                      )}
                      {/* Website Info */}
                      <div className="rounded-lg p-3 sm:p-4 bg-neutral-900/30 border border-neutral-800/50">
                        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium break-words text-foreground">{logEntry.websiteName}</div>
                            <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                              <span className="break-all font-mono" title={logEntry.websiteUrl}>{logEntry.websiteUrl}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      {/* Status & Timing */}
                      <div className="rounded-lg p-3 sm:p-4 bg-neutral-900/30 border border-neutral-800/50">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3 font-mono">Status & Timing</div>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-muted-foreground">Status</span>
                            <div className="flex-shrink-0"><StatusBadge status={logEntry.status} /></div>
                          </div>
                          {logEntry.statusCode && (
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-sm text-muted-foreground">Status Code</span>
                              <Badge variant="outline" className="flex-shrink-0 font-mono">{logEntry.statusCode}</Badge>
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-muted-foreground">Response Time</span>
                            <span className="font-mono text-sm flex-shrink-0 text-foreground">
                              {logEntry.responseTime ? formatResponseTime(logEntry.responseTime) : 'N/A'}
                            </span>
                          </div>
                          <div className="flex items-start justify-between gap-3">
                            <span className="text-sm text-muted-foreground">Timestamp (UTC)</span>
                            <span className="font-mono text-xs break-all text-right max-w-[60%] text-foreground">{new Date(logEntry.timestamp).toISOString()}</span>
                          </div>
                          {logEntry.localTime && (
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-sm text-muted-foreground">Local time</span>
                              <span className="font-mono text-xs break-all text-right max-w-[60%] text-primary/80">{logEntry.localTime}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Error Details */}
                      {logEntry.error && (
                        <div className="rounded-lg p-3 sm:p-4 bg-neutral-900/30 border border-neutral-800/50 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-medium text-foreground">Error Details</h3>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleCopy(logEntry.error!, 'Error')}
                              className="h-8 px-2 cursor-pointer"
                            >
                              <Copy className="w-4 h-4 mr-1" />
                              Copy
                            </Button>
                          </div>
                          <div className="rounded-lg p-3 bg-background/60 border border-border/50">
                            <pre className="text-sm font-mono text-muted-foreground whitespace-pre-wrap break-words max-h-40 overflow-auto">
                              {logEntry.error}
                            </pre>
                          </div>
                        </div>
                      )}
                      {/* Timing Breakdown */}
                      {(typeof logEntry.dnsMs === "number" ||
                        typeof logEntry.connectMs === "number" ||
                        typeof logEntry.tlsMs === "number" ||
                        typeof logEntry.ttfbMs === "number") && (
                        <div className="rounded-lg p-3 sm:p-4 bg-neutral-900/30 border border-neutral-800/50">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3 font-mono">Timing Breakdown</div>
                          <div className="space-y-3">
                            {typeof logEntry.dnsMs === "number" && (
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-muted-foreground">DNS</span>
                                <span className="font-mono text-sm flex-shrink-0 text-foreground">
                                  {formatResponseTime(logEntry.dnsMs)}
                                </span>
                              </div>
                            )}
                            {typeof logEntry.connectMs === "number" && (
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Connect</span>
                                <span className="font-mono text-sm flex-shrink-0 text-foreground">
                                  {formatResponseTime(logEntry.connectMs)}
                                </span>
                              </div>
                            )}
                            {typeof logEntry.tlsMs === "number" && (
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-muted-foreground">TLS</span>
                                <span className="font-mono text-sm flex-shrink-0 text-foreground">
                                  {formatResponseTime(logEntry.tlsMs)}
                                </span>
                              </div>
                            )}
                            {typeof logEntry.ttfbMs === "number" && (
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-sm text-muted-foreground">TTFB</span>
                                <span className="font-mono text-sm flex-shrink-0 text-foreground">
                                  {formatResponseTime(logEntry.ttfbMs)}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {/* Target Details */}
                      {(logEntry.targetIp ||
                        logEntry.targetHostname ||
                        logEntry.targetCountry ||
                        logEntry.targetRegion ||
                        logEntry.targetCity ||
                        logEntry.targetAsn ||
                        logEntry.targetOrg ||
                        logEntry.targetIsp ||
                        logEntry.cdnProvider ||
                        logEntry.edgePop ||
                        logEntry.edgeRayId) && (
                        <div className="rounded-lg p-3 sm:p-4 bg-neutral-900/30 border border-neutral-800/50 space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-medium text-foreground">Target</h3>
                            {(logEntry.targetIp || logEntry.edgeHeadersJson) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  handleCopy(
                                    JSON.stringify(
                                      {
                                        targetHostname: logEntry.targetHostname,
                                        targetIp: logEntry.targetIp,
                                        targetIpsJson: logEntry.targetIpsJson,
                                        targetIpFamily: logEntry.targetIpFamily,
                                        targetCity: logEntry.targetCity,
                                        targetRegion: logEntry.targetRegion,
                                        targetCountry: logEntry.targetCountry,
                                        targetLatitude: logEntry.targetLatitude,
                                        targetLongitude: logEntry.targetLongitude,
                                        targetAsn: logEntry.targetAsn,
                                        targetOrg: logEntry.targetOrg,
                                        targetIsp: logEntry.targetIsp,
                                        cdnProvider: logEntry.cdnProvider,
                                        edgePop: logEntry.edgePop,
                                        edgeRayId: logEntry.edgeRayId,
                                        edgeHeadersJson: logEntry.edgeHeadersJson,
                                      },
                                      null,
                                      2
                                    ),
                                    "Target JSON"
                                  )
                                }
                                className="h-8 px-2 cursor-pointer"
                              >
                                <Copy className="w-4 h-4 mr-1" />
                                Copy
                              </Button>
                            )}
                          </div>
                          <div className="space-y-3">
                            {logEntry.targetHostname && (
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Hostname</span>
                                <span className="font-mono text-xs break-all text-right max-w-[65%] text-foreground">
                                  {logEntry.targetHostname}
                                </span>
                              </div>
                            )}
                            {(logEntry.targetIp || logEntry.targetIpFamily) && (
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-sm text-muted-foreground">IP</span>
                                <span className="font-mono text-xs break-all text-right max-w-[65%] text-foreground">
                                  {logEntry.targetIp || "N/A"}{logEntry.targetIpFamily ? ` (IPv${logEntry.targetIpFamily})` : ""}
                                </span>
                              </div>
                            )}
                            {(logEntry.targetCity || logEntry.targetRegion || logEntry.targetCountry) && (
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Geo</span>
                                <span className="font-mono text-xs break-all text-right max-w-[65%] text-foreground">
                                  {[logEntry.targetCity, logEntry.targetRegion, logEntry.targetCountry].filter(Boolean).join(", ")}
                                </span>
                              </div>
                            )}
                            {(typeof logEntry.targetLatitude === "number" || typeof logEntry.targetLongitude === "number") && (
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Coords</span>
                                <span className="font-mono text-xs break-all text-right max-w-[65%] text-foreground">
                                  {typeof logEntry.targetLatitude === "number" ? logEntry.targetLatitude.toFixed(4) : "?"},{" "}
                                  {typeof logEntry.targetLongitude === "number" ? logEntry.targetLongitude.toFixed(4) : "?"}
                                </span>
                              </div>
                            )}
                            {(logEntry.targetAsn || logEntry.targetOrg || logEntry.targetIsp) && (
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Network</span>
                                <span className="font-mono text-xs break-all text-right max-w-[65%] text-foreground">
                                  {[logEntry.targetAsn, logEntry.targetOrg, logEntry.targetIsp].filter(Boolean).join(" • ")}
                                </span>
                              </div>
                            )}
                            {(logEntry.cdnProvider || logEntry.edgePop || logEntry.edgeRayId) && (
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-sm text-muted-foreground">Edge</span>
                                <span className="font-mono text-xs break-all text-right max-w-[65%] text-foreground">
                                  {[logEntry.cdnProvider, logEntry.edgePop, logEntry.edgeRayId].filter(Boolean).join(" • ")}
                                </span>
                              </div>
                            )}
                            {logEntry.edgeHeadersJson && (
                              <div className="pt-2">
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => handleCopy(logEntry.edgeHeadersJson!, "Edge headers")}
                                        className="w-full justify-center cursor-pointer"
                                      >
                                        <Copy className="w-4 h-4 mr-2" />
                                        Copy edge headers
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">Raw response headers used for edge hints</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No details</div>
                  )}
                </TabsContent>

                <TabsContent value="raw" className="mt-4 space-y-4">
                  {logEntry ? (
                    <div className="rounded-lg p-3 sm:p-4 bg-neutral-900/30 border border-neutral-800/50 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-medium text-foreground">Raw Data</h3>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopy(copyRowData(logEntry), 'JSON')}
                          className="h-8 px-2 cursor-pointer"
                        >
                          <Copy className="w-4 h-4 mr-1" />
                          Copy JSON
                        </Button>
                      </div>
                      <div className="rounded-lg p-3 bg-background/60 border border-border/50">
                        <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-words max-h-60 overflow-auto">
                          {JSON.stringify(logEntry, null, 2)}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No details</div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
};
