import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./server/db/prisma";
import { authRouter } from "./auth/auth-routes";
import { accountRouter } from "./account/account-routes";
import {
  publicLeadsRouter,
  publicContactEventsRouter,
  adminLeadsRouter,
} from "./leads/leads-routes";
import { adminSocialRouter } from "./social/social-routes";
import { startBroadcastScheduler } from "./social/broadcast.service";
import { adminUsersRouter } from "./users/admin-users-routes";
import { adminAuditRouter } from "./audit/audit-routes";
import { adminSettingsRouter, publicSettingsRouter } from "./settings/admin-settings-routes";
import { adminMediaRouter } from "./media/admin-media-routes";
import { adminContentRouter } from "./content/admin-content-routes";
import {
  adminApplicationsRouter,
  adminJobsRouter,
  publicJobsRouter,
} from "./careers/careers-routes";
import { BRANDING_LOGOS } from "./services/media.service";

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 5000;

const allowedOrigins = Array.from(
  new Set(
    [
      process.env.NEXT_PUBLIC_APP_URL,
      "https://dev-core-solutions-frontend.vercel.app",
      "http://localhost:3000",
      ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : []),
    ]
      .filter((o): o is string => Boolean(o))
      .map((o) => o.trim().replace(/\/+$/, ""))
  )
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ""))) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

// Authentication & Account Management Routes
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);

// Lead Intake & Admin Lead Management Routes
app.use("/api/public/leads", publicLeadsRouter);
app.use("/api/public/contact-events", publicContactEventsRouter);
app.use("/api/admin/leads", adminLeadsRouter);

// Admin Social Integrations & Webhook Management Routes
app.use("/api/admin/social", adminSocialRouter);

// Admin Users & IAM, Audit Log, Platform Settings, and Media Library Routes
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/admin/audit", adminAuditRouter);
app.use("/api/admin/settings", adminSettingsRouter);
app.use("/api/public/settings", publicSettingsRouter);
app.use("/api/admin/media", adminMediaRouter);
app.use("/api/admin/content", adminContentRouter);

// Careers & Job Applications Routes
app.use("/api/public/jobs", publicJobsRouter);
app.use("/api/admin/applications", adminApplicationsRouter);
app.use("/api/admin/jobs", adminJobsRouter);

// Public Branding Logos (Cloudinary Powered)
app.get("/api/public/branding/logos", (_req, res) => {
  res.json({
    data: BRANDING_LOGOS,
  });
});

const DEFAULT_CORE_SERVICES = [
  {
    slug: "custom-web-saas-engineering",
    title: "Custom Web & SaaS Engineering",
    summary:
      "Multi-tenant distributed web platforms, offline-first client architectures, and fault-tolerant operational cockpits designed to thrive under extreme concurrent loads.",
    deliverables: [
      "Next.js/React Enterprise Architecture",
      "Deterministic SQLite/CRDT Sync",
      "Automated SOC2 Harness Tests",
      "Multi-region CDN Edge Caching",
    ],
    icon: "Layers",
    displayOrder: 1,
  },
  {
    slug: "cloud-api-architecture",
    title: "Cloud & API Architecture",
    summary:
      "High-concurrency gRPC/REST APIs, Kubernetes mesh topologies, and zero-downtime event streaming engines built for sub-millisecond execution.",
    deliverables: [
      "Asymmetric Multi-Region Mesh",
      "OpenTofu / Terraform IaC Repos",
      "Kafka Realtime Ingestion Pipeline",
      "mTLS Zero-Trust Gateway Rules",
    ],
    icon: "Boxes",
    displayOrder: 2,
  },
  {
    slug: "ai-workflow-automation",
    title: "AI & Workflow Automation",
    summary:
      "Pragmatic enterprise LLM agents, vector semantic indexing, and low-latency autonomous workflow orchestration with mathematical prompt boundaries.",
    deliverables: [
      "Deterministic Guardrail Layer",
      "pgvector & Hybrid Pipeline",
      "Multi-Agent Worker Queues",
      "Prompt Drift Observability",
    ],
    icon: "Bot",
    displayOrder: 3,
  },
  {
    slug: "ui-ux-product-design",
    title: "UI/UX Product Design",
    summary:
      "Precision design systems engineered for extreme data density, WCAG AA accessibility compliance, and direct 1:1 engineering design tokens.",
    deliverables: [
      "Multi-Tier Figma Token System",
      "High-Density Telemetry HUDs",
      "Micro-interaction Motion Spec",
      "Interactive Storybook Rig",
    ],
    icon: "Layout",
    displayOrder: 4,
  },
  {
    slug: "it-technical-consultation-audits",
    title: "IT Technical Consultation & Audits",
    summary:
      "Comprehensive architectural forensics, legacy modernization roadmaps, performance profiling, and deterministic pre-audit hardening.",
    deliverables: [
      "Kernel & DB Query Profiling",
      "Penetration Hardening Audit",
      "Monolith Strangler Blueprint",
      "24/7 Disaster Runbooks",
    ],
    icon: "Terminal",
    displayOrder: 5,
  },
];

// Public Services (PostgreSQL Powered)
app.get("/api/public/services", async (_req, res) => {
  try {
    const count = await prisma.service.count({ where: { deletedAt: null } });
    if (count === 0) {
      await prisma.service.createMany({
        data: DEFAULT_CORE_SERVICES.map((s) => ({
          ...s,
          visible: true,
          status: "PUBLISHED",
        })),
        skipDuplicates: true,
      });
    }
    const services = await prisma.service.findMany({
      where: {
        deletedAt: null,
        visible: true,
        status: "PUBLISHED",
      },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
    });
    res.json({ data: services });
  } catch (err) {
    console.error("Failed to fetch public services:", err);
    res.status(500).json({ error: { message: "Failed to load services." } });
  }
});

const CATEGORY_TO_LABEL: Record<string, string> = {
  SAAS: "SaaS",
  ENTERPRISE_WEB: "Enterprise Web",
  ECOMMERCE: "E-Commerce",
  AI_AUTOMATION: "AI Automation",
  MOBILE: "Mobile",
  OTHER: "Other",
};

function mapShowcaseRow(s: any) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    tagline: s.tagline,
    category: CATEGORY_TO_LABEL[s.category] || "SaaS",
    badge: s.featuredOnHome ? "FLAGSHIP" : s.badge || "NEW",
    launchedAt: s.launchDate ? new Date(s.launchDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    version: "3.1",
    description: s.fullDescription || s.shortDescription,
    coverImage: s.coverImageUrl || undefined,
    techStack: Array.isArray(s.techTags) ? s.techTags : [],
    liveUrl: s.liveUrl || undefined,
    caseStudySlug: s.caseStudyId || s.slug,
    isFeatured: Boolean(s.featuredOnHome),
    metrics: Array.isArray(s.galleryImages) ? s.galleryImages : undefined,
  };
}

function mapProjectRow(p: any) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.title,
    tagline: p.summary,
    category: CATEGORY_TO_LABEL[p.category] || "SaaS",
    coverImage: p.coverImageUrl || undefined,
    challenge: p.challenge || p.summary,
    solution: p.solution || p.summary,
    features: Array.isArray(p.features) ? p.features : [],
    impact: Array.isArray(p.metrics) ? p.metrics : [],
    techStack: Array.isArray(p.techTags) ? p.techTags : [],
    liveUrl: p.liveUrl || undefined,
  };
}

// Public Showcase / Launches (PostgreSQL Powered)
app.get("/api/public/showcase", async (req, res) => {
  try {
    const count = await prisma.showcaseProduct.count({ where: { deletedAt: null } });
    if (count === 0) {
      const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
      if (firstUser) {
        await prisma.showcaseProduct.create({
          data: {
            slug: "dinedesk",
            name: "DineDesk",
            tagline: "Multi-Vendor Restaurant Ordering & Table Reservation SaaS Platform",
            shortDescription:
              "Enterprise-grade, full-stack multi-vendor restaurant ordering and table reservation SaaS platform engineered from the ground up by DevCore Solutions.",
            fullDescription:
              "Enterprise-grade, full-stack multi-vendor restaurant ordering and table reservation SaaS platform engineered from the ground up by DevCore Solutions. Eliminates 20–35% third-party aggregator commissions by equipping cloud kitchens, franchise venues, and restaurant groups with direct-to-consumer digital storefronts, table reservation engines, and real-time kitchen dispatch workflows.",
            coverImageUrl: "/images/dinedesk-cover.jpg",
            coverImageId: "seed-dinedesk-cover",
            coverImageWidth: 1200,
            coverImageHeight: 675,
            coverImageAlt: "DineDesk SaaS Platform",
            galleryImages: [
              { label: "Commission Saved", value: "20–35%" },
              { label: "Dishes Cataloged", value: "400+" },
              { label: "Floor Capacity", value: "42 Tables" },
            ],
            category: "SAAS",
            techTags: [
              "React SPA",
              "Vite",
              "Tailwind CSS",
              "Node.js",
              "Express",
              "PostgreSQL (Neon Cloud)",
              "Stripe SDK",
              "Google Gemini AI",
            ],
            liveUrl: "https://dine-desk-one.vercel.app/",
            caseStudyId: "dinedesk",
            badge: "NEW",
            launchDate: new Date("2026-10-15"),
            featuredOnHome: true,
            displayOrder: 1,
            status: "PUBLISHED",
            publishedAt: new Date(),
            authorId: firstUser.id,
          },
        });
      }
    }

    const limit = Math.min(Number(req.query.limit) || 12, 50);
    const rows = await prisma.showcaseProduct.findMany({
      where: { deletedAt: null, status: "PUBLISHED" },
      orderBy: [{ displayOrder: "asc" }, { launchDate: "desc" }],
    });

    let items = rows.map(mapShowcaseRow);
    if (req.query.category && typeof req.query.category === "string") {
      const c = req.query.category.toLowerCase();
      items = items.filter((i) => i.category.toLowerCase() === c);
    }

    const total = items.length;
    res.json({ data: { items: items.slice(0, limit), total } });
  } catch (err) {
    console.error("Failed to fetch public showcase:", err);
    res.status(500).json({ error: { message: "Failed to load launches." } });
  }
});

app.get("/api/public/showcase/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const item = await prisma.showcaseProduct.findFirst({
      where: { slug, deletedAt: null, status: "PUBLISHED" },
    });
    if (!item) return res.status(404).json({ error: { message: "Launch not found" } });
    res.json({ data: mapShowcaseRow(item) });
  } catch (err) {
    console.error("Failed to fetch showcase item:", err);
    res.status(500).json({ error: { message: "Failed to load launch." } });
  }
});

// Public Portfolio Projects (PostgreSQL Powered)
app.get("/api/public/projects", async (req, res) => {
  try {
    const count = await prisma.project.count({ where: { deletedAt: null } });
    if (count === 0) {
      await prisma.project.create({
        data: {
          slug: "dinedesk",
          title: "DineDesk",
          summary: "Enterprise Multi-Vendor Restaurant Ordering & Table Reservation SaaS",
          category: "SAAS",
          techTags: [
            "React SPA",
            "Vite",
            "Tailwind CSS",
            "Node.js",
            "Express",
            "TypeScript",
            "PostgreSQL (Neon Cloud)",
            "Stripe SDK",
            "Google Gemini AI",
          ],
          coverImageUrl: "/images/dinedesk-cover.jpg",
          coverImageId: "seed-dinedesk-project",
          challenge:
            "Restaurant owners, cloud kitchens, and franchise groups were losing 20% to 35% of every digital order to predatory third-party delivery apps.",
          solution:
            "DevCore Solutions engineered DineDesk as a decoupled, full-stack hospitality ecosystem with TanStack Query, Stripe Link, double-layer RBAC, interactive 42-table floor management, and Google Gemini AI.",
          features: [
            "Searchable catalog of 400+ dishes with zero-reload TanStack Query caching",
            "Interactive Table Reservation Engine with 42-table floor management",
            "4-Stage Live Order Stepper with real-time kitchen operations console",
            "Dual payment infrastructure with Stripe SDK & Cash on Delivery",
          ],
          metrics: [
            { label: "Aggregator Fee Savings", value: "20–35%" },
            { label: "Dishes in Catalog", value: "400+" },
            { label: "Tables Under Management", value: "42" },
            { label: "Order Stepper Latency", value: "Real-Time" },
          ],
          liveUrl: "https://dine-desk-one.vercel.app/",
          featured: true,
          displayOrder: 1,
          status: "PUBLISHED",
        },
      });
    }

    const limit = Math.min(Number(req.query.limit) || 24, 50);
    const rows = await prisma.project.findMany({
      where: { deletedAt: null, status: "PUBLISHED" },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
    });

    let items = rows.map(mapProjectRow);
    if (req.query.category && typeof req.query.category === "string") {
      const c = req.query.category.toLowerCase();
      items = items.filter((p) => p.category.toLowerCase() === c);
    }

    res.json({ data: { items: items.slice(0, limit), total: items.length } });
  } catch (err) {
    console.error("Failed to fetch public projects:", err);
    res.status(500).json({ error: { message: "Failed to load projects." } });
  }
});

app.get("/api/public/projects/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const item = await prisma.project.findFirst({
      where: { slug, deletedAt: null, status: "PUBLISHED" },
    });
    if (!item) return res.status(404).json({ error: { message: "Project not found" } });
    res.json({ data: mapProjectRow(item) });
  } catch (err) {
    console.error("Failed to fetch project:", err);
    res.status(500).json({ error: { message: "Failed to load project." } });
  }
});

// Public Testimonials (PostgreSQL Powered)
app.get("/api/public/testimonials", async (_req, res) => {
  try {
    const count = await prisma.testimonial.count({ where: { deletedAt: null } });
    if (count === 0) {
      await prisma.testimonial.createMany({
        data: [
          {
            authorName: "Marcus Vance",
            role: "VP of Engineering",
            company: "Vanguard FinTech",
            quote:
              "DevCore re-architected our core ledger pipeline from 400ms latency down to 14ms under peak transactional volume. Pure engineering rigor.",
            rating: 5,
            status: "APPROVED",
            featured: true,
          },
          {
            authorName: "Elena Rostova",
            role: "CTO",
            company: "Aether Cloud Systems",
            quote:
              "Zero agency fluff. Their architects integrated seamlessly with our kernel team and delivered a fault-tolerant distributed state layer ahead of schedule.",
            rating: 5,
            status: "APPROVED",
            featured: true,
          },
          {
            authorName: "David Chen",
            role: "Founder & CEO",
            company: "Kinetix AI",
            quote:
              "They transformed our brittle prototype into an enterprise-ready AI workflow orchestrator capable of handling 10M+ daily deterministic requests.",
            rating: 5,
            status: "APPROVED",
            featured: true,
          },
        ],
      });
    }

    const rows = await prisma.testimonial.findMany({
      where: { deletedAt: null, status: "APPROVED" },
      orderBy: [{ featured: "desc" }, { createdAt: "desc" }],
    });

    res.json({
      data: rows.map((t) => ({
        id: t.id,
        quote: t.quote,
        author: t.authorName,
        role: t.role || "Engineering Leader",
        company: t.company || "",
        avatarUrl: t.avatarUrl || undefined,
        rating: t.rating || 5,
      })),
    });
  } catch (err) {
    console.error("Failed to fetch public testimonials:", err);
    res.status(500).json({ error: { message: "Failed to load testimonials." } });
  }
});

// Welcome route for http://localhost:5000

app.get("/", (_req, res) => {
  res.json({
    service: "DevCore Solutions API",
    version: "v3",
    tagline: "Building the Digital Core for a Smarter Tomorrow.",
    status: "running",
    healthCheck: "/api/health",
    timestamp: new Date().toISOString(),
  });
});

// Public uptime health check (Backend PRD v3 Section 4.4)
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "OK", database: "connected" });
  } catch (error) {
    res.status(500).json({ status: "DOWN", error: "Database connection failed" });
  }
});

// ─── ABOUT & ENGINEERING PRINCIPLES IN-MEMORY DB / API ────────────────────────
let aboutContent = {
  heroBadge: "ARCHITECTURAL DOSSIER",
  heroTitle: "Building the Digital Core for a Smarter Tomorrow",
  heroSubtitle:
    "DevCore Solutions is an elite software engineering and systems architecture firm. We reject software bloat and shallow wrappers in favor of rigorous, deterministic engineering and provable fault tolerance.",
  foundingTag: "FOUNDED 2019 • DISTRIBUTED CORE",
  visionTitle: "Our Vision",
  visionText:
    "To set the global benchmark for enterprise software reliability, where downtime is obsolete and system state is mathematically provable across high-throughput distributed boundaries.",
  missionTitle: "Our Mission",
  missionText:
    "To empower ambitious enterprises with custom-tailored, resilient digital platforms engineered with zero bloat, uncompromising type safety, and predictable execution.",
  philosophyTitle: "The Core Philosophy",
  philosophyText:
    "We eliminate organizational friction by embedding verified systems architects and senior engineers directly on the operational frontlines. Every line of code is held to strict verification standards.",
  philosophyStats: [
    { label: "Direct Senior Engineering", value: "100%" },
    { label: "Deterministic SLA Bound", value: "99.9%" },
  ],
  ctaTitle: "Let's Build Something Meaningful",
  ctaSubtitle:
    "Have an idea, a challenge, or a project in mind? Let's discuss how we can turn it into a reliable digital solution.",
  ctaPrimaryText: "Start System Scoping",
  ctaPrimaryUrl: "/contact",
  ctaSecondaryText: "View Open Guild Seats",
  ctaSecondaryUrl: "/careers",
  locationEnabled: true,
  locationName: "Chattogram Engineering Hub",
  locationAddress: "North Agrabad, Chattogram, Bangladesh",
  locationTimezone: "Asia/Dhaka",
  locationStatus: "ONLINE • UTC+6",
};

let engineeringPrinciples = [
  {
    id: "principle-1",
    orderIndex: 1,
    number: "01",
    title: "Deterministic Execution",
    description:
      "Systems must exhibit verifiable behavior under network partitions, hardware drops, and cold reboots. No unhandled states, no silent failures.",
    icon: "cpu",
    supportingLabel: "Invariant:",
    supportingText: "state_t == replay(log)",
    isPublished: true,
  },
  {
    id: "principle-2",
    orderIndex: 2,
    number: "02",
    title: "Zero-Drift Architecture",
    description:
      "State replication and schemas must align across distributed edges via CRDTs and WAL persistence with zero manual drift reconciliation.",
    icon: "layers",
    supportingLabel: "Convergence:",
    supportingText: "delta_sync.converge()",
    isPublished: true,
  },
  {
    id: "principle-3",
    orderIndex: 3,
    number: "03",
    title: "Radical Transparency",
    description:
      "Complete client visibility into git commit histories, benchmark logs, and live telemetry. Direct architect collaboration without proxy gatekeepers.",
    icon: "eye",
    supportingLabel: "Pipeline:",
    supportingText: "git log --unredacted",
    isPublished: true,
  },
  {
    id: "principle-4",
    orderIndex: 4,
    number: "04",
    title: "Defense-in-Depth Security",
    description:
      "Cryptographic verification, rigorous input validation, continuous automated audits, and mutual TLS across all microservice boundaries.",
    icon: "shield",
    supportingLabel: "Standard:",
    supportingText: "mTLS + Zero-Trust IAM",
    isPublished: true,
  },
];

let teamMembers = [
  {
    id: "team-1",
    name: "Kazi Mahedi Hasan",
    role: "Founder & Full Stack Developer",
    bio: "Co-founder leading core distributed architecture, scalable cloud systems, and modern full-stack web platforms.",
    initials: "KM",
    badge: "FOUNDER",
    githubUrl: "https://github.com/kazi-Samin",
    linkedinUrl: "https://www.linkedin.com/in/kazi-mahedi-hasan",
    isFeatured: true,
    isPublished: true,
    displayOrder: 1,
  },
  {
    id: "team-2",
    name: "Fourkan Bin Ilias",
    role: "Founder & Full Stack Developer",
    bio: "Co-founder focusing on distributed backend infrastructure, microservices reliability, and deterministic database design.",
    initials: "FI",
    badge: "FOUNDER",
    githubUrl: "https://github.com/Pinon1345",
    linkedinUrl: "https://www.linkedin.com/in/fourkan-bin-ilias/",
    isFeatured: true,
    isPublished: true,
    displayOrder: 2,
  },
  {
    id: "team-3",
    name: "Senior Systems Engineer",
    role: "Senior Systems & Cloud Architect",
    bio: "Focuses on event-driven architectures, container mesh reliability, and low-latency API performance.",
    initials: "SE",
    badge: "ENGINEERING",
    githubUrl: "https://github.com/devcoresolutions2",
    linkedinUrl: "https://www.linkedin.com/company/devcoresolutions2",
    isFeatured: false,
    isPublished: true,
    displayOrder: 3,
  },
  {
    id: "team-4",
    name: "Lead Product Designer",
    role: "UI/UX Design Specialist",
    bio: "Directs accessible design systems, user workflow ergonomics, and high-fidelity interactive digital experiences.",
    initials: "PD",
    badge: "PRODUCT",
    githubUrl: "https://github.com/devcoresolutions2",
    linkedinUrl: "https://www.linkedin.com/company/devcoresolutions2",
    isFeatured: false,
    isPublished: true,
    displayOrder: 4,
  },
  {
    id: "team-5",
    name: "Applied AI Engineer",
    role: "Applied AI & Machine Learning Specialist",
    bio: "Specializes in deterministic prompt architectures, retrieval-augmented systems, and intelligent workflow automation.",
    initials: "AI",
    badge: "AI LAB",
    githubUrl: "https://github.com/devcoresolutions2",
    linkedinUrl: "https://www.linkedin.com/company/devcoresolutions2",
    isFeatured: false,
    isPublished: true,
    displayOrder: 5,
  },
];

async function ensureAboutDefaults() {
  let about = await prisma.aboutSettings.findUnique({ where: { id: "singleton" } });
  if (!about) {
    about = await prisma.aboutSettings.create({
      data: {
        id: "singleton",
        heroBadge: aboutContent.heroBadge,
        heroTitle: aboutContent.heroTitle,
        heroSubtitle: aboutContent.heroSubtitle,
        foundingTag: aboutContent.foundingTag,
        visionTitle: aboutContent.visionTitle,
        visionText: aboutContent.visionText,
        missionTitle: aboutContent.missionTitle,
        missionText: aboutContent.missionText,
        philosophyTitle: aboutContent.philosophyTitle,
        philosophyText: aboutContent.philosophyText,
        philosophyStats: aboutContent.philosophyStats,
        ctaTitle: aboutContent.ctaTitle,
        ctaSubtitle: aboutContent.ctaSubtitle,
        ctaPrimaryText: aboutContent.ctaPrimaryText,
        ctaPrimaryUrl: aboutContent.ctaPrimaryUrl,
        ctaSecondaryText: aboutContent.ctaSecondaryText,
        ctaSecondaryUrl: aboutContent.ctaSecondaryUrl,
        locationEnabled: aboutContent.locationEnabled,
        locationName: aboutContent.locationName,
        locationAddress: aboutContent.locationAddress,
        locationTimezone: aboutContent.locationTimezone,
        locationStatus: aboutContent.locationStatus,
      },
    });
  }
  return about;
}

async function ensurePrinciplesSeeded() {
  const count = await prisma.engineeringPrinciple.count();
  if (count === 0) {
    await prisma.engineeringPrinciple.createMany({
      data: engineeringPrinciples.map((p) => ({
        orderIndex: p.orderIndex,
        number: p.number,
        title: p.title,
        description: p.description,
        icon: p.icon,
        supportingLabel: p.supportingLabel,
        supportingText: p.supportingText,
        isPublished: p.isPublished,
      })),
    });
  }
}

async function ensureTeamSeeded() {
  const count = await prisma.teamMember.count();
  if (count === 0) {
    await prisma.teamMember.createMany({
      data: [
        {
          name: "Fourkan Bin Ilias",
          role: "Junior Software Engineer & Full Stack Developer",
          bio: "Founder & CEO leading end-to-end full-stack architecture, TypeScript & Next.js product systems, PostgreSQL database design, and direct client delivery at DevCore Solutions.",
          initials: "FI",
          badge: "FOUNDER & CEO",
          avatarUrl: "/images/team/fourkan-bin-ilias.jpg",
          githubUrl: "https://github.com/Pinon1345",
          linkedinUrl: "https://www.linkedin.com/in/fourkan-bin-ilias/",
          portfolioUrl: "https://fourkan-bin-ilias-portfolio-dev.vercel.app/",
          isFeatured: true,
          isPublished: true,
          displayOrder: 1,
        },
        {
          name: "Kazi Mehedi Hasan Samin",
          role: "Junior Software Engineer & Full Stack Developer",
          bio: "Co-Founder & CEO driving scalable full-stack web platforms, React & Node.js engineering workflows, API infrastructure, and collaborative product execution across DevCore Solutions.",
          initials: "KM",
          badge: "CO-FOUNDER & CEO",
          avatarUrl: "/images/team/kazi-mehedi-hasan-samin.jpg",
          githubUrl: "https://github.com/kazi-Samin",
          linkedinUrl: "https://www.linkedin.com/in/kazi-mahedi-hasan",
          portfolioUrl: "https://kazi-mahedi-hasan-portfolio.vercel.app/",
          isFeatured: true,
          isPublished: true,
          displayOrder: 2,
        },
      ],
    });
  }
}

// Public About Content (PostgreSQL Powered)
app.get("/api/public/about", async (_req, res) => {
  try {
    const about = await ensureAboutDefaults();
    res.json({ data: about });
  } catch (err) {
    console.error("Failed to fetch about content:", err);
    res.status(500).json({ error: { message: "Failed to load about content." } });
  }
});

app.patch("/api/admin/about", async (req, res) => {
  try {
    await ensureAboutDefaults();
    const b = req.body ?? {};
    const updateData: any = {};
    const allowedFields = [
      "heroBadge",
      "heroTitle",
      "heroSubtitle",
      "foundingTag",
      "visionTitle",
      "visionText",
      "missionTitle",
      "missionText",
      "philosophyTitle",
      "philosophyText",
      "philosophyStats",
      "ctaTitle",
      "ctaSubtitle",
      "ctaPrimaryText",
      "ctaPrimaryUrl",
      "ctaSecondaryText",
      "ctaSecondaryUrl",
      "locationEnabled",
      "locationName",
      "locationAddress",
      "locationTimezone",
      "locationStatus",
    ];
    for (const key of allowedFields) {
      if (b[key] !== undefined) updateData[key] = b[key];
    }
    const updated = await prisma.aboutSettings.update({
      where: { id: "singleton" },
      data: updateData,
    });
    res.json({ data: updated, message: "About content updated successfully" });
  } catch (err) {
    console.error("Failed to update about content:", err);
    res.status(500).json({ error: { message: "Failed to update about content." } });
  }
});

// Principles (PostgreSQL Powered)
app.get("/api/public/about/principles", async (req, res) => {
  try {
    await ensurePrinciplesSeeded();
    const where: any = {};
    if (req.query.publishedOnly === "true") {
      where.isPublished = true;
    }
    const list = await prisma.engineeringPrinciple.findMany({
      where,
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    });
    res.json({ data: list });
  } catch (err) {
    console.error("Failed to fetch principles:", err);
    res.status(500).json({ error: { message: "Failed to load principles." } });
  }
});

app.post("/api/admin/about/principles", async (req, res) => {
  try {
    const count = await prisma.engineeringPrinciple.count();
    const nextOrder = count + 1;
    const created = await prisma.engineeringPrinciple.create({
      data: {
        orderIndex: nextOrder,
        number: String(req.body?.number || nextOrder).padStart(2, "0"),
        title: String(req.body?.title || "New Principle").trim(),
        description: String(req.body?.description || "").trim(),
        icon: String(req.body?.icon || "cpu").trim(),
        supportingLabel: String(req.body?.supportingLabel || "Invariant:").trim(),
        supportingText: String(req.body?.supportingText || "").trim(),
        isPublished: req.body?.isPublished !== undefined ? Boolean(req.body.isPublished) : true,
      },
    });
    res.status(201).json({ data: created, message: "Principle created" });
  } catch (err) {
    console.error("Failed to create principle:", err);
    res.status(500).json({ error: { message: "Failed to create principle." } });
  }
});

app.patch("/api/admin/about/principles/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = await prisma.engineeringPrinciple.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: { message: "Principle not found" } });
    }
    const b = req.body ?? {};
    const data: any = {};
    for (const key of [
      "orderIndex",
      "number",
      "title",
      "description",
      "icon",
      "supportingLabel",
      "supportingText",
      "isPublished",
    ]) {
      if (b[key] !== undefined) data[key] = b[key];
    }
    const updated = await prisma.engineeringPrinciple.update({ where: { id }, data });
    res.json({ data: updated, message: "Principle updated" });
  } catch (err) {
    console.error("Failed to update principle:", err);
    res.status(500).json({ error: { message: "Failed to update principle." } });
  }
});

app.delete("/api/admin/about/principles/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    await prisma.engineeringPrinciple.delete({ where: { id } });
    res.json({ message: "Principle deleted successfully" });
  } catch (err) {
    console.error("Failed to delete principle:", err);
    res.status(404).json({ error: { message: "Principle not found" } });
  }
});

app.post("/api/admin/about/principles/reorder", async (req, res) => {
  try {
    const { ids } = req.body ?? {};
    if (Array.isArray(ids)) {
      await Promise.all(
        ids.map((id: string, idx: number) =>
          prisma.engineeringPrinciple.update({
            where: { id: String(id) },
            data: { orderIndex: idx + 1, number: String(idx + 1).padStart(2, "0") },
          })
        )
      );
    }
    const list = await prisma.engineeringPrinciple.findMany({
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
    });
    res.json({ data: list, message: "Principles reordered successfully" });
  } catch (err) {
    console.error("Failed to reorder principles:", err);
    res.status(500).json({ error: { message: "Failed to reorder principles." } });
  }
});

// Team Members (PostgreSQL Powered)
app.get("/api/public/about/team", async (req, res) => {
  try {
    await ensureTeamSeeded();
    const where: any = {};
    if (req.query.publishedOnly === "true") {
      where.isPublished = true;
    }
    const list = await prisma.teamMember.findMany({
      where,
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({ data: list });
  } catch (err) {
    console.error("Failed to fetch team members:", err);
    res.status(500).json({ error: { message: "Failed to load team members." } });
  }
});

app.post("/api/admin/about/team", async (req, res) => {
  try {
    const count = await prisma.teamMember.count();
    const b = req.body ?? {};
    const name = String(b.name || "Team Member").trim();
    const initials =
      b.initials ||
      name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .slice(0, 3)
        .toUpperCase();

    const created = await prisma.teamMember.create({
      data: {
        name,
        role: String(b.role || "Software Engineer").trim(),
        bio: String(b.bio || "").trim(),
        avatarUrl: b.avatarUrl ? String(b.avatarUrl).trim() : null,
        initials,
        badge: String(b.badge || "TEAM").trim(),
        linkedinUrl: b.linkedinUrl ? String(b.linkedinUrl).trim() : "",
        githubUrl: b.githubUrl ? String(b.githubUrl).trim() : "",
        portfolioUrl: b.portfolioUrl ? String(b.portfolioUrl).trim() : "",
        isFeatured: Boolean(b.isFeatured),
        isPublished: b.isPublished !== undefined ? Boolean(b.isPublished) : true,
        displayOrder: Number.isFinite(Number(b.displayOrder)) ? Number(b.displayOrder) : count + 1,
      },
    });
    res.status(201).json({ data: created, message: "Team member added" });
  } catch (err) {
    console.error("Failed to create team member:", err);
    res.status(500).json({ error: { message: "Failed to add team member." } });
  }
});

app.patch("/api/admin/about/team/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = await prisma.teamMember.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: { message: "Team member not found" } });
    }
    const b = req.body ?? {};
    const data: any = {};
    for (const key of [
      "name",
      "role",
      "bio",
      "avatarUrl",
      "initials",
      "badge",
      "linkedinUrl",
      "githubUrl",
      "portfolioUrl",
      "isFeatured",
      "isPublished",
      "displayOrder",
    ]) {
      if (b[key] !== undefined) data[key] = b[key];
    }
    const updated = await prisma.teamMember.update({ where: { id }, data });
    res.json({ data: updated, message: "Team member updated" });
  } catch (err) {
    console.error("Failed to update team member:", err);
    res.status(500).json({ error: { message: "Failed to update team member." } });
  }
});

app.delete("/api/admin/about/team/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    await prisma.teamMember.delete({ where: { id } });
    res.json({ message: "Team member deleted successfully" });
  } catch (err) {
    console.error("Failed to delete team member:", err);
    res.status(404).json({ error: { message: "Team member not found" } });
  }
});

app.post("/api/admin/about/team/reorder", async (req, res) => {
  try {
    const { ids } = req.body ?? {};
    if (Array.isArray(ids)) {
      await Promise.all(
        ids.map((id: string, idx: number) =>
          prisma.teamMember.update({
            where: { id: String(id) },
            data: { displayOrder: idx + 1 },
          })
        )
      );
    }
    const list = await prisma.teamMember.findMany({
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    res.json({ data: list, message: "Team members reordered successfully" });
  } catch (err) {
    console.error("Failed to reorder team members:", err);
    res.status(500).json({ error: { message: "Failed to reorder team members." } });
  }
});

// ─── BLOG & TECHNICAL CMS ──────────────────────────────────────────────────
let blogHeroConfig = {
  badge: "ENGINEERING DISPATCH",
  title: "Systems, Distributed State & Determinism",
  description:
    "Deep dives into high-throughput backend infrastructure, edge replication, Linux eBPF telemetry, and deterministic systems architecture from the engineers at DevCore.",
};

let blogCategories = [
  { id: "cat-1", slug: "all", name: "All Articles", description: "Complete technical archive" },
  { id: "cat-2", slug: "distributed-systems", name: "Distributed Systems", description: "Raft, Paxos, consensus and edge replication" },
  { id: "cat-3", slug: "linux-kernel", name: "Linux & eBPF", description: "Kernel bypass, socket acceleration and system observability" },
  { id: "cat-4", slug: "ai-systems", name: "Deterministic AI", description: "Constrained decoding, structured LLM pipelines and offline inferences" },
  { id: "cat-5", slug: "database-internals", name: "Databases & WAL", description: "PostgreSQL, SQLite, storage engines and CRDT sync" },
  { id: "cat-6", slug: "systems-architecture", name: "Architecture", description: "Zero-copy patterns, memory safety and microservices" },
];

let blogAuthors = [
  {
    id: "auth-kazi",
    name: "Kazi Mahedi Hasan",
    role: "Lead Systems Architect & Co-Founder",
    bio: "Specializing in distributed transaction guarantees, edge storage replication, and high-throughput microservice architecture.",
    avatarUrl: "",
    initials: "KM",
    githubUrl: "https://github.com/kazi-Samin",
    linkedinUrl: "https://www.linkedin.com/in/kazi-mahedi-hasan",
    twitterUrl: "https://x.com",
    isActive: true,
  },
  {
    id: "auth-fourkan",
    name: "Fourkan Bin Ilias",
    role: "Principal Infrastructure Engineer & Co-Founder",
    bio: "Focusing on deterministic cloud orchestration, Linux kernel networking, and eBPF observability pipelines.",
    avatarUrl: "",
    initials: "FI",
    githubUrl: "https://github.com/Pinon1345",
    linkedinUrl: "https://www.linkedin.com/in/fourkan-bin-ilias/",
    twitterUrl: "https://x.com",
    isActive: true,
  },
  {
    id: "auth-eng",
    name: "DevCore Engineering Guild",
    role: "Core Systems Team",
    bio: "Collective architectural analysis and engineering post-mortems from DevCore's systems development team.",
    avatarUrl: "",
    initials: "DC",
    githubUrl: "https://github.com",
    isActive: true,
  },
];

let blogArticles = [
  {
    id: "post-1",
    slug: "offline-first-sqlite-wal-crdts",
    title: "Offline-First Architectures: Replicating SQLite WAL via CRDTs",
    excerpt:
      "A deep architectural dissection into building zero-drift mobile and desktop clients that continue operation across unstable edge links with deterministic conflict resolution.",
    content: `## The Fallacy of Continuous Network Connectivity

Modern software architectures frequently make a dangerous assumption: reliable, low-latency broadband availability. When edge nodes, field devices, or mobile endpoints lose connection, traditional request-response architectures fail catastrophically.

Building an **offline-first** system requires inverting the data access model. The local device must treat its local embedded store (SQLite) as the primary source of truth, replicating changes to central nodes asynchronously.

\`\`\`go
// DeltaSync engine for SQLite WAL replication via CRDTs
type VectorClock map[string]uint64

type StateDelta struct {
    NodeID    string      \`json:"node_id"\`
    Seq       uint64      \`json:"seq"\`
    Clock     VectorClock \`json:"clock"\`
    Operation byte        \`json:"op"\`
    Payload   []byte      \`json:"payload"\`
    Checksum  [32]byte    \`json:"checksum"\`
}

func (d *StateDelta) VerifyIntegrity() bool {
    h := sha256.New()
    h.Write([]byte(d.NodeID))
    binary.Write(h, binary.BigEndian, d.Seq)
    h.Write(d.Payload)
    return subtle.ConstantTimeCompare(h.Sum(nil), d.Checksum[:]) == 1
}
\`\`\`

### Why Standard WAL Mirroring Is Insufficient

Postgres streaming replication or SQLite backup APIs rely on linear log-sequence numbers (LSNs). In a multi-master or disconnected topology, two nodes can mutate state simultaneously without a shared clock.

By combining State-based Conflict-Free Replicated Data Types (CvRDTs) with custom WAL hooks, we obtain a deterministic merge function that mathematically converges to the identical state regardless of packet arrival order.

### Implementation Checklist
- Intercept local SQLite transactions via update hooks (\`sqlite3_update_hook\`).
- Transform mutation deltas into causal state payloads with vector clocks.
- Stage mutations in an encrypted local outbox table.
- Broadcast deltas during reconnect windows and execute idempotent merges.`,
    category: "distributed-systems",
    categorySlug: "distributed-systems",
    tags: ["Distributed Systems", "SQLite", "CRDT", "Go", "Architecture"],
    coverImage: "",
    status: "PUBLISHED",
    featured: true,
    featuredSnippet: {
      filename: "sync_engine.go",
      language: "go",
      code: `// DeltaSync engine with vector clocks
type StateDelta struct {
    NodeID    string      \`json:"node_id"\`
    Seq       uint64      \`json:"seq"\`
    Clock     VectorClock \`json:"clock"\`
    Operation byte        \`json:"op"\`
    Payload   []byte      \`json:"payload"\`
    Checksum  [32]byte    \`json:"checksum"\`
}`,
    },
    readingMinutes: 8,
    readCount: 1420,
    author: blogAuthors[0],
    seoTitle: "Offline-First Architectures: Replicating SQLite WAL via CRDTs | DevCore",
    seoDescription: "Deep dive into building zero-drift offline-first systems using SQLite write-ahead logging and Conflict-Free Replicated Data Types.",
    publishedAt: "2026-03-12T10:00:00.000Z",
    createdAt: "2026-03-10T08:00:00.000Z",
    updatedAt: "2026-03-12T10:00:00.000Z",
  },
  {
    id: "post-2",
    slug: "linux-ebpf-socket-acceleration",
    title: "Kernel Bypass & Socket Acceleration with Linux eBPF",
    excerpt:
      "Achieving sub-microsecond IPC and packet redirection by bypassing standard TCP/IP stack overhead using eBPF sockops and sockhash maps.",
    content: `## The Cost of the Generic Linux Network Stack

Every network packet processed through the Linux TCP/IP stack crosses multiple protection domains and data structures. For ultra-low latency workloads, this introduces measurable latency jitter and CPU cache evictions.

By using **eBPF (Extended Berkeley Packet Filter)**, specifically \`BPF_PROG_TYPE_SOCK_OPS\` and \`BPF_MAP_TYPE_SOCKHASH\`, we can redirect socket buffers directly between cooperating local containers at the socket layer.

\`\`\`c
SEC("sockops")
int bpf_sockmap_redirect(struct bpf_sock_ops *skops) {
    if (skops->family != AF_INET)
        return BPF_OK;

    switch (skops->op) {
    case BPF_SOCK_OPS_PASSIVE_ESTABLISHED_CB:
    case BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB:
        bpf_sock_hash_update(skops, &sock_map, &skops->local_port, BPF_NOEXIST);
        break;
    }
    return BPF_OK;
}
\`\`\`

### Benchmarking Throughput & Latency

In synthetic Redis and RPC benchmarks, bypassing the TCP stack delivers:
- **38% reduction in p99 latency** under saturated socket loads.
- **Zero packet drops** during kernel thread preemption events.
- Transparent operation without modifying user-space application code.`,
    category: "linux-kernel",
    categorySlug: "linux-kernel",
    tags: ["Linux", "eBPF", "Performance", "Networking", "C"],
    coverImage: "",
    status: "PUBLISHED",
    featured: false,
    readingMinutes: 6,
    readCount: 980,
    author: blogAuthors[1],
    seoTitle: "Kernel Bypass & Socket Acceleration with Linux eBPF | DevCore",
    seoDescription: "How DevCore achieves sub-microsecond IPC using eBPF sockhash socket redirection.",
    publishedAt: "2026-02-28T09:00:00.000Z",
    createdAt: "2026-02-25T11:00:00.000Z",
    updatedAt: "2026-02-28T09:00:00.000Z",
  },
  {
    id: "post-3",
    slug: "deterministic-llm-structured-decoding",
    title: "Deterministic AI: Enforcing Strict Schemas with Constrained Decoding",
    excerpt:
      "Why regex post-processing fails in mission-critical AI pipelines and how context-free grammar guidance eliminates hallucination at token generation time.",
    content: `## The Fragility of JSON Parsing in Production LLMs

Prompt engineering that demands "Return only valid JSON" is fundamentally non-deterministic. Under temperature variations and complex context windows, large language models occasionally emit trailing commas, unescaped quotes, or markdown wrappers.

A robust enterprise system cannot rely on retry loops or regex cleaners. Instead, we must constrain the logits mask at the exact moment of token prediction.

\`\`\`python
# Grammar-guided logit masking during token sampling
class ConstrainedLogitProcessor:
    def __init__(self, grammar_automaton):
        self.automaton = grammar_automaton

    def filter_allowed_tokens(self, current_state: int, vocab_tensors):
        allowed_token_ids = self.automaton.valid_next_tokens(current_state)
        mask = torch.full_like(vocab_tensors, float('-inf'))
        mask[allowed_token_ids] = 0.0
        return vocab_tensors + mask
\`\`\`

### Eliminating Failure Modes

When the token sampler is restricted by a finite state automaton (FSA) representing a formal schema, 100% of generated tokens are mathematically guaranteed to conform to your target data structure.`,
    category: "ai-systems",
    categorySlug: "ai-systems",
    tags: ["AI Systems", "LLM", "Python", "Safety", "Machine Learning"],
    coverImage: "",
    status: "PUBLISHED",
    featured: false,
    readingMinutes: 7,
    readCount: 1150,
    author: blogAuthors[0],
    seoTitle: "Deterministic AI: Enforcing Strict Schemas with Constrained Decoding | DevCore",
    seoDescription: "Learn how grammar-guided token decoding eliminates hallucination and schema invalidation in production AI systems.",
    publishedAt: "2026-02-15T14:30:00.000Z",
    createdAt: "2026-02-12T16:00:00.000Z",
    updatedAt: "2026-02-15T14:30:00.000Z",
  },
  {
    id: "post-4",
    slug: "zero-copy-cloud-microservices",
    title: "Zero-Copy Memory Semantics in Cloud Microservices",
    excerpt:
      "Eliminating serialization bottlenecks and CPU memory cache thrashing with Apache Arrow, FlatBuffers, and Linux splice system calls.",
    content: `## Memory Bandwidth Is the New CPU Bound

Modern cloud servers feature dozens of high-frequency cores, but CPU cache hierarchies and memory bus bandwidth remain the primary throughput bottlenecks for data-heavy microservices.

Conventional JSON or Protocol Buffer marshaling requires repeated memory copies: network buffer -> kernel memory -> user-space runtime -> deserialized object heap.

\`\`\`rust
// Zero-copy deserialization using FlatBuffers in Rust
pub fn process_telemetry_batch<'a>(raw_bytes: &'a [u8]) -> Result<(), DeserializationError> {
    let batch = root_as_telemetry_batch(raw_bytes)?;
    for record in batch.records() {
        process_in_place(record.device_id(), record.timestamp(), record.payload());
    }
    Ok(())
}
\`\`\`

### Architectural Impact

By adopting memory layouts that are identical in memory and on the wire, servers can saturate 40Gbps+ interfaces with single-digit CPU consumption.`,
    category: "systems-architecture",
    categorySlug: "systems-architecture",
    tags: ["Rust", "Performance", "Microservices", "Cloud", "Zero-Copy"],
    coverImage: "",
    status: "PUBLISHED",
    featured: false,
    readingMinutes: 9,
    readCount: 790,
    author: blogAuthors[1],
    seoTitle: "Zero-Copy Memory Semantics in Cloud Microservices | DevCore",
    seoDescription: "Architectural techniques for eliminating serialization overhead using zero-copy memory formats.",
    publishedAt: "2026-01-20T11:00:00.000Z",
    createdAt: "2026-01-18T12:00:00.000Z",
    updatedAt: "2026-01-20T11:00:00.000Z",
  },
];

let newsletterSubscribers = [
  {
    id: "sub-1",
    email: "systems.architect@enterprise.io",
    status: "ACTIVE",
    source: "BLOG_PAGE",
    createdAt: "2026-02-01T10:00:00.000Z",
  },
  {
    id: "sub-2",
    email: "dev.core.solution2@gmail.com",
    status: "ACTIVE",
    source: "BLOG_FEATURED",
    createdAt: "2026-02-10T12:00:00.000Z",
  },
];

// Public Hero Config
app.get("/api/public/blog/hero", (_req, res) => {
  res.json({ data: blogHeroConfig });
});

app.put("/api/admin/blog/hero", (req, res) => {
  Object.assign(blogHeroConfig, req.body);
  res.json({ data: blogHeroConfig, message: "Hero configuration updated" });
});

// Categories
app.get("/api/public/blog/categories", (_req, res) => {
  const categoriesWithCounts = blogCategories.map((cat) => ({
    ...cat,
    count: blogArticles.filter(
      (a) => a.category.toLowerCase() === cat.slug.toLowerCase() && a.status === "PUBLISHED"
    ).length,
  }));
  res.json({ data: categoriesWithCounts });
});

app.post("/api/admin/blog/categories", (req, res) => {
  const newCat = {
    id: `cat-${Date.now()}`,
    slug: req.body.slug || `category-${Date.now()}`,
    name: req.body.name || "New Category",
    description: req.body.description || "",
    count: 0,
  };
  blogCategories.push(newCat);
  res.status(201).json({ data: newCat, message: "Category created" });
});

app.put("/api/admin/blog/categories/:id", (req, res) => {
  const cat = blogCategories.find((c) => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: { message: "Category not found" } });
  Object.assign(cat, req.body);
  res.json({ data: cat, message: "Category updated" });
});

app.delete("/api/admin/blog/categories/:id", (req, res) => {
  const idx = blogCategories.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: { message: "Category not found" } });
  blogCategories.splice(idx, 1);
  res.json({ message: "Category deleted" });
});

// Authors
app.get("/api/public/blog/authors", (_req, res) => {
  res.json({ data: blogAuthors });
});

app.post("/api/admin/blog/authors", (req, res) => {
  const newAuthor = {
    id: `auth-${Date.now()}`,
    name: req.body.name || "Engineering Author",
    role: req.body.role || "Systems Engineer",
    bio: req.body.bio || "",
    avatarUrl: req.body.avatarUrl || "",
    initials:
      req.body.initials ||
      (req.body.name
        ? req.body.name
            .split(" ")
            .map((n: string) => n[0])
            .join("")
            .slice(0, 3)
            .toUpperCase()
        : "DC"),
    githubUrl: req.body.githubUrl || "",
    linkedinUrl: req.body.linkedinUrl || "",
    twitterUrl: req.body.twitterUrl || "",
    isActive: req.body.isActive !== undefined ? req.body.isActive : true,
  };
  blogAuthors.push(newAuthor);
  res.status(201).json({ data: newAuthor, message: "Author created" });
});

app.put("/api/admin/blog/authors/:id", (req, res) => {
  const a = blogAuthors.find((item) => item.id === req.params.id);
  if (!a) return res.status(404).json({ error: { message: "Author not found" } });
  Object.assign(a, req.body);
  res.json({ data: a, message: "Author updated" });
});

app.delete("/api/admin/blog/authors/:id", (req, res) => {
  const idx = blogAuthors.findIndex((item) => item.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: { message: "Author not found" } });
  blogAuthors.splice(idx, 1);
  res.json({ message: "Author deleted" });
});

// Helper: map Prisma BlogPost row to frontend BlogArticleItem shape
function mapBlogPostToArticle(p: any) {
  const readingMinutes = p.readingMinutes || 5;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle || undefined,
    excerpt: p.excerpt,
    content: p.body,
    coverImageUrl: p.coverImageUrl || undefined,
    category: p.category || "Engineering",
    categorySlug:
      p.categorySlug ||
      String(p.category || "engineering")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    authorId: p.authorId,
    authorName: p.authorName || p.author?.name || "DevCore Engineering",
    authorRole: p.authorRole || "Systems Architect",
    authorInitials: p.authorInitials || "DE",
    readingMinutes,
    readTime: `${readingMinutes} min read`,
    status: p.status,
    isFeatured: Boolean(p.isFeatured),
    publishedAt: (p.publishedAt || p.createdAt).toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    tags: Array.isArray(p.tags) ? p.tags : [],
    rfcCode: p.rfcCode || undefined,
    seoTitle: p.seoTitle || undefined,
    seoDescription: p.seoDescription || undefined,
    readCount: p.readCount || 0,
  };
}

// Articles (PostgreSQL Powered via prisma.blogPost)
app.get("/api/public/blog", async (req, res) => {
  try {
    const { category, tag, search, sort, status } = req.query;

    const where: any = { deletedAt: null };
    if (status === "DRAFT") {
      where.status = "DRAFT";
    } else if (status === "SCHEDULED") {
      where.status = "SCHEDULED";
    } else if (status !== "ALL") {
      where.status = "PUBLISHED";
    }

    const orderBy: any =
      sort === "oldest"
        ? [{ publishedAt: "asc" }, { createdAt: "asc" }]
        : sort === "readingTime"
          ? [{ readingMinutes: "asc" }]
          : [{ publishedAt: "desc" }, { createdAt: "desc" }];

    const rows = await prisma.blogPost.findMany({
      where,
      include: { author: { select: { name: true } } },
      orderBy,
    });

    let list = rows.map(mapBlogPostToArticle);

    if (category && typeof category === "string" && category !== "all") {
      const c = category.toLowerCase();
      list = list.filter(
        (a) =>
          a.category.toLowerCase() === c ||
          a.categorySlug.toLowerCase() === c
      );
    }

    if (tag && typeof tag === "string") {
      const t = tag.toLowerCase();
      list = list.filter((a) => a.tags.some((item: string) => item.toLowerCase() === t));
    }

    if (search && typeof search === "string" && search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.excerpt.toLowerCase().includes(q) ||
          a.content.toLowerCase().includes(q) ||
          a.authorName.toLowerCase().includes(q)
      );
    }

    res.json({ data: list });
  } catch (err) {
    console.error("Failed to fetch blog articles:", err);
    res.status(500).json({ error: { message: "Failed to load blog articles." } });
  }
});

app.get("/api/public/blog/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const post = await prisma.blogPost.findFirst({
      where: { slug, deletedAt: null },
      include: { author: { select: { name: true } } },
    });
    if (!post) {
      return res.status(404).json({ error: { message: "Article not found" } });
    }
    const updated = await prisma.blogPost.update({
      where: { id: post.id },
      data: { readCount: { increment: 1 } },
      include: { author: { select: { name: true } } },
    });
    res.json({ data: mapBlogPostToArticle(updated) });
  } catch (err) {
    console.error("Failed to fetch blog article:", err);
    res.status(500).json({ error: { message: "Failed to load article." } });
  }
});

app.post("/api/admin/blog/articles", async (req, res) => {
  try {
    const {
      slug,
      title,
      subtitle,
      excerpt,
      content,
      body,
      coverImageUrl,
      category,
      categorySlug,
      authorId,
      authorName,
      authorRole,
      authorInitials,
      readingMinutes,
      status,
      isFeatured,
      publishedAt,
      tags,
      rfcCode,
      seoTitle,
      seoDescription,
    } = req.body ?? {};

    if (!title || !(content || body)) {
      return res.status(400).json({
        error: { message: "Article title and content are required." },
      });
    }

    // Resolve a valid User.id for the Prisma BlogPost.author relation
    let resolvedAuthorId: string | undefined;
    if (typeof authorId === "string" && authorId.trim()) {
      const userMatch = await prisma.user.findUnique({ where: { id: authorId.trim() } });
      if (userMatch) resolvedAuthorId = userMatch.id;
    }
    if (!resolvedAuthorId) {
      const fallbackUser = await prisma.user.findFirst({
        orderBy: { createdAt: "asc" },
      });
      if (!fallbackUser) {
        return res.status(400).json({
          error: { message: "No user account exists in database to associate as author." },
        });
      }
      resolvedAuthorId = fallbackUser.id;
    }

    const baseSlug = String(slug || title)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const existingSlug = baseSlug
      ? await prisma.blogPost.findUnique({ where: { slug: baseSlug } })
      : null;
    const finalSlug = existingSlug
      ? `${baseSlug}-${Date.now().toString(36)}`
      : baseSlug || `post-${Date.now().toString(36)}`;

    const normalizedStatus =
      status === "PUBLISHED" || status === "SCHEDULED" ? status : "DRAFT";

    const created = await prisma.blogPost.create({
      data: {
        slug: finalSlug,
        title: String(title).trim(),
        subtitle: subtitle ? String(subtitle).trim() : null,
        excerpt: String(excerpt || "").trim(),
        body: String(content || body),
        coverImageUrl: coverImageUrl ? String(coverImageUrl).trim() : null,
        category: String(category || "Engineering").trim(),
        categorySlug:
          categorySlug ||
          String(category || "engineering")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-"),
        tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
        seoTitle: seoTitle ? String(seoTitle).trim() : null,
        seoDescription: seoDescription ? String(seoDescription).trim() : null,
        readingMinutes: Number.isFinite(Number(readingMinutes)) ? Number(readingMinutes) : 5,
        status: normalizedStatus,
        isFeatured: Boolean(isFeatured),
        rfcCode: rfcCode ? String(rfcCode).trim() : null,
        publishedAt:
          normalizedStatus === "PUBLISHED"
            ? publishedAt
              ? new Date(publishedAt)
              : new Date()
            : null,
        authorId: resolvedAuthorId,
        authorName: String(authorName || "DevCore Engineering").trim(),
        authorRole: String(authorRole || "Systems Architect").trim(),
        authorInitials: String(authorInitials || "DE").trim(),
      },
      include: { author: { select: { name: true } } },
    });

    res.status(201).json({
      data: mapBlogPostToArticle(created),
      message: "Article created successfully",
    });
  } catch (err) {
    console.error("Failed to create blog article:", err);
    res.status(500).json({ error: { message: "Failed to create article." } });
  }
});

app.put("/api/admin/blog/articles/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = await prisma.blogPost.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: { message: "Article not found" } });
    }

    const b = req.body ?? {};
    const nextStatus =
      b.status === "PUBLISHED" || b.status === "DRAFT" || b.status === "SCHEDULED"
        ? b.status
        : existing.status;

    const data: any = {
      status: nextStatus,
    };
    if (b.title !== undefined) data.title = String(b.title).trim();
    if (b.slug !== undefined) data.slug = String(b.slug).trim();
    if (b.subtitle !== undefined) data.subtitle = b.subtitle ? String(b.subtitle).trim() : null;
    if (b.excerpt !== undefined) data.excerpt = String(b.excerpt).trim();
    if (b.content !== undefined || b.body !== undefined) {
      data.body = String(b.content ?? b.body);
    }
    if (b.coverImageUrl !== undefined) {
      data.coverImageUrl = b.coverImageUrl ? String(b.coverImageUrl).trim() : null;
    }
    if (b.category !== undefined) {
      data.category = String(b.category).trim();
      data.categorySlug =
        b.categorySlug ||
        String(b.category)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-");
    }
    if (b.authorName !== undefined) data.authorName = String(b.authorName).trim();
    if (b.authorRole !== undefined) data.authorRole = String(b.authorRole).trim();
    if (b.authorInitials !== undefined) data.authorInitials = String(b.authorInitials).trim();
    if (b.readingMinutes !== undefined) data.readingMinutes = Number(b.readingMinutes) || 5;
    if (b.isFeatured !== undefined) data.isFeatured = Boolean(b.isFeatured);
    if (b.tags !== undefined && Array.isArray(b.tags)) {
      data.tags = b.tags.map((t: unknown) => String(t).trim()).filter(Boolean);
    }
    if (b.rfcCode !== undefined) data.rfcCode = b.rfcCode ? String(b.rfcCode).trim() : null;
    if (b.seoTitle !== undefined) data.seoTitle = b.seoTitle ? String(b.seoTitle).trim() : null;
    if (b.seoDescription !== undefined) {
      data.seoDescription = b.seoDescription ? String(b.seoDescription).trim() : null;
    }
    if (nextStatus === "PUBLISHED" && !existing.publishedAt) {
      data.publishedAt = new Date();
    } else if (nextStatus === "DRAFT") {
      data.publishedAt = null;
    }

    const updated = await prisma.blogPost.update({
      where: { id },
      data,
      include: { author: { select: { name: true } } },
    });

    res.json({
      data: mapBlogPostToArticle(updated),
      message: "Article updated successfully",
    });
  } catch (err) {
    console.error("Failed to update blog article:", err);
    res.status(500).json({ error: { message: "Failed to update article." } });
  }
});

app.delete("/api/admin/blog/articles/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const existing = await prisma.blogPost.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: { message: "Article not found" } });
    }
    await prisma.blogPost.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    res.json({ message: "Article deleted successfully" });
  } catch (err) {
    console.error("Failed to delete blog article:", err);
    res.status(500).json({ error: { message: "Failed to delete article." } });
  }
});

// Newsletter
app.post("/api/public/newsletter/subscribe", (req, res) => {
  const { email, source } = req.body;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: { message: "A valid email address is required" } });
  }
  const normalized = email.trim().toLowerCase();
  const existing = newsletterSubscribers.find((s) => s.email.toLowerCase() === normalized);
  if (existing) {
    if (existing.status === "ACTIVE") {
      return res.json({
        data: { success: true, message: "You are already subscribed to the technical dispatch.", subscriber: existing },
      });
    } else {
      existing.status = "ACTIVE";
      return res.json({
        data: { success: true, message: "Welcome back! Your subscription has been reactivated.", subscriber: existing },
      });
    }
  }

  const newSub = {
    id: `sub-${Date.now()}`,
    email: normalized,
    status: "ACTIVE",
    source: source || "BLOG_PAGE",
    createdAt: new Date().toISOString(),
  };
  newsletterSubscribers.unshift(newSub);
  res.status(201).json({
    data: {
      success: true,
      message: "Thank you for subscribing to DevCore Technical Engineering Dispatches.",
      subscriber: newSub,
    },
  });
});

app.post("/api/public/newsletter/unsubscribe", (req, res) => {
  const { email } = req.body;
  if (email && typeof email === "string") {
    const sub = newsletterSubscribers.find((s) => s.email.toLowerCase() === email.trim().toLowerCase());
    if (sub) sub.status = "UNSUBSCRIBED";
  }
  res.json({ data: { success: true, message: "You have been unsubscribed from the dispatch." } });
});

app.get("/api/admin/newsletter/subscribers", (_req, res) => {
  res.json({ data: newsletterSubscribers });
});

app.put("/api/admin/newsletter/subscribers/:id", (req, res) => {
  const sub = newsletterSubscribers.find((s) => s.id === req.params.id);
  if (!sub) return res.status(404).json({ error: { message: "Subscriber not found" } });
  if (req.body.status) sub.status = req.body.status;
  res.json({ data: sub, message: "Subscriber status updated" });
});

app.delete("/api/admin/newsletter/subscribers/:id", (req, res) => {
  const idx = newsletterSubscribers.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: { message: "Subscriber not found" } });
  newsletterSubscribers.splice(idx, 1);
  res.json({ message: "Subscriber deleted successfully" });
});

app.get("/api/admin/blog/stats", async (_req, res) => {
  try {
    const [totalArticles, publishedArticles, draftArticles, readsAgg] = await Promise.all([
      prisma.blogPost.count({ where: { deletedAt: null } }),
      prisma.blogPost.count({ where: { deletedAt: null, status: "PUBLISHED" } }),
      prisma.blogPost.count({ where: { deletedAt: null, status: "DRAFT" } }),
      prisma.blogPost.aggregate({
        where: { deletedAt: null },
        _sum: { readCount: true },
      }),
    ]);

    res.json({
      data: {
        totalArticles,
        publishedArticles,
        draftArticles,
        totalCategories: blogCategories.length,
        totalSubscribers: newsletterSubscribers.filter((s) => s.status === "ACTIVE").length,
        totalReads: readsAgg._sum.readCount || 0,
      },
    });
  } catch (err) {
    console.error("Failed to fetch blog stats:", err);
    res.status(500).json({ error: { message: "Failed to load blog stats." } });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`DevCore Backend running on http://localhost:${PORT}`);
    startBroadcastScheduler();
  });
}

export { app };
export default app;