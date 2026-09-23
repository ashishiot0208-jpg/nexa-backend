import { Router } from 'express';
import { DecisionSnapshot } from '../models/index.js';
import { requireAuth, requireProjectAccess, ensureProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';

const router = Router(); router.use(requireAuth);
router.get('/projects/:projectId/decisions', requireProjectAccess, asyncHandler(async (req, res) => {
  const limit=Math.min(Number(req.query.limit||50),200); const q={projectId:req.params.projectId}; if(req.query.instrumentId) q.instrumentId=req.query.instrumentId; if(req.query.severity) q.severity={$in:String(req.query.severity).split(',')};
  res.json(await DecisionSnapshot.find(q).sort({evaluatedAt:-1}).limit(limit).lean());
}));
router.get('/decisions/:id', asyncHandler(async (req,res)=>{const d=await DecisionSnapshot.findOne({_id:req.params.id,organizationId:req.auth.organizationId}).lean(); if(!d) throw new ApiError(404,'Decision not found'); await ensureProjectAccess(req,d.projectId); res.json(d);}));
router.get('/decisions/:id/trace', asyncHandler(async (req,res)=>{const d=await DecisionSnapshot.findOne({_id:req.params.id,organizationId:req.auth.organizationId}).lean(); if(!d) throw new ApiError(404,'Decision not found'); await ensureProjectAccess(req,d.projectId); res.json({decisionId:d._id,decisionCode:d.decisionCode,severity:d.severity,severityFloor:d.severityFloor,confidence:d.confidence,monitoringHealth:d.monitoringHealth,reasonCodes:d.reasonCodes,matchedRules:d.matchedRules,evidence:d.evidence,trace:d.trace,inputReadingIds:d.inputReadingIds,ruleSetId:d.ruleSetId,ruleSetVersion:d.ruleSetVersion});}));
export default router;
