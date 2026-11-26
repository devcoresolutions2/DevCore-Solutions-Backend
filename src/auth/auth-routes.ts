import { Router, Request, Response } from "express";
import { prisma } from "../server/db/prisma";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateSecureToken,
  generateOtp,
} from "../security/hash";
import { checkRateLimit } from "../security/rate-limit";
import { sendVerificationEmail, sendPasswordResetOtpEmail, sendPasswordResetEmail } from "../emails/mailer";
import { recordAuthEvent } from "../account/account-routes";

export const authRouter = Router();

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

function getAdminWhitelist(): string[] {
  const envEmails = process.env.ADMIN_WHITELIST_EMAILS || "";
  return envEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function parseCookies(req: Request): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const name = parts[0]?.trim();
    if (name) {
      list[name] = decodeURIComponent(parts.slice(1).join("=").trim());
    }
  });
  return list;
}

// ─── 1. SIGN UP ──────────────────────────────────────────────────────────────
authRouter.post("/signup", async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
  const rateKey = `signup:${ip}`;
  const rate = await checkRateLimit(rateKey, 6, 600); // max 6 attempts / 10 mins

  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many registration attempts. Please wait.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  const { name, email, password, termsAccepted, inviteToken } = req.body;

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return res.status(400).json({
      error: { code: "INVALID_NAME", message: "Please enter your full corporate or personal name." },
    });
  }

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({
      error: { code: "INVALID_EMAIL", message: "Please provide a valid work email address." },
    });
  }

  if (!password || typeof password !== "string" || password.length < 10) {
    return res.status(400).json({
      error: {
        code: "WEAK_PASSWORD",
        message: "Password must be at least 10 characters long and include numbers and letters.",
      },
    });
  }

  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  if (!hasLetter || !hasNumber) {
    return res.status(400).json({
      error: {
        code: "WEAK_PASSWORD",
        message: "Password must contain at least one letter and one numeric digit.",
      },
    });
  }

  if (!termsAccepted) {
    return res.status(400).json({
      error: { code: "TERMS_REQUIRED", message: "You must accept the Terms of Service to create an account." },
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Check if user already exists
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      if (existing.emailVerified) {
        return res.status(409).json({
          error: {
            code: "EMAIL_EXISTS",
            message: "An account with this work email already exists.",
          },
        });
      }

      // If user exists but is not yet verified, refresh their registration & dispatch fresh OTP
      const passwordHash = await hashPassword(password);
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: name.trim(),
          passwordHash,
        },
      });

      // Invalidate any previous unverified tokens for this email
      await prisma.verificationToken.deleteMany({ where: { email: normalizedEmail } });

      // Create new verification token & OTP (10-minute expiry)
      const rawToken = generateSecureToken(32);
      const tokenHash = hashToken(rawToken);
      const otp = generateOtp();
      const otpHash = hashToken(otp);

      await prisma.verificationToken.create({
        data: {
          email: normalizedEmail,
          otpHash: `${tokenHash}:${otpHash}`,
          attempts: 0,
          resendCount: 0,
          lastSentAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      });

      // Send verification email
      const emailDelivered = await sendVerificationEmail(normalizedEmail, existing.name, rawToken, otp);

      return res.status(200).json({
        success: true,
        message: emailDelivered
          ? "Account credentials refreshed. A new verification code has been dispatched to your email."
          : "Account created, but SMTP delivery failed. Please request a new code via Resend.",
        email: normalizedEmail,
        deliveryStatus: emailDelivered ? "DELIVERED" : "SMTP_FAILED",
      });
    }

    // Role assignment: valid single-use UserInvitation or ADMIN_WHITELIST_EMAILS, otherwise USER
    const adminWhitelist = getAdminWhitelist();
    let role: string = adminWhitelist.includes(normalizedEmail) ? "SUPER_ADMIN" : "USER";
    let acceptedInviteId: string | null = null;

    if (typeof inviteToken === "string" && inviteToken.trim()) {
      const inviteHash = hashToken(inviteToken.trim());
      const invite = await prisma.userInvitation.findUnique({ where: { tokenHash: inviteHash } });
      if (
        invite &&
        invite.email === normalizedEmail &&
        !invite.acceptedAt &&
        !invite.revokedAt &&
        new Date() <= invite.expiresAt
      ) {
        role = invite.role;
        acceptedInviteId = invite.id;
      } else {
        return res.status(400).json({
          error: { code: "INVALID_INVITATION", message: "Invitation link is invalid or expired." },
        });
      }
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: role as any,
        emailVerified: Boolean(acceptedInviteId),
      },
    });

    if (acceptedInviteId) {
      await prisma.userInvitation.update({
        where: { id: acceptedInviteId },
        data: { acceptedAt: new Date() },
      });
      await prisma.auditLog
        .create({
          data: {
            actorId: user.id,
            action: "INVITATION_ACCEPTED",
            entity: "UserInvitation",
            entityId: acceptedInviteId,
            meta: { email: normalizedEmail, role },
            ip,
          },
        })
        .catch(() => {});
    }

    // Invalidate any previous unverified tokens for this email
    await prisma.verificationToken.deleteMany({ where: { email: normalizedEmail } });

    // Create verification token & OTP (10-minute expiry)
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const otp = generateOtp();
    const otpHash = hashToken(otp);

    await prisma.verificationToken.create({
      data: {
        email: normalizedEmail,
        otpHash: `${tokenHash}:${otpHash}`,
        attempts: 0,
        resendCount: 0,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    });

    // Send verification email
    const emailDelivered = await sendVerificationEmail(normalizedEmail, user.name, rawToken, otp);

    return res.status(201).json({
      success: true,
      message: emailDelivered
        ? "Account created successfully. A verification code has been dispatched to your email."
        : "Account created, but SMTP delivery failed. Please request a new code via Resend.",
      email: normalizedEmail,
      deliveryStatus: emailDelivered ? "DELIVERED" : "SMTP_FAILED",
    });
  } catch (error) {
    console.error("[Auth:SignUp] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to create account. Please try again." },
    });
  }
});

// ─── 2. SIGN IN ──────────────────────────────────────────────────────────────
authRouter.post("/signin", async (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || "127.0.0.1";
  const { email, password, rememberMe } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "Work email and password are required." },
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const rateKey = `signin:${normalizedEmail}_${ip}`;
  const rate = await checkRateLimit(rateKey, 5, 300); // 5 attempts per 5 mins

  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many sign-in attempts. Please wait.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Email or password is incorrect. Please recheck your credentials.",
        },
      });
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      await recordAuthEvent({
        type: "LOGIN_FAILED",
        status: "FAILED",
        userId: user.id,
        email: user.email,
        ip: String(ip),
        userAgent: req.headers["user-agent"] || null,
        metadata: { reason: "invalid_password" },
      });
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Email or password is incorrect. Please recheck your credentials.",
        },
      });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        error: {
          code: "EMAIL_NOT_VERIFIED",
          message: "Your email address has not been verified yet.",
          email: user.email,
        },
      });
    }

    // Generate Session
    const rawSessionToken = generateSecureToken(32);
    const tokenHash = hashToken(rawSessionToken);
    const sessionDuration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + sessionDuration);

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        ip: String(ip),
        userAgent: req.headers["user-agent"] || null,
        rememberMe: !!rememberMe,
        expiresAt,
      },
    });

    // Update lastSignInAt
    await prisma.user.update({
      where: { id: user.id },
      data: { lastSignInAt: new Date() },
    });

    // Set HTTP-only Cookie
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("devcore_session", rawSessionToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: sessionDuration,
    });

    const isAdmin = user.role === "SUPER_ADMIN" || user.role === "EDITOR";
    const redirectUrl = isAdmin ? "/admin/dashboard" : "/";

    await recordAuthEvent({
      type: "LOGIN_SUCCESS",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: String(ip),
      userAgent: req.headers["user-agent"] || null,
      metadata: { method: "credentials" },
    });

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        avatarUrl: user.avatarUrl,
        hasPassword: Boolean(user.passwordHash),
      },
      redirectUrl,
    });
  } catch (error) {
    console.error("[Auth:SignIn] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Authentication service encountered an error." },
    });
  }
});

// ─── 3. CURRENT SESSION (ME) ────────────────────────────────────────────────
authRouter.get("/me", async (req: Request, res: Response) => {
  const cookies = parseCookies(req);
  const sessionToken = cookies["devcore_session"] || req.headers.authorization?.replace("Bearer ", "");

  if (!sessionToken) {
    return res.json({ user: null });
  }

  try {
    const tokenHash = hashToken(sessionToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.revokedAt || new Date() > session.expiresAt) {
      return res.json({ user: null });
    }

    // Touch lastActiveAt asynchronously
    prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date() },
    }).catch(() => {});

    return res.json({
      user: {
        id: session.user.id,
        name: session.user.name,
        username: session.user.username,
        email: session.user.email,
        role: session.user.role,
        emailVerified: session.user.emailVerified,
        avatarUrl: session.user.avatarUrl,
        hasPassword: Boolean(session.user.passwordHash),
      },
    });
  } catch (error) {
    return res.json({ user: null });
  }
});

// ─── 4. SIGN OUT ─────────────────────────────────────────────────────────────
authRouter.post("/signout", async (req: Request, res: Response) => {
  const cookies = parseCookies(req);
  const sessionToken = cookies["devcore_session"];

  if (sessionToken) {
    const tokenHash = hashToken(sessionToken);
    await prisma.session.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    }).catch(() => {});
  }

  res.clearCookie("devcore_session", { path: "/" });
  return res.json({ success: true, message: "Signed out successfully." });
});

// ─── 5. VERIFY EMAIL ─────────────────────────────────────────────────────────
authRouter.post("/verify-email", async (req: Request, res: Response) => {
  const { token, otp, email } = req.body;

  if (!token && !otp) {
    return res.status(400).json({
      error: { code: "MISSING_TOKEN", message: "Verification token or code is required." },
    });
  }

  try {
    // A) Direct Link Verification via raw token
    if (token) {
      const hashed = hashToken(token);
      const records = await prisma.verificationToken.findMany({
        where: { expiresAt: { gt: new Date() } },
      });
      const matched = records.find((r) => r.otpHash.startsWith(hashed));

      if (!matched) {
        return res.status(400).json({
          error: {
            code: "EXPIRED_OR_INVALID",
            message: "Verification link is invalid or has expired. Please request a new verification code.",
          },
        });
      }

      await prisma.user.update({
        where: { email: matched.email },
        data: { emailVerified: true },
      });

      await prisma.verificationToken.delete({ where: { id: matched.id } }).catch(() => {});

      return res.json({
        success: true,
        message: "Email verified successfully! You may now sign in.",
      });
    }

    // B) 6-Digit OTP Verification
    if (!email || typeof email !== "string") {
      return res.status(400).json({
        error: { code: "MISSING_EMAIL", message: "Registered email address is required for code validation." },
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    const record = await prisma.verificationToken.findFirst({
      where: { email: normalizedEmail },
      orderBy: { createdAt: "desc" },
    });

    if (!record) {
      // Check if user is already verified
      const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (user?.emailVerified) {
        return res.json({
          success: true,
          alreadyVerified: true,
          message: "Email is already verified. You may proceed to your workspace.",
        });
      }

      return res.status(400).json({
        error: {
          code: "NO_ACTIVE_CODE",
          message: "No active verification code found for this account. Please request a new code.",
        },
      });
    }

    // Check expiration (10 minutes)
    if (new Date() > record.expiresAt) {
      return res.status(400).json({
        error: {
          code: "EXPIRED_CODE",
          message: "Verification code expired. The 10-minute validity window has lapsed. Request a new token.",
        },
      });
    }

    // Check failed attempt lockout (Max 5 attempts)
    const MAX_ATTEMPTS = 5;
    if (record.attempts >= MAX_ATTEMPTS) {
      const remainingCooldown = Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
      return res.status(429).json({
        error: {
          code: "TOO_MANY_ATTEMPTS",
          message: "Too many failed attempts. Account verification is rate-limited for security.",
          cooldownSeconds: remainingCooldown,
        },
      });
    }

    // Verify submitted OTP against stored hash
    const submittedHash = hashToken(cleanOtp);
    const isMatch = record.otpHash.endsWith(submittedHash) || record.otpHash === submittedHash;

    if (!isMatch) {
      const updatedRecord = await prisma.verificationToken.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });

      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - updatedRecord.attempts);

      if (attemptsLeft === 0) {
        const remainingCooldown = Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
        return res.status(429).json({
          error: {
            code: "TOO_MANY_ATTEMPTS",
            message: "Too many failed attempts. Account verification is rate-limited for security.",
            attemptsLeft: 0,
            cooldownSeconds: remainingCooldown,
          },
        });
      }

      return res.status(400).json({
        error: {
          code: "WRONG_CODE",
          message: "That code is not correct.",
          attemptsLeft,
        },
      });
    }

    // Successful Verification: Update user and consume token atomically
    await prisma.$transaction([
      prisma.user.update({
        where: { email: normalizedEmail },
        data: { emailVerified: true },
      }),
      prisma.verificationToken.delete({
        where: { id: record.id },
      }),
    ]);

    return res.json({
      success: true,
      message: "Email verified successfully! Your identity has been cryptographically confirmed.",
    });
  } catch (error) {
    console.error("[Auth:VerifyEmail] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Verification processing failed. Please try again." },
    });
  }
});

// ─── 6. RESEND VERIFICATION ──────────────────────────────────────────────────
authRouter.post("/resend-verification", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({
      error: { code: "INVALID_EMAIL", message: "A valid email address is required." },
    });
  }

  const normalized = email.trim().toLowerCase();
  const rateKey = `resend:${normalized}`;
  const rate = await checkRateLimit(rateKey, 4, 900); // 4 requests per 15 mins window

  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many verification requests. Please wait a few minutes.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      return res.json({
        success: true,
        message: "If an account matches this email, a verification code was dispatched.",
        resendsLeft: 2,
      });
    }

    if (user.emailVerified) {
      return res.json({
        success: true,
        alreadyVerified: true,
        message: "This email is already verified. Please proceed to sign in.",
      });
    }

    // Check existing token for resend count and 60-second cooldown
    const existing = await prisma.verificationToken.findFirst({
      where: { email: normalized },
      orderBy: { createdAt: "desc" },
    });

    const MAX_RESENDS = 3;

    if (existing) {
      // Check 60-second cooldown between consecutive resend actions
      const timeSinceLast = (Date.now() - existing.lastSentAt.getTime()) / 1000;
      if (timeSinceLast < 60) {
        const cooldownRemaining = Math.ceil(60 - timeSinceLast);
        return res.status(429).json({
          error: {
            code: "COOLDOWN_ACTIVE",
            message: `Please wait ${cooldownRemaining} seconds before requesting another code.`,
            retryAfter: cooldownRemaining,
          },
        });
      }

      // Check max 3 resends limit
      if (existing.resendCount >= MAX_RESENDS) {
        const timeSinceCreation = (Date.now() - existing.createdAt.getTime()) / 1000;
        if (timeSinceCreation < 900) { // 15-minute window
          const remainingWait = Math.ceil(900 - timeSinceCreation);
          return res.status(429).json({
            error: {
              code: "MAX_RESENDS_REACHED",
              message: "Maximum resend limit (3 of 3) reached. Please wait for the security window to lapse.",
              retryAfter: remainingWait,
            },
          });
        }
      }
    }

    const currentResendCount = existing ? existing.resendCount + 1 : 1;
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const otp = generateOtp();
    const otpHash = hashToken(otp);

    await prisma.verificationToken.deleteMany({ where: { email: normalized } });
    await prisma.verificationToken.create({
      data: {
        email: normalized,
        otpHash: `${tokenHash}:${otpHash}`,
        attempts: 0,
        resendCount: currentResendCount,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    });

    const sent = await sendVerificationEmail(normalized, user.name, rawToken, otp);

    const resendsLeft = Math.max(0, MAX_RESENDS - currentResendCount);

    return res.json({
      success: true,
      message: sent
        ? "A fresh 6-digit verification code has been dispatched to your email."
        : "Failed to dispatch email via SMTP. Please try again shortly.",
      resendsLeft,
      expiresInSeconds: 600,
    });
  } catch (error) {
    console.error("[Auth:ResendVerification] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to dispatch verification email." },
    });
  }
});

// ─── 6B. CHANGE PENDING SIGNUP EMAIL ─────────────────────────────────────────
authRouter.post("/change-pending-email", async (req: Request, res: Response) => {
  const { currentEmail, newEmail } = req.body;

  if (!currentEmail || !newEmail || typeof currentEmail !== "string" || typeof newEmail !== "string") {
    return res.status(400).json({
      error: { code: "INVALID_FIELDS", message: "Both current and new email addresses are required." },
    });
  }

  const normalizedCurrent = currentEmail.trim().toLowerCase();
  const normalizedNew = newEmail.trim().toLowerCase();

  if (!normalizedNew.includes("@") || normalizedNew.length < 5) {
    return res.status(400).json({
      error: { code: "INVALID_NEW_EMAIL", message: "Please provide a valid new email address." },
    });
  }

  if (normalizedCurrent === normalizedNew) {
    return res.status(400).json({
      error: { code: "SAME_EMAIL", message: "The new email address cannot be identical to the current one." },
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedCurrent } });
    if (!user) {
      return res.status(404).json({
        error: { code: "USER_NOT_FOUND", message: "Account not found for the specified current email." },
      });
    }

    if (user.emailVerified) {
      return res.status(403).json({
        error: {
          code: "ALREADY_VERIFIED",
          message: "This account has already verified its email. Use authenticated account settings to change emails.",
        },
      });
    }

    // Check if new email is already in use by another account
    const existingNew = await prisma.user.findUnique({ where: { email: normalizedNew } });
    if (existingNew) {
      return res.status(409).json({
        error: { code: "EMAIL_EXISTS", message: "An account with this email address already exists." },
      });
    }

    // Generate fresh OTP & Token for the new email
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const otp = generateOtp();
    const otpHash = hashToken(otp);

    // Update user and replace verification token
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { email: normalizedNew },
      }),
      prisma.verificationToken.deleteMany({
        where: { email: { in: [normalizedCurrent, normalizedNew] } },
      }),
      prisma.verificationToken.create({
        data: {
          email: normalizedNew,
          otpHash: `${tokenHash}:${otpHash}`,
          attempts: 0,
          resendCount: 0,
          lastSentAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      }),
    ]);

    await sendVerificationEmail(normalizedNew, user.name, rawToken, otp);

    return res.json({
      success: true,
      email: normalizedNew,
      message: "Email updated successfully. A verification code has been dispatched to your new address.",
    });
  } catch (error) {
    console.error("[Auth:ChangePendingEmail] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to update email address. Please try again." },
    });
  }
});

// ─── 6C. GET VERIFICATION STATUS ─────────────────────────────────────────────
authRouter.get("/verification-status", async (req: Request, res: Response) => {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";

  if (!email) {
    return res.status(400).json({ error: { message: "Email query parameter is required." } });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.json({ exists: false, emailVerified: false });
    }

    if (user.emailVerified) {
      return res.json({ exists: true, emailVerified: true });
    }

    const token = await prisma.verificationToken.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });

    if (!token) {
      return res.json({
        exists: true,
        emailVerified: false,
        hasActiveOtp: false,
      });
    }

    const now = Date.now();
    const expiresInSeconds = Math.max(0, Math.ceil((token.expiresAt.getTime() - now) / 1000));
    const timeSinceLast = (now - token.lastSentAt.getTime()) / 1000;
    const cooldownSeconds = timeSinceLast < 60 ? Math.ceil(60 - timeSinceLast) : 0;
    const attemptsLeft = Math.max(0, 5 - token.attempts);
    const resendsLeft = Math.max(0, 3 - token.resendCount);

    return res.json({
      exists: true,
      emailVerified: false,
      hasActiveOtp: expiresInSeconds > 0,
      expiresInSeconds,
      cooldownSeconds,
      attemptsLeft,
      resendsLeft,
      isLocked: token.attempts >= 5,
    });
  } catch (error) {
    return res.status(500).json({ error: { message: "Failed to fetch verification status." } });
  }
});

// ─── 7. FORGOT PASSWORD (REAL 6-DIGIT OTP DISPATCH) ──────────────────────────
authRouter.post("/forgot-password", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({
      error: { code: "INVALID_EMAIL", message: "A valid email address is required." },
    });
  }

  const normalized = email.trim().toLowerCase();
  const rateKey = `forgot:${normalized}`;
  const rate = await checkRateLimit(rateKey, 4, 900); // Max 4 requests per 15 mins

  if (!rate.allowed) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many recovery attempts. Please wait.",
        retryAfter: rate.resetInSeconds,
      },
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: normalized } });

    // Only issue reset code if account exists and has a password
    if (user && user.passwordHash) {
      const resetOtp = generateOtp(); // CSPRNG 6-digit OTP
      const otpHash = hashToken(resetOtp);

      // Invalidate any previous forgot-password token for this email
      await prisma.verificationToken.deleteMany({
        where: { email: `reset:${normalized}` },
      });

      // Create new OTP record valid for 10 minutes
      await prisma.verificationToken.create({
        data: {
          email: `reset:${normalized}`,
          otpHash,
          attempts: 0,
          resendCount: 0,
          lastSentAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // Exactly 10 minutes
        },
      });

      // Dispatch real email via existing SMTP
      await sendPasswordResetOtpEmail(normalized, user.name, resetOtp);
    }

    // Always return consistent generic response to avoid account enumeration
    const parts = normalized.split("@");
    const local = parts[0] || "";
    const domain = parts[1] || "";
    const masked = local.length <= 2 ? `${local[0]}***@${domain}` : `${local[0]}***${local[local.length - 1]}@${domain}`;

    return res.json({
      success: true,
      message: "If an account exists for that address, a verification code is on its way.",
      maskedEmail: masked,
      expiresInSeconds: 600,
      cooldownSeconds: 60,
      resendsLeft: 3,
    });
  } catch (error) {
    console.error("[Auth] Forgot-password dispatch error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Password recovery service failed." },
    });
  }
});

// ─── 8. VERIFY RESET OTP ─────────────────────────────────────────────────────
authRouter.post("/verify-reset-otp", async (req: Request, res: Response) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "Email and 6-digit verification code are required." },
    });
  }

  const normalized = email.trim().toLowerCase();
  const cleanedOtp = otp.toString().trim();

  try {
    const tokenRecord = await prisma.verificationToken.findFirst({
      where: {
        email: `reset:${normalized}`,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!tokenRecord) {
      return res.status(400).json({
        error: { code: "EXPIRED_CODE", message: "Security code expired or not found. Please request a new code." },
      });
    }

    // Check failed attempts limit (max 5)
    if (tokenRecord.attempts >= 5) {
      await prisma.verificationToken.delete({ where: { id: tokenRecord.id } });
      return res.status(429).json({
        error: {
          code: "TOO_MANY_ATTEMPTS",
          message: "Too many failed attempts. Security cooldown active. Please request a fresh code.",
        },
      });
    }

    const submittedHash = hashToken(cleanedOtp);
    if (tokenRecord.otpHash !== submittedHash) {
      const nextAttempts = tokenRecord.attempts + 1;
      await prisma.verificationToken.update({
        where: { id: tokenRecord.id },
        data: { attempts: nextAttempts },
      });

      const remaining = Math.max(0, 5 - nextAttempts);
      return res.status(400).json({
        error: {
          code: "INVALID_CODE",
          message: `Invalid verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
          attemptsLeft: remaining,
        },
      });
    }

    // OTP is valid! Consume it atomically so it cannot be reused
    await prisma.verificationToken.delete({ where: { id: tokenRecord.id } });

    // Look up user to bind reset authorization
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      return res.status(400).json({
        error: { code: "USER_NOT_FOUND", message: "Account authorization failure." },
      });
    }

    // Invalidate previous reset authorizations
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });

    // Generate single-use, short-lived reset authorization token (15 mins)
    const resetAuthorizationToken = generateSecureToken(32);
    const tokenHash = hashToken(resetAuthorizationToken);

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      },
    });

    return res.json({
      success: true,
      message: "Verification code confirmed. You may now establish a new password.",
      resetToken: resetAuthorizationToken,
    });
  } catch (error) {
    console.error("[Auth] Verify reset OTP error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to verify security code." },
    });
  }
});

// ─── 9. RESEND RESET OTP ─────────────────────────────────────────────────────
authRouter.post("/resend-reset-otp", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({
      error: { code: "INVALID_EMAIL", message: "A valid email address is required." },
    });
  }

  const normalized = email.trim().toLowerCase();

  try {
    const existing = await prisma.verificationToken.findFirst({
      where: { email: `reset:${normalized}` },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      // 60-second cooldown check
      const elapsedSeconds = Math.floor((Date.now() - existing.lastSentAt.getTime()) / 1000);
      if (elapsedSeconds < 60) {
        return res.status(429).json({
          error: {
            code: "COOLDOWN_ACTIVE",
            message: `Please wait ${60 - elapsedSeconds}s before requesting a new code.`,
            cooldownSeconds: 60 - elapsedSeconds,
          },
        });
      }

      // Max 3 resends per session check
      if (existing.resendCount >= 3) {
        return res.status(429).json({
          error: {
            code: "RESEND_LIMIT_EXCEEDED",
            message: "Maximum verification code resends reached for this session. Please wait before retrying.",
          },
        });
      }
    }

    const user = await prisma.user.findUnique({ where: { email: normalized } });
    const currentResendCount = existing ? existing.resendCount + 1 : 1;

    if (user && user.passwordHash) {
      const resetOtp = generateOtp();
      const otpHash = hashToken(resetOtp);

      await prisma.verificationToken.deleteMany({ where: { email: `reset:${normalized}` } });
      await prisma.verificationToken.create({
        data: {
          email: `reset:${normalized}`,
          otpHash,
          attempts: 0,
          resendCount: currentResendCount,
          lastSentAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      await sendPasswordResetOtpEmail(normalized, user.name, resetOtp);
    }

    return res.json({
      success: true,
      message: "If an account exists, a fresh verification code has been dispatched.",
      cooldownSeconds: 60,
      resendsLeft: Math.max(0, 3 - currentResendCount),
    });
  } catch (error) {
    console.error("[Auth] Resend reset OTP error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to resend verification code." },
    });
  }
});

// ─── 9B. VALIDATE RESET AUTHORIZATION TOKEN ──────────────────────────────────
authRouter.post("/validate-reset-token", async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ valid: false, message: "Reset authorization token is required." });
  }

  try {
    const tokenHash = hashToken(token);
    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!resetRecord || resetRecord.usedAt || new Date() > resetRecord.expiresAt) {
      return res.status(400).json({
        valid: false,
        message: "Password recovery authorization token has expired or is invalid.",
      });
    }

    const expiresInSeconds = Math.max(0, Math.floor((resetRecord.expiresAt.getTime() - Date.now()) / 1000));

    return res.json({
      valid: true,
      message: "Token is active and authorized for credential reset.",
      expiresInSeconds,
    });
  } catch (error) {
    console.error("[Auth] Validate reset token error:", error);
    return res.status(500).json({
      valid: false,
      message: "Failed to validate reset authorization token.",
    });
  }
});

// ─── 10. RESET PASSWORD (CONSUME AUTHORIZATION TOKEN) ─────────────────────────
authRouter.post("/reset-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "Reset authorization token and new password are required." },
    });
  }

  // Enforce password policy: at least 12 characters with mixed complexity
  if (typeof password !== "string" || password.length < 12) {
    return res.status(400).json({
      error: { code: "WEAK_PASSWORD", message: "Password must be at least 12 characters in length." },
    });
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  if (!hasUpper || !hasLower || (!hasNumber && !hasSpecial)) {
    return res.status(400).json({
      error: {
        code: "WEAK_PASSWORD",
        message: "Password must contain uppercase letters, lowercase letters, and at least one number or symbol.",
      },
    });
  }

  try {
    const tokenHash = hashToken(token);
    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!resetRecord || resetRecord.usedAt || new Date() > resetRecord.expiresAt) {
      return res.status(400).json({
        error: {
          code: "INVALID_TOKEN",
          message: "Password reset authorization has expired or was already consumed. Please request a new code.",
        },
      });
    }

    const newHash = await hashPassword(password);

    // Atomically update password, consume token, and revoke active sessions
    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetRecord.userId },
        data: { passwordHash: newHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetRecord.id },
        data: { usedAt: new Date() },
      }),
      prisma.passwordResetToken.deleteMany({
        where: {
          userId: resetRecord.userId,
          id: { not: resetRecord.id },
        },
      }),
      prisma.session.updateMany({
        where: { userId: resetRecord.userId },
        data: { revokedAt: new Date() },
      }),
    ]);

    return res.json({
      success: true,
      message: "Password reset successfully. Your password has been updated. You can now sign in using your new password.",
    });
  } catch (error) {
    console.error("[Auth] Reset password error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Password reset processing failed." },
    });
  }
});

// ─── 9. GOOGLE OAUTH FLOW ────────────────────────────────────────────────────
authRouter.get("/google", (req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: { message: "Google OAuth credentials not configured." } });
  }

  if (req.query.mode === "link") {
    res.cookie("devcore_oauth_next", "/account/settings?tab=providers", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 5 * 60 * 1000,
    });
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || `${BACKEND_URL}/api/auth/google/callback`;
  const state = generateSecureToken(16);
  const scope = encodeURIComponent("openid email profile");

  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&response_type=code&scope=${scope}&state=${state}&access_type=offline&prompt=consent`;

  res.redirect(googleAuthUrl);
});

const handleGoogleCallback = async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code || typeof code !== "string") {
    return res.redirect(`${APP_URL}/auth/signin?error=oauth_failed`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (req.query.mode === "link") {
    res.cookie("devcore_oauth_next", "/account/settings?tab=providers", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 5 * 60 * 1000,
    });
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || `${BACKEND_URL}/api/auth/google/callback`;

  try {
    // Exchange code for token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId || "",
        client_secret: clientSecret || "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed with status ${tokenRes.status}`);
    }

    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile from Google
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!profileRes.ok) {
      throw new Error("Failed to fetch Google userinfo profile");
    }

    const profile: any = await profileRes.json();
    const email = profile.email?.toLowerCase();
    const name = profile.name || "Google User";
    const googleId = profile.id;
    const avatarUrl = profile.picture;

    if (!email) {
      return res.redirect(`${APP_URL}/auth/signin?error=email_not_provided`);
    }

    const cookies = parseCookies(req);
    const oauthNext = cookies["devcore_oauth_next"];
    if (oauthNext) {
      res.clearCookie("devcore_oauth_next", { path: "/" });
    }

    // If initiated in "link" mode from an active session, attach Google to current user
    const currentToken = cookies["devcore_session"];
    if (oauthNext && currentToken) {
      const currentSession = await prisma.session.findUnique({
        where: { tokenHash: hashToken(currentToken) },
        include: { user: true },
      });
      if (currentSession && !currentSession.revokedAt && new Date() <= currentSession.expiresAt) {
        const existingOwner = await prisma.account.findUnique({
          where: { provider_providerAccountId: { provider: "google", providerAccountId: googleId } },
        });
        if (existingOwner && existingOwner.userId !== currentSession.user.id) {
          return res.redirect(`${APP_URL}/account/settings?tab=providers&error=provider_in_use`);
        }
        if (!existingOwner) {
          await prisma.account.create({
            data: {
              userId: currentSession.user.id,
              provider: "google",
              providerAccountId: googleId,
              accessToken,
            },
          });
          await recordAuthEvent({
            type: "PROVIDER_CONNECTED",
            status: "SUCCESS",
            userId: currentSession.user.id,
            email: currentSession.user.email,
            ip: req.ip || null,
            userAgent: req.headers["user-agent"] || null,
            metadata: { provider: "google" },
          });
        }
        return res.redirect(`${APP_URL}/account/settings?tab=providers&linked=google`);
      }
    }

    // Role check against admin whitelist
    const adminWhitelist = getAdminWhitelist();
    const role = adminWhitelist.includes(email) ? "SUPER_ADMIN" : "USER";

    let user = await prisma.user.findUnique({
      where: { email },
      include: { accounts: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          name,
          email,
          emailVerified: true, // Google verifies email
          avatarUrl,
          role: role as any,
          accounts: {
            create: {
              provider: "google",
              providerAccountId: googleId,
              accessToken,
            },
          },
        },
        include: { accounts: true },
      });
    } else {
      // User exists: ensure emailVerified is set and link account if missing
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true, avatarUrl: user.avatarUrl || avatarUrl },
      });

      const hasGoogleAccount = user.accounts.some(
        (a) => a.provider === "google" && a.providerAccountId === googleId
      );
      if (!hasGoogleAccount) {
        await prisma.account.create({
          data: {
            userId: user.id,
            provider: "google",
            providerAccountId: googleId,
            accessToken,
          },
        });
      }
    }

    // Establish Session
    const rawSessionToken = generateSecureToken(32);
    const tokenHash = hashToken(rawSessionToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        ip: req.ip || null,
        userAgent: req.headers["user-agent"] || null,
        rememberMe: true,
        expiresAt,
      },
    });

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("devcore_session", rawSessionToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    await recordAuthEvent({
      type: "LOGIN_SUCCESS",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: req.ip || null,
      userAgent: req.headers["user-agent"] || null,
      metadata: { method: "github" },
    });

    const isAdmin = user.role === "SUPER_ADMIN" || user.role === "EDITOR";
    const dest = isAdmin ? "/admin/dashboard" : "/";
    return res.redirect(`${APP_URL}${dest}`);
  } catch (err) {
    console.error("[Google OAuth] Error:", err);
    return res.redirect(`${APP_URL}/auth/signin?error=oauth_exception`);
  }
};

authRouter.get("/google/callback", handleGoogleCallback);
authRouter.get("/callback/google", handleGoogleCallback);

// ─── 10. GITHUB OAUTH FLOW ───────────────────────────────────────────────────
authRouter.get("/github", (req: Request, res: Response) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: { message: "GitHub OAuth credentials not configured." } });
  }

  if (req.query.mode === "link") {
    res.cookie("devcore_oauth_next", "/account/settings?tab=providers", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 5 * 60 * 1000,
    });
  }

  const redirectUri =
    process.env.GITHUB_REDIRECT_URI || `${BACKEND_URL}/api/auth/github/callback`;
  const state = generateSecureToken(16);
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=user:email&state=${state}`;

  res.redirect(githubAuthUrl);
});

const handleGitHubCallback = async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code || typeof code !== "string") {
    return res.redirect(`${APP_URL}/auth/signin?error=github_failed`);
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri =
    process.env.GITHUB_REDIRECT_URI || `${BACKEND_URL}/api/auth/github/callback`;

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      throw new Error("GitHub token exchange returned no access token");
    }

    // Get user
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "DevCore-Backend",
      },
    });
    const profile: any = await userRes.json();

    // Get primary verified email
    let email = profile.email?.toLowerCase();
    if (!email) {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "DevCore-Backend",
        },
      });
      const emailsList: any = await emailsRes.json();
      if (Array.isArray(emailsList)) {
        const primary = emailsList.find((e: any) => e.primary && e.verified) || emailsList[0];
        if (primary) email = primary.email?.toLowerCase();
      }
    }

    if (!email) {
      return res.redirect(`${APP_URL}/auth/signin?error=github_no_email`);
    }

    const adminWhitelist = getAdminWhitelist();
    const role = adminWhitelist.includes(email) ? "SUPER_ADMIN" : "USER";
    const name = profile.name || profile.login || "GitHub User";
    const githubId = String(profile.id);

    let user = await prisma.user.findUnique({
      where: { email },
      include: { accounts: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          name,
          email,
          emailVerified: true,
          avatarUrl: profile.avatar_url,
          role: role as any,
          accounts: {
            create: {
              provider: "github",
              providerAccountId: githubId,
              accessToken,
            },
          },
        },
        include: { accounts: true },
      });
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
      const hasAccount = user.accounts.some(
        (a) => a.provider === "github" && a.providerAccountId === githubId
      );
      if (!hasAccount) {
        await prisma.account.create({
          data: {
            userId: user.id,
            provider: "github",
            providerAccountId: githubId,
            accessToken,
          },
        });
      }
    }

    const rawSessionToken = generateSecureToken(32);
    const tokenHash = hashToken(rawSessionToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        ip: req.ip || null,
        userAgent: req.headers["user-agent"] || null,
        rememberMe: true,
        expiresAt,
      },
    });

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("devcore_session", rawSessionToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    await recordAuthEvent({
      type: "LOGIN_SUCCESS",
      status: "SUCCESS",
      userId: user.id,
      email: user.email,
      ip: req.ip || null,
      userAgent: req.headers["user-agent"] || null,
      metadata: { method: "github" },
    });

    const isAdmin = user.role === "SUPER_ADMIN" || user.role === "EDITOR";
    const dest = isAdmin ? "/admin/dashboard" : "/";
    return res.redirect(`${APP_URL}${dest}`);
  } catch (err) {
    console.error("[GitHub OAuth] Error:", err);
    return res.redirect(`${APP_URL}/auth/signin?error=oauth_exception`);
  }
};

authRouter.get("/github/callback", handleGitHubCallback);
authRouter.get("/callback/github", handleGitHubCallback);
