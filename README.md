# Exit1.dev

A modern, real-time website and API monitoring platform with comprehensive SSL certificate validation, domain expiry tracking, and intelligent alerting.

## Overview

Exit1.dev provides continuous monitoring for websites and REST API endpoints with real-time status updates, performance analytics, and multi-channel notifications. Built with React, TypeScript, and Firebase for scalability and reliability.

## Key Features

### Core Monitoring
- **Website & API Monitoring**: Monitor HTTP/HTTPS endpoints with configurable check intervals
- **REST API Support**: Custom HTTP methods, headers, request bodies, and response validation
- **Real-time Updates**: Instant status changes across all devices without page refresh
- **Performance Analytics**: Response time tracking, uptime statistics, and 24-hour performance charts

### SSL Certificate Management
- **Certificate Validation**: Automatic SSL certificate validity checks for HTTPS URLs
- **Expiration Tracking**: Monitor days until certificate expiration with visual indicators
- **Issuer Information**: Display certificate issuer and subject details
- **Automated Alerts**: Notifications for invalid, expired, or expiring certificates

### Domain Management
- **Domain Expiry Monitoring**: Real domain expiration dates using RDAP protocol
- **Registrar Information**: Display actual registrar names and details
- **DNS Resolution**: Verify domain resolution and IP address validation
- **Expiry Alerts**: Get notified when domains are expiring soon or have expired

### Alerting & Notifications
- **Multi-channel Alerts**: Email, SMS, and webhook notifications
- **Smart Throttling**: Prevents alert spam while ensuring critical issues are reported
- **Customizable Rules**: Configure alerts for downtime, SSL issues, and domain expiry
- **Real-time Delivery**: Instant notifications when services go down or come back up

### User Experience
- **Modern UI**: Glassmorphism design with dark-first theme
- **Drag & Drop**: Reorder checks with intuitive drag-and-drop interface
- **Folder Organization**: Group checks into custom folders for better organization
- **Responsive Design**: Mobile-first approach with adaptive layouts

### Cost Optimization
- **Intelligent Batching**: Optimized check scheduling to minimize infrastructure costs
- **Concurrency Management**: Efficient resource utilization
- **Tier-based Monitoring**: Different check frequencies for free and premium users

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS
- **UI Components**: shadcn/ui with custom glassmorphism styling
- **Backend**: Firebase Functions (Node.js/TypeScript)
- **Database**: Cloud Firestore
- **Authentication**: Clerk
- **Analytics**: BigQuery integration
- **Testing**: Playwright for E2E testing

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Firebase CLI
- Firebase project with Firestore, Authentication, and Functions enabled

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/exit1.dev.git
cd exit1.dev
```

2. Install dependencies:
```bash
npm install
cd functions && npm install && cd ..
```

3. Configure Firebase:
   - Create a Firebase project
   - Enable Firestore, Authentication, and Functions
   - Update `src/firebase.ts` with your Firebase configuration

4. Deploy Firebase Functions:
```bash
cd functions
npm run deploy
cd ..
```

5. Start the development server:
```bash
npm run dev
```

## Development

### Environment Variables

Create `.env.local` for local development:
```bash
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_auth_domain
VITE_FIREBASE_PROJECT_ID=your_project_id
# ... other Firebase config
```

### Debug Mode

Enable debug logging during development:
```bash
VITE_DEBUG_CHECKS=true
VITE_DEBUG_AUTH=true
```

### Testing

Run end-to-end tests:
```bash
npm run test:e2e
npm run test:e2e:ui      # Interactive UI mode
npm run test:e2e:headed  # Run with browser visible
```

## Project Structure

```
exit1.dev/
├── src/                 # Frontend React application
│   ├── components/      # React components
│   ├── pages/          # Page components
│   ├── hooks/          # Custom React hooks
│   ├── api/            # API client and types
│   └── lib/            # Utility functions
├── functions/          # Firebase Cloud Functions
│   └── src/            # TypeScript source files
├── public/             # Static assets
└── docs/               # Documentation
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see LICENSE file for details.

## Support

For issues, questions, or contributions, please open an issue on GitHub.
