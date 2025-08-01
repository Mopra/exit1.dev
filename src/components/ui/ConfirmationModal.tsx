import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faTrash, faExclamationTriangle } from '@fortawesome/free-solid-svg-icons';
import Modal from './Modal';
import Button from './Button';
import { theme } from '../../config/theme';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  icon?: IconDefinition;
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
  variant = 'danger',
  icon,
  itemCount,
  itemName
}) => {
  const getVariantConfig = () => {
    switch (variant) {
      case 'danger':
        return {
          icon: icon || faTrash,
          iconBg: 'bg-red-100',
          iconColor: 'text-red-600',
          buttonVariant: 'danger' as const
        };
      case 'warning':
        return {
          icon: icon || faExclamationTriangle,
          iconBg: 'bg-yellow-100',
          iconColor: 'text-yellow-600',
          buttonVariant: 'secondary' as const
        };
      case 'info':
        return {
          icon: icon || faExclamationTriangle,
          iconBg: 'bg-blue-100',
          iconColor: 'text-blue-600',
          buttonVariant: 'primary' as const
        };
    }
  };

  const config = getVariantConfig();
  const defaultConfirmText = itemCount && itemName 
    ? `${confirmText || 'Delete'} ${itemCount} ${itemName}${itemCount !== 1 ? 's' : ''}`
    : confirmText || 'Confirm';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="md"
    >
      <div className="space-y-4">
        <div className="text-center">
          <div className={`mx-auto flex items-center justify-center h-12 w-12 rounded-full mb-4 ${config.iconBg}`}>
            <FontAwesomeIcon icon={config.icon} className={`h-6 w-6 ${config.iconColor}`} />
          </div>
          <h3 className={`text-lg font-medium ${theme.colors.text.primary} mb-2`}>
            {title}
          </h3>
          <p className={`text-sm ${theme.colors.text.muted}`}>
            {message}
          </p>
        </div>

        <div className="flex gap-3 pt-4">
          <Button 
            onClick={onConfirm}
            variant={config.buttonVariant}
            className="flex-1"
          >
            {defaultConfirmText}
          </Button>
          <Button 
            onClick={onClose}
            variant="secondary"
            className="flex-1"
          >
            {cancelText}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default ConfirmationModal; 