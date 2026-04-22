import { PageContainer, PublicPageHeader } from '@/components/layout';
import { FileText, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Footer from '@/components/layout/Footer';

export default function Terms() {
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
                <FileText className="h-6 w-6 text-muted-foreground" />
                <h1 className="text-2xl sm:text-3xl font-bold">Terms of Service</h1>
              </div>
              <p className="text-sm text-muted-foreground">Last updated: March 7, 2026</p>
            </div>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">1. Acceptance of Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                By accessing or using Exit1.dev ("the Service"), you agree to be bound by these Terms
                of Service. If you do not agree to these terms, do not use the Service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">2. Description of Service</h2>
              <p className="text-muted-foreground leading-relaxed">
                Exit1.dev is a website monitoring service that checks the availability, performance,
                and SSL certificate status of websites you configure. We provide alerts via email,
                SMS text messages, and webhooks when issues are detected.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">3. Account Registration</h2>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li>You must provide accurate and complete information when creating an account.</li>
                <li>You are responsible for maintaining the security of your account credentials.</li>
                <li>You must be at least 18 years old to use the Service.</li>
                <li>One person or entity may not maintain more than one account.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">4. Acceptable Use</h2>
              <p className="text-muted-foreground leading-relaxed">You agree not to:</p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li>Use the Service to monitor websites you do not own or have authorization to monitor.</li>
                <li>Use the Service to conduct denial-of-service attacks or other malicious activities.</li>
                <li>Attempt to gain unauthorized access to the Service or its infrastructure.</li>
                <li>Resell or redistribute the Service without our written consent.</li>
                <li>Use the Service in violation of any applicable laws or regulations.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">5. SMS Text Messaging Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                By opting in to SMS alerts through your account settings, you agree to the following:
              </p>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li><strong className="text-foreground">Consent:</strong> You consent to receive automated SMS text messages from Exit1.dev at the phone number(s) you provide. These messages are transactional alerts related to your website monitoring configuration.</li>
                <li><strong className="text-foreground">Message types:</strong> Messages include website down/up alerts, SSL certificate warnings and errors, and domain expiration notices.</li>
                <li><strong className="text-foreground">Frequency:</strong> Message frequency varies depending on your monitoring configuration and the status of your websites. Messages are subject to hourly and monthly limits as described in your plan.</li>
                <li><strong className="text-foreground">Costs:</strong> Message and data rates may apply. You are responsible for any charges from your mobile carrier.</li>
                <li><strong className="text-foreground">Opt-out:</strong> You can stop receiving SMS messages at any time by replying STOP to any message, removing your phone number from your SMS settings, or disabling SMS notifications in your account. After opting out, you will receive a confirmation message and no further messages will be sent.</li>
                <li><strong className="text-foreground">Help:</strong> For assistance, reply HELP to any message or contact us at connect@exit1.dev.</li>
                <li><strong className="text-foreground">No sharing:</strong> We will not share your phone number or SMS opt-in consent with any third parties for marketing purposes.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">6. Plans and Billing</h2>
              <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
                <li>The Service offers free and paid plans with different feature sets and limits.</li>
                <li>Paid plans are billed on a recurring basis according to the plan you select.</li>
                <li>You may upgrade, downgrade, or cancel your plan at any time.</li>
                <li>Refunds are handled on a case-by-case basis at our discretion.</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">7. Service Availability</h2>
              <p className="text-muted-foreground leading-relaxed">
                We strive to maintain high availability of the Service, but do not guarantee
                uninterrupted access. We may perform scheduled maintenance with reasonable
                advance notice. We are not liable for any downtime or service interruptions.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">8. Data and Privacy</h2>
              <p className="text-muted-foreground leading-relaxed">
                Your use of the Service is also governed by our{' '}
                <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>,
                which describes how we collect, use, and protect your information.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">9. Intellectual Property</h2>
              <p className="text-muted-foreground leading-relaxed">
                The Service, including its design, features, and content, is owned by Exit1.dev
                and protected by applicable intellectual property laws. You retain ownership of
                the data you provide to the Service.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">10. Limitation of Liability</h2>
              <p className="text-muted-foreground leading-relaxed">
                The Service is provided "as is" without warranties of any kind. Exit1.dev shall
                not be liable for any indirect, incidental, special, or consequential damages
                arising from your use of the Service. Our total liability shall not exceed the
                amount you paid for the Service in the 12 months preceding the claim.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">11. Termination</h2>
              <p className="text-muted-foreground leading-relaxed">
                We reserve the right to suspend or terminate your account if you violate these
                terms. You may terminate your account at any time by contacting us. Upon
                termination, your data will be deleted in accordance with our Privacy Policy.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">12. Changes to Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                We may modify these Terms of Service at any time. We will notify you of
                significant changes by posting a notice on our website or sending you an email.
                Continued use of the Service after changes constitutes acceptance of the
                updated terms.
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-xl font-semibold">13. Contact Us</h2>
              <p className="text-muted-foreground leading-relaxed">
                If you have questions about these Terms of Service, please contact us
                at <a href="mailto:connect@exit1.dev" className="text-primary hover:underline">connect@exit1.dev</a>.
              </p>
            </section>
          </div>
        </PageContainer>
      </div>
      <Footer />
    </div>
  );
}
