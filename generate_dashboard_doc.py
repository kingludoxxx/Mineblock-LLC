from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    ListFlowable, ListItem, KeepTogether
)
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.lib import colors
import os

OUTPUT_PATH = os.path.expanduser("~/Mineblock-LLC/Mineblock_LLC_Dashboard_Implementation_Plan.pdf")

doc = SimpleDocTemplate(
    OUTPUT_PATH,
    pagesize=letter,
    rightMargin=60,
    leftMargin=60,
    topMargin=60,
    bottomMargin=60
)

styles = getSampleStyleSheet()

# Custom styles
styles.add(ParagraphStyle(
    name='DocTitle',
    parent=styles['Title'],
    fontSize=26,
    spaceAfter=6,
    textColor=HexColor('#1a1a2e'),
    fontName='Helvetica-Bold'
))
styles.add(ParagraphStyle(
    name='DocSubtitle',
    parent=styles['Normal'],
    fontSize=14,
    spaceAfter=30,
    textColor=HexColor('#4a4a6a'),
    alignment=TA_CENTER,
    fontName='Helvetica'
))
styles.add(ParagraphStyle(
    name='PhaseTitle',
    parent=styles['Heading1'],
    fontSize=18,
    spaceBefore=20,
    spaceAfter=10,
    textColor=HexColor('#0f3460'),
    fontName='Helvetica-Bold',
    borderWidth=1,
    borderColor=HexColor('#0f3460'),
    borderPadding=6
))
styles.add(ParagraphStyle(
    name='SectionHead',
    parent=styles['Heading2'],
    fontSize=12,
    spaceBefore=12,
    spaceAfter=4,
    textColor=HexColor('#16213e'),
    fontName='Helvetica-Bold'
))
styles.add(ParagraphStyle(
    name='BodyText2',
    parent=styles['Normal'],
    fontSize=10,
    spaceAfter=6,
    leading=14,
    alignment=TA_JUSTIFY,
    fontName='Helvetica'
))
styles.add(ParagraphStyle(
    name='CodeBlock',
    parent=styles['Normal'],
    fontSize=8,
    fontName='Courier',
    backColor=HexColor('#f0f0f0'),
    borderWidth=0.5,
    borderColor=HexColor('#cccccc'),
    borderPadding=6,
    spaceAfter=8,
    leading=11
))
styles.add(ParagraphStyle(
    name='BulletItem',
    parent=styles['Normal'],
    fontSize=10,
    leftIndent=20,
    spaceAfter=3,
    leading=13,
    fontName='Helvetica'
))
styles.add(ParagraphStyle(
    name='MetaLabel',
    parent=styles['Normal'],
    fontSize=10,
    fontName='Helvetica-Bold',
    textColor=HexColor('#333355'),
    spaceAfter=2
))

story = []

# ── COVER PAGE ──
story.append(Spacer(1, 2 * inch))
story.append(Paragraph("MINEBLOCK LLC", styles['DocTitle']))
story.append(Paragraph("Admin Dashboard Implementation Plan", styles['DocSubtitle']))
story.append(Spacer(1, 0.3 * inch))
story.append(Paragraph("10-Phase Build Document", ParagraphStyle(
    'sub2', parent=styles['Normal'], fontSize=16, alignment=TA_CENTER,
    textColor=HexColor('#333366'), fontName='Helvetica-Bold'
)))
story.append(Spacer(1, 0.5 * inch))

cover_data = [
    ["Document Version", "1.0"],
    ["Date", "March 13, 2026"],
    ["Prepared For", "Ludo - Founder, Mineblock LLC"],
    ["Tech Stack", "Node.js, PostgreSQL, Render.com"],
    ["Architecture", "API-First, Modular Departments"],
    ["Auth", "JWT + Refresh Tokens, bcrypt, RBAC"],
]
cover_table = Table(cover_data, colWidths=[2.2 * inch, 3.5 * inch])
cover_table.setStyle(TableStyle([
    ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
    ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
    ('FONTSIZE', (0, 0), (-1, -1), 10),
    ('TEXTCOLOR', (0, 0), (0, -1), HexColor('#333366')),
    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ('TOPPADDING', (0, 0), (-1, -1), 8),
    ('LINEBELOW', (0, 0), (-1, -2), 0.5, HexColor('#ccccdd')),
    ('LINEBELOW', (0, -1), (-1, -1), 1, HexColor('#0f3460')),
    ('LINEABOVE', (0, 0), (-1, 0), 1, HexColor('#0f3460')),
]))
story.append(cover_table)
story.append(PageBreak())

# ── TABLE OF CONTENTS ──
story.append(Paragraph("TABLE OF CONTENTS", styles['PhaseTitle']))
story.append(Spacer(1, 0.2 * inch))
toc_items = [
    "Executive Summary",
    "Project Architecture Overview",
    "Folder Structure",
    "Phase 1: Project Setup & Render Infrastructure",
    "Phase 2: Database Design & PostgreSQL Setup on Render",
    "Phase 3: Authentication System (SuperAdmin Login)",
    "Phase 4: Role-Based Access Control (RBAC)",
    "Phase 5: Dashboard Layout & Navigation Shell",
    "Phase 6: SuperAdmin Management Panel",
    "Phase 7: Department Module Framework (Pluggable Architecture)",
    "Phase 8: Audit Logging & Session Management",
    "Phase 9: Security Hardening & Testing",
    "Phase 10: Production Deployment & Monitoring",
    "Appendix: Role Permissions Matrix",
]
for i, item in enumerate(toc_items):
    story.append(Paragraph(f"{item}", styles['BulletItem']))
story.append(PageBreak())

# ── EXECUTIVE SUMMARY ──
story.append(Paragraph("EXECUTIVE SUMMARY", styles['PhaseTitle']))
story.append(Spacer(1, 0.1 * inch))
story.append(Paragraph(
    "This document outlines a 10-phase plan to build a secure, scalable admin dashboard for Mineblock LLC's "
    "e-commerce operations. The dashboard provides SuperAdmin access with full control, role-based access for "
    "team members (Admin, Manager, Viewer), and a pluggable department architecture that allows new business "
    "modules (inventory, orders, customers, analytics) to be added without restructuring the codebase.",
    styles['BodyText2']
))
story.append(Paragraph(
    "The system is built API-first using Node.js and PostgreSQL, deployed on Render.com. This ensures mobile "
    "apps and third-party integrations can connect to the same backend. Each phase is designed to be completed "
    "in 1-2 days, with clear deliverables and deployment checkpoints.",
    styles['BodyText2']
))
story.append(Spacer(1, 0.2 * inch))

# ── ARCHITECTURE OVERVIEW ──
story.append(Paragraph("PROJECT ARCHITECTURE OVERVIEW", styles['PhaseTitle']))
story.append(Spacer(1, 0.1 * inch))
arch_data = [
    ["Layer", "Technology", "Purpose"],
    ["Frontend", "React.js + Tailwind CSS", "Dark-mode admin UI with responsive layout"],
    ["Backend API", "Node.js + Express.js", "RESTful API serving all clients"],
    ["Database", "PostgreSQL (Render)", "Users, roles, departments, audit logs"],
    ["Auth", "JWT + Refresh Tokens", "Stateless auth with secure token rotation"],
    ["Passwords", "bcrypt (12 rounds)", "Industry-standard password hashing"],
    ["Hosting", "Render.com", "Web service + managed PostgreSQL"],
    ["Deployment", "Auto-deploy from GitHub", "Push to main = deploy to production"],
]
arch_table = Table(arch_data, colWidths=[1.4 * inch, 2.2 * inch, 2.6 * inch])
arch_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#0f3460')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#ccccdd')),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ('TOPPADDING', (0, 0), (-1, -1), 6),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, HexColor('#f5f5fa')]),
]))
story.append(arch_table)
story.append(PageBreak())

# ── FOLDER STRUCTURE ──
story.append(Paragraph("PROJECT FOLDER STRUCTURE", styles['PhaseTitle']))
story.append(Spacer(1, 0.1 * inch))
folder = """mineblock-dashboard/
+-- client/                          # React frontend
|   +-- public/
|   +-- src/
|       +-- components/
|       |   +-- layout/              # Sidebar, Header, Footer
|       |   +-- auth/                # Login, ProtectedRoute
|       |   +-- shared/              # Buttons, Modals, Tables
|       |   +-- departments/         # Pluggable department modules
|       +-- pages/
|       |   +-- Login.jsx
|       |   +-- Dashboard.jsx
|       |   +-- SuperAdmin.jsx
|       |   +-- Departments.jsx
|       +-- hooks/                   # useAuth, usePermissions
|       +-- context/                 # AuthContext, ThemeContext
|       +-- services/                # API client (axios)
|       +-- styles/                  # Tailwind + custom dark theme
|       +-- App.jsx
|       +-- main.jsx
+-- server/                          # Node.js backend
|   +-- src/
|       +-- config/                  # db.js, env.js, cors.js
|       +-- controllers/            # auth, users, departments, audit
|       +-- middleware/              # auth.js, rbac.js, validate.js
|       +-- models/                  # User, Role, Department, AuditLog
|       +-- routes/                  # auth, users, departments, audit
|       +-- services/               # Business logic layer
|       +-- utils/                   # jwt.js, hash.js, logger.js
|       +-- departments/            # Pluggable department modules
|       |   +-- registry.js         # Department auto-loader
|       |   +-- base.js             # Base department class
|       +-- app.js
|       +-- server.js
|   +-- migrations/                  # SQL migration files
|   +-- seeds/                       # SuperAdmin seed data
+-- .env.example
+-- render.yaml                      # Render Blueprint (IaC)
+-- package.json
+-- README.md"""
story.append(Paragraph(folder.replace("\n", "<br/>").replace(" ", "&nbsp;"), styles['CodeBlock']))
story.append(PageBreak())


# ── HELPER FUNCTION ──
def add_phase(phase_num, title, objective, what_gets_built, db_schema, api_endpoints,
              frontend, security, complexity, dependencies, deliverable, render_notes):
    story.append(Paragraph(f"PHASE {phase_num}: {title.upper()}", styles['PhaseTitle']))
    story.append(Spacer(1, 0.1 * inch))

    # Objective
    story.append(Paragraph("1. Objective", styles['SectionHead']))
    story.append(Paragraph(objective, styles['BodyText2']))

    # What gets built
    story.append(Paragraph("2. What Gets Built", styles['SectionHead']))
    for item in what_gets_built:
        story.append(Paragraph(f"&#8226; {item}", styles['BulletItem']))

    # DB Schema
    story.append(Paragraph("3. Database Schema Changes", styles['SectionHead']))
    if isinstance(db_schema, list):
        for item in db_schema:
            story.append(Paragraph(f"&#8226; {item}", styles['BulletItem']))
    else:
        story.append(Paragraph(db_schema, styles['BodyText2']))

    # API Endpoints
    story.append(Paragraph("4. API Endpoints", styles['SectionHead']))
    if isinstance(api_endpoints, list) and len(api_endpoints) > 0 and isinstance(api_endpoints[0], list):
        ep_data = [["Method", "Endpoint", "Description"]] + api_endpoints
        ep_table = Table(ep_data, colWidths=[0.8 * inch, 2.5 * inch, 2.9 * inch])
        ep_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), HexColor('#16213e')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTNAME', (0, 1), (-1, -1), 'Courier'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#ccccdd')),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, HexColor('#f8f8fc')]),
        ]))
        story.append(ep_table)
    else:
        for item in api_endpoints:
            story.append(Paragraph(f"&#8226; {item}", styles['BulletItem']))

    # Frontend
    story.append(Paragraph("5. Frontend Pages / Components", styles['SectionHead']))
    for item in frontend:
        story.append(Paragraph(f"&#8226; {item}", styles['BulletItem']))

    # Security
    story.append(Paragraph("6. Security Considerations", styles['SectionHead']))
    for item in security:
        story.append(Paragraph(f"&#8226; {item}", styles['BulletItem']))

    # Meta table
    story.append(Spacer(1, 0.1 * inch))
    meta_data = [
        ["Complexity", complexity],
        ["Dependencies", dependencies],
        ["Deliverable", deliverable],
        ["Render Notes", render_notes],
    ]
    meta_table = Table(meta_data, colWidths=[1.5 * inch, 4.7 * inch])
    meta_table.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('TEXTCOLOR', (0, 0), (0, -1), HexColor('#0f3460')),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#ccccdd')),
        ('BACKGROUND', (0, 0), (0, -1), HexColor('#f0f0fa')),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(meta_table)
    story.append(PageBreak())


# ══════════════════════════════════════════
# PHASE 1
# ══════════════════════════════════════════
add_phase(
    1, "Project Setup & Render Infrastructure",
    "Initialize the monorepo, configure Node.js backend and React frontend scaffolding, "
    "set up the Render web service with environment variables, and establish the CI/CD pipeline "
    "from GitHub to Render with auto-deploy on push to main.",
    [
        "Node.js + Express backend scaffold with folder structure",
        "React + Vite + Tailwind CSS frontend scaffold with dark theme",
        "render.yaml Blueprint for Infrastructure as Code",
        "Environment variable configuration (.env.example)",
        "ESLint + Prettier configuration for code consistency",
        "GitHub repository structure with .gitignore",
        "CORS configuration for API-first design",
        "Health check endpoint for Render monitoring",
    ],
    "No database changes in this phase.",
    [
        ["GET", "/api/health", "Health check (returns status + uptime)"],
        ["GET", "/api/v1/status", "API version and service info"],
    ],
    [
        "Vite project with Tailwind CSS dark theme configured",
        "Base layout placeholder (empty shell)",
        "Environment-specific API base URL configuration",
    ],
    [
        "All secrets stored in Render environment variables, never in code",
        ".env.example with placeholder values only (no real secrets)",
        "CORS whitelist limited to known frontend origins",
        "Helmet.js for HTTP security headers from day one",
    ],
    "Low",
    "None - this is the foundation phase",
    "Running web service on Render returning JSON from /api/health. "
    "Frontend builds and serves. Auto-deploy from GitHub main branch works.",
    "Create Web Service on Render pointing to GitHub repo. Set build command: "
    "npm install && npm run build. Set start command: node server/src/server.js. "
    "Add all env vars. Enable auto-deploy from main branch."
)

# ══════════════════════════════════════════
# PHASE 2
# ══════════════════════════════════════════
add_phase(
    2, "Database Design & PostgreSQL Setup on Render",
    "Provision a managed PostgreSQL instance on Render, design the core schema for users, roles, "
    "departments, and sessions, create migration scripts, and seed the SuperAdmin account.",
    [
        "Render PostgreSQL instance provisioned and connected",
        "Migration system using node-pg-migrate",
        "Core tables: users, roles, user_roles, departments, sessions",
        "SuperAdmin seed script with secure default credentials",
        "Database connection pooling with pg library",
        "Migration CLI commands (up, down, create)",
    ],
    [
        "CREATE TABLE roles (id UUID PK, name VARCHAR UNIQUE, description TEXT, permissions JSONB, created_at, updated_at)",
        "CREATE TABLE users (id UUID PK, email VARCHAR UNIQUE, password_hash VARCHAR, first_name, last_name, is_active BOOLEAN, last_login, created_at, updated_at)",
        "CREATE TABLE user_roles (user_id FK, role_id FK, assigned_by FK, assigned_at) - composite PK",
        "CREATE TABLE departments (id UUID PK, name VARCHAR UNIQUE, slug VARCHAR UNIQUE, description, icon, is_active, sort_order, config JSONB, created_at, updated_at)",
        "CREATE TABLE sessions (id UUID PK, user_id FK, refresh_token_hash, ip_address, user_agent, expires_at, created_at)",
        "INSERT default roles: SuperAdmin, Admin, Manager, Viewer",
        "INSERT SuperAdmin user with bcrypt-hashed password",
    ],
    [
        ["GET", "/api/v1/db/status", "Database connection status check"],
    ],
    [
        "No frontend changes in this phase",
    ],
    [
        "PostgreSQL SSL connection enforced (sslmode=require)",
        "SuperAdmin seed password must be changed on first login",
        "Database credentials stored only in Render env vars",
        "UUID primary keys to prevent enumeration attacks",
        "Passwords stored as bcrypt hashes (12 salt rounds)",
        "Connection pooling to prevent connection exhaustion",
    ],
    "Medium",
    "Phase 1 (running web service on Render)",
    "PostgreSQL instance running on Render. All migrations execute successfully. "
    "SuperAdmin account exists in database. /api/v1/db/status returns connected.",
    "Create PostgreSQL instance on Render (free or starter tier). Copy Internal Database URL "
    "to web service env var DATABASE_URL. Run migrations via Render Shell or build command."
)

# ══════════════════════════════════════════
# PHASE 3
# ══════════════════════════════════════════
add_phase(
    3, "Authentication System (SuperAdmin Login)",
    "Build the complete authentication flow: login with email/password, JWT access token + refresh token "
    "issuance, token refresh endpoint, logout with token invalidation, and password change on first login.",
    [
        "Login endpoint with email/password validation",
        "JWT access token (15min) + refresh token (7 days) generation",
        "Refresh token rotation (old token invalidated on refresh)",
        "Logout endpoint that invalidates refresh token",
        "Auth middleware that validates JWT on protected routes",
        "Force password change on first SuperAdmin login",
        "Rate limiting on login endpoint (5 attempts / 15 min)",
        "Login page UI with dark theme",
    ],
    [
        "ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT false",
        "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN locked_until TIMESTAMP",
    ],
    [
        ["POST", "/api/v1/auth/login", "Authenticate and receive tokens"],
        ["POST", "/api/v1/auth/refresh", "Refresh access token using refresh token"],
        ["POST", "/api/v1/auth/logout", "Invalidate refresh token"],
        ["POST", "/api/v1/auth/change-password", "Change password (required on first login)"],
        ["GET", "/api/v1/auth/me", "Get current authenticated user profile"],
    ],
    [
        "Login page with email/password form, dark theme, Mineblock branding",
        "Change Password modal (shown on first login)",
        "AuthContext provider wrapping the app",
        "useAuth hook for login/logout/token management",
        "ProtectedRoute component that redirects to login if unauthenticated",
        "Automatic token refresh on 401 responses (axios interceptor)",
    ],
    [
        "JWT secret minimum 256 bits, stored in env var JWT_SECRET",
        "Refresh tokens hashed (SHA-256) before database storage",
        "HttpOnly, Secure, SameSite=Strict cookies for refresh token",
        "Access token in memory only (never localStorage)",
        "Account lockout after 5 failed attempts (15 min cooldown)",
        "Rate limiting: 5 login attempts per IP per 15 minutes",
        "Timing-safe comparison for password verification",
    ],
    "High",
    "Phase 2 (database with users and sessions tables)",
    "SuperAdmin can log in, receive tokens, access protected /api/v1/auth/me, "
    "refresh tokens, logout, and is forced to change password on first login.",
    "Add JWT_SECRET and JWT_REFRESH_SECRET to Render env vars. Use crypto.randomBytes(64).toString('hex') "
    "to generate secure secrets. Verify login flow works via Render logs."
)

# ══════════════════════════════════════════
# PHASE 4
# ══════════════════════════════════════════
add_phase(
    4, "Role-Based Access Control (RBAC)",
    "Implement a granular permission system where each role (SuperAdmin, Admin, Manager, Viewer) has "
    "specific permissions stored as JSONB. Build middleware that checks permissions on every API request "
    "and a frontend hook that conditionally renders UI elements based on user permissions.",
    [
        "RBAC middleware that checks role permissions on API routes",
        "Permission definitions: create, read, update, delete per resource",
        "SuperAdmin bypass (full access to everything)",
        "Role-permission mapping stored in database JSONB",
        "Frontend usePermissions hook for conditional rendering",
        "API to manage roles and assign roles to users",
    ],
    [
        "UPDATE roles SET permissions where name='SuperAdmin' -> {\"*\": [\"*\"]}",
        "UPDATE roles SET permissions where name='Admin' -> {\"users\": [\"read\",\"update\"], \"departments\": [\"*\"], \"audit\": [\"read\"]}",
        "UPDATE roles SET permissions where name='Manager' -> {\"departments\": [\"read\",\"update\"], \"audit\": [\"read\"]}",
        "UPDATE roles SET permissions where name='Viewer' -> {\"departments\": [\"read\"], \"audit\": [\"read\"]}",
    ],
    [
        ["GET", "/api/v1/roles", "List all roles (Admin+)"],
        ["GET", "/api/v1/roles/:id", "Get role details with permissions"],
        ["PUT", "/api/v1/roles/:id", "Update role permissions (SuperAdmin)"],
        ["POST", "/api/v1/users/:id/roles", "Assign role to user (Admin+)"],
        ["DELETE", "/api/v1/users/:id/roles/:roleId", "Remove role from user (Admin+)"],
        ["GET", "/api/v1/permissions", "List all available permissions"],
    ],
    [
        "usePermissions(resource, action) hook returns boolean",
        "PermissionGate component: renders children only if user has permission",
        "Role badge component showing user's role in UI",
        "Forbidden (403) page for unauthorized access attempts",
    ],
    [
        "Permissions checked server-side on EVERY request (never trust frontend)",
        "SuperAdmin role cannot be deleted or have permissions reduced via API",
        "Role changes take effect on next token refresh",
        "Principle of least privilege: default to deny",
        "Permission changes are audit-logged (Phase 8)",
    ],
    "High",
    "Phase 3 (authentication system with JWT)",
    "All 4 roles created with correct permissions. RBAC middleware blocks unauthorized access. "
    "Frontend conditionally renders based on permissions. SuperAdmin has unrestricted access.",
    "No additional Render configuration needed. Test by creating test users with different roles "
    "and verifying access restrictions via API calls."
)

# ══════════════════════════════════════════
# PHASE 5
# ══════════════════════════════════════════
add_phase(
    5, "Dashboard Layout & Navigation Shell",
    "Build the main dashboard UI shell with collapsible sidebar navigation, top header bar, "
    "breadcrumbs, dark/light theme toggle, and responsive layout. This is the container that all "
    "department modules will render inside.",
    [
        "Collapsible sidebar with navigation links",
        "Top header bar with user info, notifications bell, logout",
        "Breadcrumb navigation component",
        "Dark mode as default with light mode toggle",
        "Responsive layout (desktop sidebar, mobile hamburger menu)",
        "Dashboard home page with welcome message and quick stats placeholders",
        "React Router setup with nested routes for departments",
        "Loading states and skeleton screens",
    ],
    "No database changes in this phase.",
    [
        ["GET", "/api/v1/dashboard/stats", "Dashboard summary stats (placeholder)"],
        ["GET", "/api/v1/navigation", "Dynamic nav items based on user permissions"],
    ],
    [
        "Sidebar component with collapsible sections and department links",
        "Header component with user avatar, role badge, logout button",
        "Breadcrumb component auto-generated from route path",
        "ThemeContext with dark/light mode toggle (persisted to localStorage)",
        "Dashboard home page with stat cards (placeholder data)",
        "Mobile-responsive hamburger menu",
        "404 Not Found page",
        "Loading spinner and skeleton screen components",
    ],
    [
        "Navigation items filtered by user permissions (no hidden links visible)",
        "Theme preference stored client-side only (no security impact)",
        "No sensitive data rendered on dashboard home (stats are aggregate only)",
    ],
    "Medium",
    "Phase 4 (RBAC system for permission-based navigation)",
    "Dashboard shell renders with sidebar, header, breadcrumbs. Navigation items appear/hide "
    "based on user role. Dark mode works. Responsive on mobile. Nested routes render in content area.",
    "No additional Render configuration. Frontend build included in existing deploy pipeline."
)

# ══════════════════════════════════════════
# PHASE 6
# ══════════════════════════════════════════
add_phase(
    6, "SuperAdmin Management Panel",
    "Build the SuperAdmin-exclusive control panel for managing users, roles, departments, and system "
    "settings. This is the nerve center where Ludo (SuperAdmin) controls everything.",
    [
        "User management CRUD (create, list, edit, deactivate users)",
        "Role assignment interface (assign/revoke roles per user)",
        "Department management (create, edit, activate/deactivate departments)",
        "System settings page (app name, maintenance mode, etc.)",
        "User invitation flow (create user with temporary password)",
        "Bulk actions (deactivate multiple users, export user list)",
    ],
    [
        "CREATE TABLE system_settings (key VARCHAR PK, value JSONB, updated_by FK, updated_at)",
        "INSERT default settings: app_name, maintenance_mode, max_login_attempts",
    ],
    [
        ["GET", "/api/v1/users", "List all users (paginated, filterable)"],
        ["POST", "/api/v1/users", "Create new user (SuperAdmin/Admin)"],
        ["GET", "/api/v1/users/:id", "Get user details"],
        ["PUT", "/api/v1/users/:id", "Update user profile"],
        ["PATCH", "/api/v1/users/:id/status", "Activate/deactivate user"],
        ["GET", "/api/v1/departments", "List all departments"],
        ["POST", "/api/v1/departments", "Create department (SuperAdmin)"],
        ["PUT", "/api/v1/departments/:id", "Update department"],
        ["PATCH", "/api/v1/departments/:id/status", "Toggle department active status"],
        ["GET", "/api/v1/settings", "Get system settings (SuperAdmin)"],
        ["PUT", "/api/v1/settings/:key", "Update system setting"],
    ],
    [
        "Users list page with search, filter by role, pagination",
        "User detail/edit page with role assignment",
        "Create User modal with email, name, temporary password",
        "Departments list with drag-to-reorder, activate/deactivate toggle",
        "Create/Edit Department modal",
        "System Settings page with key-value configuration",
        "Confirmation modals for destructive actions",
    ],
    [
        "All SuperAdmin routes require SuperAdmin role (double-checked in middleware)",
        "Cannot deactivate the last SuperAdmin account",
        "Temporary passwords must meet minimum complexity requirements",
        "Deactivated users' sessions are immediately invalidated",
        "System settings changes are audit-logged",
    ],
    "High",
    "Phase 5 (dashboard shell for rendering management pages)",
    "SuperAdmin can create/edit/deactivate users, assign roles, manage departments, "
    "and configure system settings. All actions restricted to SuperAdmin role.",
    "No additional Render configuration. Ensure DATABASE_URL connection pool handles "
    "concurrent admin operations."
)

# ══════════════════════════════════════════
# PHASE 7
# ══════════════════════════════════════════
add_phase(
    7, "Department Module Framework (Pluggable Architecture)",
    "Build the department module system — a pluggable architecture that allows new business modules "
    "(inventory, orders, customers, analytics, etc.) to be added by dropping files into a directory. "
    "Each department is self-contained with its own routes, controllers, and UI components.",
    [
        "Base Department class that all modules extend",
        "Department registry that auto-discovers and loads modules",
        "Department route auto-mounting under /api/v1/departments/:slug/*",
        "Frontend department lazy-loading with React.lazy + Suspense",
        "Department configuration stored in database (JSONB config column)",
        "Sample department module (placeholder) as a template",
        "Department-specific permission scoping",
        "CLI command to scaffold a new department module",
    ],
    [
        "ALTER TABLE departments ADD COLUMN module_path VARCHAR",
        "ALTER TABLE departments ADD COLUMN version VARCHAR DEFAULT '1.0.0'",
        "ALTER TABLE departments ADD COLUMN settings JSONB DEFAULT '{}'",
    ],
    [
        ["GET", "/api/v1/departments/:slug/config", "Get department configuration"],
        ["PUT", "/api/v1/departments/:slug/config", "Update department config (Admin+)"],
        ["GET", "/api/v1/departments/:slug/*", "Wildcard - routes to department module"],
        ["POST", "/api/v1/departments/:slug/*", "Wildcard - routes to department module"],
    ],
    [
        "DepartmentRouter component that lazy-loads department UI based on slug",
        "Department wrapper with consistent header, breadcrumbs, and permission checks",
        "Sample department page (placeholder) showing the module pattern",
        "Department settings page (per-department configuration)",
        "Empty state component for departments with no content yet",
    ],
    [
        "Department modules run in sandboxed scope (no cross-department data access)",
        "Each department's routes are permission-checked against user's department access",
        "Department config changes require Admin or SuperAdmin role",
        "Module loading validates file paths to prevent directory traversal",
    ],
    "High",
    "Phase 6 (department management + dashboard shell)",
    "New department modules can be added by: (1) creating files in server/src/departments/ and "
    "client/src/components/departments/, (2) registering in database. No core code changes needed. "
    "Sample module works end-to-end.",
    "No additional Render configuration. Department modules are part of the main build. "
    "Future modules deploy automatically with the main app."
)

# ══════════════════════════════════════════
# PHASE 8
# ══════════════════════════════════════════
add_phase(
    8, "Audit Logging & Session Management",
    "Implement comprehensive audit logging that records every significant action (login, data changes, "
    "permission changes, settings updates) and a session management system where SuperAdmin can view "
    "and revoke active sessions.",
    [
        "Audit log middleware that captures all write operations automatically",
        "Audit log table with actor, action, resource, old/new values, IP, timestamp",
        "Session management API (list active sessions, revoke sessions)",
        "Audit log viewer in SuperAdmin panel with filters and search",
        "Active sessions viewer showing all logged-in users",
        "Force logout capability (revoke specific user's sessions)",
        "Automatic session cleanup (expired sessions purged daily)",
    ],
    [
        "CREATE TABLE audit_logs (id UUID PK, user_id FK, action VARCHAR, resource_type VARCHAR, "
        "resource_id UUID, old_values JSONB, new_values JSONB, ip_address INET, user_agent TEXT, "
        "created_at TIMESTAMP DEFAULT NOW())",
        "CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id)",
        "CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id)",
        "CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at)",
    ],
    [
        ["GET", "/api/v1/audit-logs", "List audit logs (paginated, filterable)"],
        ["GET", "/api/v1/audit-logs/:id", "Get audit log entry detail"],
        ["GET", "/api/v1/sessions", "List all active sessions (SuperAdmin)"],
        ["GET", "/api/v1/sessions/user/:id", "List sessions for specific user"],
        ["DELETE", "/api/v1/sessions/:id", "Revoke specific session"],
        ["DELETE", "/api/v1/sessions/user/:id", "Revoke all sessions for user"],
    ],
    [
        "Audit Log page with table: timestamp, user, action, resource, IP",
        "Audit log detail modal showing old vs new values diff",
        "Filter bar: by user, action type, resource, date range",
        "Active Sessions page showing all logged-in users with device info",
        "Revoke Session button with confirmation modal",
        "Force Logout All button for emergency use",
    ],
    [
        "Audit logs are append-only (no update or delete API)",
        "Audit log table has separate database permissions (no DELETE grant)",
        "Session revocation immediately invalidates refresh tokens",
        "IP addresses stored for security investigation but shown only to SuperAdmin",
        "Audit log retention policy: 90 days default (configurable in settings)",
        "Failed login attempts are audit-logged with IP and user agent",
    ],
    "Medium",
    "Phase 7 (department framework for logging department-specific actions)",
    "All write operations generate audit log entries. SuperAdmin can view full audit history, "
    "filter by any dimension, see session list, and force-logout any user.",
    "Consider Render's log retention limits. For long-term audit storage, configure periodic "
    "export to external storage. Monitor database size as audit logs grow."
)

# ══════════════════════════════════════════
# PHASE 9
# ══════════════════════════════════════════
add_phase(
    9, "Security Hardening & Testing",
    "Perform a comprehensive security review and implement hardening measures: input validation, "
    "SQL injection prevention, XSS protection, CSRF tokens, penetration testing, and automated "
    "security scanning. Write integration and unit tests for all critical paths.",
    [
        "Input validation on all API endpoints using Joi/Zod schemas",
        "SQL injection prevention audit (parameterized queries verified)",
        "XSS protection: Content-Security-Policy headers, output encoding",
        "CSRF protection for cookie-based auth flows",
        "API rate limiting per endpoint (configurable thresholds)",
        "Security headers audit (Helmet.js configuration review)",
        "Unit tests for auth, RBAC, and audit logging",
        "Integration tests for critical user flows",
        "Dependency vulnerability scan (npm audit)",
        "Error handling review (no stack traces leaked to client)",
    ],
    "No database changes in this phase.",
    [
        "No new endpoints. All existing endpoints are hardened and tested.",
    ],
    [
        "Error boundary components catching frontend crashes gracefully",
        "User-friendly error pages (no technical details exposed)",
        "CSP violation reporting setup",
    ],
    [
        "All user inputs validated and sanitized before processing",
        "Parameterized queries verified on every database call",
        "Content-Security-Policy: default-src 'self'; script-src 'self'",
        "X-Content-Type-Options: nosniff on all responses",
        "Strict-Transport-Security: max-age=31536000; includeSubDomains",
        "Rate limits: Login 5/15min, API 100/min, SuperAdmin 200/min",
        "npm audit shows 0 high/critical vulnerabilities",
        "All sensitive error details logged server-side, generic message to client",
        "CORS restricted to specific frontend domain only",
    ],
    "Medium",
    "Phase 8 (all features built and audit logging active)",
    "Zero high/critical npm vulnerabilities. All validation schemas in place. Rate limiting active. "
    "Security headers score A+ on securityheaders.com. Test suite passes with >80% coverage on critical paths.",
    "Enable Render's DDoS protection. Review Render's IP allowlisting for database access. "
    "Set up Render health check alerts for uptime monitoring."
)

# ══════════════════════════════════════════
# PHASE 10
# ══════════════════════════════════════════
add_phase(
    10, "Production Deployment & Monitoring",
    "Finalize production deployment on Render with proper environment configuration, set up monitoring "
    "and alerting, create runbooks for common operations, and establish the ongoing maintenance workflow.",
    [
        "Production environment variables finalized on Render",
        "render.yaml Blueprint with all services defined as Infrastructure as Code",
        "Health check endpoint with deep checks (DB connectivity, memory usage)",
        "Structured logging with Winston (JSON format for Render log search)",
        "Error tracking integration (Sentry or similar)",
        "Performance monitoring (response times, DB query times)",
        "Backup strategy for PostgreSQL (Render automatic backups + manual exports)",
        "Runbook documentation for common operations",
        "Custom domain setup (if applicable)",
        "SSL/TLS verification on custom domain",
    ],
    "No database changes. Final migration verification only.",
    [
        ["GET", "/api/v1/health", "Shallow health check (fast, for Render)"],
        ["GET", "/api/v1/health/deep", "Deep health check (DB, memory, disk)"],
        ["GET", "/api/v1/metrics", "Basic metrics endpoint (SuperAdmin only)"],
    ],
    [
        "System status indicator in dashboard header (green/yellow/red)",
        "Version number displayed in footer",
        "Maintenance mode banner (when enabled in system settings)",
    ],
    [
        "All production secrets rotated from development values",
        "Database connection string uses internal Render URL (not external)",
        "Render auto-deploy only from main branch (no feature branches)",
        "Health check endpoint does not expose sensitive system information",
        "Error tracking sanitizes PII before sending to external services",
        "PostgreSQL backups verified and restore tested",
    ],
    "Low",
    "Phase 9 (security hardening complete, all tests passing)",
    "Production dashboard live on Render with monitoring active. Health checks passing. "
    "Logs searchable in Render dashboard. Backup strategy documented and tested. "
    "SuperAdmin can log in and manage all aspects of the system.",
    "Final Render checklist: (1) Upgrade PostgreSQL to Starter+ for automatic backups, "
    "(2) Set health check path to /api/v1/health, (3) Configure notification emails for "
    "deploy failures, (4) Enable Render's zero-downtime deploys, (5) Set up custom domain "
    "with Render's free SSL certificate."
)

# ── APPENDIX: ROLE PERMISSIONS MATRIX ──
story.append(Paragraph("APPENDIX: ROLE PERMISSIONS MATRIX", styles['PhaseTitle']))
story.append(Spacer(1, 0.2 * inch))

perm_data = [
    ["Resource / Action", "SuperAdmin", "Admin", "Manager", "Viewer"],
    ["Users - Create", "YES", "YES", "NO", "NO"],
    ["Users - Read", "YES", "YES", "NO", "NO"],
    ["Users - Update", "YES", "YES", "NO", "NO"],
    ["Users - Deactivate", "YES", "NO", "NO", "NO"],
    ["Roles - Manage", "YES", "NO", "NO", "NO"],
    ["Departments - Create", "YES", "YES", "NO", "NO"],
    ["Departments - Read", "YES", "YES", "YES", "YES"],
    ["Departments - Update", "YES", "YES", "YES", "NO"],
    ["Departments - Delete", "YES", "NO", "NO", "NO"],
    ["Dept Modules - Access", "YES", "YES", "YES", "YES"],
    ["Dept Modules - Configure", "YES", "YES", "NO", "NO"],
    ["Audit Logs - Read", "YES", "YES", "YES", "YES"],
    ["Sessions - View", "YES", "NO", "NO", "NO"],
    ["Sessions - Revoke", "YES", "NO", "NO", "NO"],
    ["System Settings", "YES", "NO", "NO", "NO"],
    ["Maintenance Mode", "YES", "NO", "NO", "NO"],
]

perm_table = Table(perm_data, colWidths=[2.2*inch, 1.1*inch, 1.1*inch, 1.1*inch, 1.1*inch])
perm_table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), HexColor('#0f3460')),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTNAME', (0, 1), (0, -1), 'Helvetica-Bold'),
    ('FONTNAME', (1, 1), (-1, -1), 'Helvetica'),
    ('FONTSIZE', (0, 0), (-1, -1), 8),
    ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
    ('ALIGN', (0, 0), (0, -1), 'LEFT'),
    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ('GRID', (0, 0), (-1, -1), 0.5, HexColor('#ccccdd')),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ('TOPPADDING', (0, 0), (-1, -1), 5),
    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, HexColor('#f5f5fa')]),
]))

# Color YES green, NO red
for row in range(1, len(perm_data)):
    for col in range(1, 5):
        if perm_data[row][col] == "YES":
            perm_table.setStyle(TableStyle([
                ('TEXTCOLOR', (col, row), (col, row), HexColor('#0a8f0a')),
                ('FONTNAME', (col, row), (col, row), 'Helvetica-Bold'),
            ]))
        else:
            perm_table.setStyle(TableStyle([
                ('TEXTCOLOR', (col, row), (col, row), HexColor('#cc2222')),
            ]))

story.append(perm_table)
story.append(Spacer(1, 0.3 * inch))
story.append(Paragraph(
    "This document is a living blueprint. Each phase should be reviewed and adjusted based on "
    "actual implementation learnings. The modular architecture ensures that future departments "
    "can be added without touching the core system.",
    styles['BodyText2']
))
story.append(Spacer(1, 0.2*inch))
story.append(Paragraph(
    "Prepared for Mineblock LLC | March 2026 | Confidential",
    ParagraphStyle('footer', parent=styles['Normal'], fontSize=8, textColor=HexColor('#999999'), alignment=TA_CENTER)
))

# ── BUILD PDF ──
doc.build(story)
print(f"PDF generated: {OUTPUT_PATH}")
