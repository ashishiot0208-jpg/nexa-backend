import { Router } from 'express';
import { DashboardTemplate, InstrumentCatalog, RuleSet, UseCaseTemplate } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router();
router.use(requireAuth);

router.get('/use-case-templates', asyncHandler(async (_req, res) => {
  const rows = await UseCaseTemplate.find({ status: 'APPROVED' }).sort({ name: 1 }).lean();
  res.json(rows.map((u) => ({ id: u._id, code: u.code, name: u.name, summary: u.summary, recommendedHierarchy: u.recommendedHierarchy, recommendedInstruments: u.recommendedInstruments, recommendedCorrelations: u.recommendedCorrelations, terminology: u.terminology || {}, dashboardTemplateName: u.dashboardTemplateName, version: u.version })));
}));

router.get('/instrument-catalog', asyncHandler(async (_req, res) => {
  const rows = await InstrumentCatalog.find().sort({ category: 1, name: 1 }).lean();
  res.json(rows.map((x) => ({ id: x._id, code: x.code, name: x.name, category: x.category, parameters: x.parameters, defaultVisualizations: x.defaultVisualizations })));
}));

router.get('/configuration/:code', asyncHandler(async (req, res) => {
  const useCase = await UseCaseTemplate.findOne({ code: req.params.code.toUpperCase(), status: 'APPROVED' }).lean();
  if (!useCase) throw new ApiError(404, 'Use-case template not found');
  const [dashboards, ruleSets] = await Promise.all([
    DashboardTemplate.find({ status: 'APPROVED', useCaseCodes: useCase.code }).sort({ version: -1 }).lean(),
    RuleSet.find({ status: { $in: ['APPROVED', 'ACTIVE'] }, $or: [{ organizationId: req.auth.organizationId }, { organizationId: null }], useCaseCodes: useCase.code }).sort({ version: -1 }).lean()
  ]);
  res.json({ useCase: { ...useCase, id: useCase._id }, dashboards: dashboards.map((d) => ({ id: d._id, name: d.name, version: d.version, status: d.status })), ruleSets: ruleSets.map((r) => ({ id: r._id, name: r.name, version: r.version, status: r.status, description: r.description })) });
}));

export default router;
