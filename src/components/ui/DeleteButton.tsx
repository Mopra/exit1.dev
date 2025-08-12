import * as React from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Trash2, Loader2 } from 'lucide-react';

export interface DeleteButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: React.ComponentProps<typeof Button>['size'];
  isLoading?: boolean;
}

/**
 * Standardized delete button: deep red background, white text, left trash icon.
 * Always use this for destructive delete actions.
 */
export function DeleteButton({
  className,
  children,
  size = 'sm',
  isLoading = false,
  disabled,
  ...props
}: DeleteButtonProps) {
  return (
    <Button
      type="button"
      variant="destructive"
      size={size}
      disabled={disabled || isLoading}
      className={cn(
        'cursor-pointer bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600',
        'flex items-center',
        className,
      )}
      {...props}
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin text-white" aria-hidden="true" />
      ) : (
        <Trash2 className="h-4 w-4 mr-2 text-white" aria-hidden="true" />
      )}
      {children ?? (isLoading ? 'Deleting…' : 'Delete')}
    </Button>
  );
}

export default DeleteButton;


