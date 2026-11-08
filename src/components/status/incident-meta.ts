import { format } from 'date-fns';
import type { IncidentStatus } from '../../types';

/** Shared labels and tones for incident statuses (public page + owner editor). */
export const INCIDENT_STATUS_META: Record<IncidentStatus, { label: string; tone: string; chip: string; hint: string }> = {
  investigating: {
    label: 'Investigating',
    tone: 'bg-destructive',
    chip: 'bg-destructive/10 text-destructive',
    hint: 'We know something is wrong and are looking into it.',
  },
  identified: {
    label: 'Identified',
    tone: 'bg-warning',
    chip: 'bg-warning/10 text-warning',
    hint: 'We found the cause and are working on a fix.',
  },
  monitoring: {
    label: 'Monitoring',
    tone: 'bg-primary',
    chip: 'bg-primary/10 text-primary',
    hint: 'A fix is in place and we are watching the results.',
  },
  resolved: {
    label: 'Resolved',
    tone: 'bg-success',
    chip: 'bg-success/10 text-success',
    hint: 'The incident is over.',
  },
};

export const INCIDENT_STATUS_ORDER: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved'];

export const formatIncidentTime = (ts: number) => {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format(date, sameYear ? 'MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
};

export const formatIncidentDuration = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h` : `${days} d`;
};
