#!/usr/bin/env node

import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  Project,
  Instrument,
  Device,
  SensorChannel,
  RawReading,
  DerivedReading,
  LatestState,
  Alarm,
  User,
  OrganizationMember,
  EngineeringSeverityRule,
  validateRuleThresholds
} from '../src/models/index.js';
import { evaluateSeverity, resolveApplicableRule } from '../src/services/severity.service.js';
import { getInstrumentOperationalSummary } from '../src/services/instrument-summary.service.js';

let server;
const TEST_PORT = 3105;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(TEST_PORT, '127.0.0.1', () => {
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runC3Verification() {
  console.log('====================================================');
  console.log('PHASE C3 — ENGINEERING SEVERITY RULE FOUNDATION TEST');
  console.log('====================================================');

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geonexa');
  await startServer();

  const results = {};
  const initialAlarmCount = await Alarm.countDocuments();

  try {
    // 1. Resolve Project LAN-PRO-01
    const project = await Project.findOne({ code: 'LAN-PRO-01' });
    if (!project) throw new Error('Project LAN-PRO-01 not found.');
    console.log(`[PASS] Found project: ${project.name} (${project._id})`);

    // Setup auth token for HTTP API tests
    const user = await User.findOne({ organizationId: project.organizationId }) || await User.findOne();
    const member = await OrganizationMember.findOne({ userId: user._id, status: 'ACTIVE' }).lean();
    const token = jwt.sign(
      { organizationId: project.organizationId.toString(), organizationRole: member?.organizationRole || 'OWNER' },
      env.jwtSecret,
      { subject: user._id.toString(), expiresIn: '1h' }
    );

    // Initial check: ensure no active severity rules exist on live project
    const liveRules = await EngineeringSeverityRule.find({ projectId: project._id, status: 'ACTIVE' }).lean();
    console.log(`[INFO] Current live rules count: ${liveRules.length}`);

    // Verify current live instruments return NOT EVALUATED (or S1 if development rule active)
    const inc1 = await Instrument.findOne({ projectId: project._id, code: 'INC-2026-0001' }).lean();
    if (inc1) {
      const summary = await getInstrumentOperationalSummary(inc1._id);
      const expectedSev = liveRules.length > 0 ? 'S1' : 'NOT EVALUATED';
      if (summary.operational.severity !== expectedSev) {
        throw new Error(`Expected live instrument severity to be '${expectedSev}', got '${summary.operational.severity}'`);
      }
      console.log(`[PASS] Live instrument ${inc1.code} severity is currently: '${summary.operational.severity}'`);
    }

    // =========================================================================
    // TEST A: NO RULE
    // =========================================================================
    console.log('\n--- Running Test A: NO RULE ---');
    const readingA = {
      value: 12.5,
      unit: 'mm',
      quality: 'VALID',
      deltaFromBaseline: 2.5,
      ratePerHour: 0.1
    };
    const resA = evaluateSeverity({
      derivedReading: readingA,
      quality: 'VALID',
      applicableRule: null
    });
    console.log('Test A Result:', resA);
    if (!resA.evaluated && resA.level === 'NOT_EVALUATED' && resA.reason === 'NO_RULE') {
      results['A_NO_RULE'] = 'PASS';
      console.log('[PASS] Test A: Evaluated = false, Level = NOT_EVALUATED, Reason = NO_RULE');
    } else {
      throw new Error(`Test A failed: ${JSON.stringify(resA)}`);
    }

    // Synthetic rule fixture for B, C, D, E, F
    // Mode = INCREASING, metric = engineeringValue, unit = mm, thresholds: S1=5, S2=10, S3=15, S4=20
    const syntheticRuleIncreasing = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Synthetic Test Increasing Rule',
      parameterCode: 'test_disp_x',
      metric: 'engineeringValue',
      mode: 'INCREASING',
      unit: 'mm',
      version: 1,
      thresholds: { s1: 5.0, s2: 10.0, s3: 15.0, s4: 20.0 }
    };

    // =========================================================================
    // TEST B: VALID S0 (Value inside S0 range)
    // =========================================================================
    console.log('\n--- Running Test B: VALID S0 ---');
    const readingB = { value: 2.4, unit: 'mm', quality: 'VALID' };
    const resB = evaluateSeverity({
      derivedReading: readingB,
      quality: 'VALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test B Result:', resB);
    if (resB.evaluated && resB.level === 'S0' && resB.evaluatedValue === 2.4) {
      results['B_VALID_S0'] = 'PASS';
      console.log('[PASS] Test B: Evaluated = true, Level = S0');
    } else {
      throw new Error(`Test B failed: ${JSON.stringify(resB)}`);
    }

    // =========================================================================
    // TEST C: S1 (Value crossing S1 threshold)
    // =========================================================================
    console.log('\n--- Running Test C: S1 ---');
    const readingC = { value: 6.2, unit: 'mm', quality: 'VALID' };
    const resC = evaluateSeverity({
      derivedReading: readingC,
      quality: 'VALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test C Result:', resC);
    if (resC.evaluated && resC.level === 'S1' && resC.evaluatedValue === 6.2) {
      results['C_S1'] = 'PASS';
      console.log('[PASS] Test C: Evaluated = true, Level = S1');
    } else {
      throw new Error(`Test C failed: ${JSON.stringify(resC)}`);
    }

    // =========================================================================
    // TEST D: S2 (Value crossing S2 threshold)
    // =========================================================================
    console.log('\n--- Running Test D: S2 ---');
    const readingD = { value: 11.8, unit: 'mm', quality: 'VALID' };
    const resD = evaluateSeverity({
      derivedReading: readingD,
      quality: 'VALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test D Result:', resD);
    if (resD.evaluated && resD.level === 'S2' && resD.evaluatedValue === 11.8) {
      results['D_S2'] = 'PASS';
      console.log('[PASS] Test D: Evaluated = true, Level = S2');
    } else {
      throw new Error(`Test D failed: ${JSON.stringify(resD)}`);
    }

    // =========================================================================
    // TEST E: S3 (Value crossing S3 threshold)
    // =========================================================================
    console.log('\n--- Running Test E: S3 ---');
    const readingE = { value: 17.5, unit: 'mm', quality: 'VALID' };
    const resE = evaluateSeverity({
      derivedReading: readingE,
      quality: 'VALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test E Result:', resE);
    if (resE.evaluated && resE.level === 'S3' && resE.evaluatedValue === 17.5) {
      results['E_S3'] = 'PASS';
      console.log('[PASS] Test E: Evaluated = true, Level = S3');
    } else {
      throw new Error(`Test E failed: ${JSON.stringify(resE)}`);
    }

    // =========================================================================
    // TEST F: S4 (Value crossing S4 threshold)
    // =========================================================================
    console.log('\n--- Running Test F: S4 ---');
    const readingF = { value: 24.1, unit: 'mm', quality: 'VALID' };
    const resF = evaluateSeverity({
      derivedReading: readingF,
      quality: 'VALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test F Result:', resF);
    if (resF.evaluated && resF.level === 'S4' && resF.evaluatedValue === 24.1) {
      results['F_S4'] = 'PASS';
      console.log('[PASS] Test F: Evaluated = true, Level = S4');
    } else {
      throw new Error(`Test F failed: ${JSON.stringify(resF)}`);
    }

    // =========================================================================
    // TEST G: INVALID QUALITY
    // =========================================================================
    console.log('\n--- Running Test G: INVALID QUALITY ---');
    const readingG = { value: 99.9, unit: 'mm', quality: 'INVALID' };
    const resG = evaluateSeverity({
      derivedReading: readingG,
      quality: 'INVALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test G Result:', resG);
    if (!resG.evaluated && resG.level === 'NOT_EVALUATED' && resG.reason === 'QUALITY_NOT_VALID') {
      results['G_INVALID_QUALITY'] = 'PASS';
      console.log('[PASS] Test G: Evaluated = false, Level = NOT_EVALUATED, Reason = QUALITY_NOT_VALID (Not S0/S4)');
    } else {
      throw new Error(`Test G failed: ${JSON.stringify(resG)}`);
    }

    // =========================================================================
    // TEST H: BASELINE MISSING FOR DELTA RULE
    // =========================================================================
    console.log('\n--- Running Test H: BASELINE MISSING FOR DELTA RULE ---');
    const deltaRule = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Synthetic Delta Rule',
      parameterCode: 'disp_delta',
      metric: 'deltaFromBaseline',
      mode: 'INCREASING',
      unit: 'mm',
      version: 1,
      thresholds: { s1: 3.0, s2: 6.0 }
    };
    // Channel baseline not configured
    const unconfiguredChannel = { baseline: { configured: false, value: 0 }, engineeringUnit: 'mm' };
    const readingH = { value: 8.5, unit: 'mm', deltaFromBaseline: null, quality: 'VALID' };
    const resH = evaluateSeverity({
      channel: unconfiguredChannel,
      derivedReading: readingH,
      quality: 'VALID',
      applicableRule: deltaRule
    });
    console.log('Test H Result:', resH);
    if (!resH.evaluated && resH.level === 'NOT_EVALUATED' && resH.reason === 'BASELINE_UNAVAILABLE') {
      results['H_BASELINE_MISSING'] = 'PASS';
      console.log('[PASS] Test H: Evaluated = false, Level = NOT_EVALUATED, Reason = BASELINE_UNAVAILABLE');
    } else {
      throw new Error(`Test H failed: ${JSON.stringify(resH)}`);
    }

    // =========================================================================
    // TEST I: RATE MISSING FOR RATE RULE
    // =========================================================================
    console.log('\n--- Running Test I: RATE MISSING ---');
    const rateRule = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Synthetic Rate Rule',
      parameterCode: 'settlement_rate',
      metric: 'ratePerHour',
      mode: 'INCREASING',
      unit: 'mm/h',
      version: 1,
      thresholds: { s1: 0.5, s2: 1.0 }
    };
    const readingI = { value: 2.0, unit: 'mm/h', ratePerHour: null, quality: 'VALID' };
    const resI = evaluateSeverity({
      derivedReading: readingI,
      quality: 'VALID',
      applicableRule: rateRule
    });
    console.log('Test I Result:', resI);
    if (!resI.evaluated && resI.level === 'NOT_EVALUATED' && resI.reason === 'RATE_UNAVAILABLE') {
      results['I_RATE_MISSING'] = 'PASS';
      console.log('[PASS] Test I: Evaluated = false, Level = NOT_EVALUATED, Reason = RATE_UNAVAILABLE');
    } else {
      throw new Error(`Test I failed: ${JSON.stringify(resI)}`);
    }

    // =========================================================================
    // TEST J: UNIT MISMATCH (Rule validation / rejection)
    // =========================================================================
    console.log('\n--- Running Test J: UNIT MISMATCH ---');
    const readingJ = { value: 12.0, unit: 'kPa', quality: 'VALID' }; // rule is mm
    const resJ = evaluateSeverity({
      derivedReading: readingJ,
      quality: 'VALID',
      applicableRule: syntheticRuleIncreasing
    });
    console.log('Test J Result:', resJ);
    if (!resJ.evaluated && resJ.level === 'NOT_EVALUATED' && resJ.reason === 'UNIT_MISMATCH') {
      results['J_UNIT_MISMATCH'] = 'PASS';
      console.log('[PASS] Test J: Rejected with UNIT_MISMATCH');
    } else {
      throw new Error(`Test J failed: ${JSON.stringify(resJ)}`);
    }

    // =========================================================================
    // TEST K: INVALID THRESHOLD ORDER (Monotonic validation rejection)
    // =========================================================================
    console.log('\n--- Running Test K: INVALID THRESHOLD ORDER ---');
    const invalidIncreasing = validateRuleThresholds({
      mode: 'INCREASING',
      thresholds: { s1: 10.0, s2: 8.0 } // 10 >= 8 violation!
    });
    console.log('Invalid Increasing Validation Result:', invalidIncreasing);

    const invalidDecreasing = validateRuleThresholds({
      mode: 'DECREASING',
      thresholds: { s1: 5.0, s2: 8.0 } // 5 <= 8 violation!
    });
    console.log('Invalid Decreasing Validation Result:', invalidDecreasing);

    if (!invalidIncreasing.valid && !invalidDecreasing.valid) {
      results['K_INVALID_ORDER'] = 'PASS';
      console.log('[PASS] Test K: Both invalid ordering cases successfully rejected with monotonic errors');
    } else {
      throw new Error('Test K failed: Expected invalid threshold order to be rejected');
    }

    // Also test HTTP rejection of invalid order
    const httpResK = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/severity-rules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        name: 'Invalid Test Rule',
        parameterCode: 'invalid_param',
        metric: 'engineeringValue',
        mode: 'INCREASING',
        unit: 'mm',
        thresholds: { s1: 10, s2: 5 }
      })
    });
    if (httpResK.status === 400) {
      console.log('[PASS] Test K: API properly returned HTTP 400 Bad Request for monotonic violation');
    } else {
      throw new Error(`Test K HTTP failed: Expected 400, got ${httpResK.status}`);
    }

    // =========================================================================
    // TEST L: RULE VERSION CHANGE & HISTORICAL PERSISTENCE
    // =========================================================================
    console.log('\n--- Running Test L: RULE VERSION CHANGE ---');
    // Create temporary test rule via API
    const createRuleRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/severity-rules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        name: 'Version Test Rule',
        code: `TEST-VER-${Date.now()}`,
        parameterCode: 'test_version_param',
        metric: 'engineeringValue',
        mode: 'INCREASING',
        unit: 'mm',
        thresholds: { s1: 10, s2: 20 },
        status: 'ACTIVE'
      })
    });
    const createdRule = await createRuleRes.json();
    console.log('Created Test Rule V1:', createdRule._id, 'version:', createdRule.version);
    if (createdRule.version !== 1) throw new Error('Expected created rule version to be 1');

    // Evaluate reading 1 with V1
    const readingV1 = { value: 12.0, unit: 'mm', quality: 'VALID' };
    const evalV1 = evaluateSeverity({
      derivedReading: readingV1,
      quality: 'VALID',
      applicableRule: createdRule
    });
    console.log('Evaluation V1:', evalV1);
    if (!evalV1.evaluated || evalV1.level !== 'S1' || evalV1.ruleVersion !== 1) {
      throw new Error(`Evaluation V1 failed: ${JSON.stringify(evalV1)}`);
    }

    // Update rule to V2 by updating thresholds
    const updateRuleRes = await fetch(`${BASE_URL}/api/v1/projects/${project._id}/severity-rules/${createdRule._id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        thresholds: { s1: 15, s2: 25 }
      })
    });
    const updatedRule = await updateRuleRes.json();
    console.log('Updated Test Rule V2:', updatedRule._id, 'version:', updatedRule.version);
    if (updatedRule.version !== 2) throw new Error('Expected updated rule version to be 2');

    // Evaluate reading 2 with V2
    const readingV2 = { value: 12.0, unit: 'mm', quality: 'VALID' };
    const evalV2 = evaluateSeverity({
      derivedReading: readingV2,
      quality: 'VALID',
      applicableRule: updatedRule
    });
    console.log('Evaluation V2:', evalV2);
    // At value 12, under V2 (s1=15), it should evaluate to S0 with ruleVersion: 2!
    if (!evalV2.evaluated || evalV2.level !== 'S0' || evalV2.ruleVersion !== 2) {
      throw new Error(`Evaluation V2 failed: ${JSON.stringify(evalV2)}`);
    }

    // Historical reading V1 remains untouched with ruleVersion 1:
    if (evalV1.ruleVersion === 1 && evalV2.ruleVersion === 2) {
      results['L_VERSION_CHANGE'] = 'PASS';
      console.log('[PASS] Test L: New evaluation references version 2; old evaluation retains version 1');
    }

    // Clean up temporary test rule
    await EngineeringSeverityRule.deleteOne({ _id: createdRule._id });
    console.log('[INFO] Cleaned up temporary test rule');

    // =========================================================================
    // TEST M: ABSOLUTE MAGNITUDE MODE
    // =========================================================================
    console.log('\n--- Running Test M: ABSOLUTE MAGNITUDE MODE ---');
    const absoluteRule = {
      _id: new mongoose.Types.ObjectId(),
      name: 'Synthetic Absolute Rule',
      parameterCode: 'disp_x_abs',
      metric: 'engineeringValue',
      mode: 'ABSOLUTE',
      unit: 'mm',
      version: 1,
      thresholds: { s1: 2.0, s2: 5.0, s3: 10.0 }
    };
    const readingNegative = { value: -3.5, unit: 'mm', quality: 'VALID' };
    const resNeg = evaluateSeverity({
      derivedReading: readingNegative,
      quality: 'VALID',
      applicableRule: absoluteRule
    });
    console.log('Absolute Mode Negative Value Result:', resNeg);
    if (resNeg.evaluated && resNeg.level === 'S1' && resNeg.evaluatedValue === 3.5) {
      results['M_ABSOLUTE_MODE'] = 'PASS';
      console.log('[PASS] Test M: -3.5 mm evaluated as 3.5 mm -> Level = S1 in ABSOLUTE mode');
    } else {
      throw new Error(`Test M failed: ${JSON.stringify(resNeg)}`);
    }

    // =========================================================================
    // TEST N: ALARM & COMMISSIONING SAFETY
    // =========================================================================
    console.log('\n--- Running Test N: ALARM & COMMISSIONING SAFETY ---');
    const finalAlarmCount = await Alarm.countDocuments();
    if (finalAlarmCount !== initialAlarmCount) {
      throw new Error(`Alarm count increased from ${initialAlarmCount} to ${finalAlarmCount}! Alarm generation must NOT happen in Phase C3.`);
    }
    console.log(`[PASS] Zero alarm records created. Initial: ${initialAlarmCount}, Final: ${finalAlarmCount}`);
    results['N_ZERO_ALARMS'] = 'PASS';

    // Summary of all test results
    console.log('\n====================================================');
    console.log('ALL PHASE C3 CONTROLLED TESTS PASSED:');
    console.log(JSON.stringify(results, null, 2));
    console.log('====================================================');

  } finally {
    await stopServer();
    await mongoose.disconnect();
  }
}

runC3Verification().catch(err => {
  console.error('\n[FATAL ERROR]:', err);
  process.exit(1);
});
