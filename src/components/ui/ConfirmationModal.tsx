import React from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { Button } from './button';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'destructive' | 'warning' | 'info';
  icon?: React.ComponentType<{ className?: string }>;
  itemCount?: number;
  itemName?: string;
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText = 'Cancel',
  variant = 'destructive',
  icon,
  itemCount,
  itemName
}) => {
  const getVariantConfig = () => {
    switch (variant) {
      case 'destructive':
        return {
          icon: icon || Trash2,
          iconBg: 'bg-red-100',
          iconColor: 'text-red-600',
          buttonVariant: 'destructive' as const
        };
      case 'warning':
        return {
          icon: icon || AlertTriangle,
          iconBg: 'bg-primary/10',
          iconColor: 'text-primary',
          buttonVariant: 'secondary' as const
        };
      case 'info':
        return {
          icon: icon || AlertTriangle,
          iconBg: 'bg-primary/10',
          iconColor: 'text-primary',
          buttonVariant: 'default' as const
        };
    }
  };

  const config = getVariantConfig();
  const defaultConfirmText = itemCount && itemName 
    ? `${confirmText || 'Delete'} ${itemCount} ${itemName}${itemCount !== 1 ? 's' : ''}`
    : confirmText || 'Confirm';

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center h-10 w-10 rounded-full ${config.iconBg}`}>
              <config.icon className={`h-5 w-5 ${config.iconColor}`} />
            </div>
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </div>
        </AlertDialogHeader>
        
        <AlertDialogDescription className="text-left">
          {message}
        </AlertDialogDescription>

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline">
              {cancelText}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button 
              variant={config.buttonVariant}
              onClick={onConfirm}
              className={variant === 'destructive' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}
            >
              {defaultConfirmText}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ConfirmationModal; 