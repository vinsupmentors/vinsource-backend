import type { FieldMap } from './filterTree';

const STAGES = ['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'DEMO_DONE', 'NEGOTIATION', 'ENROLLED', 'LOST'];
const ACTIVITY_STATUSES = ['DNP', 'FOLLOW_UP', 'DEMO_BOOKED', 'DEMO_OVER', 'NOT_INTERESTED', 'DISQUALIFIED'];

/** Fields the advanced filter may use on the Leads list. */
export const LEAD_FILTER_FIELDS: FieldMap = {
  name: { type: 'text', path: ['name'] },
  phone: { type: 'text', path: ['phone'] },
  email: { type: 'text', path: ['email'], nullable: true },
  source: { type: 'text', path: ['source'], nullable: true },
  courseInterest: { type: 'text', path: ['courseInterest'], nullable: true },
  city: { type: 'text', path: ['city'], nullable: true },
  educationQualification: { type: 'text', path: ['educationQualification'], nullable: true },
  collegeName: { type: 'text', path: ['collegeName'], nullable: true },
  currentStatus: { type: 'text', path: ['currentStatus'], nullable: true },
  passedOutYear: { type: 'number', path: ['passedOutYear'], nullable: true },
  status: { type: 'select', path: ['status'], enumValues: STAGES },
  activityStatus: { type: 'select', path: ['activityStatus'], nullable: true, enumValues: ACTIVITY_STATUSES },
  assignedToId: { type: 'select', path: ['assignedToId'], nullable: true },
  createdAt: { type: 'date', path: ['createdAt'] },
  lastContactAt: { type: 'date', path: ['lastContactAt'], nullable: true },
  nextFollowUpAt: { type: 'date', path: ['nextFollowUpAt'], nullable: true },
  // Any demo of the lead matches (to-many relation).
  demoMode: { type: 'select', path: ['mode'], enumValues: ['ONLINE', 'OFFLINE'], wrap: (f) => ({ demos: { some: f } }) },
  demoStatus: { type: 'select', path: ['status'], enumValues: ['SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED'], wrap: (f) => ({ demos: { some: f } }) },
  demoDate: { type: 'date', path: ['scheduledAt'], wrap: (f) => ({ demos: { some: f } }) },
};

/** Fields for the Call Log. */
export const CALL_FILTER_FIELDS: FieldMap = {
  calledAt: { type: 'date', path: ['calledAt'] },
  activityType: { type: 'select', path: ['activityType'], nullable: true, enumValues: ['CALL', 'MEETING'] },
  activityStatus: { type: 'select', path: ['activityStatus'], nullable: true, enumValues: ACTIVITY_STATUSES },
  direction: { type: 'select', path: ['direction'], nullable: true, enumValues: ['INBOUND', 'OUTBOUND', 'MISSED'] },
  source: { type: 'select', path: ['source'], enumValues: ['MANUAL', 'AUTO'] },
  durationSeconds: { type: 'number', path: ['durationSeconds'], nullable: true },
  calledById: { type: 'select', path: ['calledById'], nullable: true },
  notes: { type: 'text', path: ['notes'], nullable: true },
  rawPhoneNumber: { type: 'text', path: ['rawPhoneNumber'], nullable: true },
  leadName: { type: 'text', path: ['lead', 'name'] },
  leadPhone: { type: 'text', path: ['lead', 'phone'] },
};

/** Fields for the Activity Monitor (lead history). */
export const FEED_FILTER_FIELDS: FieldMap = {
  createdAt: { type: 'date', path: ['createdAt'] },
  type: {
    type: 'select', path: ['type'],
    enumValues: ['CREATED', 'ASSIGNED', 'STATUS', 'STAGE', 'ACTIVITY', 'FOLLOW_UP', 'EDIT', 'DELETED', 'DEMO', 'TASK', 'NOTE', 'RESTORED'],
  },
  actorId: { type: 'select', path: ['actorId'], nullable: true },
  summary: { type: 'text', path: ['summary'] },
  leadName: { type: 'text', path: ['lead', 'name'] },
  leadPhone: { type: 'text', path: ['lead', 'phone'] },
};
