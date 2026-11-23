import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./server/db/prisma";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

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
    githubUrl: "https://github.com/kazisamin0173-byte",
    linkedinUrl: "https://www.linkedin.com/company/devcoresolutions2",
    isFeatured: true,
    isPublished: true,
    displayOrder: 1,
  },
  {
    id: "team-2",
    name: "The Fourkan Bin Ilias",
    role: "Founder & Full Stack Developer",
    bio: "Co-founder focusing on distributed backend infrastructure, microservices reliability, and deterministic database design.",
    initials: "TF",
    badge: "FOUNDER",
    githubUrl: "https://github.com/devcoresolutions2",
    linkedinUrl: "https://www.linkedin.com/company/devcoresolutions2",
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

// Public About Content
app.get("/api/public/about", (_req, res) => {
  res.json({ data: aboutContent });
});

app.patch("/api/admin/about", (req, res) => {
  aboutContent = { ...aboutContent, ...req.body };
  res.json({ data: aboutContent, message: "About content updated successfully" });
});

// Principles
app.get("/api/public/about/principles", (req, res) => {
  let list = [...engineeringPrinciples];
  if (req.query.publishedOnly === "true") {
    list = list.filter((p) => p.isPublished);
  }
  list.sort((a, b) => a.orderIndex - b.orderIndex);
  res.json({ data: list });
});

app.post("/api/admin/about/principles", (req, res) => {
  const newPrinciple = {
    id: `principle-${Date.now()}`,
    orderIndex: engineeringPrinciples.length + 1,
    number: String(engineeringPrinciples.length + 1).padStart(2, "0"),
    title: req.body.title || "New Principle",
    description: req.body.description || "",
    icon: req.body.icon || "cpu",
    supportingLabel: req.body.supportingLabel || "Invariant:",
    supportingText: req.body.supportingText || "",
    isPublished: req.body.isPublished !== undefined ? req.body.isPublished : true,
  };
  engineeringPrinciples.push(newPrinciple);
  res.status(201).json({ data: newPrinciple, message: "Principle created" });
});

app.patch("/api/admin/about/principles/:id", (req, res) => {
  const p = engineeringPrinciples.find((item) => item.id === req.params.id);
  if (!p) {
    return res.status(404).json({ error: { message: "Principle not found" } });
  }
  Object.assign(p, req.body);
  res.json({ data: p, message: "Principle updated" });
});

app.delete("/api/admin/about/principles/:id", (req, res) => {
  const index = engineeringPrinciples.findIndex((item) => item.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: { message: "Principle not found" } });
  }
  engineeringPrinciples.splice(index, 1);
  res.json({ message: "Principle deleted successfully" });
});

app.post("/api/admin/about/principles/reorder", (req, res) => {
  const { ids } = req.body;
  if (Array.isArray(ids)) {
    ids.forEach((id, idx) => {
      const p = engineeringPrinciples.find((item) => item.id === id);
      if (p) p.orderIndex = idx + 1;
    });
    engineeringPrinciples.sort((a, b) => a.orderIndex - b.orderIndex);
  }
  res.json({ data: engineeringPrinciples, message: "Principles reordered successfully" });
});

// Team Members
app.get("/api/public/about/team", (req, res) => {
  let list = [...teamMembers];
  if (req.query.publishedOnly === "true") {
    list = list.filter((m) => m.isPublished);
  }
  list.sort((a, b) => a.displayOrder - b.displayOrder);
  res.json({ data: list });
});

app.post("/api/admin/about/team", (req, res) => {
  const newMember = {
    id: `team-${Date.now()}`,
    name: req.body.name || "Team Member",
    role: req.body.role || "Software Engineer",
    bio: req.body.bio || "",
    avatarUrl: req.body.avatarUrl || undefined,
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
    badge: req.body.badge || "TEAM",
    linkedinUrl: req.body.linkedinUrl || "",
    githubUrl: req.body.githubUrl || "",
    portfolioUrl: req.body.portfolioUrl || "",
    isFeatured: !!req.body.isFeatured,
    isPublished: req.body.isPublished !== undefined ? req.body.isPublished : true,
    displayOrder: req.body.displayOrder || teamMembers.length + 1,
  };
  teamMembers.push(newMember);
  res.status(201).json({ data: newMember, message: "Team member added" });
});

app.patch("/api/admin/about/team/:id", (req, res) => {
  const m = teamMembers.find((item) => item.id === req.params.id);
  if (!m) {
    return res.status(404).json({ error: { message: "Team member not found" } });
  }
  Object.assign(m, req.body);
  res.json({ data: m, message: "Team member updated" });
});

app.delete("/api/admin/about/team/:id", (req, res) => {
  const index = teamMembers.findIndex((item) => item.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: { message: "Team member not found" } });
  }
  teamMembers.splice(index, 1);
  res.json({ message: "Team member deleted successfully" });
});

app.post("/api/admin/about/team/reorder", (req, res) => {
  const { ids } = req.body;
  if (Array.isArray(ids)) {
    ids.forEach((id, idx) => {
      const m = teamMembers.find((item) => item.id === id);
      if (m) m.displayOrder = idx + 1;
    });
    teamMembers.sort((a, b) => a.displayOrder - b.displayOrder);
  }
  res.json({ data: teamMembers, message: "Team members reordered successfully" });
});

app.listen(PORT, () => {
  console.log(`DevCore Backend running on http://localhost:${PORT}`);
});