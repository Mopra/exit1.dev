import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@clerk/clerk-react';
import { Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/Button';
import { RELEASE_NOTES, type ReleaseNote } from '@/config/release-notes';

// Seen state lives in Clerk unsafeMetadata so a dismissal follows the user
// across devices. localStorage mirrors it so the popup never flashes again on
// this browser while Clerk is still saving.
const METADATA_KEY = 'whatsNewSeenId';
const CACHE_PREFIX = 'exit1_whats_new_seen:';
const MAX_SHOWN = 3;

function readCache(userId: string): string | null {
  try {
    return localStorage.getItem(`${CACHE_PREFIX}${userId}`);
  } catch {
    return null;
  }
}

function writeCache(userId: string, id: string) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${userId}`, id);
  } catch {
    // ignore
  }
}

/** Notes newer than the last one this user dismissed and newer than their signup. */
function unseenNotes(seenId: string | null, signedUpAt: number): ReleaseNote[] {
  const seenIndex = seenId ? RELEASE_NOTES.findIndex((n) => n.id === seenId) : -1;
  const newer = seenIndex === -1 ? RELEASE_NOTES : RELEASE_NOTES.slice(0, seenIndex);
  return newer
    .filter((n) => new Date(`${n.date}T23:59:59Z`).getTime() > signedUpAt)
    .slice(0, MAX_SHOWN);
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function WhatsNewDialog() {
  const { user, isLoaded } = useUser();
  const [open, setOpen] = useState(false);

  const notes = useMemo(() => {
    if (!isLoaded || !user || RELEASE_NOTES.length === 0) return [];
    const fromClerk = user.unsafeMetadata?.[METADATA_KEY];
    const seenId = typeof fromClerk === 'string' ? fromClerk : readCache(user.id);
    const signedUpAt = user.createdAt?.getTime() ?? 0;
    return unseenNotes(seenId, signedUpAt);
  }, [isLoaded, user]);

  useEffect(() => {
    if (notes.length > 0) setOpen(true);
  }, [notes]);

  const dismiss = () => {
    setOpen(false);
    if (!user) return;
    const latestId = RELEASE_NOTES[0].id;
    writeCache(user.id, latestId);
    // Clerk replaces unsafeMetadata wholesale, so carry over what's there.
    user
      .update({ unsafeMetadata: { ...user.unsafeMetadata, [METADATA_KEY]: latestId } })
      .catch((err) => console.warn('[whats-new] failed to save seen state', err));
  };

  if (notes.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent className="sm:max-w-md shadow-[0_8px_30px_rgb(0,0,0,0.4)]">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-primary" />
            What's new
          </DialogTitle>
          <DialogDescription>A few things we shipped since you were last here.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 max-h-[60vh] overflow-y-auto">
          {notes.map((note) => (
            <section key={note.id} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">{note.title}</h3>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(note.date)}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground list-disc pl-5">
                {note.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {note.link && (
                <Link
                  to={note.link.to}
                  onClick={dismiss}
                  className="text-sm font-medium text-primary hover:underline w-fit"
                >
                  {note.link.label} →
                </Link>
              )}
            </section>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={dismiss} className="cursor-pointer">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
