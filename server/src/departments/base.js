export default class BaseDepartment {
  constructor(config) {
    this.name = config.name;
    this.slug = config.slug;
    this.version = config.version || '1.0.0';
    this.description = config.description || '';
  }

  // Override in subclass to define routes
  registerRoutes(router) {
    throw new Error('registerRoutes must be implemented');
  }

  // Called when department is activated
  async onActivate() {}

  // Called when department is deactivated
  async onDeactivate() {}

  // Return department metadata
  getMetadata() {
    return {
      name: this.name,
      slug: this.slug,
      version: this.version,
      description: this.description
    };
  }
}
