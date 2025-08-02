import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { Button } from './index';
import { theme, typography } from '../../config/theme';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
  className?: string;
  showQuickJump?: boolean;
  isMobile?: boolean;
}

const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  onPageChange,
  className = '',
  showQuickJump = true,
  isMobile = false
}) => {
  if (totalPages <= 1) return null;

  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, totalItems);

  // Generate page numbers to display
  const getPageNumbers = () => {
    const maxVisible = isMobile ? 3 : 5;
    const pages: (number | string)[] = [];

    if (totalPages <= maxVisible) {
      // Show all pages if total is small
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);

      if (currentPage <= 3) {
        // Near the beginning
        for (let i = 2; i <= Math.min(4, totalPages - 1); i++) {
          pages.push(i);
        }
        if (totalPages > 4) {
          pages.push('...');
        }
      } else if (currentPage >= totalPages - 2) {
        // Near the end
        if (totalPages > 4) {
          pages.push('...');
        }
        for (let i = Math.max(2, totalPages - 3); i < totalPages; i++) {
          pages.push(i);
        }
      } else {
        // In the middle
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) {
          pages.push(i);
        }
        pages.push('...');
      }

      // Always show last page
      if (totalPages > 1) {
        pages.push(totalPages);
      }
    }

    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Page Info */}
      <div className={`flex items-center justify-between ${isMobile ? 'flex-col gap-2' : ''}`}>
        <div className={`text-sm ${theme.colors.text.muted} ${isMobile ? 'text-center' : ''}`}>
          {isMobile ? (
            <>Page {currentPage} of {totalPages}</>
          ) : (
            <>Showing {startIndex + 1}-{endIndex} of {totalItems} items</>
          )}
        </div>
        
        {/* Quick Jump - Desktop Only */}
        {showQuickJump && !isMobile && totalPages > 5 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Quick jump:</span>
            <div className="flex items-center gap-1">
              {[1, Math.ceil(totalPages / 2), totalPages].map(pageNum => (
                <button
                  key={pageNum}
                  onClick={() => onPageChange(pageNum)}
                  disabled={currentPage === pageNum}
                  className={`
                    px-2 py-1 text-xs rounded-md transition-all cursor-pointer
                    ${currentPage === pageNum 
                      ? 'bg-neutral-700/50 text-neutral-300 cursor-not-allowed' 
                      : 'bg-neutral-800/30 text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200'
                    }
                    ${typography.fontFamily.mono} tracking-wide
                  `}
                >
                  {pageNum === 1 ? '1st' : pageNum === totalPages ? 'Last' : 'Mid'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {/* Navigation Controls */}
      <div className={`flex items-center justify-center gap-2 ${isMobile ? 'flex-col gap-3' : ''}`}>
        {/* Previous Button */}
        <Button
          variant="secondary"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          size="sm"
          className="flex items-center gap-2 min-w-[80px]"
        >
          <FontAwesomeIcon icon={faChevronLeft} className="w-3 h-3" />
          {!isMobile && 'Previous'}
        </Button>
        
        {/* Page Numbers */}
        <div className="flex items-center gap-1">
          {pageNumbers.map((page, index) => (
            <React.Fragment key={index}>
              {page === '...' ? (
                <span className={`px-2 py-1 text-xs ${theme.colors.text.muted} ${typography.fontFamily.mono}`}>
                  ...
                </span>
              ) : (
                <button
                  onClick={() => onPageChange(page as number)}
                  className={`
                    ${isMobile ? 'w-8 h-8' : 'w-9 h-9'} 
                    rounded-md transition-all cursor-pointer flex items-center justify-center
                    ${currentPage === page
                      ? 'bg-white/90 text-black font-semibold'
                      : 'bg-neutral-800/30 text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-200'
                    }
                    ${typography.fontFamily.mono} text-sm
                  `}
                >
                  {page}
                </button>
              )}
            </React.Fragment>
          ))}
        </div>
        
        {/* Next Button */}
        <Button
          variant="secondary"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          size="sm"
          className="flex items-center gap-2 min-w-[80px]"
        >
          {!isMobile && 'Next'}
          <FontAwesomeIcon icon={faChevronRight} className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
};

export default Pagination; 