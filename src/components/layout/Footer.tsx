import { Link } from 'react-router-dom';

const Footer = () => (
  <footer className="border-t border-border/40 py-4 px-6 flex-shrink-0">
    <div className="flex flex-col sm:flex-row items-center justify-between gap-2 max-w-7xl mx-auto">
      <div className="text-foreground font-mono tracking-widest text-sm opacity-80">
        &copy; {new Date().getFullYear()} EXIT1.DEV
      </div>
      <nav className="flex items-center gap-4 text-xs text-muted-foreground">
        <Link to="/privacy" className="hover:text-foreground transition-colors">
          Privacy Policy
        </Link>
        <span className="opacity-30">|</span>
        <Link to="/terms" className="hover:text-foreground transition-colors">
          Terms of Service
        </Link>
      </nav>
    </div>
  </footer>
);

export default Footer;
