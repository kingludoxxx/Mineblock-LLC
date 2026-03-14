# Mineblock LLC Admin Dashboard

Secure, modular admin dashboard for Mineblock LLC's e-commerce operations.

## Tech Stack

- **Backend**: Node.js + Express.js
- **Frontend**: React + Vite + Tailwind CSS
- **Database**: PostgreSQL
- **Auth**: JWT + Refresh Tokens + bcrypt
- **Hosting**: Render.com

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15+

### Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/MineblockLLC/admin-dashboard.git
   cd admin-dashboard
   ```

2. **Install dependencies**

   ```bash
   npm install
   cd client && npm install && cd ..
   ```

3. **Configure environment variables**

   Create a `.env` file in the project root:

   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/mineblock_admin
   JWT_SECRET=your-jwt-secret-here
   JWT_REFRESH_SECRET=your-refresh-secret-here
   NODE_ENV=development
   PORT=5000
   ```

4. **Run database migrations**

   ```bash
   npm run migrate
   ```

5. **Seed the database**

   ```bash
   npm run seed
   ```

6. **Start the development server**

   ```bash
   npm run dev
   ```

   The API server runs on `http://localhost:5000` and the client dev server on `http://localhost:5173`.

### Default SuperAdmin

- **Email**: admin@try-mineblock.com
- **Password**: MineblockAdmin2026!
- **Change this password on first login!**

## Scripts

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `npm start`       | Start the production server                  |
| `npm run dev`     | Start both backend and frontend in dev mode  |
| `npm run migrate` | Run database migrations                      |
| `npm run seed`    | Seed the database with initial data          |
| `npm run build`   | Build the frontend for production            |

## Architecture

The dashboard follows an API-first design with a modular department system and role-based access control (RBAC).

```
server/
  src/
    config/          # Database and app configuration
    controllers/     # Route handlers
    departments/     # Pluggable department modules
      base.js        # Base class all departments extend
      registry.js    # Auto-discovers and loads department modules
      sample/        # Example department module
    middleware/      # Auth, validation, error handling
    models/          # Database models
    routes/          # API route definitions
    services/        # Business logic layer
    utils/           # Logger, helpers
client/
  src/
    components/
      auth/          # Login, session management
      departments/   # Department UI framework
        modules/     # Department-specific UI components
      layout/        # Sidebar, header, main layout
      shared/        # Reusable UI components
```

## Adding a Department Module

Departments are self-contained, pluggable modules. To add a new department:

### 1. Create the backend module

Create a new directory under `server/src/departments/` with an `index.js` file:

```javascript
import BaseDepartment from '../base.js';

export default class InventoryDepartment extends BaseDepartment {
  constructor() {
    super({
      name: 'Inventory',
      slug: 'inventory',
      version: '1.0.0',
      description: 'Manage product inventory and stock levels'
    });
  }

  registerRoutes(router) {
    router.get('/', (req, res) => {
      res.json({ department: this.getMetadata() });
    });

    // Add more routes as needed
  }
}
```

The registry automatically discovers any subdirectory containing an `index.js` file and mounts its routes at `/api/departments/<slug>`.

### 2. Create the frontend module

Add a React component at `client/src/components/departments/modules/InventoryDepartment.jsx`:

```jsx
export default function InventoryDepartment() {
  return (
    <div className="space-y-6">
      <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
        <h2 className="text-xl font-semibold text-white">Inventory</h2>
        <p className="text-slate-400 mt-2">Manage product inventory here.</p>
      </div>
    </div>
  );
}
```

### 3. Register the frontend module

Add an entry to the `departmentModules` map in `client/src/components/departments/DepartmentRouter.jsx`:

```javascript
const departmentModules = {
  sample: lazy(() => import('./modules/SampleDepartment')),
  inventory: lazy(() => import('./modules/InventoryDepartment')),
};
```

## Deployment

This project includes a `render.yaml` Blueprint for one-click deployment to Render.com.

1. Push your code to GitHub.
2. In the Render dashboard, click **New Blueprint Instance**.
3. Connect your repository and select the branch to deploy.
4. Render will automatically provision the web service and PostgreSQL database based on `render.yaml`.
5. Set the required environment variables (`JWT_SECRET`, `JWT_REFRESH_SECRET`) in the Render dashboard.
6. The initial deploy will run migrations and seed the database automatically.
