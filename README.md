# exit1.dev - Website Monitor

A modern website monitoring platform built with React, TypeScript, Vite, and Firebase.

## Features

- **Real-time Website Monitoring**: Track uptime and performance of your websites
- **Authentication**: Secure login with Clerk (Google, GitHub, Discord, or email/password)
- **Protected Routes**: Automatic redirect to login for unauthenticated users
- **Modern UI**: Clean, terminal-inspired interface with Tailwind CSS
- **Firebase Integration**: Real-time data with Firestore and Cloud Functions

## Authentication & Route Protection

The application uses Clerk for authentication and includes comprehensive route protection:

### Protected Routes
- `/websites` - Main dashboard (requires authentication)
- `/settings` - User settings (requires authentication)

### Public Routes
- `/login` - Sign in page
- `/sign-up` - Registration page
- `/` - Redirects to appropriate page based on auth status

### How It Works
1. **AuthGuard Component**: Wraps protected routes and checks authentication status
2. **Automatic Redirects**: Unauthenticated users are redirected to `/login`
3. **Return to Original Page**: After login, users are redirected back to the page they were trying to access
4. **Loading States**: Shows appropriate loading indicators during authentication checks

### Implementation Details
- Uses Clerk's `useAuth` hook for authentication state
- Implements `AuthGuard` component for route protection
- Handles OAuth redirects with proper return URLs
- Preserves original destination in location state

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default tseslint.config({
  extends: [
    // Remove ...tseslint.configs.recommended and replace with this
    ...tseslint.configs.recommendedTypeChecked,
    // Alternatively, use this for stricter rules
    ...tseslint.configs.strictTypeChecked,
    // Optionally, add this for stylistic rules
    ...tseslint.configs.stylisticTypeChecked,
  ],
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default tseslint.config({
  plugins: {
    // Add the react-x and react-dom plugins
    'react-x': reactX,
    'react-dom': reactDom,
  },
  rules: {
    // other rules...
    // Enable its recommended typescript rules
    ...reactX.configs['recommended-typescript'].rules,
    ...reactDom.configs.recommended.rules,
  },
})
```
