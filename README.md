# exit1.dev - Website Monitoring Platform

A modern, real-time website monitoring platform built with React, TypeScript, Vite, and Firebase. Monitor your websites' uptime, performance, and receive instant alerts when issues are detected.

## 🚀 Features

### Core Monitoring
- **Real-time Website Monitoring**: Track uptime and performance of your websites
- **Multi-tier Monitoring**: Different monitoring intervals based on your subscription tier
- **Performance Metrics**: Response time tracking and historical data
- **Status Dashboard**: Real-time status overview of all monitored websites

### Authentication & Security
- **Secure Authentication**: Powered by Clerk with multiple sign-in options
  - Google OAuth
  - GitHub OAuth  
  - Discord OAuth
  - Email/Password authentication
- **Protected Routes**: Automatic redirect to login for unauthenticated users
- **User Management**: Profile management and subscription tiers

### User Interface
- **Modern Terminal-Inspired UI**: Clean, developer-friendly interface
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **Dark Theme**: Easy on the eyes with a professional dark color scheme
- **Real-time Updates**: Live status updates without page refreshes

### Alerting System
- **Multi-channel Notifications**: 
  - Email alerts via Nodemailer
  - SMS notifications via Twilio
  - Discord webhook integration
- **Customizable Alerts**: Configure notification preferences per website
- **Instant Notifications**: Real-time alerts when websites go down or recover

### Firebase Integration
- **Real-time Database**: Firestore for live data synchronization
- **Cloud Functions**: Serverless backend for monitoring and notifications
- **Hosting**: Fast, global CDN hosting
- **Security Rules**: Comprehensive Firestore security rules

## 🏗️ Architecture

### Frontend
- **React 19** with TypeScript for type safety
- **Vite** for fast development and building
- **Tailwind CSS 4** for styling
- **React Router** for client-side routing
- **Clerk** for authentication
- **FontAwesome** for icons

### Backend
- **Firebase Cloud Functions** (Node.js 22)
- **Firestore** for real-time database
- **Firebase Hosting** for static file serving
- **Nodemailer** for email notifications
- **Twilio** for SMS alerts
- **Discord.js** for Discord webhook integration

### Project Structure
```
exit1.dev/
├── src/
│   ├── components/
│   │   ├── auth/          # Authentication components
│   │   ├── console/       # Terminal-style console
│   │   ├── layout/        # Layout components
│   │   ├── ui/           # Reusable UI components
│   │   └── website/      # Website monitoring components
│   ├── hooks/            # Custom React hooks
│   ├── pages/            # Page components
│   ├── config/           # Configuration files
│   └── utils/            # Utility functions
├── functions/            # Firebase Cloud Functions
│   └── src/
│       ├── alert.ts      # Alert notification logic
│       ├── config.ts     # Function configuration
│       ├── discord.ts    # Discord integration
│       └── types.ts      # TypeScript types
└── public/              # Static assets
```

## 🛠️ Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Firebase CLI
- Clerk account for authentication

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Mopra/errdev.git
   cd exit1.dev
   ```

2. **Install dependencies**
   ```bash
   npm install
   cd functions && npm install && cd ..
   ```

3. **Environment Setup**
   
   Create a `.env` file in the root directory:
   ```env
   VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
   VITE_FIREBASE_API_KEY=your_firebase_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your_project_id
   VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
   VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
   VITE_FIREBASE_APP_ID=your_app_id
   ```

   Create a `.env` file in the `functions/` directory:
   ```env
   CLERK_SECRET_KEY=your_clerk_secret_key
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   TWILIO_PHONE_NUMBER=your_twilio_phone_number
   DISCORD_WEBHOOK_URL=your_discord_webhook_url
   SMTP_HOST=your_smtp_host
   SMTP_PORT=your_smtp_port
   SMTP_USER=your_smtp_user
   SMTP_PASS=your_smtp_password
   ```

4. **Firebase Setup**
   ```bash
   firebase login
   firebase init
   ```

5. **Start Development Server**
   ```bash
   npm run dev
   ```

6. **Start Firebase Emulators** (optional)
   ```bash
   firebase emulators:start
   ```

## 📝 Available Scripts

### Frontend
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run lint` - Run ESLint
- `npm run preview` - Preview production build

### Backend (Firebase Functions)
- `npm run serve` - Start functions emulator
- `npm run deploy` - Deploy functions to Firebase
- `npm run logs` - View function logs

### Deployment
- `npm run deploy` - Build and deploy to Firebase Hosting

## 🚀 Deployment

### Firebase Deployment
```bash
# Deploy everything
firebase deploy

# Deploy only hosting
firebase deploy --only hosting

# Deploy only functions
firebase deploy --only functions

# Deploy only Firestore rules
firebase deploy --only firestore:rules
```

### Environment Variables
Make sure to set up all required environment variables in your Firebase project:
- Go to Firebase Console > Project Settings > Functions > Environment Variables
- Add all the variables from the functions `.env` file

## 🔧 Configuration

### Firebase Configuration
The project uses Firebase for:
- **Hosting**: Static file hosting with SPA routing
- **Firestore**: Real-time database
- **Functions**: Serverless backend functions
- **Authentication**: User management (via Clerk integration)

### Clerk Authentication
Clerk handles all authentication with:
- Multiple OAuth providers
- Email/password authentication
- Protected routes
- User management

### Monitoring Configuration
- **Free Tier**: Basic monitoring with limited features
- **Pro Tier**: Enhanced monitoring with faster intervals
- **Enterprise Tier**: Full monitoring with custom intervals

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

If you encounter any issues or have questions:
1. Check the [Issues](https://github.com/Mopra/errdev/issues) page
2. Create a new issue with detailed information
3. Contact the maintainers

## 🔗 Links

- **Live Demo**: [exit1.dev](https://exit1.dev)
- **Repository**: [https://github.com/Mopra/errdev](https://github.com/Mopra/exit1.dev)
- **Documentation**: [Coming Soon]

---

Built with ❤️ using React, TypeScript, and Firebase
