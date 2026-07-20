import { config } from "dotenv";
import path from "path";
import { PrismaClient } from "@prisma/client";

// Load THIS service's .env whether started from repo root (vitest) or the
// service dir (tsx). Runs before `new PrismaClient()` reads DATABASE_URL.
config({ path: path.resolve(__dirname, "../.env") });

export const prisma = new PrismaClient();
