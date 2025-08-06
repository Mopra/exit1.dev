import React from 'react';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from './pagination';

interface PaginationWrapperProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
  className?: string;
  showQuickJump?: boolean;
  isMobile?: boolean;
}

const PaginationWrapper: React.FC<PaginationWrapperProps> = ({
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
        <div className={`text-sm text-muted-foreground ${isMobile ? 'text-center' : ''}`}>
          {isMobile ? (
            <>Page {currentPage} of {totalPages}</>
          ) : (
            <>Showing {startIndex + 1}-{endIndex} of {totalItems} items</>
          )}
        </div>
        
        {/* Quick Jump - Desktop Only */}
        {showQuickJump && !isMobile && totalPages > 5 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick jump:</span>
            <div className="flex items-center gap-1">
              {[1, Math.ceil(totalPages / 2), totalPages].map(pageNum => (
                <button
                  key={pageNum}
                  onClick={() => onPageChange(pageNum)}
                  disabled={currentPage === pageNum}
                  className={`
                    px-2 py-1 text-xs rounded-md transition-all cursor-pointer
                    ${currentPage === pageNum 
                      ? 'bg-muted text-muted-foreground cursor-not-allowed' 
                      : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    }
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
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious 
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onPageChange(currentPage - 1);
              }}
              className={currentPage === 1 ? 'pointer-events-none opacity-50' : ''}
            />
          </PaginationItem>
          
          {pageNumbers.map((page, index) => (
            <PaginationItem key={index}>
              {page === '...' ? (
                <PaginationEllipsis />
              ) : (
                <PaginationLink
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onPageChange(page as number);
                  }}
                  isActive={currentPage === page}
                >
                  {page}
                </PaginationLink>
              )}
            </PaginationItem>
          ))}
          
          <PaginationItem>
            <PaginationNext 
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onPageChange(currentPage + 1);
              }}
              className={currentPage === totalPages ? 'pointer-events-none opacity-50' : ''}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
};

export default PaginationWrapper; 