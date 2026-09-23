import { Router } from 'express';
import mongoose from 'mongoose';
const router=Router();
router.get('/health',(_req,res)=>res.json({status:'ok',service:'geonexa-backend',time:new Date().toISOString(),mongo:mongoose.connection.readyState===1?'connected':'disconnected'}));
export default router;
