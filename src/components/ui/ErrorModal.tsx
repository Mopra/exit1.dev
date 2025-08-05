import Modal from './Modal';
import Button from './Button';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExclamationTriangle, faTimes } from '@fortawesome/free-solid-svg-icons';
import { typography } from '../../config/theme';

interface ErrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  error: {
    title: string;
    message: string;
    details?: string;
    suggestions?: string[];
  };
}

export function ErrorModal({ isOpen, onClose, error }: ErrorModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={error.title}>
      <div className="p-6 max-w-md mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-red-500/20 rounded-full flex items-center justify-center">
            <FontAwesomeIcon icon={faExclamationTriangle} className="text-red-500 w-5 h-5" />
          </div>
          <div>
            <h3 className={`${typography.fontFamily.mono} text-lg font-semibold text-white`}>
              {error.title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <FontAwesomeIcon icon={faTimes} className="text-gray-400 w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          <p className={`${typography.fontFamily.sans} text-gray-300 leading-relaxed`}>
            {error.message}
          </p>

          {error.details && (
            <div className="bg-gray-800/50 rounded-lg p-3">
              <p className={`${typography.fontFamily.mono} text-sm text-gray-400`}>
                {error.details}
              </p>
            </div>
          )}

          {error.suggestions && error.suggestions.length > 0 && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
              <h4 className={`${typography.fontFamily.mono} text-sm font-medium text-blue-300 mb-2`}>
                Suggestions:
              </h4>
              <ul className="space-y-1">
                {error.suggestions.map((suggestion, index) => (
                  <li key={index} className={`${typography.fontFamily.sans} text-sm text-blue-200`}>
                    • {suggestion}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex justify-end mt-6">
          <Button onClick={onClose} variant="primary">
            Got it
          </Button>
        </div>
      </div>
    </Modal>
  );
} 