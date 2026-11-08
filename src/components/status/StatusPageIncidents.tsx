import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { IncidentStatus, IncidentUpdate, StatusPageIncident } from '../../types';
import { INCIDENT_STATUS_META, formatIncidentDuration, formatIncidentTime } from './incident-meta';

export const IncidentStatusChip: React.FC<{ status: IncidentStatus }> = ({ status }) => {
  const meta = INCIDENT_STATUS_META[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${meta.chip}`}>
      <span className={`size-1.5 rounded-[2px] ${meta.tone}`} />
      {meta.label}
    </span>
  );
};

const UpdateTimeline: React.FC<{ updates: IncidentUpdate[] }> = ({ updates }) => (
  <ol className="space-y-4">
    {updates.map((update) => (
      <li key={update.id} className="grid grid-cols-[auto_1fr] gap-x-3">
        <span className={`mt-1.5 size-2 rounded-[2px] ${INCIDENT_STATUS_META[update.status].tone}`} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-xs font-semibold text-foreground">{INCIDENT_STATUS_META[update.status].label}</span>
            <time
              className="text-[11px] text-muted-foreground"
              dateTime={new Date(update.createdAt).toISOString()}
              title={new Date(update.createdAt).toString()}
            >
              {formatIncidentTime(update.createdAt)}
            </time>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{update.message}</p>
        </div>
      </li>
    ))}
  </ol>
);

const affectedLabel = (incident: StatusPageIncident, checkNames: Record<string, string>) => {
  const names = incident.affectedCheckIds.map((id) => checkNames[id]).filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(', ') : null;
};

/** Open incidents, shown above everything else on the public page. */
export const ActiveIncidents: React.FC<{
  incidents: StatusPageIncident[];
  checkNames: Record<string, string>;
}> = ({ incidents, checkNames }) => {
  const active = incidents.filter((incident) => incident.status !== 'resolved');
  if (active.length === 0) return null;

  return (
    <div className="mb-6 space-y-3">
      {active.map((incident) => {
        const affected = affectedLabel(incident, checkNames);
        const latest = incident.updates[0];
        return (
          <section
            key={incident.id}
            aria-label={`Incident: ${incident.title}`}
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="flex gap-4 px-5 py-4">
              <span className={`w-1 shrink-0 self-stretch rounded-[2px] ${INCIDENT_STATUS_META[incident.status].tone}`} />
              <div className="min-w-0 flex-1 space-y-4">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <IncidentStatusChip status={incident.status} />
                    <h2 className="text-base font-semibold tracking-tight text-foreground">{incident.title}</h2>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Started {formatIncidentTime(incident.startedAt)}
                    {latest ? ` · Updated ${formatIncidentTime(latest.createdAt)}` : ''}
                    {affected ? ` · Affects ${affected}` : ''}
                  </div>
                </div>
                <UpdateTimeline updates={incident.updates} />
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
};

const PastIncidentRow: React.FC<{ incident: StatusPageIncident; checkNames: Record<string, string> }> = ({
  incident,
  checkNames,
}) => {
  const [open, setOpen] = useState(false);
  const affected = affectedLabel(incident, checkNames);
  const duration = incident.resolvedAt != null ? formatIncidentDuration(incident.resolvedAt - incident.startedAt) : null;
  const latest = incident.updates[0];

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="text-sm font-medium text-foreground">{incident.title}</div>
          <div className="text-xs text-muted-foreground">
            {formatIncidentTime(incident.startedAt)}
            {duration ? ` · Lasted ${duration}` : ''}
            {affected ? ` · ${affected}` : ''}
          </div>
        </div>
        <IncidentStatusChip status={incident.status} />
      </div>
      {!open && latest && (
        <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{latest.message}</p>
      )}
      {open && (
        <div className="mt-4">
          <UpdateTimeline updates={incident.updates} />
        </div>
      )}
      {incident.updates.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-2 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? 'Hide updates' : `Show ${incident.updates.length} update${incident.updates.length === 1 ? '' : 's'}`}
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
    </li>
  );
};

/** Resolved incidents from the last 90 days, below the checks. */
export const PastIncidents: React.FC<{
  incidents: StatusPageIncident[];
  checkNames: Record<string, string>;
  windowDays?: number;
}> = ({ incidents, checkNames, windowDays = 90 }) => {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const past = incidents
    .filter((incident) => incident.status === 'resolved' && (incident.resolvedAt ?? 0) >= cutoff)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (past.length === 0) return null;

  return (
    <section aria-label="Past incidents" className="mt-8 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Past incidents</h2>
        <span className="text-[11px] text-muted-foreground">Last {windowDays} days</span>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {past.map((incident) => (
          <PastIncidentRow key={incident.id} incident={incident} checkNames={checkNames} />
        ))}
      </ul>
    </section>
  );
};
