import { Router } from 'express';
import { Alarm, AlarmEvent } from '../models/index.js';
import { requireAuth, requireProjectAccess, ensureProjectAccess } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { transitionAlarm } from '../services/alarm.service.js';
import { ApiError } from '../utils/api-error.js';

const router = Router(); router.use(requireAuth);
router.get('/projects/:projectId/alarms', requireProjectAccess, asyncHandler(async (req,res)=>{const q={projectId:req.params.projectId}; if(req.query.state) q.state={$in:String(req.query.state).split(',')}; if(req.query.type) q.type=req.query.type; res.json(await Alarm.find(q).sort({createdAt:-1}).lean());}));
router.get('/alarms/:id', asyncHandler(async (req,res)=>{const alarm=await Alarm.findOne({_id:req.params.id,organizationId:req.auth.organizationId}).lean(); if(!alarm) throw new ApiError(404,'Alarm not found'); await ensureProjectAccess(req,alarm.projectId); const events=await AlarmEvent.find({alarmId:alarm._id}).sort({createdAt:1}).lean(); res.json({alarm,events});}));
router.post('/alarms/:id/transition', asyncHandler(async (req,res)=>res.json(await transitionAlarm({alarmId:req.params.id,toState:req.body.toState,comment:req.body.comment,actionCode:req.body.actionCode,resolutionCode:req.body.resolutionCode,ownerId:req.body.ownerId,req,emit:req.app.locals.emitEvent}))));
router.post('/alarms/:id/acknowledge', asyncHandler(async (req,res)=>res.json(await transitionAlarm({alarmId:req.params.id,toState:'ACKNOWLEDGED',comment:req.body.comment||'Acknowledged',req,emit:req.app.locals.emitEvent}))));
router.post('/alarms/:id/actions', asyncHandler(async (req,res)=>res.json(await transitionAlarm({alarmId:req.params.id,toState:req.body.toState||'ACTION_IN_PROGRESS',comment:req.body.comment||'Action started',actionCode:req.body.actionCode,req,emit:req.app.locals.emitEvent}))));
export default router;
