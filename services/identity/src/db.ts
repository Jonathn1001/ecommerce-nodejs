import { config } from "dotenv";
import path from "path";
import { PrismaClient } from "./generated/prisma";

config({ path: path.resolve(__dirname, "../.env") });

export const prisma = new PrismaClient();
