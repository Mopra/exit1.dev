export default function Footer() {
  return (
    <footer className="w-full bg-white shadow mt-8">
      <div className="container mx-auto py-4 px-6 text-center text-gray-500 text-sm">
        &copy; {new Date().getFullYear()} err.dev. All rights reserved.
      </div>
    </footer>
  );
} 