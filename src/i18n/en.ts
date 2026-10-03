// All UI strings live here so crew-facing screens can get Russian labels later.
export const en = {
  appName: "A&A CRM",
  login: {
    title: "Sign in",
    emailLabel: "Work email",
    submit: "Email me a sign-in link",
    sending: "Sending...",
    sentTitle: "Check your email",
    sentBody: "If that email belongs to an active account, we sent a sign-in link. It works once and expires in 15 minutes.",
    confirmTitle: "Finish signing in",
    confirmSubmit: "Sign in",
    confirmWorking: "Signing in...",
    invalidLink: "That sign-in link is invalid or has expired. Request a new one.",
    tooManyRequests: "Too many attempts. Wait a few minutes and try again.",
    backToLogin: "Back to sign in",
  },
  home: {
    greeting: (name: string) => `Welcome, ${name}`,
    roleLabel: "Your role",
    signOut: "Sign out",
    comingSoon: "Coming soon",
  },
  roles: {
    admin: "Admin",
    csr: "CSR",
    estimator: "Estimator",
    production_manager: "Production Manager",
    crew_leader: "Crew leader",
    accounting: "Accounting",
  },
} as const;
