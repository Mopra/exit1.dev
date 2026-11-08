import { createContext, useContext } from 'react';

/**
 * Who is looking at a public status page. PublicStatus reads this instead of
 * Clerk's useAuth() so it can also render on a customer's custom domain,
 * where Clerk never mounts. The app route fills it from Clerk (App.tsx);
 * without a provider the viewer is anonymous, so owner-only controls (edit
 * mode, incidents sheet, owner map data) simply do not show.
 */
export interface StatusViewer {
  userId: string | null;
  isSignedIn: boolean;
}

const ANONYMOUS_VIEWER: StatusViewer = { userId: null, isSignedIn: false };

export const StatusViewerContext = createContext<StatusViewer>(ANONYMOUS_VIEWER);

export function useStatusViewer(): StatusViewer {
  return useContext(StatusViewerContext);
}
