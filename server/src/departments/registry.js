import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class DepartmentRegistry {
  constructor() {
    this.departments = new Map();
  }

  async loadAll() {
    const dirs = fs.readdirSync(__dirname).filter(d => {
      const fullPath = path.join(__dirname, d);
      return fs.statSync(fullPath).isDirectory() && fs.existsSync(path.join(fullPath, 'index.js'));
    });

    for (const dir of dirs) {
      try {
        const mod = await import(`./${dir}/index.js`);
        const dept = new mod.default();
        this.departments.set(dept.slug, dept);
        logger.info(`Loaded department module: ${dept.name} (${dept.slug})`);
      } catch (err) {
        logger.error(`Failed to load department module: ${dir}`, err);
      }
    }
  }

  getRouter() {
    const router = Router();
    for (const [slug, dept] of this.departments) {
      const deptRouter = Router();
      dept.registerRoutes(deptRouter);
      router.use(`/${slug}`, deptRouter);
    }
    return router;
  }

  get(slug) { return this.departments.get(slug); }
  getAll() { return Array.from(this.departments.values()); }
}

export default new DepartmentRegistry();
