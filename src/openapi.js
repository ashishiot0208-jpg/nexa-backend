export const openApiSpec = {
  openapi: '3.0.3',
  info: { title: 'GeoNexa API', version: '1.0.0', description: 'Node.js + Express.js + MongoDB backend for GeoNexa Phase-1 engineering monitoring workflows.' },
  servers: [{ url: 'http://localhost:3000/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, deviceKey: { type: 'apiKey', in: 'header', name: 'x-device-key' } }
  },
  paths: {
    '/health': { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
    '/auth/login': { post: { summary: 'Login', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email','password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { '200': { description: 'JWT and user' } } } },
    '/projects': { get: { summary: 'List accessible projects', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Projects' } } }, post: { summary: 'Create a persisted project from the 8-step wizard', security: [{ bearerAuth: [] }], responses: { '201': { description: 'Created project' } } } },
    '/projects/{projectId}/overview': { get: { summary: 'Project engineering overview', security: [{ bearerAuth: [] }], parameters: [{ name:'projectId',in:'path',required:true,schema:{type:'string'} }], responses:{'200':{description:'Overview'}} } },
    '/telemetry/ingest': { post: { summary: 'Device telemetry ingestion', security: [{ deviceKey: [] }], responses: { '202': { description: 'Telemetry accepted and processed' } } } },
    '/projects/{projectId}/telemetry': { get: { summary: 'Historical raw/processed telemetry', security: [{ bearerAuth: [] }], parameters: [{name:'projectId',in:'path',required:true,schema:{type:'string'}}], responses:{'200':{description:'Telemetry page'}} } },
    '/projects/{projectId}/alarms': { get: { summary: 'Project alarms', security: [{ bearerAuth: [] }], parameters:[{name:'projectId',in:'path',required:true,schema:{type:'string'}}], responses:{'200':{description:'Alarm list'}} } },
    '/alarms/{id}/transition': { post: { summary: 'Apply controlled alarm state transition', security: [{ bearerAuth: [] }], parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{'200':{description:'Updated alarm'}} } }
  }
};
