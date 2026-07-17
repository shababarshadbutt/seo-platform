/**
 * Clears all test data: execution logs, backlinks, and settings.
 * Keeps all user accounts intact.
 * Run: npx tsx --env-file=.env.local scripts/seed/clear-data.ts
 */
import { connectDB, ExecutionLog, Backlink, Settings, User } from "@/lib/mongodb";

async function main() {
  await connectDB();

  const [logs, backlinks, settings, users] = await Promise.all([
    ExecutionLog.deleteMany({}),
    Backlink.deleteMany({}),
    Settings.deleteMany({}),
    User.deleteMany({}),
  ]);

  console.log(`✓ Execution logs deleted: ${logs.deletedCount}`);
  console.log(`✓ Backlinks deleted:      ${backlinks.deletedCount}`);
  console.log(`✓ Settings deleted:       ${settings.deletedCount}`);
  console.log(`✓ Users deleted:          ${users.deletedCount}`);
  console.log("\nDone. Database is clean.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
