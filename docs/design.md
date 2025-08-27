# Design System

## Overview

Exit1.dev features a modern, sophisticated design system built around **frosted blue glassmorphism** with a dark-first approach. The design emphasizes clarity, performance, and a premium user experience through carefully crafted visual elements and interactions.

## Core Design Principles

### 1. Glassmorphism Aesthetic
- **Frosted blue transparency**: Primary color scheme using sky-blue tints with backdrop blur effects
- **Subtle borders**: Soft, translucent borders that enhance depth without being intrusive
- **Layered depth**: Multiple visual layers creating a sense of depth and hierarchy
- **Backdrop blur**: Consistent use of backdrop-blur-md for glass-like effects

### 2. Dark-First Design
- **Primary theme**: Dark background with high contrast text
- **Reduced eye strain**: Optimized for extended monitoring sessions
- **Professional appearance**: Clean, modern aesthetic suitable for technical users

### 3. Performance-Focused
- **Smooth animations**: Subtle, purposeful animations that enhance UX without distraction
- **Optimized interactions**: Cursor-pointer on all clickable elements
- **Responsive design**: Mobile-first approach with adaptive layouts

## Color Palette

### Primary Colors
```css
/* Light Theme */
--primary: oklch(0.62 0.09 231)        /* Sky blue */
--secondary: oklch(0.7038 0.1230 182.5025) /* Teal */
--background: oklch(0.9789 0.0082 121.6272) /* Off-white */

/* Dark Theme */
--primary: oklch(0.86 0.06 231)        /* Bright sky blue */
--secondary: oklch(0.7845 0.1325 181.9120) /* Bright teal */
--background: oklch(0 0 0)             /* Pure black */
```

### Semantic Colors
- **Success**: Emerald green for operational status
- **Warning**: Amber for alerts and warnings
- **Error**: Red for critical issues and failures
- **Info**: Sky blue for informational elements

### Glassmorphism Variants
```css
/* Primary (Sky Blue) */
bg-sky-500/15 text-sky-50 border-sky-300/20

/* Success */
bg-emerald-500/15 text-emerald-50 border-emerald-300/20

/* Warning */
bg-amber-500/15 text-amber-50 border-amber-300/20

/* Destructive */
bg-red-500/15 text-red-50 border-red-300/20
```

### Subtle Gradients

#### Card Background Gradients
```css
/* Standard Glow Card */
bg-gradient-to-br from-primary/[0.02] via-transparent to-transparent

/* Aurora Blob Gradients (Premium Cards) */
bg-sky-600/45 blur-3xl    /* Top-left floating blob */
bg-indigo-700/40 blur-3xl /* Bottom-right floating blob */
bg-cyan-600/42 blur-3xl   /* Center floating blob */
```

#### Data Visualization Gradients
```css
/* Success/Online Status */
linear-gradient(to bottom, #4ade80, #059669)

/* Error/Offline Status */
linear-gradient(to bottom, #fca5a5, #dc2626)

/* Unknown/No Data Status */
linear-gradient(to bottom, #6b7280, #4b5563)
```

#### Table Row Hover Gradients
```css
/* Default hover */
hover:bg-muted/50

/* Success context */
hover:bg-green-50/50 dark:hover:bg-green-950/10

/* Error context */
hover:bg-red-50/50 dark:hover:bg-red-950/10

/* Warning context */
hover:bg-orange-50/50 dark:hover:bg-orange-950/10

/* Info context */
hover:bg-primary/10
```

#### Specular Highlights & Inner Glow
```css
/* Inner glow effect */
box-shadow: inset 0 0 80px 8px oklch(0.40 0.08 240 / 0.35)

/* Inner ring with glow */
box-shadow: inset 0 0 0 1px oklch(0.75 0.06 230 / 0.22), 
            inset 0 0 40px 6px oklch(0.30 0.06 240 / 0.20)

/* Specular sweep gradients */
linear-gradient(120deg,
  transparent 20%,
  oklch(0.98 0 0 / 0.08) 40%,
  oklch(0.98 0 0 / 0.18) 50%,
  oklch(0.98 0 0 / 0.08) 60%,
  transparent 80%
)

/* Diagonal specular sweep */
linear-gradient(200deg,
  transparent 15%,
  oklch(0.98 0 0 / 0.06) 35%,
  oklch(0.98 0 0 / 0.14) 50%,
  oklch(0.98 0 0 / 0.06) 65%,
  transparent 85%
)
```

## Typography

### Font Stack
- **Primary**: DM Sans (sans-serif)
- **Monospace**: Space Mono (for code and technical data)
- **Fallback**: System UI fonts

### Type Scale
- **Headings**: 2xl font-semibold with tight tracking
- **Body**: Base size with normal tracking
- **Small text**: Text-sm for secondary information
- **Micro**: Text-xs for metadata and labels

### Font Features
- **Ligatures**: Enabled for improved readability
- **Tracking**: Normal letter spacing for optimal legibility
- **Line height**: Comfortable spacing for extended reading

## Component Design

### Cards & Containers

#### Standard Card
```css
rounded-lg border bg-card text-card-foreground shadow-sm
```

#### Glow Card (Premium)
- **Aurora animations**: Floating gradient blobs with organic movement
- **Inner glow**: Subtle inner shadows for depth
- **Specular highlights**: Animated light sweeps for premium feel
- **Hover effects**: Subtle tilt on hover for interactivity

#### Glass Components
- **Backdrop blur**: Consistent md blur for glass effect
- **Translucent backgrounds**: 15% opacity with color variants
- **Soft borders**: 20% opacity borders matching background color

### Interactive Elements

#### Buttons
- **Primary**: Sky blue with hover states
- **Secondary**: Muted variants for less prominent actions
- **Destructive**: Red variants for dangerous actions
- **Cursor**: Always pointer on interactive elements

#### Form Elements
- **Inputs**: Subtle borders with focus rings
- **Checkboxes/Radios**: Custom styled with smooth transitions
- **Selects**: Dropdown with glassmorphism styling

### Navigation

#### Sidebar
- **Collapsible**: Icon-only mode for space efficiency
- **Frosted accents**: Sky blue translucent backgrounds
- **Active states**: Clear visual indicators for current page
- **Hover effects**: Smooth transitions on interaction

#### Breadcrumbs & Tabs
- **Subtle styling**: Minimal visual weight
- **Active indicators**: Clear current state
- **Hover states**: Smooth transitions

## Animation System

### Micro-interactions
- **Hover states**: 200ms transitions for smooth feedback
- **Focus states**: Clear visual indicators for accessibility
- **Loading states**: Skeleton screens and spinners

### Aurora Animations
```css
/* Floating blobs */
animate-aurora-1: 6.5s ease-in-out infinite
animate-aurora-2: 9s ease-in-out infinite  
animate-aurora-3: 7.8s ease-in-out infinite

/* Specular sweeps */
specSweep: 5.5s ease-in-out infinite
specDriftY: 7.5s ease-in-out infinite
```

### Page Transitions
- **Fade in**: Smooth entrance animations
- **Slide effects**: Directional movement for navigation
- **Staggered loading**: Progressive content reveal

## Layout System

### Grid System
- **Responsive**: Mobile-first with breakpoint scaling
- **Flexible**: CSS Grid and Flexbox for complex layouts
- **Consistent spacing**: 4px base unit system

### Spacing Scale
```css
--spacing: 0.25rem  /* 4px base unit */
gap-1: 0.25rem     /* 4px */
gap-2: 0.5rem      /* 8px */
gap-3: 0.75rem     /* 12px */
gap-4: 1rem        /* 16px */
gap-6: 1.5rem      /* 24px */
gap-8: 2rem        /* 32px */
```

### Container System
- **Max width**: 1400px for large screens
- **Padding**: 2rem horizontal padding
- **Centered**: Auto margins for centering

## Status & Data Visualization

### Status Indicators
- **Operational**: Green with checkmark icon
- **Warning**: Amber with alert icon
- **Critical**: Red with error icon
- **Unknown**: Gray with question icon

### Charts & Graphs
- **Color palette**: 5-color system for data visualization
- **Smooth curves**: Rounded line charts and areas
- **Interactive**: Hover states with tooltips
- **Responsive**: Scales with container size

### Tables
- **Clean borders**: Subtle grid lines
- **Hover states**: Row highlighting
- **Responsive**: Horizontal scroll on mobile
- **Custom scrollbars**: Frosted blue styling

## Accessibility

### Color Contrast
- **WCAG AA compliant**: Minimum 4.5:1 contrast ratio
- **High contrast mode**: Support for system preferences
- **Color independence**: Information not conveyed by color alone

### Keyboard Navigation
- **Full keyboard support**: All interactive elements accessible
- **Focus indicators**: Clear visual focus states
- **Skip links**: Hidden navigation for screen readers

### Screen Reader Support
- **ARIA labels**: Comprehensive labeling system
- **Semantic HTML**: Proper heading hierarchy
- **Alt text**: Descriptive text for images and icons

## Responsive Design

### Breakpoints
```css
sm: 640px   /* Small tablets */
md: 768px   /* Tablets */
lg: 1024px  /* Laptops */
xl: 1280px  /* Desktops */
2xl: 1536px /* Large screens */
```

### Mobile Adaptations
- **Touch targets**: Minimum 44px for touch interaction
- **Simplified navigation**: Collapsible sidebar
- **Stacked layouts**: Single column on small screens
- **Optimized tables**: Horizontal scroll with custom controls

## Icon System

### Lucide Icons
- **Consistent style**: Unified icon family
- **Semantic meaning**: Clear visual communication
- **Scalable**: Vector-based for crisp rendering
- **Accessible**: Proper ARIA labels

### Icon Usage
- **Navigation**: Clear, recognizable symbols
- **Status**: Color-coded for quick recognition
- **Actions**: Intuitive for common operations
- **Sizing**: Consistent scale across interface

## Loading States

### Skeleton Screens
- **Content placeholders**: Animated loading indicators
- **Progressive loading**: Reveal content as it loads
- **Optimistic updates**: Immediate feedback for actions

### Spinners & Indicators
- **Subtle animations**: Non-distracting loading states
- **Contextual**: Different styles for different contexts
- **Accessible**: Screen reader announcements

## Error States

### Error Messages
- **Clear communication**: Simple, actionable language
- **Visual hierarchy**: Prominent but not overwhelming
- **Recovery options**: Suggested next steps

### Empty States
- **Helpful guidance**: Clear instructions for next actions
- **Visual interest**: Illustrations or icons
- **Actionable**: Direct links to relevant features

## Performance Considerations

### Visual Optimization
- **CSS-in-JS**: Minimal runtime overhead
- **Optimized animations**: Hardware-accelerated transforms
- **Lazy loading**: Progressive image and content loading
- **Efficient rendering**: Minimal reflows and repaints

### Asset Optimization
- **SVG icons**: Scalable and lightweight
- **Compressed images**: WebP format with fallbacks
- **Font loading**: Optimized web font delivery
- **Bundle splitting**: Code splitting for faster loads

## Brand Identity

### Logo & Mark
- **Minimalist**: Clean, geometric design
- **Scalable**: Works at all sizes
- **Monochromatic**: Adapts to light/dark themes
- **Consistent**: Used across all touchpoints

### Voice & Tone
- **Professional**: Technical but approachable
- **Clear**: Direct, actionable language
- **Confident**: Assured in capabilities
- **Helpful**: Proactive guidance and support

## Implementation Guidelines

### CSS Architecture
- **Tailwind CSS**: Utility-first approach
- **CSS Custom Properties**: Theme variables for consistency
- **Component isolation**: Scoped styles for maintainability
- **Performance**: Optimized selectors and specificity

### Component Library
- **shadcn/ui**: Base component system
- **Custom variants**: Extended for specific needs
- **Consistent API**: Unified prop patterns
- **Documentation**: Clear usage examples

### Design Tokens
- **Centralized**: Single source of truth for design values
- **Semantic naming**: Meaningful variable names
- **Scalable**: Easy to modify and extend
- **Versioned**: Tracked changes for consistency

This design system ensures a cohesive, professional, and accessible user experience across all aspects of the Exit1.dev application.
