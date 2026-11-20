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

app.listen(PORT, () => {
  console.log(`DevCore Backend running on http://localhost:${PORT}`);
});