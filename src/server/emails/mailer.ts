import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

export interface SendEmailOptions {
    to: string | string[];
    subject: string;
    html: string;
    text?: string;
}

export async function sendEmail({ to, subject, html, text }: SendEmailOptions) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn("[Mailer] SMTP credentials missing. Email skipped:", { to, subject });
        return null;
    }

    return transporter.sendMail({
        from: `"DevCore Solutions" <${process.env.SMTP_USER}>`,
        replyTo: "dev.core.solution2@gmail.com",
        to,
        subject,
        html,
        text,
    });
}