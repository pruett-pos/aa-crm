import { Resend } from "resend";

/** Email the customer their signed contract. Throws on failure; the caller decides how to report it. */
export async function sendSignedContract(to: string, customerName: string, jobNumber: number, pdf: Uint8Array): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is not set");
    console.log(`[dev] signed contract for job ${jobNumber} would be emailed to ${to} (${pdf.length} bytes)`);
    return;
  }
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is not set");
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to,
    subject: `Your signed contract with A&A Exterior Group (job ${jobNumber})`,
    text: `Hello ${customerName},\n\nThank you for choosing A&A Exterior Group. Your signed contract is attached. Please keep it for your records.`,
    attachments: [{ filename: `contract-job-${jobNumber}-signed.pdf`, content: Buffer.from(pdf) }],
  });
  if (error) throw new Error(`Resend failed: ${error.message}`);
}

/** Send the magic-link email. With no RESEND_API_KEY (local dev) the link is logged instead. */
export async function sendLoginLink(to: string, link: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is not set");
    console.log(`[dev] sign-in link for ${to}: ${link}`);
    return;
  }
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is not set");
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to,
    subject: "Your A&A CRM sign-in link",
    text: `Use this link to sign in. It works once and expires in 15 minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`,
  });
  if (error) throw new Error(`Resend failed: ${error.message}`);
}
