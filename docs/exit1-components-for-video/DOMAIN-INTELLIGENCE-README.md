# Domain Intelligence Video Components

These HTML components are designed for creating product videos showcasing the Domain Intelligence feature. All components match the exact styling of the Exit1 app.

## Components

### 1. domain-intelligence-page-header.html
The page header showing the "Enable for checks" button.
- **Use for:** Introducing the Domain Intelligence feature
- **Shows:** Page title, description, and the primary CTA button

### 2. domain-intelligence-stats.html
Overview statistics cards showing domain health at a glance.
- **Use for:** Showing the dashboard overview
- **Shows:** Total domains, expiring soon, healthy, and error counts

### 3. domain-intelligence-enable-modal.html
Modal dialog for selecting which checks to enable Domain Intelligence for.
- **Use for:** Demonstrating how easy it is to add domains
- **Shows:** Search functionality, check selection, and bulk enable

### 4. domain-intelligence-table.html
Full table view of all monitored domains.
- **Use for:** Showing domain monitoring in action
- **Shows:**
  - Domain names and associated checks
  - Expiry status badges (Active, 7 days, 30 days)
  - Registrar information
  - Last checked timestamps
  - Actions menu

### 5. domain-intelligence-settings.html
Side panel showing detailed domain information and settings.
- **Use for:** Showing domain details and configuration
- **Shows:**
  - Domain status and days until expiry
  - Alert thresholds (7, 14, 30, 60 days)
  - Registration information (registrar, created date, expiry date)
  - Nameservers
  - Registry status
  - Associated check details

### 6. domain-intelligence-alert.html
Alert notification showing domain expiry warning.
- **Use for:** Demonstrating the alert system
- **Shows:** Warning notification with domain name and days until expiry

## Video Storyboard Suggestion

1. **Introduction** (page-header.html)
   - Show the Domain Intelligence page header
   - Highlight the "Enable for checks" button

2. **Adding Domains** (enable-modal.html)
   - Click "Enable for checks"
   - Show the modal with available checks
   - Select 2-3 checks
   - Click "Enable (2)" button

3. **Overview** (stats.html + table.html)
   - Show the stats cards (5 total, 2 expiring soon, 3 healthy)
   - Pan down to the table showing all domains
   - Highlight the domains with expiring status

4. **Domain Details** (settings.html)
   - Click on a domain to show the settings panel
   - Highlight the expiry date and alert thresholds
   - Show the registration information

5. **Alert System** (alert.html)
   - Show the alert notification appearing
   - Demonstrate the warning for domains expiring in 7 days

## Styling Notes

All components use:
- Dark theme (matching app background: #000000)
- Sky blue primary color (#7dd3fc)
- DM Sans font for UI text
- Space Mono font for monospace text
- Consistent border radius (1rem)
- Glow card effects with blur
- Status badge colors:
  - Green (#4ade80) for healthy/active
  - Yellow (#fbbf24) for expiring soon
  - Red (#f87171) for expired/errors

## Tips for Video Production

- Open each HTML file in a browser
- Use browser dev tools to adjust zoom for optimal recording size
- Components are static - use video editing to simulate interactions
- For hover effects, you can manually add the `:hover` class in dev tools
- Consider adding smooth transitions between components in post-production
