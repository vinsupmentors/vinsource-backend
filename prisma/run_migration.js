/**
 * run_migration.js — run with: node prisma/run_migration.js
 * Adds WFH columns to Attendance and creates PasswordLog table.
 * Safe to re-run: skips columns/tables that already exist.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run(label, sql) {
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log(`✓ ${label}`);
  } catch (e) {
    if (e.message && (e.message.includes('Duplicate column') || e.message.includes('already exists'))) {
      console.log(`– ${label} (already exists, skipped)`);
    } else {
      console.error(`✗ ${label}: ${e.message}`);
    }
  }
}

async function main() {
  console.log('Running migration...\n');

  await run('ADD checkInIp',       `ALTER TABLE \`Attendance\` ADD COLUMN \`checkInIp\` VARCHAR(45) NULL`);
  await run('ADD checkOutIp',      `ALTER TABLE \`Attendance\` ADD COLUMN \`checkOutIp\` VARCHAR(45) NULL`);
  await run('ADD locationType',    `ALTER TABLE \`Attendance\` ADD COLUMN \`locationType\` VARCHAR(20) NOT NULL DEFAULT 'OFFICE'`);
  await run('ADD wfhStatus',       `ALTER TABLE \`Attendance\` ADD COLUMN \`wfhStatus\` VARCHAR(20) NULL`);
  await run('ADD wfhNote',         `ALTER TABLE \`Attendance\` ADD COLUMN \`wfhNote\` TEXT NULL`);
  await run('ADD wfhApprovedById', `ALTER TABLE \`Attendance\` ADD COLUMN \`wfhApprovedById\` VARCHAR(36) NULL`);
  await run('ADD wfhApprovedAt',   `ALTER TABLE \`Attendance\` ADD COLUMN \`wfhApprovedAt\` DATETIME(3) NULL`);

  await run('CREATE PasswordLog', `
    CREATE TABLE IF NOT EXISTS \`PasswordLog\` (
      \`id\`        VARCHAR(36)  NOT NULL,
      \`userId\`    VARCHAR(36)  NOT NULL,
      \`plainText\` TEXT         NOT NULL,
      \`setBy\`     VARCHAR(36)  NULL,
      \`reason\`    VARCHAR(50)  NULL,
      \`createdAt\` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      KEY \`PasswordLog_userId_fkey\` (\`userId\`),
      CONSTRAINT \`PasswordLog_userId_fkey\`
        FOREIGN KEY (\`userId\`) REFERENCES \`User\` (\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('\nMigration complete!');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
