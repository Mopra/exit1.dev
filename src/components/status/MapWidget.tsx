import React from 'react';
import { Map as MapIcon } from 'lucide-react';
import { GlowCard } from '../ui';
import type { CustomLayoutWidget, Website } from '../../types';
import CheckMapView from '../check/CheckMapView';

interface MapWidgetProps {
  widget: CustomLayoutWidget;
  checks: Website[];
  editMode: boolean;
}

export const MapWidget: React.FC<MapWidgetProps> = ({
  checks,
}) => {
  // Filter to only checks with geo data
  const geoChecks = checks.filter(
    (c) =>
      typeof c.targetLatitude === 'number' &&
      typeof c.targetLongitude === 'number' &&
      Number.isFinite(c.targetLatitude) &&
      Number.isFinite(c.targetLongitude)
  );

  if (geoChecks.length === 0) {
    return (
      <GlowCard className="p-5 h-full flex flex-col items-center justify-center gap-2 border-dashed">
        <MapIcon className="w-8 h-8 text-muted-foreground/50" />
        <div className="text-sm text-muted-foreground text-center">
          No geo data available
        </div>
        <p className="text-xs text-muted-foreground/70 text-center max-w-[200px]">
          Geographic locations will appear once checks have run and resolved their targets.
        </p>
      </GlowCard>
    );
  }

  return (
    <GlowCard className="h-full flex flex-col min-w-0 overflow-hidden p-0">
      <div className="flex-1 min-h-0">
        <CheckMapView checks={checks} hideHeader fill />
      </div>
    </GlowCard>
  );
};
