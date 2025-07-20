// Monochromatic theme using only Tailwind's neutral scale (and black/white)
// All color tokens for the app are defined here

export const theme = {
  colors: {
    background: {
      primary: 'bg-black backdrop-blur-xl',
      secondary: 'bg-black/20 backdrop-blur-lg',
      card: 'bg-black/30 backdrop-blur-xl border border-white/3',
      modal: 'bg-black/95 backdrop-blur-2xl border border-white/10',
      console: 'bg-black/95',
      hover: 'hover:bg-neutral-300/10',
    },
    text: {
      primary: 'text-white',
      secondary: 'text-neutral-100',
      muted: 'text-neutral-400',
      error: 'text-neutral-400',
      helper: 'text-neutral-500',
      console: 'text-neutral-300',
    },
    border: {
      primary: 'border-white/10',
      secondary: 'border-neutral-200/8',
      console: 'border-neutral-300',
    },
    button: {
      primary: {
        background: 'bg-white/90 backdrop-blur-sm',
        text: 'text-black font-semibold',
        hover: 'hover:bg-white hover:backdrop-blur-sm',
        disabled: 'disabled:bg-neutral-800/50 disabled:text-neutral-500',
      },
      secondary: {
        background: 'bg-neutral-100/20 backdrop-blur-sm',
        text: 'text-neutral-100',
        hover: 'hover:bg-neutral-200/30 hover:backdrop-blur-sm',
        disabled: 'disabled:text-neutral-600',
      },
      danger: {
        background: 'bg-neutral-600/90 backdrop-blur-sm',
        text: 'text-white',
        hover: 'hover:bg-neutral-500/90 hover:backdrop-blur-sm',
        disabled: 'disabled:bg-neutral-800/50 disabled:text-neutral-500',
      },
      ghost: {
        background: 'bg-transparent',
        text: 'text-neutral-50',
        hover: 'hover:bg-neutral-200/20 hover:backdrop-blur-sm',
        disabled: 'disabled:text-neutranpm l-600',
      },
    },
    input: {
      background: 'bg-neutral-950/70 backdrop-blur-md',
      text: 'text-white',
      textBlack: 'text-black',
      border: 'border-neutral-800/50',
      focus: 'focus:ring-white/50 focus:border-white/50',
      placeholder: 'text-neutral-500',
      error: 'bg-neutral-900/40 border-neutral-400/50 text-neutral-200 focus:ring-neutral-400/30',
      disabled: 'bg-neutral-800/50 border-neutral-700/20 text-neutral-600',
      hover: 'hover:bg-neutral-900/70 hover:border-neutral-700/50',
    },
    status: {
      online: 'text-neutral-300',
      offline: 'text-neutral-500',
      loading: 'text-neutral-400',
      unknown: 'text-neutral-400',
    },
    badge: {
      default: 'bg-neutral-800/50 text-neutral-300',
      primary: 'bg-white/20 text-white',
      success: 'bg-green-600 text-white font-bold',
      warning: 'bg-neutral-600/20 text-neutral-400',
      danger: 'bg-neutral-700/20 text-neutral-400',
      error: 'bg-red-600 text-white font-bold',
      info: 'bg-neutral-500/20 text-neutral-400',
    },
    progress: {
      normal: 'bg-neutral-300',
      warning: 'bg-neutral-400',
      error: 'bg-neutral-500',
    },
    iconButton: {
      default: {
        background: 'bg-white',
        text: 'text-black',
        hover: 'hover:bg-neutral-200',
        disabled: 'disabled:bg-neutral-600 disabled:text-neutral-400',
        focus: 'focus:ring-white',
      },
      ghost: {
        background: 'bg-transparent',
        text: 'text-neutral-300',
        hover: 'hover:bg-neutral-200/10',
        disabled: 'disabled:text-neutral-400',
        focus: 'focus:ring-neutral-300',
      },
      danger: {
        background: 'bg-neutral-600',
        text: 'text-white',
        hover: 'hover:bg-neutral-700',
        disabled: 'disabled:bg-neutral-600 disabled:text-neutral-400',
        focus: 'focus:ring-neutral-400',
      },
    },
    console: {
      background: 'bg-black/95',
      border: 'border-neutral-300',
      text: 'text-neutral-300',
      hover: 'hover:bg-neutral-300/10',
      button: {
        border: 'border-neutral-300',
        hover: 'hover:bg-neutral-500 hover:text-black',
      },
    },
    themeSettings: {
      primary: 'text-neutral-300',
      secondary: 'text-neutral-300/80',
      border: {
        selected: 'border-neutral-300 bg-neutral-300/10',
        unselected: 'border-neutral-600 hover:border-neutral-300/50',
      },
    },
  },
  spacing: {
    container: 'max-w-7xl',
    section: 'py-16 px-4 sm:px-6 lg:px-8',
    padding: {
      sm: 'p-2',
      md: 'p-4',
      lg: 'p-6',
      xl: 'p-8',
    },
    margin: {
      sm: 'm-2',
      md: 'm-4',
      lg: 'm-6',
      xl: 'm-8',
    },
    gap: {
      sm: 'gap-2',
      md: 'gap-4',
      lg: 'gap-6',
      xl: 'gap-8',
    },
  },
  sizing: {
    width: {
      full: 'w-full',
      auto: 'w-auto',
      fit: 'w-fit',
    },
    height: {
      full: 'h-full',
      auto: 'h-auto',
      screen: 'h-screen',
    },
    max: {
      width: {
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
        xl: 'max-w-xl',
        '2xl': 'max-w-2xl',
        '7xl': 'max-w-7xl',
        full: 'max-w-full',
      },
    },
  },
  borderRadius: {
    default: 'rounded-md',
    sm: 'rounded',
    md: 'rounded-md',
    lg: 'rounded-lg',
    xl: 'rounded-xl',
    full: 'rounded-full',
  },
  shadows: {
    none: 'shadow-none',
    sm: 'shadow',
    md: 'shadow-md',
    lg: 'shadow-lg',
    glass: 'shadow-[0_8px_32px_0_rgba(0,0,0,0.37)]',
    glow: 'shadow-[0_0_20px_rgba(255,255,255,0.1)]',
  },
  typography: {
    fontFamily: {
      sans: 'font-sans',
      serif: 'font-serif',
      mono: 'font-mono',
      display: 'font-mono', 
      body: 'font-sans',  
    },
    fontSize: {
      xs: 'text-xs',
      sm: 'text-sm',
      base: 'text-base',
      lg: 'text-lg',
      xl: 'text-xl',
      '2xl': 'text-2xl',
      '3xl': 'text-3xl',
    },
    fontWeight: {
      normal: 'font-normal',
      medium: 'font-medium',
      semibold: 'font-semibold',
      bold: 'font-bold',
    },
  },
  animation: {
    transition: {
      all: 'transition-all',
      colors: 'transition-colors',
    },
    duration: {
      200: 'duration-200',
      300: 'duration-300',
      500: 'duration-500',
    },
    hover: {
      scale: 'hover:scale-105',
      translateY: 'hover:-translate-y-1',
    },
    focus: {
      ring: 'focus:ring-2 focus:ring-white/50',
      outline: 'focus:outline-none',
    },
  },
  layout: {
    display: {
      flex: 'flex',
      grid: 'grid',
      hidden: 'hidden',
    },
    position: {
      relative: 'relative',
      absolute: 'absolute',
      fixed: 'fixed',
    },
    zIndex: {
      10: 'z-10',
      20: 'z-20',
      50: 'z-50',
    },
  },
} as const;

export const getThemeValue = (path: string): string => {
  const keys = path.split('.');
  let value: unknown = theme;
  for (const key of keys) {
    value = (value as Record<string, unknown>)[key];
    if (value === undefined) {
      console.warn(`Theme path "${path}" not found`);
      return '';
    }
  }
  return value as string;
};

export type ThemePath = string;

export const { 
  colors, 
  spacing, 
  sizing, 
  borderRadius, 
  shadows, 
  typography, 
  animation, 
  layout 
} = theme; 