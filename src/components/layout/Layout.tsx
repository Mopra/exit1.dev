import Header from './Header';
import Footer from './Footer';
import React from 'react';
import { colors, typography } from '../../config/theme';

const Layout = ({ children }: { children: React.ReactNode }) => (
  <div className={`min-h-screen ${colors.background.primary} ${colors.text.primary} ${typography.fontFamily.body} flex flex-col`}>
    <Header />
    <main className="flex-1 max-w-6xl mx-auto w-full px-3 sm:px-6 py-6 sm:py-8 lg:py-12">
      {children}
    </main>
    <Footer />
  </div>
);

export default Layout; 