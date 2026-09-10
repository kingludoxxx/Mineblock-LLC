import { seedRoles, pool as rolesPool } from './seed_roles.js';
import { seedSuperAdmin, assertSuperAdminEnv, pool as adminPool } from './seed_superadmin.js';

async function run() {
  try {
    // Preflight before the first write: a missing per-store credential must not
    // leave a half-seeded database behind (R4 credentials never cross stores).
    assertSuperAdminEnv();

    console.log('Starting seed process...\n');

    console.log('--- Seeding Roles ---');
    await seedRoles();
    console.log('');

    console.log('--- Seeding SuperAdmin ---');
    await seedSuperAdmin();
    console.log('');

    console.log('All seeds completed successfully.');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await rolesPool.end();
    await adminPool.end();
  }
}

run();
