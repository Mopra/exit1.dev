import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import Websites from './pages/Websites';
import { dark } from '@clerk/themes';
import { SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';

function App() {
  const { isSignedIn } = useAuth();
  return (
    <Router>
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Header />
        <main className="flex-1 container mx-auto px-4">
          <Routes>
            <Route
              path="/"
              element={
                isSignedIn ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />
              }
            />
            <Route
              path="/login"
              element={
                isSignedIn ? (
                  <Navigate to="/home" replace />
                ) : (
                  <SignedOut>
                    <div className="flex flex-col items-center justify-center min-h-[60vh]">
                      <SignIn
                        routing="path"
                        path="/login"
                        appearance={{
                          baseTheme: dark
                        }}
                      />
                    </div>
                  </SignedOut>
                )
              }
            />
            <Route
              path="/home"
              element={
                <SignedIn>
                  <Home />
                </SignedIn>
              }
            />
            <Route
              path="/websites"
              element={
                <SignedIn>
                  <Websites />
                </SignedIn>
              }
            />
            <Route
              path="*"
              element={isSignedIn ? <Navigate to="/home" replace /> : <Navigate to="/login" replace />} 
            />
          </Routes>
        </main>
        <Footer />
      </div>
    </Router>
  );
}

export default App;
