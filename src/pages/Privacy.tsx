import { PageContainer, PublicPageHeader } from '@/components/layout';
import { Shield, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Footer from '@/components/layout/Footer';

export default function Privacy() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <PublicPageHeader />
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <PageContainer className="overflow-visible">
          <div className="max-w-3xl mx-auto px-3 sm:px-4 py-6 sm:py-12 space-y-6 sm:space-y-10">
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Shield className="h-6 w-6 text-muted-foreground" />
                <h1 className="text-2xl sm:text-3xl font-bold">Privacy Policy</h1>
              </div>
              <p className="text-sm text-muted-foreground">Last updated: May 2, 2026</p>
            </div>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">1. Introduction</h2>
              <p className="text-muted-foreground leading-relaxed">
                Exit1.dev ("we", "us", or "our") operates the website monitoring service at exit1.dev.
                This Privacy Policy describes how we collect, use, and protect your personal information
                when you use our service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">2. Information We Collect</h2>
              <p className="text-muted-foreground leading-relaxed">We collect the following types of information:</p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li><strong className="text-foreground">Account information:</strong> Your name, email address, and authentication credentials when you create an account.</li>
                <li><strong className="text-foreground">Phone numbers:</strong> If you opt in to SMS alerts, we collect the phone number(s) you provide to deliver text message notifications.</li>
                <li><strong className="text-foreground">Website URLs:</strong> The URLs you configure for monitoring.</li>
                <li><strong className="text-foreground">Usage data:</strong> Check results, response times, status codes, and SSL certificate information for your monitored websites.</li>
                <li><strong className="text-foreground">Billing information:</strong> Payment details are processed by our third-party payment provider and are not stored on our servers.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">3. How We Use Your Information</h2>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li>To provide and maintain our website monitoring service.</li>
                <li>To send you alerts via email, SMS, or webhooks when your monitored websites experience issues.</li>
                <li>To process your payments and manage your subscription.</li>
                <li>To communicate with you about service updates, security alerts, and support.</li>
                <li>To improve our service and develop new features.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">4. SMS Text Messaging</h2>
              <p className="text-muted-foreground leading-relaxed">
                If you opt in to SMS alerts by providing your phone number on our SMS Settings page,
                we will send you text messages related to your website monitoring alerts. Specifically:
              </p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li><strong className="text-foreground">Types of messages:</strong> Website down/up notifications, SSL certificate errors and warnings, and domain expiry alerts.</li>
                <li><strong className="text-foreground">Message frequency:</strong> Varies based on your alert configuration and the status of your monitored websites. Messages are subject to hourly and monthly limits.</li>
                <li><strong className="text-foreground">Opt-in:</strong> SMS alerts are opt-in only. You must explicitly add your phone number and enable SMS notifications in your account settings.</li>
                <li><strong className="text-foreground">Opt-out:</strong> You can opt out at any time by replying STOP to any message, removing your phone number from settings, or disabling SMS alerts in your account.</li>
                <li><strong className="text-foreground">Costs:</strong> Message and data rates may apply. Check with your carrier for details.</li>
                <li><strong className="text-foreground">No sharing:</strong> We do not share your phone number with third parties for marketing purposes. Your phone number is only used to deliver the alerts you have configured.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">5. Product and Marketing Emails</h2>
              <p className="text-muted-foreground leading-relaxed">
                In addition to transactional emails (account, billing, security, and monitoring alerts), we
                occasionally send you emails about our own service — for example, new features, product
                updates, changes to your plan, and plan offers relating to exit1.dev. We do this on the
                basis of our legitimate interest in keeping existing customers informed about the service
                they use, in line with EU ePrivacy rules on similar products and services (the "soft
                opt-in").
              </p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li><strong className="text-foreground">Scope:</strong> We only email you about exit1.dev itself. We do not send third-party advertising and we do not share your email with third parties for their marketing.</li>
                <li><strong className="text-foreground">Frequency:</strong> Infrequent — typically when we ship a notable feature or change a plan. We do not run high-volume promotional campaigns.</li>
                <li><strong className="text-foreground">Opt-out:</strong> Every product and marketing email contains a one-click unsubscribe link. You can opt out at any time, free of charge, and we will stop sending these messages without affecting your account or transactional emails.</li>
                <li><strong className="text-foreground">Email provider:</strong> These emails are sent via Resend, our email delivery provider.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">6. Data Sharing</h2>
              <p className="text-muted-foreground leading-relaxed">
                We do not sell your personal information. We may share your information with:
              </p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li><strong className="text-foreground">Service providers:</strong> Third-party services that help us operate our platform (e.g., cloud hosting, email delivery, SMS delivery, payment processing).</li>
                <li><strong className="text-foreground">Legal requirements:</strong> When required by law, court order, or governmental authority.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">7. Data Security</h2>
              <p className="text-muted-foreground leading-relaxed">
                We implement appropriate technical and organizational measures to protect your personal
                information. All data is transmitted over encrypted connections (TLS/SSL) and stored
                in secure cloud infrastructure.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">8. Data Retention</h2>
              <p className="text-muted-foreground leading-relaxed">
                We retain your account information for as long as your account is active. Monitoring
                data (check results, logs) is retained according to your plan's data retention policy.
                When you delete your account, we will remove your personal information within 30 days.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">9. Your Rights</h2>
              <p className="text-muted-foreground leading-relaxed">You have the right to:</p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li>Access and review the personal information we hold about you.</li>
                <li>Request correction of inaccurate information.</li>
                <li>Request deletion of your account and associated data.</li>
                <li>Opt out of SMS alerts at any time by replying STOP or adjusting your settings.</li>
                <li>Opt out of marketing communications.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">10. Cookies</h2>
              <p className="text-muted-foreground leading-relaxed">
                We use essential cookies required for authentication and session management. We do not
                use third-party advertising or tracking cookies.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">11. Changes to This Policy</h2>
              <p className="text-muted-foreground leading-relaxed">
                We may update this Privacy Policy from time to time. We will notify you of significant
                changes by posting a notice on our website or sending you an email.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">12. Contact Us</h2>
              <p className="text-muted-foreground leading-relaxed">
                If you have questions about this Privacy Policy or your personal data, please contact
                us at <a href="mailto:connect@exit1.dev" className="text-primary hover:underline">connect@exit1.dev</a>.
              </p>
            </section>
          </div>
        </PageContainer>
      </div>
      <Footer />
    </div>
  );
}
