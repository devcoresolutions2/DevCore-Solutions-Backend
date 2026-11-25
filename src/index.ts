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
import { BRANDING_LOGOS } from "./services/media.service";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
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

// Public Branding Logos (Cloudinary Powered)
app.get("/api/public/branding/logos", (_req, res) => {
  res.json({
    data: BRANDING_LOGOS,
  });
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

// Articles
app.get("/api/public/blog", (req, res) => {
  let list = [...blogArticles];
  const { category, tag, search, sort, status } = req.query;

  if (status === "DRAFT") {
    list = list.filter((a) => a.status === "DRAFT");
  } else if (status !== "ALL") {
    list = list.filter((a) => a.status === "PUBLISHED");
  }

  if (category && typeof category === "string" && category !== "all") {
    const c = category.toLowerCase();
    list = list.filter((a) => a.category.toLowerCase() === c || a.categorySlug?.toLowerCase() === c);
  }

  if (tag && typeof tag === "string") {
    const t = tag.toLowerCase();
    list = list.filter((a) => a.tags.some((item) => item.toLowerCase() === t));
  }

  if (search && typeof search === "string" && search.trim()) {
    const q = search.toLowerCase().trim();
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.excerpt.toLowerCase().includes(q) ||
        a.content.toLowerCase().includes(q) ||
        (a.author?.name ? a.author.name.toLowerCase().includes(q) : false)
    );
  }

  if (sort === "oldest") {
    list.sort((a, b) => new Date(a.publishedAt || a.createdAt).getTime() - new Date(b.publishedAt || b.createdAt).getTime());
  } else if (sort === "readingTime") {
    list.sort((a, b) => a.readingMinutes - b.readingMinutes);
  } else {
    list.sort((a, b) => new Date(b.publishedAt || b.createdAt).getTime() - new Date(a.publishedAt || a.createdAt).getTime());
  }

  res.json({ data: list });
});

app.get("/api/public/blog/:slug", (req, res) => {
  const article = blogArticles.find((a) => a.slug === req.params.slug);
  if (!article) return res.status(404).json({ error: { message: "Article not found" } });
  // Increment view
  article.readCount = (article.readCount || 0) + 1;
  res.json({ data: article });
});

app.post("/api/admin/blog/articles", (req, res) => {
  const now = new Date().toISOString();
  const newArticle = {
    ...req.body,
    id: `post-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    publishedAt: req.body.status === "PUBLISHED" ? now : undefined,
    readCount: 0,
  };
  blogArticles.unshift(newArticle);
  res.status(201).json({ data: newArticle, message: "Article created successfully" });
});

app.put("/api/admin/blog/articles/:id", (req, res) => {
  const idx = blogArticles.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: { message: "Article not found" } });
  const existing = blogArticles[idx]!;
  const updated = {
    ...existing,
    ...req.body,
    updatedAt: new Date().toISOString(),
    publishedAt:
      req.body.status === "PUBLISHED" && !existing.publishedAt
        ? new Date().toISOString()
        : req.body.status === "DRAFT"
        ? undefined
        : req.body.publishedAt || existing.publishedAt,
  };
  blogArticles[idx] = updated;
  res.json({ data: updated, message: "Article updated successfully" });
});

app.delete("/api/admin/blog/articles/:id", (req, res) => {
  const idx = blogArticles.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: { message: "Article not found" } });
  blogArticles.splice(idx, 1);
  res.json({ message: "Article deleted successfully" });
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

app.get("/api/admin/blog/stats", (_req, res) => {
  res.json({
    data: {
      totalArticles: blogArticles.length,
      publishedArticles: blogArticles.filter((a) => a.status === "PUBLISHED").length,
      draftArticles: blogArticles.filter((a) => a.status === "DRAFT").length,
      totalCategories: blogCategories.length,
      totalSubscribers: newsletterSubscribers.filter((s) => s.status === "ACTIVE").length,
      totalReads: blogArticles.reduce((sum, a) => sum + (a.readCount || 0), 0),
    },
  });
});

app.listen(PORT, () => {
  console.log(`DevCore Backend running on http://localhost:${PORT}`);
  startBroadcastScheduler();
});