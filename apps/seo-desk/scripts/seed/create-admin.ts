/**
 * One-time seed script to create the first admin user.
 * Run with: npx tsx scripts/seed/create-admin.ts
 *
 * Set MONGODB_URI in .env.local before running.
 */
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB, User } from "../../lib/mongodb";

async function main() {
  await connectDB();

  const existing = await User.findOne({ role: "super-admin" });
  if (existing) {
    console.log("Super admin already exists:", existing.email);
    process.exit(0);
  }

  const password = await bcrypt.hash("husnain@12345", 12);

  const admin = await User.create({
    name: "Ali Husnain",
    email: "ali.husnain@corp.tkxel.com",
    password,
    role: "super-admin",
    isActive: true,
  });

  console.log("Super admin created:");
  console.log("  Email:", admin.email);
  console.log("  Password: husnain@12345");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
