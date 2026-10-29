/**
 * Central Permission Catalog & Access Profiles
 * Phase A1A: Organization Workforce, Teams & Project Access Backend Foundation
 */

export const PERMISSION_GROUPS = [
  {
    id: 'OVERVIEW',
    label: 'Overview',
    description: 'Project dashboard and high-level health views',
    permissions: [
      { key: 'overview.view', label: 'View Overview', description: 'View project dashboard overview and summary metrics' }
    ]
  },
  {
    id: 'MAP',
    label: 'Geospatial Map',
    description: 'GIS layers, map features and geospatial visualization',
    permissions: [
      { key: 'map.view', label: 'View Map', description: 'View GIS map, spatial layers, site and zone locations' }
    ]
  },
  {
    id: 'COMMISSIONING',
    label: 'Commissioning',
    description: 'Sensor, device and gateway installation and commissioning workflows',
    permissions: [
      { key: 'commissioning.view', label: 'View Commissioning', description: 'View commissioning status and asset pipeline' },
      { key: 'commissioning.register', label: 'Register Assets', description: 'Register sensors, loggers and gateways for commissioning' },
      { key: 'commissioning.configure', label: 'Configure Assets', description: 'Configure telemetry channels and hardware properties' },
      { key: 'commissioning.map', label: 'Map Channels', description: 'Map sensor channels to data streams' },
      { key: 'commissioning.calibrate', label: 'Calibrate Sensors', description: 'Perform baseline zeroing and calibration adjustments' },
      { key: 'commissioning.finalize', label: 'Finalize Commissioning', description: 'Complete commissioning and transition to operational monitoring' }
    ]
  },
  {
    id: 'INSTRUMENTS',
    label: 'Instruments',
    description: 'Geotechnical instrument catalog and active sensors',
    permissions: [
      { key: 'instruments.view', label: 'View Instruments', description: 'View instrument list, status and parameter specifications' }
    ]
  },
  {
    id: 'DEVICES',
    label: 'Devices & Gateways',
    description: 'Hardware loggers, nodes and telemetry gateways',
    permissions: [
      { key: 'devices.view', label: 'View Devices', description: 'View devices, battery, signal health and status' },
      { key: 'devices.manage', label: 'Manage Devices', description: 'Add, edit, configure or reboot devices and gateways' }
    ]
  },
  {
    id: 'HISTORICAL',
    label: 'Historical Data',
    description: 'Telemetry readings, raw data queries and historical logs',
    permissions: [
      { key: 'historical.view', label: 'View Historical Data', description: 'Query and view historical time-series data' },
      { key: 'historical.export', label: 'Export Historical Data', description: 'Export historical sensor data to CSV or Excel' }
    ]
  },
  {
    id: 'TRENDS',
    label: 'Trends & Analytics',
    description: 'Data charting, rate of change analysis and engineering trends',
    permissions: [
      { key: 'trends.view', label: 'View Trends', description: 'View interactive trend charts and comparative analysis' },
      { key: 'trends.export', label: 'Export Trends', description: 'Export trend charts and analytics reports' }
    ]
  },
  {
    id: 'SEVERITY_RULES',
    label: 'Severity Rules',
    description: 'Engineering thresholds, TARP levels and trigger criteria',
    permissions: [
      { key: 'severityRules.view', label: 'View Severity Rules', description: 'View engineering threshold rules and TARP levels' },
      { key: 'severityRules.configure', label: 'Configure Severity Rules', description: 'Create and update threshold limits and conditions' },
      { key: 'severityRules.activate', label: 'Activate Severity Rules', description: 'Activate, deactivate or promote rule versions' }
    ]
  },
  {
    id: 'ALARM_POLICIES',
    label: 'Alarm Policies',
    description: 'Notification policies, routing rules and escalation pathways',
    permissions: [
      { key: 'alarmPolicies.view', label: 'View Alarm Policies', description: 'View alarm notification and escalation policies' },
      { key: 'alarmPolicies.configure', label: 'Configure Alarm Policies', description: 'Create and edit notification channels and schedules' },
      { key: 'alarmPolicies.activate', label: 'Activate Alarm Policies', description: 'Enable or disable alarm policies' }
    ]
  },
  {
    id: 'ALARMS',
    label: 'Alarms',
    description: 'Real-time alert monitoring, acknowledgement and resolution',
    permissions: [
      { key: 'alarms.view', label: 'View Alarms', description: 'View active alarms and alarm history' },
      { key: 'alarms.acknowledge', label: 'Acknowledge Alarms', description: 'Acknowledge active alarms with operational notes' },
      { key: 'alarms.resolve', label: 'Resolve Alarms', description: 'Resolve alarms and provide root-cause documentation' }
    ]
  },
  {
    id: 'INVESTIGATIONS',
    label: 'Investigations',
    description: 'Geotechnical investigations, incident tracking and findings',
    permissions: [
      { key: 'investigations.view', label: 'View Investigations', description: 'View geotechnical investigation cases and logs' },
      { key: 'investigations.assign', label: 'Assign Investigations', description: 'Assign lead investigator or team to investigation' },
      { key: 'investigations.start', label: 'Start Investigations', description: 'Initiate and activate investigation cases' },
      { key: 'investigations.addFinding', label: 'Add Findings', description: 'Add field observations, photos and technical notes' },
      { key: 'investigations.complete', label: 'Complete Investigations', description: 'Close and finalize investigation reports' }
    ]
  },
  {
    id: 'REPORTS',
    label: 'Reports',
    description: 'Automated geotechnical reports and executive summaries',
    permissions: [
      { key: 'reports.view', label: 'View Reports', description: 'View report previews and scheduled reports' },
      { key: 'reports.export', label: 'Export Reports', description: 'Download generated PDF and Excel reports' }
    ]
  },
  {
    id: 'ADMINISTRATION',
    label: 'Administration',
    description: 'Workforce management, teams, project access and settings',
    permissions: [
      { key: 'administration.view', label: 'View Administration', description: 'View workforce directory, teams and access lists' },
      { key: 'administration.manageEmployees', label: 'Manage Employees', description: 'Add, update and deactivate employee profiles' },
      { key: 'administration.manageTeams', label: 'Manage Teams', description: 'Create, update and configure teams and team members' },
      { key: 'administration.manageAccess', label: 'Manage Project Access', description: 'Assign teams to projects and grant permission profiles' }
    ]
  }
];

// Flat map of all permissions
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((p) => ({ ...p, group: group.id, groupLabel: group.label }))
);

export const ALL_PERMISSION_KEYS = new Set(ALL_PERMISSIONS.map((p) => p.key));

// Preset Access Profiles
export const ACCESS_PROFILES = {
  ENGINEERING: {
    key: 'ENGINEERING',
    label: 'Geotechnical Engineering',
    description: 'Comprehensive engineering analysis, threshold management, investigations and reporting',
    permissions: [
      'overview.view',
      'map.view',
      'instruments.view',
      'historical.view',
      'historical.export',
      'trends.view',
      'trends.export',
      'severityRules.view',
      'severityRules.configure',
      'severityRules.activate',
      'alarmPolicies.view',
      'alarms.view',
      'alarms.acknowledge',
      'investigations.view',
      'investigations.assign',
      'investigations.start',
      'investigations.addFinding',
      'investigations.complete',
      'reports.view',
      'reports.export'
    ]
  },
  MONITORING_OPERATIONS: {
    key: 'MONITORING_OPERATIONS',
    label: 'Monitoring / Control Room Operations',
    description: 'Continuous monitoring, telemetry surveillance, alarm acknowledgement and initial findings',
    permissions: [
      'overview.view',
      'map.view',
      'instruments.view',
      'devices.view',
      'historical.view',
      'trends.view',
      'alarms.view',
      'alarms.acknowledge',
      'investigations.view',
      'investigations.addFinding',
      'reports.view',
      'reports.export'
    ]
  },
  COMMISSIONING: {
    key: 'COMMISSIONING',
    label: 'Field Commissioning & Hardware',
    description: 'Sensor registration, logger mapping, calibration and hardware deployment',
    permissions: [
      'overview.view',
      'map.view',
      'commissioning.view',
      'commissioning.register',
      'commissioning.configure',
      'commissioning.map',
      'commissioning.calibrate',
      'commissioning.finalize',
      'instruments.view',
      'devices.view',
      'devices.manage'
    ]
  },
  MAINTENANCE: {
    key: 'MAINTENANCE',
    label: 'Maintenance & Field Support',
    description: 'Hardware diagnosis, sensor maintenance, investigation findings and status checks',
    permissions: [
      'overview.view',
      'map.view',
      'instruments.view',
      'devices.view',
      'devices.manage',
      'alarms.view',
      'investigations.view',
      'investigations.addFinding',
      'reports.view',
      'reports.export'
    ]
  },
  MANAGEMENT_VIEW: {
    key: 'MANAGEMENT_VIEW',
    label: 'Management & Stakeholder View',
    description: 'Read-only visibility into dashboards, trends, alarms and executive reports',
    permissions: [
      'overview.view',
      'map.view',
      'instruments.view',
      'historical.view',
      'trends.view',
      'alarms.view',
      'investigations.view',
      'reports.view',
      'reports.export'
    ]
  },
  CUSTOM: {
    key: 'CUSTOM',
    label: 'Custom Permissions',
    description: 'Tailored permissions configured specifically for this project assignment',
    permissions: []
  }
};

/**
 * Validate that an array of permission keys contains only valid catalog entries.
 * Returns { valid: boolean, invalid: string[] }
 */
export function validatePermissions(permissions) {
  if (!Array.isArray(permissions)) {
    return { valid: false, invalid: ['permissions must be an array'] };
  }
  const invalid = permissions.filter((key) => !ALL_PERMISSION_KEYS.has(key));
  return {
    valid: invalid.length === 0,
    invalid
  };
}
