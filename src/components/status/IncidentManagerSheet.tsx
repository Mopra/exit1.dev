import React, { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { format } from 'date-fns';
import { AlertTriangle, ArrowLeft, Link2, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '../../firebase';
import { apiClient } from '../../api/client';
import type { IncidentStatus, IncidentUpdate, LinkedDowntime, StatusPageIncidentDoc } from '../../types';
import {
  Button,
  Checkbox,
  ConfirmationModal,
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
  Textarea,
} from '../ui';
import { IncidentStatusChip } from './StatusPageIncidents';
import { INCIDENT_STATUS_META, INCIDENT_STATUS_ORDER, formatIncidentDuration, formatIncidentTime } from './incident-meta';

type IncidentRow = StatusPageIncidentDoc & { id: string };
type CheckOption = { id: string; name: string };
type DowntimeWindow = { startedAt: number; endedAt: number | null; durationMs: number };

interface IncidentManagerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statusPage: { id: string; name: string; userId: string } | null;
  /** Checks shown on this status page (affected-check and downtime pickers). */
  checks: CheckOption[];
  canWrite: boolean;
}

const TITLE_MAX = 140;
const MESSAGE_MAX = 2000;

const toLocalInput = (ts: number) => format(new Date(ts), "yyyy-MM-dd'T'HH:mm");
const fromLocalInput = (value: string): number | undefined => {
  if (!value) return undefined;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : undefined;
};

const fieldLabel = 'text-xs font-medium text-muted-foreground';

const StatusSelect: React.FC<{ value: IncidentStatus; onChange: (value: IncidentStatus) => void; id?: string }> = ({
  value,
  onChange,
  id,
}) => (
  <Select value={value} onValueChange={(next) => onChange(next as IncidentStatus)}>
    <SelectTrigger id={id} className="h-10 text-sm mt-1.5">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {INCIDENT_STATUS_ORDER.map((status) => (
        <SelectItem key={status} value={status}>
          {INCIDENT_STATUS_META[status].label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/** Affected checks + optional link to a detected outage. */
const ScopeFields: React.FC<{
  statusPageId: string;
  checks: CheckOption[];
  affected: Set<string>;
  onAffectedChange: (next: Set<string>) => void;
  linked: LinkedDowntime | null;
  onLinkedChange: (next: LinkedDowntime | null) => void;
}> = ({ statusPageId, checks, affected, onAffectedChange, linked, onLinkedChange }) => {
  const [downtimeCheckId, setDowntimeCheckId] = useState<string>(linked?.checkId ?? '');
  const [downtimes, setDowntimes] = useState<DowntimeWindow[] | null>(null);
  const [loadingDowntimes, setLoadingDowntimes] = useState(false);
  const checkName = (id: string) => checks.find((c) => c.id === id)?.name ?? 'Unknown check';

  const loadDowntimes = async (checkId: string) => {
    setDowntimeCheckId(checkId);
    setDowntimes(null);
    if (!checkId) return;
    setLoadingDowntimes(true);
    const result = await apiClient.getStatusPageCheckDowntimes(statusPageId, checkId);
    setLoadingDowntimes(false);
    if (result.success && result.data) {
      setDowntimes(result.data.downtimes);
    } else {
      toast.error(result.error ?? 'Could not load downtime history');
    }
  };

  const toggle = (id: string) => {
    const next = new Set(affected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onAffectedChange(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className={fieldLabel}>Affected checks (optional)</Label>
        {checks.length === 0 ? (
          <p className="text-xs text-muted-foreground mt-1.5">This status page has no checks yet.</p>
        ) : (
          <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-1">
            {checks.map((check) => (
              <label
                key={check.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm hover:bg-muted/40"
              >
                <Checkbox checked={affected.has(check.id)} onCheckedChange={() => toggle(check.id)} />
                <span className="truncate">{check.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <Label className={fieldLabel}>Link to a detected outage (optional)</Label>
        {linked ? (
          <div className="mt-1.5 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <div className="min-w-0 text-sm">
              <div className="flex items-center gap-1.5 font-medium">
                <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{checkName(linked.checkId)}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {formatIncidentTime(linked.startedAt)}
                {linked.endedAt ? ` to ${formatIncidentTime(linked.endedAt)} (${formatIncidentDuration(linked.endedAt - linked.startedAt)})` : ', ongoing'}
              </div>
            </div>
            <Button variant="ghost" size="icon" aria-label="Remove outage link" onClick={() => onLinkedChange(null)}>
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="mt-1.5 space-y-2">
            <Select value={downtimeCheckId} onValueChange={(value) => void loadDowntimes(value)} disabled={checks.length === 0}>
              <SelectTrigger className="h-10 text-sm">
                <SelectValue placeholder="Pick a check to see its outages" />
              </SelectTrigger>
              <SelectContent>
                {checks.map((check) => (
                  <SelectItem key={check.id} value={check.id}>
                    {check.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadingDowntimes && <p className="text-xs text-muted-foreground">Loading outages from the last 30 days...</p>}
            {downtimes && downtimes.length === 0 && (
              <p className="text-xs text-muted-foreground">No outages detected for this check in the last 30 days.</p>
            )}
            {downtimes && downtimes.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-1">
                {downtimes.map((window) => (
                  <button
                    key={window.startedAt}
                    type="button"
                    onClick={() => {
                      onLinkedChange({ checkId: downtimeCheckId, startedAt: window.startedAt, endedAt: window.endedAt });
                      if (!affected.has(downtimeCheckId)) onAffectedChange(new Set(affected).add(downtimeCheckId));
                    }}
                    className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted/40"
                  >
                    <span>{formatIncidentTime(window.startedAt)}</span>
                    <span className="text-xs text-muted-foreground">
                      {window.endedAt ? formatIncidentDuration(window.durationMs) : 'Ongoing'}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Linking shows the outage times next to your explanation. Use this to annotate a past outage.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

const NewIncidentForm: React.FC<{
  statusPageId: string;
  checks: CheckOption[];
  onDone: (incidentId: string | null) => void;
}> = ({ statusPageId, checks, onDone }) => {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<IncidentStatus>('investigating');
  const [message, setMessage] = useState('');
  const [time, setTime] = useState('');
  const [affected, setAffected] = useState<Set<string>>(new Set());
  const [linked, setLinked] = useState<LinkedDowntime | null>(null);
  const [saving, setSaving] = useState(false);

  const handleLinked = (next: LinkedDowntime | null) => {
    setLinked(next);
    // Annotating a finished outage: default the first update to when it ended.
    if (next && !time) {
      setTime(toLocalInput(next.endedAt ?? next.startedAt));
      if (next.endedAt) setStatus('resolved');
    }
  };

  const submit = async () => {
    setSaving(true);
    const result = await apiClient.manageStatusPageIncident({
      action: 'create',
      statusPageId,
      title,
      affectedCheckIds: Array.from(affected),
      linkedDowntime: linked,
      update: { status, message, createdAt: fromLocalInput(time) },
    });
    setSaving(false);
    if (result.success) {
      toast.success('Incident posted.');
      onDone(result.data?.incidentId ?? null);
    } else {
      toast.error(result.error ?? 'Failed to post incident');
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <Label htmlFor="incident-title" className={fieldLabel}>Title</Label>
          <Input
            id="incident-title"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Elevated API error rates"
            className="h-10 text-sm mt-1.5"
            autoFocus
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="incident-status" className={fieldLabel}>Status</Label>
            <StatusSelect id="incident-status" value={status} onChange={setStatus} />
          </div>
          <div>
            <Label htmlFor="incident-time" className={fieldLabel}>Time (blank for now)</Label>
            <Input
              id="incident-time"
              type="datetime-local"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="h-10 text-sm mt-1.5"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="incident-message" className={fieldLabel}>Message</Label>
          <Textarea
            id="incident-message"
            value={message}
            maxLength={MESSAGE_MAX}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={INCIDENT_STATUS_META[status].hint}
            className="mt-1.5 min-h-28 text-sm"
          />
        </div>
      </div>

      <ScopeFields
        statusPageId={statusPageId}
        checks={checks}
        affected={affected}
        onAffectedChange={setAffected}
        linked={linked}
        onLinkedChange={handleLinked}
      />

      <Button
        onClick={submit}
        disabled={saving || title.trim().length < 3 || !message.trim()}
        className="w-full h-11 text-sm font-medium"
      >
        {saving ? (
          <>
            <Zap className="w-4 h-4 mr-2 animate-pulse" />
            Posting...
          </>
        ) : (
          'Post incident'
        )}
      </Button>
    </div>
  );
};

const UpdateRow: React.FC<{
  update: IncidentUpdate;
  canWrite: boolean;
  canDelete: boolean;
  onSave: (patch: { status: IncidentStatus; message: string; createdAt?: number }) => Promise<boolean>;
  onDelete: () => void;
}> = ({ update, canWrite, canDelete, onSave, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<IncidentStatus>(update.status);
  const [message, setMessage] = useState(update.message);
  const [time, setTime] = useState(toLocalInput(update.createdAt));
  const [saving, setSaving] = useState(false);

  if (editing) {
    return (
      <li className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className={fieldLabel}>Status</Label>
            <StatusSelect value={status} onChange={setStatus} />
          </div>
          <div>
            <Label className={fieldLabel}>Time</Label>
            <Input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} className="h-10 text-sm mt-1.5" />
          </div>
        </div>
        <Textarea value={message} maxLength={MESSAGE_MAX} onChange={(e) => setMessage(e.target.value)} className="min-h-24 text-sm" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving || !message.trim()}
            onClick={async () => {
              setSaving(true);
              const timeChanged = time !== toLocalInput(update.createdAt);
              const ok = await onSave({ status, message, createdAt: timeChanged ? fromLocalInput(time) : undefined });
              setSaving(false);
              if (ok) setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="group grid grid-cols-[auto_1fr_auto] gap-x-3">
      <span className={`mt-1.5 size-2 rounded-[2px] ${INCIDENT_STATUS_META[update.status].tone}`} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-semibold">{INCIDENT_STATUS_META[update.status].label}</span>
          <span className="text-[11px] text-muted-foreground">{formatIncidentTime(update.createdAt)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{update.message}</p>
      </div>
      {canWrite && (
        <div className="flex items-start gap-0.5">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Edit update" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </Button>
          {canDelete && (
            <Button variant="ghost" size="icon" className="size-7 text-destructive" aria-label="Delete update" onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </li>
  );
};

const IncidentDetail: React.FC<{
  statusPageId: string;
  incident: IncidentRow;
  checks: CheckOption[];
  canWrite: boolean;
  onBack: () => void;
}> = ({ statusPageId, incident, checks, canWrite, onBack }) => {
  const [title, setTitle] = useState(incident.title);
  const [affected, setAffected] = useState<Set<string>>(new Set(incident.affectedCheckIds));
  const [linked, setLinked] = useState<LinkedDowntime | null>(incident.linkedDowntime);
  const [savingDetails, setSavingDetails] = useState(false);
  const [newStatus, setNewStatus] = useState<IncidentStatus>(incident.status);
  const [newMessage, setNewMessage] = useState('');
  const [newTime, setNewTime] = useState('');
  const [posting, setPosting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteUpdateId, setDeleteUpdateId] = useState<string | null>(null);

  const updatesNewestFirst = useMemo(() => [...incident.updates].reverse(), [incident.updates]);
  const detailsDirty =
    title !== incident.title ||
    JSON.stringify(Array.from(affected).sort()) !== JSON.stringify([...incident.affectedCheckIds].sort()) ||
    JSON.stringify(linked) !== JSON.stringify(incident.linkedDowntime);

  const base = { statusPageId, incidentId: incident.id };

  const saveDetails = async () => {
    setSavingDetails(true);
    const result = await apiClient.manageStatusPageIncident({
      action: 'edit',
      ...base,
      title,
      affectedCheckIds: Array.from(affected),
      linkedDowntime: linked,
    });
    setSavingDetails(false);
    if (result.success) toast.success('Incident updated.');
    else toast.error(result.error ?? 'Failed to update incident');
  };

  const postUpdate = async () => {
    setPosting(true);
    const result = await apiClient.manageStatusPageIncident({
      action: 'addUpdate',
      ...base,
      update: { status: newStatus, message: newMessage, createdAt: fromLocalInput(newTime) },
    });
    setPosting(false);
    if (result.success) {
      toast.success(newStatus === 'resolved' ? 'Incident resolved.' : 'Update posted.');
      setNewMessage('');
      setNewTime('');
    } else {
      toast.error(result.error ?? 'Failed to post update');
    }
  };

  const editUpdate = async (updateId: string, patch: { status: IncidentStatus; message: string; createdAt?: number }) => {
    const result = await apiClient.manageStatusPageIncident({ action: 'editUpdate', ...base, updateId, update: patch });
    if (!result.success) toast.error(result.error ?? 'Failed to save update');
    return result.success;
  };

  const removeUpdate = async () => {
    if (!deleteUpdateId) return;
    const result = await apiClient.manageStatusPageIncident({ action: 'deleteUpdate', ...base, updateId: deleteUpdateId });
    setDeleteUpdateId(null);
    if (!result.success) toast.error(result.error ?? 'Failed to delete update');
  };

  const removeIncident = async () => {
    const result = await apiClient.manageStatusPageIncident({ action: 'delete', ...base });
    setConfirmDelete(false);
    if (result.success) {
      toast.success('Incident deleted.');
      onBack();
    } else {
      toast.error(result.error ?? 'Failed to delete incident');
    }
  };

  return (
    <div className="space-y-8">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        All incidents
      </button>

      {canWrite && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold">Post an update</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="update-status" className={fieldLabel}>Status</Label>
              <StatusSelect id="update-status" value={newStatus} onChange={setNewStatus} />
            </div>
            <div>
              <Label htmlFor="update-time" className={fieldLabel}>Time (blank for now)</Label>
              <Input
                id="update-time"
                type="datetime-local"
                value={newTime}
                onChange={(event) => setNewTime(event.target.value)}
                className="h-10 text-sm mt-1.5"
              />
            </div>
          </div>
          <Textarea
            value={newMessage}
            maxLength={MESSAGE_MAX}
            onChange={(event) => setNewMessage(event.target.value)}
            placeholder={INCIDENT_STATUS_META[newStatus].hint}
            className="min-h-24 text-sm"
          />
          <Button onClick={postUpdate} disabled={posting || !newMessage.trim()} className="w-full h-11 text-sm font-medium">
            {posting ? 'Posting...' : newStatus === 'resolved' ? 'Post and resolve' : 'Post update'}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Timeline</h3>
          <IncidentStatusChip status={incident.status} />
        </div>
        <ol className="space-y-4">
          {updatesNewestFirst.map((update) => (
            <UpdateRow
              key={`${update.id}-${update.createdAt}-${update.status}-${update.message.length}`}
              update={update}
              canWrite={canWrite}
              canDelete={incident.updates.length > 1}
              onSave={(patch) => editUpdate(update.id, patch)}
              onDelete={() => setDeleteUpdateId(update.id)}
            />
          ))}
        </ol>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Details</h3>
        <div>
          <Label htmlFor="incident-edit-title" className={fieldLabel}>Title</Label>
          <Input
            id="incident-edit-title"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            className="h-10 text-sm mt-1.5"
            disabled={!canWrite}
          />
        </div>
        <ScopeFields
          statusPageId={statusPageId}
          checks={checks}
          affected={affected}
          onAffectedChange={setAffected}
          linked={linked}
          onLinkedChange={setLinked}
        />
        {canWrite && (
          <Button
            variant="outline"
            onClick={saveDetails}
            disabled={savingDetails || !detailsDirty || title.trim().length < 3}
            className="w-full h-10 text-sm"
          >
            {savingDetails ? 'Saving...' : 'Save details'}
          </Button>
        )}
      </div>

      {canWrite && (
        <div className="border-t border-border/60 pt-6">
          <Button
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            className="w-full h-10 text-sm text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4 mr-2" />
            Delete incident
          </Button>
        </div>
      )}

      <ConfirmationModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={removeIncident}
        title={`Delete "${incident.title}"?`}
        message="The incident and its updates disappear from the status page. This cannot be undone."
        confirmText="Delete incident"
        variant="destructive"
      />
      <ConfirmationModal
        isOpen={!!deleteUpdateId}
        onClose={() => setDeleteUpdateId(null)}
        onConfirm={removeUpdate}
        title="Delete this update?"
        message="The update is removed from the incident timeline."
        confirmText="Delete update"
        variant="destructive"
      />
    </div>
  );
};

/**
 * Owner-side incident management for one status page: list, post, update,
 * resolve, delete. Reads `status_page_incidents` directly (rules allow the
 * account to read); every write goes through manageStatusPageIncident.
 */
export const IncidentManagerSheet: React.FC<IncidentManagerSheetProps> = ({
  open,
  onOpenChange,
  statusPage,
  checks,
  canWrite,
}) => {
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'new' | string>('list');

  const statusPageId = statusPage?.id ?? null;
  const ownerId = statusPage?.userId ?? null;

  useEffect(() => {
    if (!open) setView('list');
  }, [open]);

  useEffect(() => {
    if (!open || !statusPageId || !ownerId) return;
    setLoading(true);
    const q = query(
      collection(db, 'status_page_incidents'),
      where('userId', '==', ownerId),
      where('statusPageId', '==', statusPageId),
      orderBy('startedAt', 'desc'),
      limit(100),
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setIncidents(snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as StatusPageIncidentDoc) })));
        setLoading(false);
      },
      (error) => {
        console.error('[IncidentManager] Failed to load incidents:', error);
        toast.error('Failed to load incidents');
        setLoading(false);
      },
    );
    return () => unsubscribe();
  }, [open, statusPageId, ownerId]);

  const selected = view !== 'list' && view !== 'new' ? incidents.find((i) => i.id === view) ?? null : null;
  const openIncidents = incidents.filter((i) => i.status !== 'resolved');
  const resolvedIncidents = incidents.filter((i) => i.status === 'resolved');

  const renderRow = (incident: IncidentRow) => (
    <button
      key={incident.id}
      type="button"
      onClick={() => setView(incident.id)}
      className="flex w-full cursor-pointer items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{incident.title}</div>
        <div className="text-xs text-muted-foreground">
          {formatIncidentTime(incident.startedAt)}
          {incident.resolvedAt ? ` · Lasted ${formatIncidentDuration(incident.resolvedAt - incident.startedAt)}` : ''}
          {` · ${incident.updates.length} update${incident.updates.length === 1 ? '' : 's'}`}
        </div>
      </div>
      <IncidentStatusChip status={incident.status} />
    </button>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-full sm:max-w-lg md:max-w-xl p-0 overflow-hidden">
        <SheetTitle className="sr-only">Incidents</SheetTitle>
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-viewport]]:!overflow-x-hidden [&_[data-slot=scroll-viewport]>div]:!block [&_[data-slot=scroll-viewport]>div]:!w-full">
          <div className="p-7 sm:p-8 min-w-0">
            <div className="flex items-center gap-3 mb-8">
              <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
                <AlertTriangle className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight">
                  {view === 'new' ? 'New incident' : selected ? selected.title : 'Incidents'}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {statusPage?.name ?? ''} · shown on the public status page
                </p>
              </div>
            </div>

            {!statusPageId ? null : view === 'new' ? (
              <div className="space-y-6">
                <button
                  type="button"
                  onClick={() => setView('list')}
                  className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="size-3.5" />
                  All incidents
                </button>
                <NewIncidentForm
                  statusPageId={statusPageId}
                  checks={checks}
                  onDone={(id) => setView(id ?? 'list')}
                />
              </div>
            ) : selected ? (
              <IncidentDetail
                key={selected.id}
                statusPageId={statusPageId}
                incident={selected}
                checks={checks}
                canWrite={canWrite}
                onBack={() => setView('list')}
              />
            ) : (
              <div className="space-y-6">
                {canWrite && (
                  <Button onClick={() => setView('new')} className="w-full h-11 gap-2 text-sm font-medium">
                    <Plus className="size-4" />
                    New incident
                  </Button>
                )}
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading incidents...</p>
                ) : incidents.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border/60 px-5 py-8 text-center">
                    <p className="text-sm font-medium">No incidents yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Post one when something breaks, or annotate a past outage so visitors know what happened.
                    </p>
                  </div>
                ) : (
                  <>
                    {openIncidents.length > 0 && (
                      <div className="space-y-2">
                        <div className={fieldLabel}>Open</div>
                        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                          {openIncidents.map(renderRow)}
                        </div>
                      </div>
                    )}
                    {resolvedIncidents.length > 0 && (
                      <div className="space-y-2">
                        <div className={fieldLabel}>Resolved</div>
                        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                          {resolvedIncidents.map(renderRow)}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Resolved incidents stay on the public page for 90 days.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
};
