import React, { useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { theme, typography } from '../../config/theme';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const Modal: React.FC<ModalProps> = ({ 
  isOpen, 
  onClose, 
  title, 
  children, 
  className = '',
  size = 'md'
}) => {
  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl'
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      
      {/* Modal Container - ensures proper scrolling and viewport constraint */}
      <div className="flex min-h-screen items-start justify-center p-4 pt-16 pb-16">
        {/* Modal */}
        <div 
          className={`relative ${theme.colors.background.modal} ${theme.colors.border.primary} rounded-lg shadow-2xl ${sizeClasses[size]} w-full max-h-[calc(100vh-8rem)] flex flex-col ${className}`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className={`flex items-center justify-between p-6 border-b ${theme.colors.border.secondary} flex-shrink-0`}>
            <h2 className={`${theme.colors.text.primary} ${typography.fontFamily.mono} font-medium text-lg uppercase tracking-wider`}>
              {title}
            </h2>
            <button
              onClick={onClose}
              className={`${theme.colors.text.secondary} hover:${theme.colors.text.primary} ${theme.colors.background.hover} p-2 rounded-full transition-colors flex-shrink-0`}
              aria-label="Close modal"
            >
              <FontAwesomeIcon icon={['fas', 'times']} className="w-4 h-4" />
            </button>
          </div>
          
          {/* Content */}
          <div className="p-6 overflow-y-auto flex-1 min-h-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Modal; 