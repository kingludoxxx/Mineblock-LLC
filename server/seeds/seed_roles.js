import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const roles = [
  {
    name: 'SuperAdmin',
    description: 'Full system access with all permissions',
    permissions: { '*': ['*'] },
    is_system: true,
  },
  {
    name: 'Admin',
    description: 'Administrative access to users, departments, audit, and settings',
    permissions: {
      users: ['read', 'create', 'update'],
      departments: ['*'],
      audit: ['read'],
      settings: ['read'],
    },
    is_system: true,
  },
  {
    name: 'Manager',
    description: 'Department management and audit viewing',
    permissions: {
      departments: ['read', 'update'],
      audit: ['read'],
    },
    is_system: false,
  },
  {
    name: 'Viewer',
    description: 'Read-only access to departments and audit logs',
    permissions: {
      departments: ['read'],
      audit: ['read'],
    },
    is_system: false,
  },
];

export async function seedRoles() {
  const client = await pool.connect();
  try {
    for (const role of roles) {
      await client.query(
        `INSERT INTO roles (name, description, permissions, is_system)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO NOTHING`,
        [role.name, role.description, JSON.stringify(role.permissions), role.is_system]
      );
      console.log(`Role seeded: ${role.name}`);
    }
  } finally {
    client.release();
  }
}

export { pool };
