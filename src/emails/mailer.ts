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
            <div style="font-size: 11px; color: #8b949e; margin-top: 6px;">Expires in 10 minutes</div>
          </div>

          <div style="text-align: center;">
            <a href="${verifyUrl}" class="btn">Verify Account Directly</a>
          </div>

          <p style="font-size: 12px; color: #f87171; margin-top: 16px;"><strong>Security Warning:</strong> Never share this code with anyone. DevCore engineers will never request this verification code by phone, chat, or email.</p>
          <p style="font-size: 12px; color: #8b949e; margin-top: 12px;">If you did not initiate this registration request, please disregard this transmission.</p>

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

export async function sendPasswordResetOtpEmail(
  to: string,
  name: string,
  otp: string
): Promise<boolean> {
  const mail = getTransporter();

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f1215; color: #FAF8F5; margin: 0; padding: 24px; }
          .card { max-width: 540px; margin: 0 auto; background: #161a1e; border: 1px solid #283038; border-radius: 16px; padding: 36px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
          .brand-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #242b31; }
          .brand-title { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: #FAF8F5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          .badge { display: inline-block; padding: 4px 10px; border-radius: 9999px; background: rgba(84,101,113,0.3); border: 1px solid rgba(211,229,243,0.3); color: #d3e5f3; font-family: monospace; font-size: 11px; margin-bottom: 16px; font-weight: bold; }
          h1 { font-size: 24px; font-weight: 700; margin-bottom: 12px; color: #ffffff; letter-spacing: -0.02em; }
          p { color: #c6c7c4; font-size: 14px; line-height: 1.6; margin: 8px 0; }
          .otp-container { margin: 28px 0; background: #1f252c; border: 1px solid #384954; border-radius: 12px; padding: 24px; text-align: center; }
          .otp-label { font-size: 11px; font-family: monospace; color: #8b949e; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 8px; font-weight: 600; }
          .otp-code { font-family: 'SF Mono', Monaco, Consolas, 'Courier New', monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #d3e5f3; text-shadow: 0 0 16px rgba(84,101,113,0.6); }
          .otp-expiry { font-size: 12px; color: #d1c6aa; margin-top: 10px; font-family: monospace; font-weight: 500; }
          .security-box { margin-top: 24px; padding: 14px 18px; background: rgba(229,103,92,0.1); border: 1px solid rgba(229,103,92,0.3); border-radius: 10px; font-size: 12px; color: #fca5a5; line-height: 1.5; }
          .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #283038; font-size: 11px; color: #73777b; text-align: center; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="brand-row">
            <span class="brand-title">DEVCORE</span>
            <span style="font-family: monospace; font-size: 11px; color: #8b949e;">SECURITY GATEWAY</span>
          </div>

          <div class="badge">PASSWORD RECOVERY CHALLENGE</div>
          <h1>Reset your password</h1>
          <p>Hello ${name || "Engineer"},</p>
          <p>We received an authorized password recovery request for your DevCore account. Enter the verification code below to establish a new password.</p>
          
          <div class="otp-container">
            <div class="otp-label">ONE-TIME VERIFICATION CODE</div>
            <div class="otp-code">${otp}</div>
            <div class="otp-expiry">⏱ This code expires in 10 minutes</div>
          </div>

          <div class="security-box">
            <strong>Security Notice:</strong> DevCore Solutions will never contact you via telephone, message, or email requesting your one-time verification code. Never disclose this code to anyone.
          </div>

          <p style="font-size: 12px; color: #8b949e; margin-top: 20px;">
            If you did not initiate this password recovery request, your account credentials remain secure. No further action is required.
          </p>

          <div class="footer">
            DEVCORE SOLUTIONS INC. • ZERO-DRIFT INFRASTRUCTURE • SECURE IDENTITY MATRIX
          </div>
        </div>
      </body>
    </html>
  `;

  if (!mail) {
    console.log(`[Dev Simulator] Password Reset OTP for ${to}: ${otp} (Expires in 10 mins)`);
    return true;
  }

  try {
    await mail.sendMail({
      from: `"DevCore Security" <${process.env.SMTP_USER}>`,
      to,
      subject: `DEVCORE — Your Password Reset Verification Code`,
      html,
    });
    return true;
  } catch (err) {
    console.error("[Mailer] Failed to deliver password reset OTP email:", err);
    return false;
  }
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  token: string
): Promise<boolean> {
  return sendPasswordResetOtpEmail(to, name, token);
}
