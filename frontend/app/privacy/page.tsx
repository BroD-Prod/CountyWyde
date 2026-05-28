export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-[calc(100vh-5rem)] bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-3xl">
        <div className="rounded-4xl border border-white/10 bg-white/92 p-8 text-slate-900 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
            Legal
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">
            Privacy Policy
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Last updated: May 28, 2026
          </p>

          <div className="mt-6 space-y-5 text-sm leading-7 text-slate-700">
            <section>
              <h2 className="text-base font-semibold text-slate-900">
                Data Collection Clause
              </h2>
              <p className="mt-2">
                By creating an account or using CountyWyde, you agree that we
                may collect and process account data (such as username, county,
                and state), authentication/session data, and uploaded file
                content strictly to operate, secure, and improve the service. We
                retain this data only as long as needed for legitimate
                operational purposes or to comply with legal obligations.
              </p>
            </section>
            <section>
              <h2 className="text-base font-semibold text-slate-900">
                Children&apos;s Privacy (Under 13)
              </h2>
              <p className="mt-2">
                CountyWyde is not directed to children under 13, and children
                under 13 are not permitted to create an account or use the
                service. We do not knowingly collect personal information from
                children under 13 without verifiable parental consent.
              </p>
              <p className="mt-2">
                If we learn that personal information from a child under 13 has
                been submitted without required parental consent, we will
                promptly suspend the account and delete the related personal
                information and uploaded content, unless retention is required
                by law.
              </p>
              <p className="mt-2">
                Parents or legal guardians who believe a child under 13 has
                provided information to CountyWyde may contact us to request
                review and deletion.
              </p>
            </section>
            <p>
              CountyWyde collects the information you provide to create and
              manage your account, including username, county, state, and
              session data required to keep you signed in.
            </p>
            <p>
              Uploaded documents are stored to power search results within the
              app. Please avoid uploading sensitive personal information unless
              you are authorized to do so.
            </p>
            <p>
              We use cookies only for authentication and session management. We
              do not sell personal information and we do not run third-party
              advertising trackers in the application.
            </p>
            <p>
              You may request account deletion at any time from your account
              settings. Deleting your account removes account access and
              associated session records.
            </p>
            <p>
              For privacy questions, contact your CountyWyde administrator or
              support channel.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
