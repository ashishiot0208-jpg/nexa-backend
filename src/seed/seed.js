import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import {
  Alarm, AlarmEvent, AuditEvent, BacktestRun, BaselineVersion, CalibrationVersion, CameraSource, CorrelationModel,
  Dashboard, DashboardTemplate, DashboardVersion, DecisionSnapshot, DerivedReading, Device, DeviceCommand, DeviceTelemetry, Document,
  Instrument, InstrumentCatalog, LatestState, LogbookEvent, MediaAsset, Notification, Organization, OrganizationMember,
  Project, ProjectMember, RawReading, Report, RuleSet, SensorChannel, Site, UseCaseTemplate, User, Zone
} from '../models/index.js';
import { sha256 } from '../utils/crypto.js';
import { processTelemetry } from '../services/telemetry.service.js';

await connectDb();
console.log('Connected to MongoDB. Clearing GeoNexa collections...');
for (const Model of [AlarmEvent,Alarm,DecisionSnapshot,Notification,AuditEvent,LatestState,DerivedReading,RawReading,DeviceCommand,DeviceTelemetry,BacktestRun,CorrelationModel,MediaAsset,CameraSource,Document,LogbookEvent,Report,DashboardVersion,Dashboard,CalibrationVersion,BaselineVersion,SensorChannel,Instrument,Device,Zone,Site,ProjectMember,Project,RuleSet,DashboardTemplate,InstrumentCatalog,UseCaseTemplate,OrganizationMember,User,Organization]) await Model.deleteMany({});

const org = await Organization.create({ name: 'GeoNexa Demonstration', code: 'GEONEXA-DEMO', timezone: 'Asia/Kolkata' });
const users = {};
for (const u of [
  ['admin','admin@geonexa.local','GeoNexa Admin','Admin@123','ADMINISTRATOR'],
  ['engineer','engineer@geonexa.local','Demo Geotechnical Engineer','Engineer@123','ENGINEER'],
  ['operator','operator@geonexa.local','Monitoring Operator','Operator@123','OPERATOR'],
  ['viewer','viewer@geonexa.local','Client Viewer','Viewer@123','VIEWER']
]) {
  const user = await User.create({ email:u[1], displayName:u[2], passwordHash:await bcrypt.hash(u[3],12), status:'ACTIVE' });
  await OrganizationMember.create({ organizationId:org._id,userId:user._id,organizationRole:u[4],status:'ACTIVE' });
  users[u[0]]=user;
}

const useCases = [
  {code:'LANDSLIDE_SLOPE',name:'Landslide / Slope Monitoring',summary:'Movement, pore pressure, rainfall and spatial confirmation for slopes and landslides.',recommendedHierarchy:['Site','Slope','Zone'],recommendedInstruments:['INCLINOMETER','TILTMETER','PIEZOMETER','RAIN_GAUGE','GNSS','CAMERA'],recommendedCorrelations:['RAINFALL_PORE_PRESSURE','PORE_PRESSURE_MOVEMENT','SPATIAL_CONFIRMATION'],terminology:{primary:'Slope',secondary:'Zone'},dashboardTemplateName:'Slope Engineering Overview',navigationEmphasis:['overview','map','instruments','alarms']},
  {code:'TUNNEL',name:'Tunnel Monitoring',summary:'Convergence, settlement, tilt and excavation/TBM context by section and chainage.',recommendedHierarchy:['Project','Alignment','Chainage Section'],recommendedInstruments:['TUNNEL_CONVERGENCE','TILTMETER','CRACKMETER','PIEZOMETER','CAMERA'],recommendedCorrelations:['EXCAVATION_CONVERGENCE','SECTION_CONFIRMATION'],terminology:{primary:'Alignment',secondary:'Chainage'},dashboardTemplateName:'Tunnel Convergence Overview'},
  {code:'DAM',name:'Dam Monitoring',summary:'Reservoir, pore pressure, seepage, settlement and movement monitoring.',recommendedHierarchy:['Dam','Block','Zone'],recommendedInstruments:['PIEZOMETER','INCLINOMETER','SETTLEMENT','CRACKMETER','RAIN_GAUGE','CAMERA'],recommendedCorrelations:['RESERVOIR_PORE_PRESSURE','SEEPAGE_MOVEMENT'],terminology:{primary:'Dam',secondary:'Block'},dashboardTemplateName:'Dam Safety Overview'},
  {code:'RETAINING_WALL',name:'Retaining Wall / Excavation',summary:'Wall deflection, groundwater and support-load monitoring.',recommendedHierarchy:['Site','Excavation','Wall Section'],recommendedInstruments:['INCLINOMETER','TILTMETER','PIEZOMETER','SETTLEMENT','CAMERA'],recommendedCorrelations:['EXCAVATION_DEFLECTION','GROUNDWATER_DEFLECTION'],terminology:{primary:'Excavation',secondary:'Wall Section'},dashboardTemplateName:'Retaining Wall Overview'},
  {code:'BRIDGE',name:'Bridge / Structure',summary:'Structural strain, tilt, vibration, displacement and temperature monitoring.',recommendedHierarchy:['Bridge','Span','Zone'],recommendedInstruments:['TILTMETER','CRACKMETER','VIBRATION','GNSS','CAMERA'],recommendedCorrelations:['TEMPERATURE_STRAIN','LOAD_VIBRATION'],terminology:{primary:'Bridge',secondary:'Span'},dashboardTemplateName:'Bridge Structural Overview'},
  {code:'EMBANKMENT',name:'Embankment / Road / Rail',summary:'Settlement, lateral movement, groundwater and weather monitoring.',recommendedHierarchy:['Alignment','Chainage','Zone'],recommendedInstruments:['SETTLEMENT','INCLINOMETER','PIEZOMETER','GNSS','RAIN_GAUGE'],recommendedCorrelations:['RAINFALL_SETTLEMENT','WATER_LATERAL_MOVEMENT'],terminology:{primary:'Alignment',secondary:'Chainage'},dashboardTemplateName:'Embankment Overview'},
  {code:'MINING_OPEN_PIT',name:'Mining / Open Pit',summary:'Pit/slope movement, events, rainfall and visual context.',recommendedHierarchy:['Mine','Pit','Slope Zone'],recommendedInstruments:['GNSS','INCLINOMETER','TILTMETER','RAIN_GAUGE','CAMERA'],recommendedCorrelations:['BLAST_MOVEMENT','RAIN_MOVEMENT','SPATIAL_CONFIRMATION'],terminology:{primary:'Pit',secondary:'Slope Zone'},dashboardTemplateName:'Open Pit Overview'},
  {code:'GENERIC_GEOTECHNICAL',name:'Generic Geotechnical',summary:'Configurable monitoring project for mixed geotechnical instrumentation.',recommendedHierarchy:['Site','Zone'],recommendedInstruments:['TILTMETER','PIEZOMETER'],recommendedCorrelations:['USER_DEFINED'],terminology:{primary:'Site',secondary:'Zone'},dashboardTemplateName:'Generic Engineering Overview'}
];
for (const u of useCases) await UseCaseTemplate.create({...u,version:1,status:'APPROVED'});

const catalogs = [
 {code:'INCLINOMETER',name:'Automatic Inclinometer',category:'Movement',defaultVisualizations:['DEPTH_PROFILE','TREND','VECTOR','HEATMAP'],defaultChannels:[
   {code:'X',sourceField:'inc_x',parameterCode:'disp_x_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:-100,physicalMax:100,maxStep:5,maxRatePerHour:10}},
   {code:'Y',sourceField:'inc_y',parameterCode:'disp_y_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:-100,physicalMax:100,maxStep:5,maxRatePerHour:10}},
   {code:'TEMP',sourceField:'inc_temp',parameterCode:'temperature_c',rawUnit:'C',engineeringUnit:'C',qualityConfig:{physicalMin:-20,physicalMax:80,maxStep:15}}
 ]},
 {code:'TILTMETER',name:'Tiltmeter',category:'Movement',defaultVisualizations:['VECTOR','TREND','VALUE_CARD'],defaultChannels:[
   {code:'X',sourceField:'tilt_x',parameterCode:'tilt_x_deg',rawUnit:'deg',engineeringUnit:'deg',qualityConfig:{physicalMin:-30,physicalMax:30,maxStep:3}},
   {code:'Y',sourceField:'tilt_y',parameterCode:'tilt_y_deg',rawUnit:'deg',engineeringUnit:'deg',qualityConfig:{physicalMin:-30,physicalMax:30,maxStep:3}},
   {code:'TEMP',sourceField:'tilt_temp',parameterCode:'temperature_c',rawUnit:'C',engineeringUnit:'C',qualityConfig:{physicalMin:-20,physicalMax:80}}
 ]},
 {code:'PIEZOMETER',name:'Vibrating Wire Piezometer',category:'Groundwater',defaultVisualizations:['TREND','WATER_HEAD','RAINFALL_CORRELATION'],defaultChannels:[
   {code:'PRESSURE',sourceField:'pore_pressure',parameterCode:'pore_pressure_kpa',rawUnit:'kPa',engineeringUnit:'kPa',qualityConfig:{physicalMin:0,physicalMax:500,maxStep:50,maxRatePerHour:100}}
 ]},
 {code:'RAIN_GAUGE',name:'Rain Gauge',category:'Environmental',defaultVisualizations:['BAR','ACCUMULATION','CORRELATION'],defaultChannels:[
   {code:'RAIN',sourceField:'rain_15m',parameterCode:'rain_15m_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:0,physicalMax:100,maxStep:50}}
 ]},
 {code:'TUNNEL_CONVERGENCE',name:'Tunnel Convergence Array',category:'Tunnel',defaultVisualizations:['TUNNEL_SECTION','TREND'],defaultChannels:[
   {code:'H',sourceField:'conv_h',parameterCode:'convergence_horizontal_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:-100,physicalMax:100,maxStep:10}},
   {code:'V',sourceField:'conv_v',parameterCode:'convergence_vertical_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:-100,physicalMax:100,maxStep:10}}
 ]},
 {code:'CRACKMETER',name:'Crackmeter / Extensometer',category:'Structural',defaultVisualizations:['TREND','VALUE_CARD'],defaultChannels:[{code:'OPEN',sourceField:'crack_opening',parameterCode:'crack_opening_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:-20,physicalMax:100,maxStep:5}}]},
 {code:'SETTLEMENT',name:'Settlement Sensor',category:'Movement',defaultVisualizations:['PROFILE','TREND'],defaultChannels:[{code:'SET',sourceField:'settlement',parameterCode:'settlement_mm',rawUnit:'mm',engineeringUnit:'mm',qualityConfig:{physicalMin:-500,physicalMax:500,maxStep:20}}]},
 {code:'GNSS',name:'GNSS Monitoring Point',category:'Position',defaultVisualizations:['MAP','VECTOR','TREND'],defaultChannels:[{code:'DISP',sourceField:'gnss_disp',parameterCode:'gnss_displacement_mm',rawUnit:'mm',engineeringUnit:'mm'}]},
 {code:'VIBRATION',name:'Vibration / Accelerometer',category:'Dynamic',defaultVisualizations:['TREND','FFT'],defaultChannels:[{code:'RMS',sourceField:'vibration_rms',parameterCode:'vibration_rms',rawUnit:'g',engineeringUnit:'g'}]},
 {code:'CAMERA',name:'Camera',category:'Vision',defaultVisualizations:['SNAPSHOT','TIMELINE'],defaultChannels:[]}
];
for (const c of catalogs) await InstrumentCatalog.create(c);

const dashboards = [
 {code:'SLOPE_DEFAULT',name:'Slope Engineering Overview',useCaseCodes:['LANDSLIDE_SLOPE'],widgets:[{type:'STATUS_HEADER'},{type:'SITE_MAP'},{type:'MOVEMENT_TREND'},{type:'PORE_PRESSURE_TREND'},{type:'RAINFALL'},{type:'OPEN_ALARMS'},{type:'DECISION_EVIDENCE'}]},
 {code:'TUNNEL_DEFAULT',name:'Tunnel Convergence Overview',useCaseCodes:['TUNNEL'],widgets:[{type:'STATUS_HEADER'},{type:'TUNNEL_SECTION'},{type:'CONVERGENCE_TREND'},{type:'OPEN_ALARMS'}]},
 {code:'DAM_DEFAULT',name:'Dam Safety Overview',useCaseCodes:['DAM'],widgets:[{type:'STATUS_HEADER'},{type:'DAM_SECTION'},{type:'PORE_PRESSURE_TREND'},{type:'SETTLEMENT_TREND'},{type:'OPEN_ALARMS'}]},
 {code:'GENERIC_DEFAULT',name:'Generic Engineering Overview',useCaseCodes:['GENERIC_GEOTECHNICAL','RETAINING_WALL','BRIDGE','EMBANKMENT','MINING_OPEN_PIT'],widgets:[{type:'STATUS_HEADER'},{type:'SITE_MAP'},{type:'MULTI_TREND'},{type:'OPEN_ALARMS'}]}
];
const dashboardDocs={}; for(const d of dashboards){const x=await DashboardTemplate.create({...d,version:1,status:'APPROVED',layout:{columns:12}});dashboardDocs[d.code]=x;}

const slopeRules=await RuleSet.create({organizationId:org._id,code:'SLOPE_STANDARD',name:'Slope Standard Demo Rules',useCaseCodes:['LANDSLIDE_SLOPE'],version:1,status:'ACTIVE',description:'Demonstration deterministic thresholds. Replace with project-approved engineering criteria before real deployment.',rules:[
 {id:'DISP_WATCH',name:'Resultant movement watch',type:'ABSOLUTE',parameterCode:'disp_resultant_mm',operator:'>',threshold:5,severity:'S1',reasonCode:'DISPLACEMENT_WATCH'},
 {id:'DISP_REVIEW',name:'Resultant movement review',type:'ABSOLUTE',parameterCode:'disp_resultant_mm',operator:'>',threshold:8,severity:'S2',reasonCode:'DISPLACEMENT_S2'},
 {id:'DISP_ALERT',name:'Resultant movement alert',type:'ABSOLUTE',parameterCode:'disp_resultant_mm',operator:'>',threshold:11,severity:'S3',reasonCode:'DISPLACEMENT_S3'},
 {id:'PORE_REVIEW',name:'Pore pressure review',type:'ABSOLUTE',parameterCode:'pore_pressure_kpa',operator:'>',threshold:120,severity:'S2',reasonCode:'PORE_PRESSURE_HIGH'},
 {id:'RAIN_WATCH',name:'High 15-minute rainfall',type:'ABSOLUTE',parameterCode:'rain_15m_mm',operator:'>',threshold:7,severity:'S1',reasonCode:'RAINFALL_HIGH'}
],tarpActions:{S1:['WATCH'],S2:['ENGINEER_REVIEW'],S3:['TARP_LEVEL_3'],S4:['URGENT_ESCALATION']},approvedBy:users.engineer._id,approvedAt:new Date()});
const tunnelRules=await RuleSet.create({organizationId:org._id,code:'TUNNEL_STANDARD',name:'Tunnel Standard Demo Rules',useCaseCodes:['TUNNEL'],version:1,status:'ACTIVE',description:'Demo convergence rules.',rules:[{id:'CONV_S1',name:'Convergence watch',type:'ABSOLUTE',parameterCode:'convergence_horizontal_mm',operator:'>',threshold:5,severity:'S1',reasonCode:'CONVERGENCE_WATCH'},{id:'CONV_S2',name:'Convergence review',type:'ABSOLUTE',parameterCode:'convergence_horizontal_mm',operator:'>',threshold:10,severity:'S2',reasonCode:'CONVERGENCE_S2'}],approvedBy:users.engineer._id,approvedAt:new Date()});
const damRules=await RuleSet.create({organizationId:org._id,code:'DAM_STANDARD',name:'Dam Standard Demo Rules',useCaseCodes:['DAM'],version:1,status:'ACTIVE',description:'Demo pore-pressure rules.',rules:[{id:'DAM_PORE_S1',name:'Pore pressure watch',type:'ABSOLUTE',parameterCode:'pore_pressure_kpa',operator:'>',threshold:150,severity:'S1',reasonCode:'PORE_PRESSURE_WATCH'},{id:'DAM_PORE_S2',name:'Pore pressure review',type:'ABSOLUTE',parameterCode:'pore_pressure_kpa',operator:'>',threshold:180,severity:'S2',reasonCode:'PORE_PRESSURE_S2'}],approvedBy:users.engineer._id,approvedAt:new Date()});

async function createProject({code,name,useCaseCode,location,dashboardCode,ruleSet,hierarchy,instruments,deviceId,deviceKey}){
 const uc=await UseCaseTemplate.findOne({code:useCaseCode});
 const p=await Project.create({organizationId:org._id,name,code,clientName:'GeoNexa Demo Client',location,timezone:'Asia/Kolkata',status:'ACTIVE',useCaseTemplateId:uc._id,useCaseCode,dashboardTemplateId:dashboardDocs[dashboardCode]._id,ruleSetId:ruleSet._id,correlations:uc.recommendedCorrelations});
 for(const u of Object.values(users)) await ProjectMember.create({projectId:p._id,userId:u._id,role:(await OrganizationMember.findOne({userId:u._id})).organizationRole,status:'ACTIVE'});
 let parentId=null,site=null,zone=null;
 for(let i=0;i<hierarchy.length;i++){const h=hierarchy[i];if(i===hierarchy.length-1){zone=await Zone.create({organizationId:org._id,projectId:p._id,siteId:site?._id,name:h,type:'ZONE'});}else{const s=await Site.create({organizationId:org._id,projectId:p._id,name:h,type:i===0?'SITE':'STRUCTURE',parentId,level:i});site ||= s;parentId=s._id;}}
 const device=await Device.create({organizationId:org._id,projectId:p._id,deviceId,name:`${name} Logger`,deviceType:'LOGGER',transport:'4G',firmware:'2.1.4',apiKeyHash:sha256(deviceKey),apiKeyPrefix:deviceKey.slice(0,10),status:'ONLINE',healthGrade:'H0',expectedIntervalSec:900,lastSeenAt:new Date()});
 const created={};
 for(let i=0;i<instruments.length;i++){const cat=await InstrumentCatalog.findOne({code:instruments[i]});const inst=await Instrument.create({organizationId:org._id,projectId:p._id,siteId:site?._id,zoneId:zone?._id,catalogCode:cat.code,name:`${cat.name} ${i+1}`,code:`${cat.code}-${String(i+1).padStart(2,'0')}`,serial:`${code}-${cat.code}-${i+1}`,installDate:new Date(Date.now()-30*86400000),status:'COMMISSIONED',commissionedAt:new Date(Date.now()-29*86400000),commissionedBy:users.engineer._id});created[cat.code]=inst;for(const ch of cat.defaultChannels||[])await SensorChannel.create({organizationId:org._id,projectId:p._id,instrumentId:inst._id,deviceId:device._id,code:`${inst.code}-${ch.code}`,sourceField:ch.sourceField||ch.code,parameterCode:ch.parameterCode,rawUnit:ch.rawUnit,engineeringUnit:ch.engineeringUnit,sampleIntervalSec:900,calibration:{scale:1,offset:0,version:1},baseline:{value:0,capturedAt:new Date(Date.now()-29*86400000),version:1},qualityConfig:ch.qualityConfig||{}});}
 const d=await Dashboard.create({organizationId:org._id,projectId:p._id,name:'Project Overview',ownerId:users.admin._id,templateType:useCaseCode});const dv=await DashboardVersion.create({dashboardId:d._id,versionNo:1,status:'PUBLISHED',layoutJson:{widgets:dashboardDocs[dashboardCode].widgets,layout:dashboardDocs[dashboardCode].layout},schemaVersion:1,createdBy:users.admin._id,publishedAt:new Date()});d.currentPublishedVersionId=dv._id;await d.save();
 return {project:p,device,instruments:created,site,zone};
}

const slope=await createProject({code:'NH-10',name:'NH-10 Slope Monitoring',useCaseCode:'LANDSLIDE_SLOPE',location:'NH-10, Sikkim',dashboardCode:'SLOPE_DEFAULT',ruleSet:slopeRules,hierarchy:['NH-10 Corridor','Landslide Sector A','Upper Slope Zone'],instruments:['INCLINOMETER','PIEZOMETER','RAIN_GAUGE','TILTMETER'],deviceId:'GW-018',deviceKey:'DEMO-GW-018-KEY'});
const tunnel=await createProject({code:'TN-01',name:'East Portal Tunnel Monitoring',useCaseCode:'TUNNEL',location:'Demo Tunnel Site',dashboardCode:'TUNNEL_DEFAULT',ruleSet:tunnelRules,hierarchy:['East Portal','Tunnel Alignment','Chainage 0+450'],instruments:['TUNNEL_CONVERGENCE','TILTMETER'],deviceId:'GW-TN-01',deviceKey:'DEMO-TN-01-KEY'});
const dam=await createProject({code:'DM-01',name:'Reservoir Dam Monitoring',useCaseCode:'DAM',location:'Demo Reservoir',dashboardCode:'DAM_DEFAULT',ruleSet:damRules,hierarchy:['Main Dam','Block B','Drainage Gallery'],instruments:['PIEZOMETER','INCLINOMETER'],deviceId:'GW-DM-01',deviceKey:'DEMO-DM-01-KEY'});

await CameraSource.create({organizationId:org._id,projectId:slope.project._id,siteId:slope.site._id,zoneId:slope.zone._id,name:'Slope Camera 01',sourceMode:'SNAPSHOT',expectedCaptureSec:900,timezone:'Asia/Kolkata',healthState:'ONLINE',lastImageAt:new Date()});
await LogbookEvent.insertMany([
 {organizationId:org._id,projectId:slope.project._id,siteId:slope.site._id,zoneId:slope.zone._id,eventType:'RAINFALL',occurredAt:new Date(Date.now()-3*3600000),title:'Heavy rainfall event',description:'Site team reported intense rainfall during afternoon.',createdBy:users.operator._id},
 {organizationId:org._id,projectId:slope.project._id,siteId:slope.site._id,zoneId:slope.zone._id,eventType:'INSPECTION',occurredAt:new Date(Date.now()-20*3600000),title:'Routine slope inspection',description:'No visible distress noted at inspection time.',createdBy:users.engineer._id}
]);

console.log('Generating realistic sample telemetry...');
for(let i=0;i<48;i++){
 const t=new Date(Date.now()-(47-i)*15*60000);
 const late=i>37;
 const incX=1.0+i*0.10+(late?(i-37)*0.32:0);
 const incY=0.6+i*0.065+(late?(i-37)*0.22:0);
 const pressure=88+i*0.45+(late?(i-37)*1.55:0);
 const rain=late?(i%3===0?9.2:5.8):(i%10===0?2.1:0.4);
 const tiltX=0.08+i*0.003+(late?(i-37)*0.012:0);
 const tiltY=0.04+i*0.002;
 await processTelemetry({device:slope.device,payload:{schemaVersion:'1.0',messageId:`NH10-${1000+i}`,sampleTime:t.toISOString(),channels:{inc_x:Number(incX.toFixed(3)),inc_y:Number(incY.toFixed(3)),inc_temp:29+(i%6)*0.3,pore_pressure:Number(pressure.toFixed(2)),rain_15m:Number(rain.toFixed(2)),tilt_x:Number(tiltX.toFixed(3)),tilt_y:Number(tiltY.toFixed(3)),tilt_temp:29.5},health:{batteryV:i>44?3.38:3.72,rssiDbm:i>44?-98:-76,network:'4G'}},emit:()=>{}});
}
for(let i=0;i<16;i++){
 const t=new Date(Date.now()-(15-i)*30*60000);
 await processTelemetry({device:tunnel.device,payload:{messageId:`TN-${2000+i}`,sampleTime:t.toISOString(),channels:{conv_h:Number((2.2+i*0.18).toFixed(2)),conv_v:Number((1.1+i*0.09).toFixed(2)),tilt_x:0.1+i*0.004,tilt_y:0.05+i*0.002,tilt_temp:27.5},health:{batteryV:3.78,rssiDbm:-72,network:'4G'}},emit:()=>{}});
 await processTelemetry({device:dam.device,payload:{messageId:`DM-${3000+i}`,sampleTime:t.toISOString(),channels:{pore_pressure:Number((138+i*1.3).toFixed(1)),inc_x:Number((0.8+i*0.05).toFixed(2)),inc_y:Number((0.4+i*0.03).toFixed(2)),inc_temp:26.5},health:{batteryV:3.81,rssiDbm:-69,network:'4G'}},emit:()=>{}});
}

const model=await CorrelationModel.create({organizationId:org._id,projectId:slope.project._id,name:'Rainfall vs Pore Pressure Demo',purpose:'Advisory correlation starter',scope:{zoneId:slope.zone._id},ownerId:users.engineer._id,status:'APPROVED',versions:[{version:1,status:'APPROVED',graphJson:{nodes:[{id:'rain',type:'INPUT',parameterCode:'rain_15m_mm'},{id:'pore',type:'INPUT',parameterCode:'pore_pressure_kpa'},{id:'corr',type:'CORRELATION',method:'PEARSON'}],edges:[{source:'rain',target:'corr'},{source:'pore',target:'corr'}]},validationResult:{valid:true,errors:[]},approvedAt:new Date(),approvedBy:users.engineer._id}],activeVersion:1});

console.log('\nSeed complete.');
console.log('Users:');
console.log('  admin@geonexa.local / Admin@123');
console.log('  engineer@geonexa.local / Engineer@123');
console.log('  operator@geonexa.local / Operator@123');
console.log('  viewer@geonexa.local / Viewer@123');
console.log('\nDevice API keys:');
console.log('  GW-018   -> DEMO-GW-018-KEY');
console.log('  GW-TN-01 -> DEMO-TN-01-KEY');
console.log('  GW-DM-01 -> DEMO-DM-01-KEY');
console.log(`\nSeeded projects: ${slope.project.code}, ${tunnel.project.code}, ${dam.project.code}`);
await disconnectDb();
