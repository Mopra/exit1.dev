import React, { useState, useCallback } from 'react';
import { 
  ArrowUpDown,
  SortAsc,
  SortDesc,
  MoreVertical,
  Shield,
  ShieldCheck,
  User,
  Mail,
  Calendar,
  Check,
  Loader2,
  Trash2
} from 'lucide-react';
import { 
  IconButton, 
  DeleteButton, 
  EmptyState, 
  ConfirmationModal, 
  Table, 
  TableHeader, 
  TableBody, 
  TableHead, 
  TableRow, 
  TableCell, 
  GlowCard, 
  ScrollArea, 
  glassClasses, 
  Checkbox,
  Badge,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '../ui';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';
import { highlightText } from '../../utils/formatters';

export interface PlatformUser {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
  updatedAt: number;
  isAdmin?: boolean;
  lastSignIn?: number;
  emailVerified?: boolean;
  checksCount?: number;
  webhooksCount?: number;
}

interface UserTableProps {
  users: PlatformUser[];
  onDelete?: (id: string) => void;
  onBulkDelete?: (ids: string[]) => void;
  searchQuery?: string;
  loading?: boolean;
}

type SortOption = 'name-asc' | 'name-desc' | 'email-asc' | 'email-desc' | 'createdAt' | 'lastSignIn' | 'checksCount' | 'admin';

const UserTable: React.FC<UserTableProps> = ({ 
  users, 
  onDelete,
  onBulkDelete,
  searchQuery = '',
  loading = false
}) => {
  const [sortBy, setSortBy] = useState<SortOption>('createdAt');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<PlatformUser | null>(null);
  
  // Multi-select state
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [bulkDeleteModal, setBulkDeleteModal] = useState(false);
  const [selectAll, setSelectAll] = useState(false);

  const { handleMouseDown: handleHorizontalScroll } = useHorizontalScroll();

  // Sort users based on selected option
  const sortedUsers = React.useMemo(() => {
    const sorted = [...users];
    
    switch (sortBy) {
      case 'name-asc':
        return sorted.sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email));
      case 'name-desc':
        return sorted.sort((a, b) => (b.displayName || b.email).localeCompare(a.displayName || a.email));
      case 'email-asc':
        return sorted.sort((a, b) => a.email.localeCompare(b.email));
      case 'email-desc':
        return sorted.sort((a, b) => b.email.localeCompare(a.email));
      case 'createdAt':
        return sorted.sort((a, b) => b.createdAt - a.createdAt);
      case 'lastSignIn':
        return sorted.sort((a, b) => (b.lastSignIn || 0) - (a.lastSignIn || 0));
      case 'checksCount':
        return sorted.sort((a, b) => (b.checksCount || 0) - (a.checksCount || 0));
      case 'admin':
        return sorted.sort((a, b) => {
          if (a.isAdmin && !b.isAdmin) return -1;
          if (!a.isAdmin && b.isAdmin) return 1;
          return 0;
        });
      default:
        return sorted;
    }
  }, [users, sortBy]);

  const handleSortChange = useCallback((newSortBy: SortOption) => {
    setSortBy(newSortBy);
  }, []);

  // Close menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openMenuId) {
        const target = event.target as Element;
        const isWithinActionMenu = target.closest('.action-menu');
        const isWithinMenu = target.closest('[data-menu="true"]');
        
        if (!isWithinActionMenu && !isWithinMenu) {
          setOpenMenuId(null);
        }
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);


  const handleDeleteConfirm = () => {
    if (deletingUser && onDelete) {
      onDelete(deletingUser.id);
      setDeletingUser(null);
    }
  };

  const handleDeleteCancel = () => {
    setDeletingUser(null);
  };

  // Multi-select handlers
  const handleSelectAll = useCallback(() => {
    if (selectAll) {
      setSelectedUsers(new Set());
      setSelectAll(false);
    } else {
      setSelectedUsers(new Set(sortedUsers.map(user => user.id)));
      setSelectAll(true);
    }
  }, [selectAll, sortedUsers]);

  const handleSelectUser = useCallback((userId: string) => {
    const newSelected = new Set(selectedUsers);
    if (newSelected.has(userId)) {
      newSelected.delete(userId);
    } else {
      newSelected.add(userId);
    }
    setSelectedUsers(newSelected);
    setSelectAll(newSelected.size === sortedUsers.length);
  }, [selectedUsers, sortedUsers.length]);

  const handleBulkDelete = useCallback(() => {
    setBulkDeleteModal(true);
  }, []);

  const handleBulkDeleteConfirm = useCallback(() => {
    if (onBulkDelete) {
      onBulkDelete(Array.from(selectedUsers));
      setSelectedUsers(new Set());
      setSelectAll(false);
      setBulkDeleteModal(false);
    }
  }, [onBulkDelete, selectedUsers]);

  const handleBulkDeleteCancel = useCallback(() => {
    setBulkDeleteModal(false);
  }, []);

  // Reset selection when users change
  React.useEffect(() => {
    setSelectedUsers(new Set());
    setSelectAll(false);
  }, [users]);


  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleDateString();
  };

  const formatDateTime = (timestamp?: number) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-muted-foreground">Loading users...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Mobile Card Layout (640px and below) */}
      <div className="block sm:hidden">
        <div className="space-y-3">
          {sortedUsers.map((user) => (
            <GlowCard key={user.id} className="p-4">
              <div className="space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedUsers.has(user.id)}
                      onCheckedChange={() => handleSelectUser(user.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1"
                    />
                    <div className="flex items-center gap-2">
                      <User className="h-5 w-5 text-primary" />
                      {user.isAdmin && <Shield className="h-4 w-4 text-primary" />}
                    </div>
                  </div>
                  <DropdownMenu open={openMenuId === user.id} onOpenChange={(open) => setOpenMenuId(open ? user.id : null)}>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        icon={<MoreVertical className="w-4 h-4" />}
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e?.stopPropagation();
                        }}
                        className="cursor-pointer"
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="cursor-pointer">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onDelete) {
                            setDeletingUser(user);
                          }
                          setOpenMenuId(null);
                        }}
                        className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Delete User
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* User Info */}
                <div className="space-y-2">
                  <div className="font-medium">
                    {highlightText(user.displayName || user.email, searchQuery)}
                  </div>
                  {user.displayName && (
                    <div className="text-sm text-muted-foreground font-mono">
                      {highlightText(user.email, searchQuery)}
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(user.createdAt)}
                    </div>
                    <div className="flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      {user.checksCount || 0} checks
                    </div>
                  </div>
                </div>
              </div>
            </GlowCard>
          ))}
        </div>
        
        {users.length === 0 && (
          <EmptyState
            variant="empty"
            icon={User}
            title="No users found"
            description="No users match your search criteria."
          />
        )}
      </div>

      {/* Desktop Table Layout (640px and above) */}
      <div className="hidden sm:block w-full min-w-0">
        <GlowCard className="w-full min-w-0 overflow-hidden">
          <ScrollArea className="w-full min-w-0" onMouseDown={handleHorizontalScroll}>
            <div className="min-w-[1000px] w-full">
              <Table>
                <TableHeader className="bg-muted border-b">
                  <TableRow>
                    <TableHead className="px-3 py-4 text-left w-12">
                      <div className="flex items-center justify-center">
                        <button
                          onClick={handleSelectAll}
                          className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectAll ? `border bg-background` : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                          title={selectAll ? 'Deselect all' : 'Select all'}
                        >
                          {selectAll && (
                            <Check className="w-2.5 h-2.5 text-white" />
                          )}
                        </button>
                      </div>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-left w-80">
                      <button
                        onClick={() => handleSortChange(sortBy === 'name-asc' ? 'name-desc' : 'name-asc')}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                      >
                        User
                        {sortBy === 'name-asc' ? <SortDesc className="w-3 h-3" /> : sortBy === 'name-desc' ? <SortAsc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                      </button>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-left w-60">
                      <button
                        onClick={() => handleSortChange(sortBy === 'email-asc' ? 'email-desc' : 'email-asc')}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                      >
                        Email
                        {sortBy === 'email-asc' ? <SortDesc className="w-3 h-3" /> : sortBy === 'email-desc' ? <SortAsc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                      </button>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-left w-32">
                      <button
                        onClick={() => handleSortChange('admin')}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                      >
                        Role
                        {sortBy === 'admin' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                      </button>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-left w-40">
                      <button
                        onClick={() => handleSortChange('createdAt')}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                      >
                        Created
                        {sortBy === 'createdAt' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                      </button>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-left w-40">
                      <button
                        onClick={() => handleSortChange('lastSignIn')}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                      >
                        Last Sign In
                        {sortBy === 'lastSignIn' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                      </button>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-left w-32">
                      <button
                        onClick={() => handleSortChange('checksCount')}
                        className={`flex items-center gap-2 text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer`}
                      >
                        Checks
                        {sortBy === 'checksCount' ? <SortDesc className="w-3 h-3" /> : <ArrowUpDown className="w-3 h-3" />}
                      </button>
                    </TableHead>
                    <TableHead className="px-4 py-4 text-center w-28">
                      <div className={`text-xs font-medium uppercase tracking-wider font-mono text-muted-foreground`}>
                        Actions
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y divide-border">
                  {sortedUsers.map((user) => (
                    <TableRow key={user.id} className="hover:bg-muted/50 transition-all duration-300 ease-out group cursor-pointer">
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center justify-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectUser(user.id);
                            }}
                            className={`w-4 h-4 border-2 rounded transition-colors duration-150 ${selectedUsers.has(user.id) ? `border bg-background` : 'border'} hover:border cursor-pointer flex items-center justify-center`}
                            title={selectedUsers.has(user.id) ? 'Deselect' : 'Select'}
                          >
                            {selectedUsers.has(user.id) && (
                              <Check className="w-2.5 h-2.5 text-white" />
                            )}
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-primary" />
                          <div className="flex flex-col">
                            <div className="font-medium text-sm">
                              {highlightText(user.displayName || 'No name', searchQuery)}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-mono text-muted-foreground">
                            {highlightText(user.email, searchQuery)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        {user.isAdmin ? (
                          <Badge variant="default" className="bg-primary text-primary-foreground">
                            <Shield className="h-3 w-3 mr-1" />
                            Admin
                          </Badge>
                        ) : (
                          <Badge variant="secondary">User</Badge>
                        )}
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-3 w-3 text-muted-foreground" />
                          <span className="text-sm font-mono text-muted-foreground">
                            {formatDate(user.createdAt)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <span className="text-sm font-mono text-muted-foreground">
                          {formatDateTime(user.lastSignIn)}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-3 w-3 text-muted-foreground" />
                          <span className="text-sm font-mono text-muted-foreground">
                            {user.checksCount || 0}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-4">
                        <div className="flex items-center justify-center">
                          <DropdownMenu open={openMenuId === user.id} onOpenChange={(open) => setOpenMenuId(open ? user.id : null)}>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                icon={<MoreVertical className="w-4 h-4" />}
                                size="sm"
                                variant="ghost"
                                onClick={(e) => {
                                  e?.stopPropagation();
                                }}
                                aria-label="More actions"
                                className="cursor-pointer text-muted-foreground hover:text-primary hover:bg-primary/10 pointer-events-auto p-1 transition-colors"
                              />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="cursor-pointer">
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (onDelete) {
                                    setDeletingUser(user);
                                  }
                                  setOpenMenuId(null);
                                }}
                                className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Delete User
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </ScrollArea>
          
          {users.length === 0 && (
            <div className="px-8 py-8">
              <EmptyState
                variant="empty"
                icon={User}
                title="No users found"
                description="No users match your search criteria."
              />
            </div>
          )}
        </GlowCard>
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={!!deletingUser}
        onClose={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        title={`Delete user "${deletingUser?.displayName || deletingUser?.email}"?`}
        message="This action cannot be undone. The user account and all associated data will be permanently removed."
        confirmText="Delete User"
        variant="destructive"
      />

      {/* Bulk Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={bulkDeleteModal}
        onClose={handleBulkDeleteCancel}
        onConfirm={handleBulkDeleteConfirm}
        title={`Delete ${selectedUsers.size} user${selectedUsers.size !== 1 ? 's' : ''}?`}
        message="This action cannot be undone. All selected users and their associated data will be permanently removed."
        confirmText="Delete"
        variant="destructive"
        itemCount={selectedUsers.size}
        itemName="user"
      />

      {/* Floating Bulk Actions Navigation */}
      {selectedUsers.size > 0 && (
        <div className={`fixed bottom-0 left-0 right-0 z-[50] ${glassClasses} border-t rounded-t-lg`}>
          <div className="px-4 py-4 sm:px-6 sm:py-6 max-w-screen-xl mx-auto">
            <div className="flex items-center justify-between gap-6">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full bg-background border border flex items-center justify-center`}>
                  <span className={`text-sm font-semibold font-mono text-foreground`}>
                    {selectedUsers.size}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className={`text-sm font-medium font-mono text-foreground`}>
                    {selectedUsers.size} user{selectedUsers.size !== 1 ? 's' : ''} selected
                  </span>
                  <span className={`text-xs text-muted-foreground`}>
                    {Math.round((selectedUsers.size / sortedUsers.length) * 100)}% of total
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <DeleteButton onClick={handleBulkDelete} size="sm">
                  Delete All
                </DeleteButton>
              </div>

              <button
                onClick={() => {
                  setSelectedUsers(new Set());
                  setSelectAll(false);
                }}
                className={`w-8 h-8 rounded-full hover:bg-accent border border flex items-center justify-center cursor-pointer transition-all duration-200 hover:bg-neutral/20 hover:scale-105`}
                title="Clear selection"
              >
                <span className={`text-sm text-muted-foreground hover:text-foreground transition-colors duration-200`}>
                  ✕
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default UserTable;
