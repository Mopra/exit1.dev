/**
 * "What's new" release notes, shown once per user in a popup after they ship.
 *
 * To announce something, add an entry at the TOP of the list with a new,
 * unique `id`. Users who signed up before `date` and haven't dismissed this
 * id yet see it on their next visit. Keep it light: a title and a few lines.
 */
export interface ReleaseNote {
  /** Unique and stable. Never reuse or rename one that has shipped. */
  id: string;
  /** YYYY-MM-DD. Users who signed up after this never see the entry. */
  date: string;
  title: string;
  items: string[];
  link?: { label: string; to: string };
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: '2026-10-team-members',
    date: '2026-10-12',
    title: 'Invite your team',
    items: [
      'Pro accounts can now invite team members to share checks, alerts and status pages.',
      'Switch between your own account and your team from the account switcher.',
      'Manage cards and download invoices straight from the Billing page.',
    ],
    link: { label: 'Open Team', to: '/team' },
  },
];
