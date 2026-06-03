// Integrations and Webhooks share the same Firestore collection and the same
// Cloud Functions — this is purely a UI route. The page component is
// `WebhooksContent` parameterized with scope='integration', which filters the
// list to credential-based platforms (Pushover, PagerDuty, Opsgenie) and
// adjusts every visible label.
import WebhooksContent from './Webhooks';

const IntegrationsContent = () => <WebhooksContent scope="integration" />;

export default IntegrationsContent;
