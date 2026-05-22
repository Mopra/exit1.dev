import { cn } from '@/lib/utils';

type KbdProps = React.HTMLAttributes<HTMLElement>;

export const Kbd = ({ className, children, ...props }: KbdProps) => (
  <kbd
    className={cn(
      'inline-flex items-center gap-0.5 rounded border border-border/40 bg-black/60 px-2 py-1 text-[10px] font-medium text-muted-foreground/50 select-none',
      className,
    )}
    {...props}
  >
    {children}
  </kbd>
);

export default Kbd;
