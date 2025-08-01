# Debug Guide for React Error #310

## How to Enable Debug Logging

To help debug the React error #310 issue, we've added comprehensive logging throughout the application. Here's how to enable it:

### Method 1: URL Parameter (Recommended)
Add `?debug=true` to your URL:
```
https://your-app.com/?debug=true
```

### Method 2: Local Storage
1. Open browser developer tools (F12)
2. Go to Console tab
3. Run this command:
```javascript
localStorage.setItem('VITE_DEBUG', 'true')
```
4. Refresh the page

### Method 3: Environment Variable (Development only)
Set `VITE_DEBUG=true` in your `.env` file

## What the Logs Will Show

When debug mode is enabled, you'll see detailed logs with these prefixes:

- `[Main]` - Application initialization and setup
- `[App]` - Routing and authentication state
- `[AuthReadyProvider]` - Clerk/Firebase authentication sync
- `[CustomSignIn]` - Sign-in form interactions and OAuth flow

## Key Information to Look For

When the user encounters the React error #310, ask them to:

1. **Enable debug mode** using one of the methods above
2. **Open Firefox Developer Tools** (F12)
3. **Go to the Console tab**
4. **Navigate to the sign-in page**
5. **Copy all console output** and share it with you

## What to Look For in the Logs

The logs will help identify:

- ✅ **Environment variables** - Is the Clerk publishable key loaded?
- ✅ **React initialization** - Are there multiple React instances?
- ✅ **Authentication state** - Is Clerk loading properly?
- ✅ **Firebase sync** - Is the Clerk/Firebase integration working?
- ✅ **Component rendering** - Which component fails first?
- ✅ **Error details** - The exact error message and stack trace

## Common Issues to Check

1. **Missing Environment Variables**
   - Look for `[Main] PUBLISHABLE_KEY_EXISTS: false`
   - This will cause the app to fail immediately

2. **Multiple React Instances**
   - Check if there are multiple React versions in the bundle
   - Look for React initialization errors

3. **Authentication Service Issues**
   - Look for `[AuthReadyProvider]` errors
   - Check if Clerk is loading properly

4. **Component Rendering Issues**
   - Look for `[CustomSignIn]` or `[App]` errors
   - Check if components are receiving proper props

## Sample Debug Output

When working correctly, you should see something like:
```
[Main] Starting application initialization
[Main] Environment check: {NODE_ENV: "production", DEV: false, MODE: "production", PUBLISHABLE_KEY_EXISTS: true, PUBLISHABLE_KEY_LENGTH: 123}
[Main] Publishable key validation passed
[Main] Root element found, creating React root
[Main] React root created successfully
[Main] Rendering application with StrictMode and ClerkProvider
[App] App component rendering {isSignedIn: false, timestamp: "2024-01-01T12:00:00.000Z"}
[AuthReadyProvider] AuthReadyProvider rendering {isLoaded: false, isSignedIn: false, firebaseLoaded: false, firebaseUser: false, authReady: false, showLoading: false, synced: false}
[CustomSignIn] CustomSignIn component rendering {isLoaded: false, hasSignIn: false, hasSetActive: false, loading: false, oauthLoading: null, error: null, emailLength: 0, passwordLength: 0}
```

## Next Steps

Once you have the debug logs:

1. **Share the logs** with the development team
2. **Look for the last successful log** before the error
3. **Identify which component** is failing
4. **Check for missing dependencies** or configuration issues

This will help pinpoint the exact cause of the React error #310 and provide a targeted solution. 