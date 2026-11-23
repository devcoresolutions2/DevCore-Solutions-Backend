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
import { sendVerificationEmail, sendPasswordResetEmail } from "../emails/mailer";

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

  const { name, email, password, termsAccepted } = req.body;

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
      return res.status(409).json({
        error: {
          code: "EMAIL_EXISTS",
          message: "An account with this work email already exists.",
        },
      });
    }

    // Role assignment: Only emails in ADMIN_WHITELIST_EMAILS get SUPER_ADMIN, otherwise USER
    const adminWhitelist = getAdminWhitelist();
    const role = adminWhitelist.includes(normalizedEmail) ? "SUPER_ADMIN" : "USER";

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        role: role as any,
        emailVerified: false,
      },
    });

    // Create verification token & OTP
    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const otp = generateOtp();
    const otpHash = hashToken(otp);

    await prisma.verificationToken.create({
      data: {
        email: normalizedEmail,
        otpHash: `${tokenHash}:${otpHash}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 mins
      },
    });

    // Send verification email
    await sendVerificationEmail(normalizedEmail, user.name, rawToken, otp);

    return res.status(201).json({
      success: true,
      message: "Account created successfully. A verification code has been dispatched to your email.",
      email: normalizedEmail,
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

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
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
        email: session.user.email,
        role: session.user.role,
        emailVerified: session.user.emailVerified,
        avatarUrl: session.user.avatarUrl,
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
    let matchedTokenRecord = null;

    if (token) {
      const hashed = hashToken(token);
      const records = await prisma.verificationToken.findMany({
        where: { expiresAt: { gt: new Date() } },
      });
      matchedTokenRecord = records.find((r) => r.otpHash.startsWith(hashed));
    } else if (otp && email) {
      const hashedOtp = hashToken(otp.trim());
      const records = await prisma.verificationToken.findMany({
        where: { email: email.trim().toLowerCase(), expiresAt: { gt: new Date() } },
      });
      matchedTokenRecord = records.find((r) => r.otpHash.endsWith(hashedOtp));
    }

    if (!matchedTokenRecord) {
      return res.status(400).json({
        error: { code: "INVALID_TOKEN", message: "Verification token is invalid or has expired." },
      });
    }

    await prisma.user.update({
      where: { email: matchedTokenRecord.email },
      data: { emailVerified: true },
    });

    await prisma.verificationToken.delete({
      where: { id: matchedTokenRecord.id },
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Email verified successfully! You may now sign in.",
    });
  } catch (error) {
    console.error("[Auth:VerifyEmail] Error:", error);
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Verification processing failed." },
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
  const rate = await checkRateLimit(rateKey, 3, 600); // 3 resends / 10 mins

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
      return res.json({ success: true, message: "If the account exists, a code was dispatched." });
    }

    if (user.emailVerified) {
      return res.json({ success: true, message: "This email is already verified. Please sign in." });
    }

    const rawToken = generateSecureToken(32);
    const tokenHash = hashToken(rawToken);
    const otp = generateOtp();
    const otpHash = hashToken(otp);

    await prisma.verificationToken.deleteMany({ where: { email: normalized } });
    await prisma.verificationToken.create({
      data: {
        email: normalized,
        otpHash: `${tokenHash}:${otpHash}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    await sendVerificationEmail(normalized, user.name, rawToken, otp);

    return res.json({
      success: true,
      message: "A fresh verification link and security code have been sent.",
    });
  } catch (error) {
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Failed to dispatch verification email." },
    });
  }
});

// ─── 7. FORGOT PASSWORD ──────────────────────────────────────────────────────
authRouter.post("/forgot-password", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({
      error: { code: "INVALID_EMAIL", message: "A valid email address is required." },
    });
  }

  const normalized = email.trim().toLowerCase();
  const rateKey = `forgot:${normalized}`;
  const rate = await checkRateLimit(rateKey, 4, 900); // 4 requests per 15 mins

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
    if (user) {
      const rawToken = generateSecureToken(32);
      const tokenHash = hashToken(rawToken);

      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });

      await sendPasswordResetEmail(normalized, user.name, rawToken);
    }

    // Always generic response to prevent account enumeration
    return res.json({
      success: true,
      message: "If an account matches this email, a password recovery dispatch has been transmitted.",
    });
  } catch (error) {
    return res.status(500).json({
      error: { code: "SERVER_ERROR", message: "Password recovery service failed." },
    });
  }
});

// ─── 8. RESET PASSWORD ───────────────────────────────────────────────────────
authRouter.post("/reset-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({
      error: { code: "MISSING_FIELDS", message: "Token and new password are required." },
    });
  }

  if (typeof password !== "string" || password.length < 10) {
    return res.status(400).json({
      error: { code: "WEAK_PASSWORD", message: "Password must be at least 10 characters." },
    });
  }

  try {
    const tokenHash = hashToken(token);
    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (!resetRecord || resetRecord.usedAt || new Date() > resetRecord.expiresAt) {
      return res.status(400).json({
        error: { code: "INVALID_TOKEN", message: "Password reset authorization has expired or was already utilized." },
      });
    }

    const newHash = await hashPassword(password);

    await prisma.user.update({
      where: { id: resetRecord.userId },
      data: { passwordHash: newHash },
    });

    await prisma.passwordResetToken.update({
      where: { id: resetRecord.id },
      data: { usedAt: new Date() },
    });

    // Invalidate all active sessions for security
    await prisma.session.updateMany({
      where: { userId: resetRecord.userId },
      data: { revokedAt: new Date() },
    });

    return res.json({
      success: true,
      message: "Password updated successfully. You may now sign in with your new credentials.",
    });
  } catch (error) {
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

  const redirectUri = `${BACKEND_URL}/api/auth/github/callback`;
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
