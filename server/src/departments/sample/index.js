import BaseDepartment from '../base.js';

export default class SampleDepartment extends BaseDepartment {
  constructor() {
    super({
      name: 'Sample Department',
      slug: 'sample',
      version: '1.0.0',
      description: 'A sample department module showing the pluggable architecture pattern'
    });
  }

  registerRoutes(router) {
    router.get('/', (req, res) => {
      res.json({
        department: this.getMetadata(),
        message: 'Welcome to the Sample Department',
        endpoints: [
          { method: 'GET', path: '/', description: 'Department info' },
          { method: 'GET', path: '/items', description: 'List items' }
        ]
      });
    });

    router.get('/items', (req, res) => {
      res.json({
        items: [],
        total: 0,
        message: 'No items yet. This is a sample department.'
      });
    });
  }
}
