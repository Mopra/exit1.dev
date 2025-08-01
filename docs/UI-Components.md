# UI Components Documentation

## TimeRangeSelector

A reusable toggle component for selecting time ranges with Apple-inspired design.

### Props

```typescript
interface TimeRangeSelectorProps {
  value: TimeRange | string;
  onChange: (range: TimeRange | string) => void;
  className?: string;
  variant?: 'compact' | 'full';
  options?: (TimeRange | string)[];
}
```

### Usage Examples

#### Compact Variant (Statistics page)
```tsx
<TimeRangeSelector
  value={timeRange}
  onChange={setTimeRange}
  variant="compact"
  options={['24h', '7d']}
/>
```

#### Full Variant (Logs page)
```tsx
<TimeRangeSelector
  value={dateRange}
  onChange={setDateRange}
  variant="full"
/>
```

## FilterBar

A comprehensive filter component that combines time range selection, search, status filtering, and website filtering with action buttons.

### Props

```typescript
interface FilterBarProps {
  // Time range
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  showCustomDateRange?: boolean;
  onToggleCustomDateRange?: () => void;
  customStartDate?: string;
  customEndDate?: string;
  onCustomStartDateChange?: (date: string) => void;
  onCustomEndDateChange?: (date: string) => void;
  
  // Search
  searchTerm: string;
  onSearchChange: (term: string) => void;
  searchPlaceholder?: string;
  
  // Status filter
  statusFilter: string;
  onStatusChange: (status: string) => void;
  statusOptions?: { value: string; label: string }[];
  
  // Website filter
  websiteFilter: string;
  onWebsiteChange: (website: string) => void;
  websiteOptions?: { value: string; label: string }[];
  
  // Actions
  onRefresh?: () => void;
  onExport?: () => void;
  loading?: boolean;
  canExport?: boolean;
  
  // Layout
  variant?: 'compact' | 'full';
  className?: string;
}
```

### Usage Examples

#### Full FilterBar (Logs page)
```tsx
<FilterBar
  timeRange={dateRange}
  onTimeRangeChange={setDateRange}
  showCustomDateRange={showCustomDateRange}
  onToggleCustomDateRange={() => setShowCustomDateRange(!showCustomDateRange)}
  customStartDate={customStartDate}
  customEndDate={customEndDate}
  onCustomStartDateChange={setCustomStartDate}
  onCustomEndDateChange={setCustomEndDate}
  searchTerm={searchTerm}
  onSearchChange={setSearchTerm}
  searchPlaceholder="Search websites, errors..."
  statusFilter={statusFilter}
  onStatusChange={(status) => setStatusFilter(status as 'all' | 'online' | 'offline' | 'unknown')}
  websiteFilter={websiteFilter}
  onWebsiteChange={setWebsiteFilter}
  websiteOptions={checks?.map(website => ({ value: website.id, label: website.name })) || []}
  onRefresh={() => fetchLogs(true)}
  onExport={exportToCSV}
  loading={loading}
  canExport={logEntries.length > 0}
  variant="full"
/>
```

#### Compact FilterBar (Incidents page)
```tsx
<FilterBar
  timeRange="24h"
  onTimeRangeChange={() => {}} // Not used
  searchTerm=""
  onSearchChange={() => {}} // Not used
  statusFilter={statusFilter}
  onStatusChange={(status) => setStatusFilter(status as 'all' | 'online' | 'offline' | 'unknown')}
  websiteFilter=""
  onWebsiteChange={() => {}} // Not used
  variant="compact"
  className="mb-4"
/>
```

## Button

A versatile button component with multiple variants including the new gradient style that matches the input field design.

### Props

```typescript
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'gradient';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
}
```

### Variants

- **primary**: White background with black text (default)
- **secondary**: Transparent background with white text
- **danger**: Red background for destructive actions
- **ghost**: Transparent background with subtle hover effects
- **gradient**: Blue gradient background matching input field styling

### Usage Examples

#### Primary Button
```tsx
<Button variant="primary" onClick={handleClick}>
  Save Changes
</Button>
```

#### Gradient Button (New)
```tsx
<Button variant="gradient" onClick={handleSubmit}>
  <FontAwesomeIcon icon={faPlus} className="w-3 h-3" />
  Add Item
</Button>
```

#### Secondary Button
```tsx
<Button variant="secondary" onClick={handleCancel}>
  Cancel
</Button>
```

#### Danger Button
```tsx
<Button variant="danger" onClick={handleDelete}>
  Delete
</Button>
```

#### Ghost Button
```tsx
<Button variant="ghost" onClick={handleEdit}>
  Edit
</Button>
```

#### Different Sizes
```tsx
<Button size="sm" variant="gradient">Small</Button>
<Button size="md" variant="gradient">Medium</Button>
<Button size="lg" variant="gradient">Large</Button>
```

## Design Principles

### Apple-Inspired Design
- **Minimalistic**: Clean, simple layouts with less visual clutter
- **Dark Mode**: Uses darker, toned-down colors throughout
- **Smooth Animations**: Subtle transitions and hover effects
- **Consistent Spacing**: Uniform padding and margins
- **Typography**: Clear hierarchy with appropriate font weights

### DRY Principle
- **Reusable Components**: Both components can be used across different pages
- **Configurable**: Props allow customization for different use cases
- **Consistent API**: Similar patterns for state management and callbacks
- **Type Safety**: Full TypeScript support with proper type definitions

### Accessibility
- **Keyboard Navigation**: All interactive elements are keyboard accessible
- **Screen Reader Support**: Proper ARIA labels and roles
- **Focus Management**: Clear focus indicators and logical tab order
- **Color Contrast**: Meets WCAG guidelines for text contrast

## Implementation Notes

### TimeRangeSelector
- Uses CSS transforms for smooth sliding animations
- Supports both compact (2 options) and full (6 options) variants
- Automatically adjusts button widths based on variant
- Includes hover and active states for better UX

### FilterBar
- Organizes filters in logical groups (time, search, status, website)
- Supports optional custom date range picker
- Includes action buttons for refresh and export
- Responsive design that works on different screen sizes
- Gracefully handles missing props (optional filters)

### Performance Considerations
- Uses React.memo for optimal re-rendering
- Minimal DOM manipulation with CSS-based animations
- Efficient state updates with proper dependency arrays
- Lazy loading of optional features (custom date range) 