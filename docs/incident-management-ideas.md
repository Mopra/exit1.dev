# Incident Management Improvements

This document outlines potential enhancements to Exit1's incident management capabilities, building on the existing logs page and alert system.

## Current State

### Logs Page (`/logs`)
- Check history from BigQuery with filtering (website, time range, status, search)
- Log details slide-out with timing breakdown, error details, target info
- Export to CSV/Excel
- Slow stage highlighting (DNS, Connect, TLS, TTFB)

### Alert System
- Email, SMS (nano tier), webhooks (Slack, Discord, custom)
- Events: `website_up`, `website_down`, `ssl_error`, `ssl_warning`
- Throttling, budget management, and flap suppression

### Gap
Events are logged but not grouped or tracked as incidents. Users must manually piece together what happened during an outage.

---

## Proposed Features

### 1. Comments & Annotations on Log Entries

**Description**: Add ability to annotate individual log entries with notes.

**Use Cases**:
- Document root cause: "CDN outage", "Deployed bad config"
- Add context for team members
- Reference external tickets or resources

**Data Model**:
```typescript
interface LogAnnotation {
  id: string;
  logId: string;           // BigQuery log entry ID
  checkId: string;
  userId: string;
  comment: string;
  createdAt: number;
  updatedAt?: number;
}
```

**UI Considerations**:
- Add comment button in `LogDetailsSheet`
- Show comment indicator on log rows
- Support markdown in comments

**Complexity**: Low

---

### 2. Incident Grouping / Timeline

**Description**: Auto-group related events into "incidents" (DOWN → checks → UP = 1 incident).

**Features**:
- Automatic incident creation on status change to DOWN
- Auto-resolve when status returns to UP
- Track incident duration and affected checks
- Show all related log entries in incident view

**Data Model**:
```typescript
interface Incident {
  id: string;
  userId: string;
  checkId: string;
  checkName: string;
  checkUrl: string;
  status: 'open' | 'acknowledged' | 'resolved';
  severity: 'critical' | 'warning' | 'info';
  startedAt: number;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  resolvedAt?: number;
  duration?: number;        // milliseconds
  logEntryIds: string[];    // related log entries
  rootCause?: string;
  notes?: string;
}
```

**Complexity**: Medium

---

### 3. Acknowledge & Assign

**Description**: Let users acknowledge incidents to stop repeat alerts temporarily.

**Features**:
- "Acknowledge" button on incident/log entry
- Optional assignment to team member
- Acknowledgment temporarily suppresses alerts
- Track who acknowledged and when

**UI Considerations**:
- Quick action button in logs table
- Incident card with acknowledge state
- Team member selector (if teams feature exists)

**Complexity**: Low-Medium

---

### 4. Root Cause Templates

**Description**: Pre-defined categories for tagging incidents.

**Categories**:
- DNS Issue
- Server Error (5xx)
- SSL/TLS Issue
- Third-party Outage
- Planned Maintenance
- Network/Connectivity
- Configuration Error
- Resource Exhaustion
- DDoS/Attack
- Unknown

**Benefits**:
- Consistent categorization across incidents
- Enables analytics: "What caused most incidents this month?"
- Quick tagging during incident response

**Complexity**: Low

---

### 5. Post-Incident Notes / Postmortem

**Description**: Structured form for documenting incidents after resolution.

**Fields**:
- **Summary**: Brief description of what happened
- **Impact**: Who/what was affected, duration
- **Root Cause**: What caused the incident
- **Timeline**: Key events during incident
- **Action Items**: Follow-up tasks to prevent recurrence

**Features**:
- Auto-populate with incident data
- Export as PDF for compliance/reporting
- Link to related log entries

**Complexity**: Medium

---

### 6. Incident Dashboard / Overview Page

**Description**: New `/incidents` page for incident management.

**Sections**:
- **Active Incidents**: Currently open/acknowledged incidents
- **Recent Incidents**: Last 7/30 days
- **Metrics**:
  - MTTR (Mean Time to Resolve)
  - MTTA (Mean Time to Acknowledge)
  - Incident frequency
  - Most affected checks
- **Timeline Visualization**: Visual incident history

**Filters**:
- By check
- By status (open, acknowledged, resolved)
- By severity
- By date range
- By root cause category

**Complexity**: Medium

---

### 7. Status Page Integration

**Description**: Public-facing status page that auto-updates based on incidents.

**Features**:
- Customizable which checks affect public status
- Auto-update based on incident status
- Show incident history to external stakeholders
- Custom domain support
- Branding customization

**Components**:
- Overall system status
- Per-service/check status
- Incident history feed
- Uptime metrics (30/90 day)
- Subscribe to updates (email/RSS)

**Complexity**: High

---

### 8. Alert Escalation

**Description**: Escalate alerts if not acknowledged within a time window.

**Features**:
- Configurable escalation policies
- Multiple escalation levels
- Different channels per level (email → SMS → phone)
- Per-check or global policies

**Example Policy**:
1. Immediate: Email to primary contact
2. After 5 min: SMS to primary contact
3. After 15 min: Email + SMS to secondary contact
4. After 30 min: Phone call to on-call

**Complexity**: Medium-High

---

### 9. Maintenance Windows

**Description**: Schedule maintenance windows where alerts are suppressed.

**Features**:
- Schedule start/end time
- Select affected checks
- Optional: auto-pause checks during window
- Shows in logs as "maintenance" instead of "down"
- Recurring maintenance support (weekly, monthly)

**Data Model**:
```typescript
interface MaintenanceWindow {
  id: string;
  userId: string;
  checkIds: string[];       // affected checks, or 'all'
  name: string;
  description?: string;
  startAt: number;
  endAt: number;
  recurring?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    dayOfWeek?: number;     // 0-6 for weekly
    dayOfMonth?: number;    // 1-31 for monthly
  };
  suppressAlerts: boolean;
  pauseChecks: boolean;
  createdAt: number;
}
```

**Complexity**: Low-Medium

---

### 10. Quick Actions from Logs

**Description**: Contextual actions directly from log entries.

**Actions**:
- **Create Incident**: Manually create incident from log entry
- **Silence Alerts**: Suppress alerts for 1h/4h/24h
- **Recheck Now**: Trigger immediate probe
- **Add to Maintenance**: Mark as planned downtime
- **Copy Details**: Copy log details for sharing

**UI**: Dropdown menu or action buttons in log row/details

**Complexity**: Low

---

## Implementation Priority

| Feature | Impact | Complexity | Priority |
|---------|--------|------------|----------|
| Comments on logs | Medium | Low | P1 - Start here |
| Quick actions | Medium | Low | P1 |
| Maintenance windows | Medium | Low-Medium | P1 |
| Incident grouping | High | Medium | P2 - Core feature |
| Acknowledge/assign | High | Low-Medium | P2 |
| Root cause templates | Medium | Low | P2 |
| Incident dashboard | High | Medium | P3 |
| Post-incident notes | Medium | Medium | P3 |
| Alert escalation | Medium | Medium-High | P4 |
| Status page | High | High | P4 - Bigger project |

---

## Recommended Approach

### Phase 1: Quick Wins
1. **Comments on log entries** - Immediate value, low risk
2. **Quick actions** - Better UX for existing features
3. **Maintenance windows** - Solves real pain point

### Phase 2: Core Incident Management
1. **Incident grouping** - Foundation for incident management
2. **Acknowledge/assign** - Essential for teams
3. **Root cause templates** - Enhances incident data

### Phase 3: Analytics & Reporting
1. **Incident dashboard** - Visibility and metrics
2. **Post-incident notes** - Documentation and compliance

### Phase 4: Advanced Features
1. **Alert escalation** - Enterprise feature
2. **Status page** - Public-facing, high-value project

---

## Technical Considerations

### Storage
- **Firestore**: Incidents, annotations, maintenance windows (real-time, low volume)
- **BigQuery**: Keep logs in BigQuery, reference by ID in incidents

### Performance
- Incident creation should be async (Cloud Function on status change)
- Dashboard metrics can be pre-computed or cached

### Cost
- Minimal additional Firestore reads/writes
- No additional BigQuery costs (reusing existing data)

### Migration
- No breaking changes to existing data
- New collections can be added incrementally
