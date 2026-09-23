import { Router } from 'express';
import { LogbookEvent } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
const router=Router();router.use(requireAuth);
router.get('/projects/:projectId/logbook',asyncHandler(async(req,res)=>res.json(await LogbookEvent.find({projectId:req.params.projectId,organizationId:req.auth.organizationId}).sort({occurredAt:-1}).lean())));
router.post('/projects/:projectId/logbook',asyncHandler(async(req,res)=>res.status(201).json(await LogbookEvent.create({organizationId:req.auth.organizationId,projectId:req.params.projectId,siteId:req.body.siteId,zoneId:req.body.zoneId,eventType:req.body.eventType,title:req.body.title,description:req.body.description,occurredAt:new Date(req.body.occurredAt||Date.now()),attachments:req.body.attachments||[],createdBy:req.auth.userId,metadata:req.body.metadata||{}}))));
export default router;
