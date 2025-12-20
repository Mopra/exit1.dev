import React from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import { Settings } from 'lucide-react';

export interface ColumnConfig {
  key: string;
  label: string;
  visible: boolean;
}

interface ColumnControlsProps {
  columns: ColumnConfig[];
  onColumnToggle: (key: string) => void;
}

export const ColumnControls: React.FC<ColumnControlsProps> = ({
  columns,
  onColumnToggle
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 px-2">
          <Settings className="w-4 h-4 mr-1" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={column.visible}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => onColumnToggle(column.key)}
            className="cursor-pointer"
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
