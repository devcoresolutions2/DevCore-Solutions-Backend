import nodemailer, { Transporter } from "nodemailer";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn("[Mailer] SMTP credentials not fully configured in environment.");
    return null;
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  return transporter;
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function sendVerificationEmail(
  to: string,
  name: string,
  token: string,
  otp: string
): Promise<boolean> {
  const mail = getTransporter();
  const verifyUrl = `${APP_URL}/auth/verify-email?token=${token}&email=${encodeURIComponent(to)}`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f1215; color: #FAF8F5; margin: 0; padding: 24px; }
          .card { max-width: 540px; margin: 0 auto; background: #161a1e; border: 1px solid #283038; border-radius: 16px; padding: 36px; }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; background: rgba(52,211,153,0.12); color: #34d399; font-family: monospace; font-size: 11px; margin-bottom: 16px; font-weight: bold; }
          h1 { font-size: 24px; font-weight: 700; margin-bottom: 12px; color: #ffffff; }
          p { color: #c6c7c4; font-size: 14px; line-height: 1.6; }
          .otp-box { background: #0b0e11; border: 1px dashed #34d399; border-radius: 8px; padding: 16px; text-align: center; margin: 24px 0; }
          .otp-code { font-family: monospace; font-size: 32px; letter-spacing: 8px; font-weight: bold; color: #34d399; }
          .btn { display: inline-block; background: #546571; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 16px 0; }
          .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #283038; font-size: 12px; color: #73777b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">DEVCORE SECURITY PROTOCOL</div>
          <h1>Verify Your Engineering Account</h1>
          <p>Hello ${name || "Engineer"},</p>
          <p>Thank you for registering with DevCore Solutions. To complete your account verification and establish secure access, use the one-time code or click the verification link below:</p>
          
          <div class="otp-box">
            <div style="font-size: 11px; color: #8b949e; margin-bottom: 6px; font-family: monospace;">ONE-TIME SECURITY CODE</div>
            <div class="otp-code">${otp}</div>
            <div style="font-size: 11px; color: #8b949e; margin-top: 6px;">Expires in 15 minutes</div>
          </div>

          <div style="text-align: center;">
            <a href="${verifyUrl}" class="btn">Verify Account Directly</a>
          </div>

          <p style="font-size: 12px; color: #8b949e; margin-top: 24px;">If you did not initiate this registration request, please disregard this transmission.</p>

          <div class="footer">
            DEVCORE SOLUTIONS INC. • ZERO-DRIFT INFRASTRUCTURE • CHATTOGRAM / DHAKA
          </div>
        </div>
      </body>
    </html>
  `;

  if (!mail) {
    console.log(`[Dev Simulator] Verification email for ${to}: OTP=${otp}, Link=${verifyUrl}`);
    return true;
  }

  try {
    await mail.sendMail({
      from: `"DevCore Security" <${process.env.SMTP_USER}>`,
      to,
      subject: `[DevCore] Security Verification Code: ${otp}`,
      html,
    });
    return true;
  } catch (err) {
    console.error("[Mailer] Failed to deliver verification email:", err);
    return false;
  }
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  token: string
): Promise<boolean> {
  const mail = getTransporter();
  const resetUrl = `${APP_URL}/auth/reset-password?token=${token}&email=${encodeURIComponent(to)}`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f1215; color: #FAF8F5; margin: 0; padding: 24px; }
          .card { max-width: 540px; margin: 0 auto; background: #161a1e; border: 1px solid #283038; border-radius: 16px; padding: 36px; }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; background: rgba(239,68,68,0.12); color: #f87171; font-family: monospace; font-size: 11px; margin-bottom: 16px; font-weight: bold; }
          h1 { font-size: 24px; font-weight: 700; margin-bottom: 12px; color: #ffffff; }
          p { color: #c6c7c4; font-size: 14px; line-height: 1.6; }
          .btn { display: inline-block; background: #546571; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 20px 0; }
          .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #283038; font-size: 12px; color: #73777b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">PASSWORD RECOVERY DISPATCH</div>
          <h1>Reset Your DevCore Password</h1>
          <p>Hello ${name || "Engineer"},</p>
          <p>We received an authorized request to reset the password for your DevCore corporate access account.</p>
          
          <div style="text-align: center;">
            <a href="${resetUrl}" class="btn">Establish New Password</a>
          </div>

          <p style="font-size: 12px; color: #8b949e;">This secure reset authorization link expires in 60 minutes and can only be utilized once.</p>
          <p style="font-size: 12px; color: #8b949e;">If you did not request a password reset, your credentials remain secure. No further action is required.</p>

          <div class="footer">
            DEVCORE SOLUTIONS INC. • ZERO-DRIFT INFRASTRUCTURE • CHATTOGRAM / DHAKA
          </div>
        </div>
      </body>
    </html>
  `;

  if (!mail) {
    console.log(`[Dev Simulator] Password reset email for ${to}: Link=${resetUrl}`);
    return true;
  }

  try {
    await mail.sendMail({
      from: `"DevCore Security" <${process.env.SMTP_USER}>`,
      to,
      subject: `[DevCore] Password Recovery Request`,
      html,
    });
    return true;
  } catch (err) {
    console.error("[Mailer] Failed to deliver password reset email:", err);
    return false;
  }
}
