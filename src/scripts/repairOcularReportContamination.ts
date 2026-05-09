import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { Appointment, VisitReport } from '../models/index.js';
import { AppointmentType } from '../utils/constants.js';
import { VisitReportStatus } from '../models/VisitReport.js';

function hasValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function isEmptyDraftReport(report: any) {
  return !hasValue(report.lineItems)
    && !hasValue(report.measurements)
    && !hasValue(report.siteConditions)
    && !hasValue(report.materials)
    && !hasValue(report.finishes)
    && !hasValue(report.preferredDesign)
    && !hasValue(report.customerRequirements)
    && !hasValue(report.notes)
    && !hasValue(report.specifications)
    && !hasValue(report.discussionNotes)
    && !hasValue(report.initialDesignKeys)
    && !hasValue(report.initialDesignNotes)
    && !hasValue(report.selectedDesignTemplateId)
    && !hasValue(report.selectedDesignTemplateName)
    && !hasValue(report.selectedDesignTemplateImageUrl)
    && !hasValue(report.photoKeys)
    && !hasValue(report.videoKeys)
    && !hasValue(report.sketchKeys)
    && !hasValue(report.referenceImageKeys);
}

const carryFields = [
  'measurementUnit',
  'lineItems',
  'measurements',
  'siteConditions',
  'materials',
  'finishes',
  'preferredDesign',
  'customerRequirements',
  'notes',
  'specifications',
  'discussionNotes',
  'initialDesignKeys',
  'initialDesignNotes',
  'selectedDesignTemplateId',
  'selectedDesignTemplateName',
  'selectedDesignTemplateImageUrl',
  'photoKeys',
  'videoKeys',
  'sketchKeys',
  'referenceImageKeys',
] as const;

function mergeMissing(target: any, source: any) {
  for (const field of carryFields) {
    if (!hasValue(target[field]) && hasValue(source[field])) {
      target[field] = source[field];
    }
  }
}

function hasUserData(report: any) {
  return !isEmptyDraftReport(report);
}

function createdTime(report: any) {
  return new Date(report.createdAt || 0).getTime();
}

function pickCanonical(reports: any[]) {
  return reports
    .slice()
    .sort((a, b) => {
      const aSourceData = a.visitType === 'consultation' && hasUserData(a) ? 0 : 1;
      const bSourceData = b.visitType === 'consultation' && hasUserData(b) ? 0 : 1;
      if (aSourceData !== bSourceData) return aSourceData - bSourceData;
      const aAnyData = hasUserData(a) ? 0 : 1;
      const bAnyData = hasUserData(b) ? 0 : 1;
      if (aAnyData !== bAnyData) return aAnyData - bAnyData;
      return createdTime(a) - createdTime(b);
    })[0];
}

function serviceTypesForAppointment(appointment: any) {
  return [
    ...new Set([
      ...(appointment.serviceTypes || []),
      ...(appointment.serviceTypes?.length ? [] : appointment.customerSiteDetails?.serviceTypes || []),
    ].filter(Boolean)),
  ];
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();

  const ocularAppointments = await Appointment.find({ type: AppointmentType.OCULAR })
    .select('_id customerId salesStaffId serviceTypes customerSiteDetails sourceConsultationAppointmentId')
    .lean();

  let deleted = 0;
  let transitioned = 0;
  let flagged = 0;

  for (const appointment of ocularAppointments) {
    const allowed = new Set(serviceTypesForAppointment(appointment));
    if (allowed.size === 0) continue;

    if (appointment.sourceConsultationAppointmentId) {
      const [sourceReports, ocularReports] = await Promise.all([
        VisitReport.find({
          appointmentId: appointment.sourceConsultationAppointmentId,
          customerId: appointment.customerId,
          salesStaffId: appointment.salesStaffId,
          visitType: 'consultation',
          serviceType: { $in: [...allowed] },
        }),
        VisitReport.find({
          appointmentId: appointment._id,
          customerId: appointment.customerId,
          salesStaffId: appointment.salesStaffId,
          visitType: 'ocular',
          serviceType: { $in: [...allowed] },
        }),
      ]);

      for (const serviceType of allowed) {
        const candidates = [...sourceReports, ...ocularReports].filter((report) => report.serviceType === serviceType);
        if (candidates.length === 0) continue;

        const canonical = pickCanonical(candidates);
        const duplicates = candidates.filter((report) => report._id.toString() !== canonical._id.toString());
        for (const duplicate of duplicates) {
          mergeMissing(canonical, duplicate);
          if (apply) await VisitReport.deleteOne({ _id: duplicate._id });
          deleted += 1;
          console.log(`${apply ? 'deleted' : 'would delete'} duplicate ${duplicate._id} (${serviceType}) for ocular appointment ${appointment._id}`);
        }

        canonical.appointmentId = appointment._id;
        canonical.visitType = 'ocular';
        canonical.status = VisitReportStatus.DRAFT;
        if (apply) await canonical.save();
        transitioned += 1;
        console.log(`${apply ? 'transitioned' : 'would transition'} canonical report ${canonical._id} (${serviceType}) to ocular appointment ${appointment._id}`);
      }
    }

    const reports = await VisitReport.find({ appointmentId: appointment._id });
    for (const report of reports) {
      if (allowed.has(report.serviceType)) continue;

      if (
        [VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(report.status)
        && isEmptyDraftReport(report)
      ) {
        if (apply) {
          await VisitReport.deleteOne({ _id: report._id });
        }
        deleted += 1;
        console.log(`${apply ? 'deleted' : 'would delete'} empty mismatched report ${report._id} (${report.serviceType}) from appointment ${appointment._id}`);
        continue;
      }

      flagged += 1;
      console.log(`flagged non-empty mismatched report ${report._id} (${report.serviceType}) on appointment ${appointment._id}`);
    }
  }

  console.log(JSON.stringify({ apply, transitioned, deleted, flagged }, null, 2));
  await mongoose.connection.close();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.connection.close();
  process.exit(1);
});
