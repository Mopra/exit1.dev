import { theme, typography } from '../../config/theme';

const Footer = () => (
  <footer className={`border-t ${theme.colors.border.primary} py-4 px-6 text-center`}>
    <div className={`${theme.colors.text.primary} ${typography.fontFamily.mono} tracking-widest ${typography.fontSize.sm} opacity-80`}>
      &copy; {new Date().getFullYear()} EXIT1.DEV. ALL RIGHTS RESERVED.
    </div>
  </footer>
);

export default Footer; 