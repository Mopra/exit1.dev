# Getting Started with Exit1 - Website Monitoring Made Simple

Welcome to Exit1! This guide will walk you through setting up your first website monitoring checks, configuring notifications, and using advanced features. You'll be up and running in minutes.

## 🚀 Quick Start (5 Minutes)

### 1. Create Your Account
- **Visit**: [app.exit1.dev](https://app.exit1.dev)
- **Sign up**: Use email/password or SSO (Google, GitHub, Discord)
- **Verify email**: Check your inbox for verification code
- **Welcome**: You'll be redirected to the monitoring dashboard

### 2. Add Your First Website
- **Click**: "Add Check" button in the top-right
- **Enter URL**: Type your website domain (e.g., `example.com`)
- **Name**: Give it a friendly name (auto-generated from domain)
- **Frequency**: Choose check interval (1 min, 5 min, 1 hour, 24 hours)
- **Save**: Your first check is now active!

### 3. See It Working
- **Status**: Watch the real-time status indicator
- **Response time**: See how fast your site responds
- **Last checked**: View when the last check ran
- **Manual check**: Click "Run Now" for immediate testing

## 📊 Understanding Your Dashboard

### Status Indicators
- **🟢 Online**: Website is responding normally
- **🔴 Offline**: Website is down or unreachable
- **🟡 Error**: Website responds but with errors
- **⚪ Unknown**: Not yet checked

### Key Metrics
- **Response Time**: How fast your site responds (milliseconds)
- **Uptime**: Percentage of time your site is online
- **Last Check**: When the system last tested your site
- **Next Check**: When the next automatic check will run

## 🔔 Setting Up Notifications

### Email Alerts (Recommended for Beginners)
1. **Navigate**: Go to "Emails" in the sidebar
2. **Configure**:
   - **Recipient**: Your email address
   - **Events**: Select which alerts you want (Website Down, SSL Issues, etc.)
   - **Test**: Send a test email to verify setup
3. **Save**: You'll now receive email notifications

### Webhook Notifications (For Developers)
1. **Navigate**: Go to "Webhooks" in the sidebar
2. **Create Webhook**:
   - **Name**: Give it a descriptive name
   - **URL**: Your webhook endpoint (HTTPS required)
   - **Events**: Choose which events to send
   - **Secret**: Optional HMAC signature for security
3. **Test**: Send a test payload to verify delivery

## 🔧 Advanced Configuration

### Check Types
- **Website Monitoring**: Standard HTTP checks (default)
- **API Monitoring**: REST endpoint monitoring with custom methods

### Check Frequency Options
- **1 minute**: For critical services (Premium tier)
- **5 minutes**: Good balance for most websites
- **1 hour**: For less critical services
- **24 hours**: For basic availability checks

### SSL Certificate Monitoring
- **Automatic**: SSL certificates are checked automatically
- **Warnings**: Get alerts when certificates expire soon
- **Details**: View certificate issuer, validity dates, and expiry

### Domain Expiry Monitoring
- **Automatic**: Domain registration expiry is tracked
- **Alerts**: Get notified before domains expire
- **Details**: View registrar, nameservers, and DNS status

## 📈 Monitoring Multiple Websites

### Adding More Checks
- **Bulk Add**: Add multiple websites at once
- **Import**: Use the direct monitoring signup feature
- **Organize**: Drag and drop to reorder your checks

### Managing Your Checks
- **Enable/Disable**: Pause monitoring without deleting
- **Edit**: Modify check settings anytime
- **Delete**: Remove checks you no longer need
- **Bulk Actions**: Select multiple checks for batch operations

## 📊 Viewing History & Reports

### Check History
- **Navigate**: Go to "Logs" in the sidebar
- **Filter**: By date range, status, or website
- **Details**: Click any log entry for full details
- **Export**: Download logs as CSV or Excel

### Analytics Dashboard
- **Navigate**: Go to "Reports" in the sidebar
- **Uptime**: See overall uptime percentage
- **Incidents**: Track downtime events
- **Response Times**: Monitor performance trends
- **Reliability Score**: Get a 0-10 reliability rating

## 🔗 API Integration

### API Keys
1. **Navigate**: Go to "Settings" → "API Keys"
2. **Create Key**: Generate a new API key
3. **Use**: Include `X-Api-Key` header in requests

### Available Endpoints
- **GET /api/checks**: List all your checks
- **GET /api/checks/{id}**: Get specific check details
- **GET /api/checks/{id}/history**: Get check history
- **GET /api/stats**: Get aggregated statistics

## 🛠️ Advanced Features

### Response Validation
- **Text Content**: Check if response contains specific text
- **JSON Path**: Validate JSON responses
- **Status Codes**: Configure expected HTTP status codes

### Custom Headers
- **Authentication**: Add API keys or tokens
- **User Agents**: Set custom user agent strings
- **Content Types**: Specify expected content types

### Per-Check Settings
- **Individual Notifications**: Override global email/webhook settings
- **Custom Frequencies**: Set different check intervals per site
- **Response Validation**: Configure specific validation rules

## 🚨 Troubleshooting

### Common Issues

**Check Shows "Unknown" Status**
- Wait a few minutes for the first check to complete
- Check if your URL is accessible from the internet
- Verify the URL format (include protocol if needed)

**Notifications Not Working**
- Check your email spam folder
- Verify webhook URL is accessible and returns 200 status
- Test your notification settings

**High Response Times**
- This is normal for the first few checks
- Response times will stabilize over time
- Check your website's actual performance

### Getting Help
- **Documentation**: Check our comprehensive docs
- **Status Page**: Visit our system status page
- **Support**: Contact us through the app

## 📱 Mobile Experience

### Responsive Design
- **Mobile-First**: Optimized for all screen sizes
- **Touch-Friendly**: Easy navigation on mobile devices
- **Real-Time**: Live updates work on mobile browsers

### Mobile Features
- **Quick Actions**: Swipe to enable/disable checks
- **Status Overview**: See all checks at a glance
- **Notifications**: Receive alerts on your mobile device

## 🔒 Security & Privacy

### Data Protection
- **HTTPS Only**: All connections are encrypted
- **Authentication**: Secure login with Clerk
- **API Security**: HMAC signatures for webhooks
- **Data Privacy**: Your data belongs to you

### Best Practices
- **Strong Passwords**: Use unique, strong passwords
- **API Key Security**: Keep your API keys secure
- **Webhook Validation**: Verify webhook signatures
- **Regular Updates**: Keep your monitoring URLs current

## 🎯 Pro Tips

### Getting the Most from Exit1

1. **Start Simple**: Begin with basic website monitoring
2. **Gradual Setup**: Add notifications after your first checks are working
3. **Regular Review**: Check your reports weekly
4. **Optimize**: Adjust check frequencies based on your needs
5. **Monitor Critical Paths**: Focus on user-facing services first

### Recommended Setup for Different Use Cases

**Personal Website**
- Check frequency: 5 minutes
- Notifications: Email alerts for downtime
- Monitor: Main website, SSL certificate

**Business Application**
- Check frequency: 1 minute (Premium)
- Notifications: Email + webhook alerts
- Monitor: API endpoints, critical pages, SSL certificates

**E-commerce Site**
- Check frequency: 1 minute (Premium)
- Notifications: Email + webhook + SMS (via webhook)
- Monitor: Homepage, checkout, payment APIs, SSL certificates

## 🚀 What's Next?

### Explore Advanced Features
- **BigQuery Integration**: Deep analytics and reporting
- **Custom Integrations**: Connect with your existing tools
- **API Development**: Build custom monitoring solutions

### Stay Updated
- **Feature Updates**: New features are added regularly
- **Best Practices**: Follow our blog for monitoring tips
- **Community**: Join our community for support and ideas

---

**Ready to get started?** [Sign up now](https://app.exit1.dev) and have your first website monitored in under 5 minutes!

Need help? Our documentation is always available, and we're here to support you every step of the way.
