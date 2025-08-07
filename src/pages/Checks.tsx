import { useState, useEffect } from 'react';
import { CheckForm, CheckTable, CheckUsage, FilterBar, EmptyState, ErrorModal } from '../components';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui';
import { Plus, Search, CheckCircle, XCircle } from 'lucide-react';
import { useChecks } from '../hooks/useChecks';

const Checks = () => {
  const {
    checks,
    loading,
    error,
    handleCreateCheck,
    handleDeleteCheck,
    deleteError,
    setDeleteError,
    refetch
  } = useChecks();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filteredChecks = checks.filter(check => {
    const matchesSearch = check.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         check.url.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || check.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const onlineCount = checks.filter(check => check.status === 'online').length;
  const offlineCount = checks.filter(check => check.status === 'offline').length;

  const handleFormSubmit = async (data: any) => {
    try {
      await handleCreateCheck(data);
      setIsCreateDialogOpen(false);
    } catch (error) {
      console.error('Failed to create check:', error);
    }
  };

  useEffect(() => {
    document.title = 'Checks | Exit1 Monitoring';
  }, []);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Checks</h1>
              <p className="text-muted-foreground">
                Manage your monitoring checks
              </p>
            </div>
          </div>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-16 bg-muted animate-pulse rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Checks</h1>
              <p className="text-muted-foreground">
                Manage your monitoring checks
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-6">
            <h3 className="text-lg font-semibold text-destructive mb-2">Error Loading Checks</h3>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button onClick={refetch} variant="outline">
              Try Again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Checks</h1>
            <p className="text-muted-foreground">
              Manage your monitoring checks
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button className="flex items-center gap-2">
                  <Plus className="w-3 h-3" />
                  Add Check
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Create New Check</DialogTitle>
                </DialogHeader>
                <CheckForm 
                  onSubmit={handleFormSubmit}
                  loading={loading}
                  noCard={true}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-card border rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-muted rounded-md">
                <CheckCircle className="text-green-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Online</p>
                <p className="text-2xl font-bold">{onlineCount}</p>
              </div>
            </div>
          </div>
          <div className="bg-card border rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-muted rounded-md">
                <XCircle className="text-red-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Offline</p>
                <p className="text-2xl font-bold">{offlineCount}</p>
              </div>
            </div>
          </div>
          <div className="bg-card border rounded-lg p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-muted rounded-md">
                <CheckCircle className="text-blue-500" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total</p>
                <p className="text-2xl font-bold">{checks.length}</p>
              </div>
            </div>
          </div>
          <div className="bg-card border rounded-lg p-4">
            <CheckUsage />
          </div>
        </div>

        {/* Quick Actions */}
        <div className="lg:hidden">
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button className="w-full flex items-center gap-2">
                <Plus className="w-3 h-3" />
                Add Check
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Create New Check</DialogTitle>
              </DialogHeader>
              <CheckForm 
                onSubmit={handleFormSubmit}
                loading={loading}
                noCard={true}
              />
            </DialogContent>
          </Dialog>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search checks..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {/* Checks Table */}
        {filteredChecks.length === 0 ? (
          <EmptyState
            title="No checks found"
            description={
              searchTerm || statusFilter !== 'all'
                ? "No checks match your current filters. Try adjusting your search or filter criteria."
                : "Get started by creating your first monitoring check."
            }
            action={
              <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button className="flex items-center gap-2">
                    <Plus className="w-4 h-4" />
                    Create your first check
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Create New Check</DialogTitle>
                  </DialogHeader>
                  <CheckForm 
                    onSubmit={handleFormSubmit}
                    loading={loading}
                    noCard={true}
                  />
                </DialogContent>
              </Dialog>
            }
          />
        ) : (
          <CheckTable 
            checks={filteredChecks}
            onDeleteCheck={handleDeleteCheck}
            loading={loading}
          />
        )}

        {/* Error Modal */}
        <ErrorModal
          isOpen={!!deleteError}
          onClose={() => setDeleteError(null)}
          title="Delete Check Failed"
          description={deleteError || ''}
        />
      </div>
    </div>
  );
};

export default Checks; 