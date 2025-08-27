# Direct Monitoring Signup Feature

This feature allows users to be redirected from your marketing website directly to the monitoring setup form with a pre-filled website URL.

## How It Works

1. **Marketing Site Integration**: Add a form on your marketing site that captures a website URL
2. **Redirect with Parameter**: Redirect users to your app with the website URL as a parameter
3. **Automatic Form Pre-fill**: The app automatically opens the monitoring form with the website URL pre-filled
4. **Seamless Auth Flow**: Clerk handles authentication, then users see the pre-filled form

## URL Format

The website URL should be passed as a URL parameter:

```
https://app.exit1.dev/?website=https%3A//example.com
```

### URL Encoding

The website URL must be URL-encoded. For example:
- `https://example.com` becomes `https%3A//example.com`
- `example.com` becomes `example.com`

## Implementation Details

### 1. URL Parameter Handling

The `useWebsiteUrl` hook automatically:
- Extracts the `website` parameter from the URL
- Decodes the URL-encoded parameter
- Validates the URL format
- Cleans up the URL parameter from the browser history
- Returns the website URL and validation status

### 2. Form Pre-filling

The `CheckForm` component:
- Accepts a `prefillWebsiteUrl` prop
- Automatically fills the URL field when the form opens
- Generates a friendly display name from the domain
- Sets appropriate default values for website monitoring

### 3. User Experience

When a user arrives with a website parameter:
- A welcome message appears in the header
- The monitoring form automatically opens
- A success toast notification is shown
- The form is pre-filled with the website URL

## Example Marketing Site Integration

```html
<!-- Marketing site form -->
<form action="https://app.exit1.dev/" method="GET">
  <input type="text" name="website" placeholder="Enter your website URL" required>
  <button type="submit">Start Monitoring</button>
</form>
```

Or with JavaScript:

```javascript
function redirectToMonitoring(websiteUrl) {
  const encodedUrl = encodeURIComponent(websiteUrl);
  window.location.href = `https://app.exit1.dev/?website=${encodedUrl}`;
}
```

## Error Handling

- Invalid URLs are rejected and logged to console
- The app gracefully handles malformed parameters
- Users can still manually add checks if the parameter is invalid

## Testing

You can test the feature by visiting:
- `https://app.exit1.dev/?website=https%3A//example.com`
- `https://app.exit1.dev/?website=example.com`

The form should automatically open with the website URL pre-filled.

## Browser Compatibility

This feature works in all modern browsers that support:
- URLSearchParams API
- History API
- React hooks
