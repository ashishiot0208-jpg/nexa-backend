import { Router } from 'express';
import crypto from 'node:crypto';
import { Device, DeviceCommand } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireDevice } from '../middleware/device-auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { ApiError } from '../utils/api-error.js';
import { audit } from '../services/audit.service.js';

const router=Router();
router.post('/device/:id/commands',requireAuth,asyncHandler(async(req,res)=>{const device=await Device.findOne({_id:req.params.id,organizationId:req.auth.organizationId});if(!device)throw new ApiError(404,'Device not found');const commandId=`CMD-${crypto.randomUUID()}`;const cmd=await DeviceCommand.create({organizationId:device.organizationId,projectId:device.projectId,deviceMongoId:device._id,commandId,commandType:req.body.commandType,payload:req.body.payload||{},expiresAt:new Date(Date.now()+Number(req.body.ttlSec||3600)*1000),requestedBy:req.auth.userId});await audit({req,projectId:device.projectId,action:'DEVICE_COMMAND_QUEUED',resourceType:'DeviceCommand',resourceId:cmd._id,newState:cmd.toObject()});req.app.locals.emitEvent('device.command_queued',{projectId:device.projectId,deviceId:device.deviceId,commandId,commandType:cmd.commandType});res.status(202).json(cmd);}));
router.get('/device/:deviceId/commands/pending',requireDevice,asyncHandler(async(req,res)=>{await DeviceCommand.updateMany({deviceMongoId:req.device._id,status:'QUEUED',expiresAt:{$lt:new Date()}},{$set:{status:'EXPIRED'}});const cmds=await DeviceCommand.find({deviceMongoId:req.device._id,status:'QUEUED',expiresAt:{$gte:new Date()}}).sort({createdAt:1}).limit(20).lean();res.json(cmds.map(c=>({commandId:c.commandId,commandType:c.commandType,payload:c.payload,expiresAt:c.expiresAt})));}));
router.post('/device/:deviceId/commands/:commandId/ack',requireDevice,asyncHandler(async(req,res)=>{const cmd=await DeviceCommand.findOne({deviceMongoId:req.device._id,commandId:req.params.commandId});if(!cmd)throw new ApiError(404,'Command not found');cmd.status=req.body.status||'EXECUTED';cmd.acknowledgedAt=new Date();cmd.result=req.body.result;cmd.failureReason=req.body.failureReason;await cmd.save();req.app.locals.emitEvent('device.command_ack',{projectId:req.device.projectId,deviceId:req.device.deviceId,commandId:cmd.commandId,status:cmd.status});res.json(cmd);}));
export default router;
