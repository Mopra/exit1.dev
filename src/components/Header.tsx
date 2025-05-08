import { Link } from 'react-router-dom';
import { SignedIn, UserButton } from '@clerk/clerk-react';
import { dark } from '@clerk/themes';


export default function Header() {
  return (
    <header className="w-full bg-white shadow mb-4">
      <nav className="container mx-auto flex items-center justify-between py-4 px-6">
        <Link to="/" className="text-2xl font-bold text-gray-800">err.dev</Link>
        <div className="flex items-center space-x-4">
          {/* <Link to="/home" className="text-gray-600 hover:text-gray-900">Home</Link> */}
          <SignedIn>
            <Link to="/websites" className="text-gray-600 hover:text-gray-900">Websites</Link>
            <UserButton appearance={{ baseTheme: dark }} />
          </SignedIn>

        </div>
      </nav>
    </header>
  );
} 