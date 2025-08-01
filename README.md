# Exit1.dev - Website & API Monitoring

A modern, real-time website and API monitoring platform built with React, TypeScript, and Firebase.

## Features

- **Real-time Monitoring**: Monitor websites and API endpoints with configurable check intervals
- **Real-time Updates**: All changes to checks (create, update, delete, reorder) appear instantly without page refresh
- **SSL Certificate Validation**: Automatically check SSL certificate validity, expiration dates, and issuer information
- **Advanced API Monitoring**: Support for custom HTTP methods, headers, request bodies, and response validation
- **Smart Alerting**: Get notified when your services go down or come back up
- **Cost Optimization**: Intelligent batching and concurrency management to minimize infrastructure costs
- **User-friendly Interface**: Modern, responsive UI with drag-and-drop reordering
- **Multi-tier Support**: Different monitoring frequencies for free and premium users

## SSL Certificate Monitoring

Exit1.dev now includes comprehensive SSL certificate validation for HTTPS URLs:

- **Certificate Validity**: Checks if certificates are currently valid
- **Expiration Tracking**: Monitors days until certificate expiration
- **Issuer Information**: Displays certificate issuer and subject details
- **Visual Indicators**: Color-coded status indicators (green for valid, yellow for expiring soon, red for invalid)
- **Detailed Information**: View full certificate details including valid from/to dates

SSL certificates are automatically checked during each website monitoring cycle and the results are displayed in the monitoring dashboard.

## Real-time Updates

Exit1.dev now features real-time updates for all check management operations:

- **Instant CRUD Operations**: Create, update, delete, and reorder checks with immediate UI updates
- **Live Status Changes**: Check status changes (online/offline/unknown) appear in real-time
- **Firestore Integration**: Uses Firestore's real-time listeners for efficient data synchronization
- **Optimized Performance**: Intelligent caching and efficient querying to minimize database reads
- **Cross-tab Synchronization**: Changes made in one browser tab are immediately reflected in other tabs
- **Automatic Reconnection**: Handles network disconnections and automatically reconnects to Firestore

The real-time updates are powered by Firestore's `onSnapshot` listeners, ensuring that all changes to your monitoring checks are reflected immediately across the entire application without requiring page refreshes.

## Statistics & Analytics

Monitor your website performance with detailed statistics and charts:

- **24-Hour Performance Charts**: View response time trends over the last 24 hours
- **Uptime Statistics**: Track overall uptime percentage and downtime incidents
- **Response Time Analysis**: Monitor average response times and performance trends
- **Status Distribution**: Visual breakdown of online/offline/unknown status periods
- **Interactive Charts**: Responsive area charts and bar charts using Recharts
- **Real-time Data**: Statistics update automatically with your monitoring data

Access statistics by clicking the three-dot menu on any website and selecting "Statistics" to open the detailed analytics modal.

## Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/exit1.dev.git
   cd exit1.dev
   ```

2. **Install dependencies**
   ```bash
   npm install
   cd functions && npm install
   ```

3. **Set up Firebase**
   - Create a new Firebase project
   - Enable Firestore, Authentication, and Functions
   - Update `src/firebase.ts` with your Firebase config

4. **Deploy Firebase Functions**
   ```bash
   cd functions
   npm run deploy
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```

## Development

### Debug Logging

To enable debug logging during development, you can set these environment variables:

```bash
# Enable debug logging for useChecks hook
VITE_DEBUG_CHECKS=true

# Enable debug logging for AuthReadyProvider
VITE_DEBUG_AUTH=true
```

These flags only work in development mode (`import.meta.env.DEV`) and help reduce console noise in production.

## Usage

1. **Add a Website**: Enter a URL and name to start monitoring
2. **Add an API Endpoint**: Configure custom HTTP methods, headers, and response validation
3. **Monitor SSL Certificates**: HTTPS URLs automatically include SSL certificate validation
4. **Set Up Alerts**: Configure notifications for downtime and SSL certificate issues
5. **View Analytics**: Track response times, uptime, and certificate expiration dates

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Backend**: Firebase Functions + Firestore
- **Authentication**: Firebase Auth with Clerk integration
- **Monitoring**: Scheduled Cloud Functions with intelligent batching
- **SSL Validation**: Node.js TLS module for certificate checking

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
