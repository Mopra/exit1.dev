import React from 'react';
import { Skeleton } from '../ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

interface LogsSkeletonProps {
  rows?: number;
}

export const LogsSkeleton: React.FC<LogsSkeletonProps> = ({ rows = 10 }) => {
  return (
    <div className="space-y-4">
      {/* Status Information Skeleton */}
      <div className="flex items-center justify-between p-4 bg-neutral-900/30 rounded-lg border border-neutral-800/50">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-4 w-16" />
      </div>

      {/* Table Skeleton */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader className="bg-muted border-b">
            <TableRow>
              <TableHead className="px-4 py-4">
                <Skeleton className="h-4 w-16" />
              </TableHead>
              <TableHead className="px-4 py-4">
                <Skeleton className="h-4 w-12" />
              </TableHead>
              <TableHead className="px-4 py-4">
                <Skeleton className="h-4 w-16" />
              </TableHead>
              <TableHead className="px-4 py-4">
                <Skeleton className="h-4 w-20" />
              </TableHead>
              <TableHead className="px-4 py-4">
                <Skeleton className="h-4 w-16" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-border">
            {Array.from({ length: rows }).map((_, index) => (
              <TableRow key={index}>
                <TableCell className="px-4 py-4">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </TableCell>
                <TableCell className="px-4 py-4">
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </TableCell>
                <TableCell className="px-4 py-4">
                  <Skeleton className="h-6 w-16 rounded-full" />
                </TableCell>
                <TableCell className="px-4 py-4">
                  <Skeleton className="h-4 w-12" />
                </TableCell>
                <TableCell className="px-4 py-4">
                  <Skeleton className="h-4 w-8" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
